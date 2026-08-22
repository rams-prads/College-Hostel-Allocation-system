/**
 * Allocator.gs - the allocation engine.
 *
 * Deterministic, seeded, and explainable BY CONSTRUCTION: every stage appends
 * reason codes as it runs, so the explanation shown to a student is a byproduct
 * of the algorithm and cannot drift out of sync with it.
 *
 * KEY STRUCTURAL DECISION: run() is a PURE COMPUTATION. It reads the database,
 * works entirely in memory, and returns a result object without writing
 * anything. commit() is what persists. That seam is what lets the Phase 5
 * simulator run a full what-if allocation with zero risk to live state.
 *
 * Stages (see PROJECT_CONTEXT.md section 8):
 *   A PARTITION   B SCORE   C ORDER   D QUOTA   E SERIAL DICTATORSHIP
 *   F LOCAL SEARCH   G ROOMMATES   H WAITLIST
 */

var Allocator = (function () {

  // ============================================================== entry point

  /**
   * Compute an allocation. Writes nothing.
   * @param {{seed?: string, mode?: string, triggeredBy?: string}} opts
   */
  function run(opts) {
    opts = opts || {};
    var t0 = new Date().getTime();
    var seed = opts.seed || String(Db.cfg('ACADEMIC_YEAR', '2026')) + '-' + Date.now();
    var runId = opts.runId || 'RUN-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd-HHmmss');

    Policy.invalidate();
    var policy = Policy.describe();

    var ctx = buildContext_(seed);

    stageA_partition(ctx);
    stageB_priority(ctx);
    stageC_order(ctx);
    stageD_quota(ctx);
    stageE_serialDictatorship(ctx);
    var swaps = stageF_localSearch(ctx);
    stageG_roommates(ctx);
    stageH_waitlist(ctx);

    var result = {
      runId: runId,
      seed: seed,
      mode: opts.mode || 'DRAFT',
      policyHash: policy.hash,
      policy: policy,
      startedAt: new Date(t0),
      finishedAt: new Date(),
      triggeredBy: opts.triggeredBy || 'system',
      allocations: ctx.allocations,
      waitlist: ctx.waitlist,
      rejected: ctx.rejected,
      traces: ctx.traces,
      quota: ctx.quotaPlan,
      converted: ctx.converted || 0,
      paretoSwaps: swaps,
      elapsedSec: Util.round((new Date().getTime() - t0) / 1000, 2)
    };
    result.metrics = Metrics.compute(result, ctx);
    return result;
  }

  /** Run and persist in one call. */
  function runAndCommit(opts) {
    opts = opts || {};
    opts.mode = 'COMMITTED';
    var result = run(opts);
    commit(result);
    return result;
  }

  // ================================================================= context

  function buildContext_(seed) {
    var apps      = Db.readAll('Applications');
    var students  = Db.indexBy('Students', 'studentId');
    var hostels   = Db.indexBy('Hostels', 'hostelId');
    var rooms     = Db.readAll('Rooms');
    var beds      = Db.readAll('Beds');
    var prefsByApp = Db.groupBy('Preferences', 'appId');
    var lifestyle = Roommate.lifestyleIndex();
    var roomById  = {};
    rooms.forEach(function (r) { roomById[r.roomId] = r; });

    return {
      seed: seed,
      rand: Util.rng(seed),
      apps: apps,
      students: students,
      hostels: hostels,
      rooms: rooms,
      roomById: roomById,
      beds: beds,
      prefsByApp: prefsByApp,
      lifestyle: lifestyle,
      maxPrefs: Number(Db.cfg('MAX_PREFERENCES', 5)),

      pool: [],           // eligible candidates, enriched
      rejected: [],       // ineligible, with reasons
      traces: {},         // appId -> [reason,...]
      allocations: [],
      waitlist: [],
      quotaPlan: null
    };
  }

  function trace_(ctx, appId, r) {
    (ctx.traces[appId] = ctx.traces[appId] || []).push(r);
  }

  // ======================================================== STAGE A: PARTITION

  /**
   * Hard constraints. There are TWO partitions, gender and campus.
   *
   * Campus is not a preference. A student is admitted to Dwarka or to East Delhi
   * and can only be housed in that campus's hostels, so an allocation that
   * crosses campuses is not a worse outcome - it is an impossible one.
   *
   * Merit order is still computed across the whole university, so a Dwarka and an
   * East Delhi applicant are ranked on the same scale and reserved seats are
   * apportioned university-wide. Only the beds they may occupy differ.
   *
   * Accessibility is a placement constraint handled in stage E, not a partition.
   */
  function stageA_partition(ctx) {
    var elig = Eligibility.evaluateAll();

    ctx.apps.forEach(function (app) {
      var res = elig.byAppId[app.appId];
      var student = ctx.students[app.studentId];
      res.reasons.forEach(function (r) { trace_(ctx, app.appId, r); });

      if (!res.eligible) {
        ctx.rejected.push({ appId: app.appId, reasons: res.reasons.filter(function (r) { return !r.ok; }) });
        return;
      }

      ctx.pool.push({
        appId: app.appId,
        studentId: app.studentId,
        gender: student.gender,
        campus: student.campus || app.campus,
        category: student.category,
        isPwD: !!student.isPwD,
        needsAccessible: !!app.needsAccessible,

        // Everything the priority order turns on. Read once here so stage B is
        // pure sorting and the reader can see, in one place, exactly which
        // facts about a person the allotment depends on.
        residenceCategory: student.residenceCategory || 'DELHI',
        parentTransferred: !!student.parentTransferred,
        isForeign: !!student.isForeign,
        school: student.school || '',
        meritPercent: Number(student.meritPercent) || 0,
        meritBasis: student.meritBasis || 'NOT_RECORDED',
        admissionType: app.admissionType || 'FRESH',

        year: Number(student.year),
        distanceKm: Number(app.distanceKm),
        prefs: (ctx.prefsByApp[app.appId] || []).slice().sort(function (a, b) { return a.rank - b.rank; }),
        name: student.name
      });
    });

    return ctx.pool.length;
  }

  // ========================================== STAGE B: PRIORITY AND MERIT

  /**
   * Place every candidate in a priority group, and record the merit figure
   * that orders them inside it.
   *
   * This replaced a weighted composite score, and the difference is not a
   * refinement - it is a different kind of decision. A weighted score lets a
   * strong showing on one factor compensate for a weak one, so a Delhi
   * applicant with excellent marks could outrank an outside-Delhi applicant
   * with poor ones. The brochure does not permit that. It sets a strict order
   * of groups, and a group is exhausted before the next is looked at at all:
   *
   *     1  disabled / handicapped applicants
   *     2  outside-Delhi category, by merit
   *     3  Delhi category whose parent was transferred out of Delhi, by merit
   *     4  remaining Delhi category, by distance from campus
   *
   * No amount of merit moves anyone between those groups. Encoding it as
   * weights would have produced results that looked reasonable and were not the
   * policy, which is the worst failure available to a system like this.
   *
   * Merit is a percentage in both cases the brochure names - the result up to
   * the preceding semester, or the best five subjects of class 12 for a
   * first-year - so unlike a CGPA against an entrance rank the two are directly
   * comparable and need no normalising.
   */
  function stageB_priority(ctx) {
    var ranks = Policy.load().priority || {};

    ctx.pool.forEach(function (c) {
      var tier, tierRank, orderBy;

      if (c.isPwD) {
        tier = 'PWD';
        tierRank = Number(ranks.PWD) || 1;
        orderBy = c.meritPercent;
      } else if (c.residenceCategory === 'OUTSIDE_DELHI') {
        tier = 'OUTSIDE_DELHI';
        tierRank = Number(ranks.OUTSIDE_DELHI) || 2;
        orderBy = c.meritPercent;
      } else if (c.parentTransferred) {
        tier = 'PARENT_TRANSFERRED';
        tierRank = Number(ranks.PARENT_TRANSFERRED) || 3;
        orderBy = c.meritPercent;
      } else {
        // The one group the brochure orders by distance rather than by marks:
        // among Delhi students, the question is who has furthest to travel.
        tier = 'DELHI';
        tierRank = Number(ranks.DELHI) || 4;
        orderBy = c.distanceKm;
      }

      c.tier = tier;
      c.tierRank = tierRank;
      c.orderBy = Number(orderBy) || 0;
      c.orderedByDistance = (tier === 'DELHI');

      trace_(ctx, c.appId, reason('PRIORITY_GROUP', true, tierText_(c), {
        tier: tier, tierRank: tierRank,
        meritPercent: c.meritPercent, meritBasis: c.meritBasis,
        distanceKm: c.distanceKm
      }));
    });

    return ctx.pool.length;
  }

  /** Why this applicant is in this group, in the words the brochure uses. */
  function tierText_(c) {
    if (c.tier === 'PWD') {
      return 'Placed in the first priority group. The hostel policy allots seats to ' +
             'disabled and handicapped students ahead of every other applicant.';
    }
    if (c.tier === 'OUTSIDE_DELHI') {
      return 'Placed in the second priority group, for applicants admitted in the ' +
             'outside-Delhi category, who are ranked among themselves on ' +
             meritPhrase_(c) + '.';
    }
    if (c.tier === 'PARENT_TRANSFERRED') {
      return 'Placed in the third priority group: admitted in the Delhi category, but ' +
             'with a parent transferred out of Delhi. This group is considered only ' +
             'after outside-Delhi applicants, and is ranked on ' + meritPhrase_(c) + '.';
    }
    return 'Placed in the fourth priority group, for Delhi-category applicants. This ' +
           'group is considered only if seats remain after the first three, and is ' +
           'ordered by distance from campus rather than by marks — your home is ' +
           (c.distanceKm >= 0 ? c.distanceKm + ' km away' : 'of unrecorded distance') + '.';
  }

  function meritPhrase_(c) {
    if (c.meritBasis === 'CLASS_12') {
      return 'the best five subjects of class 12 (' + c.meritPercent + '%), which is what ' +
             'the policy uses for a first-year with no university result yet';
    }
    if (c.meritBasis === 'SEMESTER') {
      return 'the result up to the preceding semester (' + c.meritPercent + '%)';
    }
    return 'academic merit, which is not recorded for you';
  }

  // =========================================================== STAGE C: ORDER

  /**
   * Order the pool: by priority group first, then within the group.
   *
   * Ties are broken by a hash of appId and the run seed - never by sheet order,
   * which would silently advantage whoever applied first, and never by
   * Math.random(), which would make the run impossible to reproduce.
   */
  function stageC_order(ctx) {
    ctx.pool.forEach(function (c) { c.tiebreak = Util.hashUnit(c.appId + '|' + ctx.seed); });

    ctx.pool.sort(function (a, b) {
      if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
      // Higher is better in both cases: a higher percentage, or a greater
      // distance from campus for the group ordered on distance.
      if (b.orderBy !== a.orderBy) return b.orderBy - a.orderBy;
      if (b.tiebreak !== a.tiebreak) return b.tiebreak - a.tiebreak;
      return a.appId < b.appId ? -1 : 1;
    });

    // Position within the group is the number that means something to an
    // applicant. Being 400th overall says little when the first three groups
    // hold 380 people; being 20th of 260 in your own group says everything.
    var counts = {}, seen = {};
    ctx.pool.forEach(function (c) { counts[c.tier] = (counts[c.tier] || 0) + 1; });

    var n = ctx.pool.length;
    ctx.pool.forEach(function (c, i) {
      c.meritPosition = i + 1;
      seen[c.tier] = (seen[c.tier] || 0) + 1;
      c.tierPosition = seen[c.tier];
      c.tierSize = counts[c.tier];

      var measure = c.orderedByDistance
        ? 'distance from campus (' + c.distanceKm + ' km)'
        : (c.meritBasis === 'CLASS_12' ? 'class 12 best-five marks' : 'your latest result') +
          ' (' + c.meritPercent + '%)';

      trace_(ctx, c.appId, reason('MERIT_POSITION', true,
        'Position ' + c.tierPosition + ' of ' + c.tierSize + ' in your priority group, ' +
        'ordered on ' + measure + '. Overall you are ' + (i + 1) + ' of ' + n +
        ' once the groups ahead of yours are counted.',
        {
          position: i + 1, of: n,
          tier: c.tier, tierPosition: c.tierPosition, tierSize: c.tierSize,
          orderedBy: c.orderedByDistance ? 'DISTANCE' : 'MERIT',
          meritPercent: c.meritPercent, meritBasis: c.meritBasis,
          distanceKm: c.distanceKm
        }));
    });
    return n;
  }

  // =========================================================== STAGE D: QUOTA

  /**
   * Apportion seats using the largest-remainder method, which distributes
   * fractional seats by largest remainder rather than by rounding each category
   * independently. Naive rounding does not sum to the pool size, and the
   * resulting off-by-one is a genuine source of quota disputes.
   *
   * Vertical reservation (SC/ST/OBC/EWS): a reserved-category candidate who
   * qualifies on open merit consumes an OPEN seat, not their quota - which is
   * how Indian reservation actually works.
   * Horizontal reservation (PwD) cuts across all verticals.
   */
  function stageD_quota(ctx) {
    var totalBeds = ctx.beds.filter(function (b) {
      return b.status !== 'BLOCKED' && b.status !== 'RESERVED';
    }).length;
    var buffer = Policy.value('capacity', 'VACANCY_BUFFER_PCT', 0);

    // The buffer holds back REAL BEDS, per hostel, rather than shaving a number
    // off a global seat cap. A global cap is silently unfair: whichever pool
    // fills last absorbs the entire reserve, so on this cohort a global buffer
    // left girls waiting while girls' beds stood empty. Holding beds per hostel
    // spreads the reserve evenly and keeps the seat count equal to real capacity.
    ctx.pools = buildBedPools_(ctx, buffer);
    var allocatable = totalVacantBeds_(ctx.pools);

    var vertical = Policy.verticalReservations();
    var reserved = Util.largestRemainder(allocatable, vertical);
    var reservedTotal = Object.keys(reserved).reduce(function (s, k) { return s + reserved[k]; }, 0);
    var open = allocatable - reservedTotal;

    // PwD is HORIZONTAL: it is a minimum guarantee carved OUT of the pool, not
    // added on top of it. Carving it from the open share keeps
    // open + reserved + pwd == allocatable, so the engine can never hand out
    // more seats than there are beds.
    var pwdPct = Policy.value('reservation', 'PwD', 0);
    var pwdSeats = Math.min(Math.round(allocatable * pwdPct / 100), open);
    open -= pwdSeats;

    ctx.quotaPlan = {
      totalBeds: totalBeds,
      buffer: ctx.heldBack,
      allocatable: allocatable,
      open: open,
      reserved: reserved,
      reservedTotal: reservedTotal,
      pwdHorizontal: pwdSeats
    };
    ctx.seats = {
      open: open,
      quota: JSON.parse(JSON.stringify(reserved)),
      pwd: pwdSeats
    };
    return ctx.quotaPlan;
  }

  // ============================================ STAGE E: SERIAL DICTATORSHIP

  /**
   * In merit order, each applicant takes their best still-available ranked
   * preference. Strategy-proof (nobody gains by misreporting preferences) and
   * explainable in one sentence per student.
   */
  function stageE_serialDictatorship(ctx) {
    var pools = ctx.pools;          // built in stage D, with the buffer already held back
    ctx.accessibleDemand = ctx.pool.filter(function (c) { return c.needsAccessible; }).length;
    ctx.exhaustedAt = {};       // "hostel|roomType" -> merit position of whoever took the last bed
    var exhaustedAt = ctx.exhaustedAt;

    ctx.pool.forEach(function (c) {
      var bucket = claimSeat_(ctx, c);
      if (!bucket) {
        c.waitlisted = true;
        trace_(ctx, c.appId, reason('WAITLIST_NO_SEAT', false, waitlistText_(ctx, c),
          { category: c.category, openRemaining: ctx.seats.open }));
        return;
      }
      if (!placeCandidate_(ctx, c, pools, exhaustedAt, bucket)) {
        releaseSeat_(ctx, bucket);
        c.waitlisted = true;
        trace_(ctx, c.appId, reason('WAITLIST_NO_BED', false,
          'You qualified for a seat, but no room matching your requirements remained.'));
      }
    });

    ctx.converted = stageE2_convertUnfilledSeats(ctx, pools, exhaustedAt);
    return ctx.allocations.length;
  }

  /**
   * Walk one candidate's ranked preferences and seat them. Returns false if no
   * legal bed remains. Shared by the main pass and the conversion pass so the
   * two can never diverge.
   */
  function placeCandidate_(ctx, c, pools, exhaustedAt, bucket, pass) {
    pass = pass || 1;
    var taken = null;

    for (var i = 0; i < c.prefs.length; i++) {
      var p = c.prefs[i];
      var key = p.hostelId + '|' + p.roomType;
      var bed = takeBed_(ctx, pools, key, c, ctx.accessibleDemand);

      if (bed) { taken = { bed: bed, rank: p.rank }; break; }

      // Quote the fill position only when it precedes this student. In the
      // dereservation pass a waitlisted student is reconsidered after students
      // ranked below them have already been seated, so naming a later position
      // would read as an impossibility rather than an explanation.
      var filledAt = ctx.exhaustedAt[key] || null;
      var quotable = filledAt && filledAt <= c.meritPosition;
      trace_(ctx, c.appId, reason('PREF_UNAVAILABLE', false,
        'Preference ' + p.rank + ' (' + hostelName_(ctx, p.hostelId) + ', ' +
        roomTypeLabel_(p.roomType) + ') was already full' +
        (quotable ? ', filled at merit position ' + filledAt
                  : (pass === 2 ? ' when your application was reconsidered' : '')) + '.',
        { rank: p.rank, hostelId: p.hostelId, roomType: p.roomType,
          filledAtPosition: filledAt, pass: pass }));
    }

    // Fallback: house them anywhere legal rather than waitlist a student we
    // have a bed for. Utilisation is one of the stated problems.
    if (!taken) {
      var fb = takeAnyBed_(ctx, pools, c, ctx.accessibleDemand);
      if (fb) {
        taken = { bed: fb, rank: 0 };
        trace_(ctx, c.appId, reason('FALLBACK_ASSIGNED', true,
          'None of your ' + c.prefs.length + ' preferences were available. You were assigned ' +
          'the next available room you qualify for, rather than being waitlisted.',
          { prefsTried: c.prefs.length }));
      }
    }

    if (!taken) return false;

    if (c.needsAccessible) ctx.accessibleDemand--;

    c.waitlisted = false;
    c.quotaUsed = bucket;
    c.bedId = taken.bed.bedId;
    c.roomId = taken.bed.roomId;
    c.prefRankMet = taken.rank;

    var room = ctx.roomById[taken.bed.roomId];
    trace_(ctx, c.appId, seatReason_(ctx, c, bucket));
    if (taken.rank > 0) {
      trace_(ctx, c.appId, reason('PREF_MET', true,
        'Preference ' + taken.rank + ' granted: ' + hostelName_(ctx, room.hostelId) +
        ', ' + roomTypeLabel_(room.roomType) + '.',
        { rank: taken.rank, hostelId: room.hostelId, roomType: room.roomType }));
    }
    if (c.needsAccessible) {
      trace_(ctx, c.appId, reason('ACCESSIBLE_ENFORCED', true,
        'Accessible room requirement applied: you were placed in a ground-floor ' +
        'accessible room (' + room.roomNo + ').', { roomId: room.roomId }));
    }

    ctx.allocations.push({
      appId: c.appId, bedId: c.bedId, roomId: c.roomId,
      prefRankMet: c.prefRankMet, quotaUsed: bucket, candidate: c
    });
    return true;
  }

  // ================================================ STAGE E2: DERESERVATION

  /**
   * Convert unfilled reserved seats and offer them to the waiting list in merit
   * order.
   *
   * WITHOUT THIS STAGE the engine leaves beds empty while students wait: quotas
   * are sized as a percentage of capacity, but the applicant mix rarely matches
   * those percentages, so reserved seats in under-subscribed categories go
   * unused. On the demo cohort that wasted about 16% of the hostel.
   *
   * Converted seats are offered strictly in merit order, and the student is
   * told their seat came from conversion, so the audit trail stays honest.
   */
  function stageE2_convertUnfilledSeats(ctx, pools, exhaustedAt) {
    var waiting = ctx.pool.filter(function (c) { return c.waitlisted; });
    var converted = 0;

    for (var i = 0; i < waiting.length; i++) {
      var c = waiting[i];
      var src = takeLeftoverSeat_(ctx, c);
      if (!src) break;                       // no seats left in any pool

      var label = src.own ? src.bucket : 'CONVERTED';
      if (placeCandidate_(ctx, c, pools, exhaustedAt, label, 2)) {
        converted++;
        if (!src.own) {
          trace_(ctx, c.appId, reason('SEAT_CONVERTED', true,
            'Seats reserved for categories that received fewer applicants than reserved ' +
            'places were converted and offered to the waiting list in merit order. ' +
            'You received one of those converted seats at merit position ' + c.meritPosition + '.',
            { convertedFrom: src.bucket, position: c.meritPosition }));
        }
      } else {
        // This candidate has no legal bed - almost always because the remaining
        // vacancies are in the other gender's hostels. Release the seat and try
        // the next student rather than stopping: halting here would strand beds
        // while students wait, which is the inefficiency we exist to remove.
        //
        // Tell them WHY. Without this the top waitlisted student is only told
        // that open seats ran out, which is true but is no longer the binding
        // reason once conversion has run.
        releaseSeat_(ctx, src.bucket);
        trace_(ctx, c.appId, reason('WAITLIST_NO_BED_FOR_GENDER', false,
          'A seat was available for you when unfilled reserved seats were converted, ' +
          'but every room in the hostels you can be allotted to (' +
          openToText_(c) + ') was already occupied. The remaining vacancies are ' +
          'in hostels you are not eligible for.',
          { meritPosition: c.meritPosition, campus: c.campus, gender: c.gender }));
        if (totalVacantBeds_(pools) === 0) break;
      }
    }
    return converted;
  }

  function totalVacantBeds_(pools) {
    var n = 0;
    Object.keys(pools).forEach(function (k) {
      n += pools[k].normal.length + pools[k].accessible.length;
    });
    return n;
  }

  /**
   * Claim any remaining seat for a waitlisted candidate.
   * Preference order: open, then the candidate's own quota, then a dereserved
   * seat from another category.
   */
  function takeLeftoverSeat_(ctx, c) {
    if (ctx.seats.open > 0) { ctx.seats.open--; return { bucket: 'OPEN', own: true }; }
    if (c.isPwD && ctx.seats.pwd > 0) { ctx.seats.pwd--; return { bucket: 'PWD_HORIZONTAL', own: true }; }
    if (ctx.seats.quota[c.category] > 0) {
      ctx.seats.quota[c.category]--;
      return { bucket: c.category, own: true };
    }
    var cats = Object.keys(ctx.seats.quota).sort();
    for (var i = 0; i < cats.length; i++) {
      if (ctx.seats.quota[cats[i]] > 0) {
        ctx.seats.quota[cats[i]]--;
        return { bucket: cats[i], own: false };
      }
    }
    if (ctx.seats.pwd > 0) { ctx.seats.pwd--; return { bucket: 'PWD_HORIZONTAL', own: false }; }
    return null;
  }

  // --- stage E helpers ------------------------------------------------------

  /**
   * Build the allocatable bed pools, holding back `bufferPct` of each hostel's
   * beds for emergencies and mid-year transfers.
   *
   * Held beds are taken from ordinary stock first: shrinking the accessible
   * stock to fund a general-purpose reserve would push a wheelchair user onto
   * the waiting list to keep a spare room free, which is not a trade we make.
   */
  function buildBedPools_(ctx, bufferPct) {
    var byHostel = {};
    ctx.beds.forEach(function (b) {
      // OCCUPIED counts as available. A full run REALLOCATES everyone, so
      // occupancy is the OUTPUT of the previous run, not a constraint on this
      // one. Treating it as a constraint meant the second run of the day
      // allocated only the leftover buffer - and made every simulation baseline
      // wrong, since the simulator runs after a committed allocation.
      // BLOCKED and RESERVED beds are genuinely out of the pool.
      if (b.status === 'BLOCKED' || b.status === 'RESERVED') return;
      var room = ctx.roomById[b.roomId];
      if (!room || room.status !== 'ACTIVE') return;
      (byHostel[room.hostelId] = byHostel[room.hostelId] || []).push({ bed: b, room: room });
    });

    var pools = {};
    ctx.heldBack = 0;

    Object.keys(byHostel).sort().forEach(function (hostelId) {
      var entries = byHostel[hostelId];
      var hold = Math.floor(entries.length * (bufferPct || 0) / 100);

      // Deterministic ordering: ordinary beds last so they are held first.
      entries.sort(function (x, y) {
        if (x.room.isAccessible !== y.room.isAccessible) return x.room.isAccessible ? -1 : 1;
        return x.bed.bedId < y.bed.bedId ? -1 : 1;
      });

      var keep = entries.slice(0, Math.max(0, entries.length - hold));
      ctx.heldBack += entries.length - keep.length;

      keep.forEach(function (e) {
        var key = e.room.hostelId + '|' + e.room.roomType;
        if (!pools[key]) pools[key] = { normal: [], accessible: [] };
        (e.room.isAccessible ? pools[key].accessible : pools[key].normal).push(e.bed);
      });
    });

    // Within a pool, hand out ordinary beds in stable bedId order.
    Object.keys(pools).forEach(function (k) {
      pools[k].normal.sort(function (a, b) { return a.bedId < b.bedId ? -1 : 1; });
      pools[k].accessible.sort(function (a, b) { return a.bedId < b.bedId ? -1 : 1; });
    });
    return pools;
  }

  /**
   * May this candidate be housed in this hostel at all?
   *
   * The single chokepoint for both hard partitions. Every path that hands out a
   * bed - ranked preferences, the fallback sweep, the dereservation pass - goes
   * through here, so the two can never disagree about what is legal.
   */
  function hostelOk_(ctx, hostelId, candidate) {
    var h = ctx.hostels[hostelId];
    if (!h || !h.active) return false;
    if (h.gender !== 'CO' && h.gender !== candidate.gender) return false;
    if (candidate.campus && h.campus !== candidate.campus) return false;
    return true;
  }

  function totalAccessibleVacant_(pools) {
    var n = 0;
    Object.keys(pools).forEach(function (k) { n += pools[k].accessible.length; });
    return n;
  }

  /**
   * Take a bed from one (hostel, roomType) pool.
   * Accessible beds are protected: a student who does not need one may only take
   * an accessible bed while surplus accessible stock exists.
   */
  function takeBed_(ctx, pools, key, candidate, accessibleDemand) {
    var hostelId = key.split('|')[0];
    if (!hostelOk_(ctx, hostelId, candidate)) return null;
    var pool = pools[key];
    if (!pool) return null;

    var bed = null;
    if (candidate.needsAccessible) {
      bed = pool.accessible.length ? pool.accessible.shift() : null;
    } else if (pool.normal.length) {
      bed = pool.normal.shift();
    } else if (pool.accessible.length && totalAccessibleVacant_(pools) > accessibleDemand) {
      bed = pool.accessible.shift();
    }

    // Record exhaustion at the moment the LAST bed leaves, not when a later
    // student notices it is empty. "Filled at merit position N" has to name the
    // student who actually took the last bed, or it is not an explanation.
    if (bed && !pool.normal.length && !pool.accessible.length && !ctx.exhaustedAt[key]) {
      ctx.exhaustedAt[key] = candidate.meritPosition;
    }
    return bed;
  }

  function poolEmptyFor_(pools, key, candidate) {
    var pool = pools[key];
    if (!pool) return true;
    return candidate.needsAccessible
      ? pool.accessible.length === 0
      : (pool.normal.length === 0 && pool.accessible.length === 0);
  }

  /** Any legal bed, preferring smaller rooms. Used only after preferences fail. */
  function takeAnyBed_(ctx, pools, candidate, accessibleDemand) {
    var order = ['SINGLE', 'TRIPLE', 'QUAD'];
    var keys = Object.keys(pools).sort(function (a, b) {
      return order.indexOf(a.split('|')[1]) - order.indexOf(b.split('|')[1]);
    });
    for (var i = 0; i < keys.length; i++) {
      var bed = takeBed_(ctx, pools, keys[i], candidate, accessibleDemand);
      if (bed) return bed;
    }
    return null;
  }

  /** Decide which seat pool this candidate consumes, or null if none remain. */
  function claimSeat_(ctx, c) {
    if (ctx.seats.open > 0) { ctx.seats.open--; return 'OPEN'; }
    if (c.isPwD && ctx.seats.pwd > 0) { ctx.seats.pwd--; return 'PWD_HORIZONTAL'; }
    if (ctx.seats.quota[c.category] > 0) { ctx.seats.quota[c.category]--; return c.category; }
    return null;
  }

  function releaseSeat_(ctx, bucket) {
    if (bucket === 'OPEN') ctx.seats.open++;
    else if (bucket === 'PWD_HORIZONTAL') ctx.seats.pwd++;
    else if (ctx.seats.quota[bucket] !== undefined) ctx.seats.quota[bucket]++;
  }

  function seatReason_(ctx, c, bucket) {
    if (bucket === 'OPEN') {
      return reason('SEAT_OPEN', true,
        'Seat awarded on open merit' +
        (c.category !== 'GEN' ? ' — as a ' + c.category + ' candidate qualifying on open merit, ' +
         'your ' + c.category + ' reserved seat stays available for someone else' : '') + '.',
        { bucket: 'OPEN', category: c.category });
    }
    if (bucket === 'PWD_HORIZONTAL') {
      return reason('SEAT_PWD', true,
        'Seat awarded under the PwD horizontal reservation.', { bucket: bucket });
    }
    return reason('SEAT_QUOTA', true,
      'Open seats were exhausted before your merit position, so your seat was ' +
      'awarded under the ' + bucket + ' reserved quota.', { bucket: bucket, category: c.category });
  }

  function waitlistText_(ctx, c) {
    if (c.category === 'GEN') {
      return 'All open seats were taken before merit position ' + c.meritPosition +
             '. General-category applicants have no reserved pool to fall back on, ' +
             'so you were placed on the waiting list.';
    }
    return 'Open seats were exhausted, and the ' + c.category +
           ' reserved quota was also fully allocated before your merit position (' +
           c.meritPosition + '). You were placed on the waiting list.';
  }

  /**
   * Names the two hard partitions in the reader's own terms. A waitlisted
   * student told only that "no bed was available" learns nothing; told which
   * hostels were even open to them, they can check the reasoning themselves.
   */
  function openToText_(c) {
    var g = { M: "men's", F: "women's", O: '' }[c.gender] || '';
    var campus = { DWARKA: 'Dwarka Campus', EDC: 'East Delhi Campus' }[c.campus] || c.campus;
    return campus ? (g ? campus + ', ' + g + ' hostels' : campus) : (g + ' hostels');
  }

  function hostelName_(ctx, hostelId) {
    var h = ctx.hostels[hostelId];
    return h ? h.name : hostelId;
  }

  function roomTypeLabel_(rt) {
    return { SINGLE: 'single room', TRIPLE: '3-seater', QUAD: '4-seater' }[rt] || rt;
  }

  // ==================================================== STAGE F: LOCAL SEARCH

  /**
   * Search for Pareto-improving pairwise swaps - two students who would BOTH
   * rather have each other's room.
   *
   * Serial dictatorship is already Pareto-efficient over stated preferences, so
   * on a healthy run this finds ZERO swaps. That is the point: the count is
   * reported as a fairness metric and doubles as a proof obligation. A non-zero
   * count means someone got a fallback assignment that could be improved, which
   * is exactly the case worth fixing.
   */
  function stageF_localSearch(ctx) {
    if (String(Db.cfg('ALLOC_LOCAL_SEARCH', 'TRUE')).toUpperCase() === 'FALSE') return 0;
    var maxIter = Number(Db.cfg('ALLOC_MAX_ITERATIONS', 2000));

    var rankOf = {};   // appId -> { "hostel|roomType": rank }
    ctx.pool.forEach(function (c) {
      var m = {};
      c.prefs.forEach(function (p) { m[p.hostelId + '|' + p.roomType] = p.rank; });
      rankOf[c.appId] = m;
    });

    function rankFor(c, room) {
      var r = rankOf[c.appId][room.hostelId + '|' + room.roomType];
      return r || 99;             // unranked is worse than any ranked choice
    }

    var swaps = 0, iter = 0;
    var allocs = ctx.allocations;

    for (var i = 0; i < allocs.length && iter < maxIter; i++) {
      for (var j = i + 1; j < allocs.length && iter < maxIter; j++) {
        iter++;
        var A = allocs[i], B = allocs[j];
        var ca = A.candidate, cb = B.candidate;
        // A swap has to be legal for both students, and both partitions bind.
        if (ca.gender !== cb.gender) continue;
        if (ca.campus !== cb.campus) continue;

        var ra = ctx.roomById[A.roomId], rb = ctx.roomById[B.roomId];
        if (ca.needsAccessible && !rb.isAccessible) continue;
        if (cb.needsAccessible && !ra.isAccessible) continue;

        var beforeA = rankFor(ca, ra), beforeB = rankFor(cb, rb);
        var afterA  = rankFor(ca, rb), afterB  = rankFor(cb, ra);

        // Pareto: neither worse, at least one strictly better.
        if (afterA <= beforeA && afterB <= beforeB && (afterA < beforeA || afterB < beforeB)) {
          var tmpBed = A.bedId, tmpRoom = A.roomId;
          A.bedId = B.bedId; A.roomId = B.roomId;
          B.bedId = tmpBed;  B.roomId = tmpRoom;
          ca.bedId = A.bedId; ca.roomId = A.roomId;
          cb.bedId = B.bedId; cb.roomId = B.roomId;
          A.prefRankMet = afterA === 99 ? 0 : afterA;
          B.prefRankMet = afterB === 99 ? 0 : afterB;
          ca.prefRankMet = A.prefRankMet;
          cb.prefRankMet = B.prefRankMet;

          trace_(ctx, ca.appId, reason('PARETO_SWAP', true,
            'A mutually better room was found after the main allocation and applied — ' +
            'both you and the other student preferred the swap.', {}));
          trace_(ctx, cb.appId, reason('PARETO_SWAP', true,
            'A mutually better room was found after the main allocation and applied — ' +
            'both you and the other student preferred the swap.', {}));
          swaps++;
        }
      }
    }
    return swaps;
  }

  // ======================================================= STAGE G: ROOMMATES

  /**
   * Re-seat students WITHIN their already-decided (hostel, roomType) outcome to
   * maximise roommate compatibility. Nobody's preference rank changes, so this
   * cannot trade fairness for comfort.
   */
  function stageG_roommates(ctx) {
    var byBucket = {};
    ctx.allocations.forEach(function (a) {
      var room = ctx.roomById[a.roomId];
      var key = room.hostelId + '|' + room.roomType + '|' + (room.isAccessible ? 'ACC' : 'STD');
      (byBucket[key] = byBucket[key] || []).push(a);
    });

    Object.keys(byBucket).forEach(function (key) {
      var group = byBucket[key];
      var roomType = key.split('|')[1];
      var capacity = { SINGLE: 1, TRIPLE: 3, QUAD: 4 }[roomType];
      if (capacity <= 1 || group.length < 2) return;

      // Rooms currently in play, and the bed slots inside them.
      var roomsUsed = {};
      group.forEach(function (a) {
        var r = ctx.roomById[a.roomId];
        (roomsUsed[r.roomId] = roomsUsed[r.roomId] || []).push(a.bedId);
      });
      var roomIds = Object.keys(roomsUsed).sort();

      var appIds = group.map(function (a) { return a.appId; });
      var groups = Roommate.formGroups(appIds, capacity, ctx.lifestyle);

      var allocByApp = {};
      group.forEach(function (a) { allocByApp[a.appId] = a; });

      // Assign each compatibility group to a room, reusing the same bed slots.
      groups.forEach(function (members, gi) {
        var roomId = roomIds[gi];
        if (!roomId) return;
        var slots = roomsUsed[roomId].slice().sort();
        members.forEach(function (appId, mi) {
          if (!slots[mi]) return;
          var a = allocByApp[appId];
          a.roomId = roomId;
          a.bedId = slots[mi];
          a.candidate.roomId = roomId;
          a.candidate.bedId = slots[mi];
        });
        var cs = Roommate.groupScore(members, ctx.lifestyle);
        members.forEach(function (appId) {
          allocByApp[appId].compatScore = Util.round(cs, 3);
          var others = members.filter(function (x) { return x !== appId; });
          if (!others.length) return;
          trace_(ctx, appId, reason('ROOMMATE_MATCHED', true,
            'Roommate compatibility ' + (cs * 100).toFixed(0) + '% — you were placed with ' +
            others.length + ' student' + (others.length === 1 ? '' : 's') +
            ' whose lifestyle answers best matched yours among everyone assigned to this room type.',
            { compatScore: Util.round(cs, 3), roommates: others }));
        });
      });
    });

    ctx.allocations.forEach(function (a) {
      if (a.compatScore === undefined) a.compatScore = 1;
    });
    return ctx.allocations.length;
  }

  // ======================================================== STAGE H: WAITLIST

  function stageH_waitlist(ctx) {
    var churn = Policy.value('capacity', 'HISTORIC_CHURN_PCT', 8);
    var expectedVacancies = Math.round(ctx.quotaPlan.allocatable * churn / 100);

    var waiting = ctx.pool.filter(function (c) { return c.waitlisted; });
    waiting.forEach(function (c, i) {
      var position = i + 1;
      // Probability that enough students withdraw to reach this position.
      var p = Util.clamp(expectedVacancies / position, 0, 0.98);
      var topPref = c.prefs.length ? c.prefs[0].hostelId : '';

      ctx.waitlist.push({
        appId: c.appId,
        hostelId: topPref,
        position: position,
        etaProbability: Util.round(p, 3),
        candidate: c
      });

      trace_(ctx, c.appId, reason('WAITLIST_POSITION', true,
        'Waiting list position ' + position + ' of ' + waiting.length + '. Based on a historic ' +
        churn + '% withdrawal rate (about ' + expectedVacancies + ' seats expected to free up), ' +
        'your chance of being allotted is roughly ' + Math.round(p * 100) + '%.',
        { position: position, of: waiting.length, probability: Util.round(p, 3),
          expectedVacancies: expectedVacancies }));
    });
    return ctx.waitlist.length;
  }

  // ================================================================== COMMIT

  /** Persist a computed result to the database. This is the only writer. */
  /**
   * Undo a committed allocation, returning the database to the state it was in
   * before the run.
   *
   * Re-running already replaces the previous result, so this is not needed to
   * allocate again - it is needed to allocate again FROM NOTHING, with the beds
   * empty and every applicant back in the queue, which is what you want when
   * the inputs themselves have changed.
   *
   * What it clears, and why each one matters:
   *   - bed occupancy, or the next run sees phantom occupants
   *   - the allocations and the waiting list
   *   - every ALLOTTED or WAITLISTED application, back to SUBMITTED, along with
   *     the merit figure and priority group the old run stamped on it
   *   - the recorded letter for each allotment, because a letter for a seat
   *     nobody now holds is void, and leaving the link behind would make the
   *     next letter batch skip a student who needs one
   *
   * The run records in Runs are NOT deleted. They are the history of what was
   * decided and when, and a system that can quietly erase its own past
   * decisions is not one anybody should trust with them.
   */
  function clearCommitted(actor) {
    var beds = Db.readAll('Beds');
    var freed = 0;
    beds.forEach(function (b) {
      if (b.status === 'OCCUPIED' || b.occupantAppId) {
        b.status = 'VACANT';
        b.occupantAppId = '';
        freed++;
      }
    });
    Db.replaceAll('Beds', beds);

    var allocations = Db.readAll('Allocations').length;
    var waitlisted = Db.readAll('Waitlist').length;
    Db.replaceAll('Allocations', []);
    Db.replaceAll('Waitlist', []);

    var apps = Db.readAll('Applications');
    var reset = 0;
    apps.forEach(function (a) {
      if (a.status === 'ALLOTTED' || a.status === 'WAITLISTED') {
        a.status = 'SUBMITTED';
        reset++;
      }
      a.meritScore = 0;
      a.priorityTier = '';
    });
    Db.replaceAll('Applications', apps);

    Ledger.append('ALLOCATION_CLEARED', {
      bedsFreed: freed, allocationsRemoved: allocations,
      waitlistRemoved: waitlisted, applicationsReset: reset
    }, actor || 'system');

    return {
      bedsFreed: freed, allocationsRemoved: allocations,
      waitlistRemoved: waitlisted, applicationsReset: reset
    };
  }

  function commit(result) {
    var now = new Date();

    // Beds. Clear every previous occupancy FIRST: a committed run supersedes
    // the last one entirely, so a bed occupied by the old run but unused by this
    // one must be released. Without the reset, students who lost their seat in
    // the new run would leave a phantom occupant behind.
    var beds = Db.readAll('Beds');
    var bedIdx = {};
    beds.forEach(function (b) {
      if (b.status === 'OCCUPIED') { b.status = 'VACANT'; b.occupantAppId = ''; }
      bedIdx[b.bedId] = b;
    });
    result.allocations.forEach(function (a) {
      var b = bedIdx[a.bedId];
      if (b) { b.status = 'OCCUPIED'; b.occupantAppId = a.appId; }
    });
    Db.replaceAll('Beds', beds);

    // Allocations
    var rows = result.allocations.map(function (a, i) {
      return {
        allocId: 'ALC-' + result.runId + '-' + Util.pad(i + 1, 4),
        runId: result.runId,
        appId: a.appId,
        bedId: a.bedId,
        allocatedAt: now,
        prefRankMet: a.prefRankMet,
        quotaUsed: a.quotaUsed,
        reasonCodes: result.traces[a.appId] || [],
        compatScore: a.compatScore,
        status: 'ACTIVE'
      };
    });
    Db.replaceAll('Allocations', rows);

    // Waitlist
    Db.replaceAll('Waitlist', result.waitlist.map(function (w) {
      return {
        runId: result.runId, appId: w.appId, hostelId: w.hostelId,
        position: w.position, etaProbability: w.etaProbability,
        reasonCodes: result.traces[w.appId] || [], updatedAt: now
      };
    }));

    // Application statuses
    var allocated = {}, waitlisted = {};
    result.allocations.forEach(function (a) { allocated[a.appId] = true; });
    result.waitlist.forEach(function (w) { waitlisted[w.appId] = true; });
    // meritScore now carries the percentage the policy actually ranks on,
    // not a composite of weighted components. Alongside it goes the priority
    // group, because the percentage means nothing without knowing which queue
    // it was competing in.
    var scoreByApp = {}, tierByApp = {};
    result.allocations.concat(result.waitlist).forEach(function (x) {
      if (!x.candidate) return;
      scoreByApp[x.appId] = Util.round(Number(x.candidate.meritPercent) || 0, 2);
      tierByApp[x.appId] = x.candidate.tier || '';
    });

    var apps = Db.readAll('Applications');
    apps.forEach(function (a) {
      if (scoreByApp[a.appId] !== undefined) a.meritScore = scoreByApp[a.appId];
      if (tierByApp[a.appId] !== undefined) a.priorityTier = tierByApp[a.appId];
      if (allocated[a.appId]) a.status = 'ALLOTTED';
      else if (waitlisted[a.appId]) a.status = 'WAITLISTED';
      a.updatedAt = now;
    });
    Db.replaceAll('Applications', apps);

    // Run record
    Db.append('Runs', {
      runId: result.runId,
      mode: 'COMMITTED',
      seed: result.seed,
      policyHash: result.policyHash,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      triggeredBy: result.triggeredBy,
      metricsJson: result.metrics,
      notes: result.allocations.length + ' allotted, ' + result.waitlist.length + ' waitlisted'
    });

    Ledger.append('ALLOCATION_COMMITTED', {
      runId: result.runId,
      seed: result.seed,
      policyHash: result.policyHash,
      allocated: result.allocations.length,
      waitlisted: result.waitlist.length,
      rejected: result.rejected.length,
      metrics: result.metrics.summary
    }, result.triggeredBy);

    return rows.length;
  }

  return {
    run: run,
    runAndCommit: runAndCommit,
    commit: commit,
    clearCommitted: clearCommitted,
    // exposed for tests and the simulator
    _stages: {
      partition: stageA_partition, priority: stageB_priority, order: stageC_order,
      quota: stageD_quota, allocate: stageE_serialDictatorship,
      localSearch: stageF_localSearch, roommates: stageG_roommates,
      waitlist: stageH_waitlist
    }
  };
})();

/** Menu entry point. */
function runAllocationFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Run allocation',
    'This will allocate rooms and overwrite any previous committed allocation.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  var r = Allocator.runAndCommit({ triggeredBy: Session.getActiveUser().getEmail() || 'admin' });
  var m = r.metrics.summary;
  ui.alert('Allocation complete',
    'Run: ' + r.runId + '\n' +
    'Allotted: ' + m.allocated + '\nWaitlisted: ' + m.waitlisted + '\nRejected: ' + m.rejected + '\n\n' +
    'First preference met: ' + m.pref1Pct + '%\n' +
    'Mean preference granted: ' + m.meanPrefRank + '\n' +
    'Room utilisation: ' + m.utilisationPct + '%\n' +
    'Mean roommate compatibility: ' + m.meanCompatPct + '%\n\n' +
    'Took ' + r.elapsedSec + 's', ui.ButtonSet.OK);
}
