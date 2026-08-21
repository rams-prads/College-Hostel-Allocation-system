/**
 * Swap.gs - the mutual room-swap marketplace (novelty feature 4, second half).
 *
 * Students arrange their own swaps. The system validates the pair against
 * policy and, if every check passes, executes it immediately - no admin queue,
 * because there is nothing left for a human to decide once the rules are met.
 *
 * WHY A SWAP IS SAFE TO AUTO-APPROVE: a swap exchanges two students between two
 * beds. It cannot change the total number of seats, cannot change who holds
 * which quota entitlement (the quota attaches to the student, not the room), and
 * cannot admit anyone new. The only things it CAN break are the gender partition
 * and the accessibility guarantee, and both are checked explicitly below.
 */

var Swap = (function () {

  /** Current placement of an application, or null if not allotted. */
  function placement(appId) {
    var alloc = Db.findOne('Allocations', { appId: appId });
    if (!alloc || alloc.status !== 'ACTIVE') return null;
    var bed = Db.byId('Beds', alloc.bedId);
    var room = bed ? Db.byId('Rooms', bed.roomId) : null;
    var hostel = room ? Db.byId('Hostels', room.hostelId) : null;
    if (!bed || !room || !hostel) return null;
    return { alloc: alloc, bed: bed, room: room, hostel: hostel };
  }

  function studentOf(appId) {
    var app = Db.byId('Applications', appId);
    return app ? Db.byId('Students', app.studentId) : null;
  }

  /**
   * Validate a proposed swap. Returns every check, passed or failed, so a
   * rejection can be explained rather than just refused.
   */
  function validate(appIdA, appIdB) {
    var checks = [];
    function chk(name, ok, text) { checks.push({ name: name, ok: !!ok, text: text }); return !!ok; }

    if (appIdA === appIdB) {
      chk('DISTINCT', false, 'A student cannot swap with themselves.');
      return { ok: false, checks: checks };
    }

    var pa = placement(appIdA), pb = placement(appIdB);
    if (!pa || !pb) {
      chk('BOTH_ALLOTTED', false,
        'Both students must hold an active room allotment before they can swap.');
      return { ok: false, checks: checks };
    }
    chk('BOTH_ALLOTTED', true, 'Both students hold an active allotment.');

    var sa = studentOf(appIdA), sb = studentOf(appIdB);
    if (!sa || !sb) {
      chk('RECORDS', false, 'Student records could not be found for both parties.');
      return { ok: false, checks: checks };
    }

    if (pa.bed.bedId === pb.bed.bedId) {
      chk('DIFFERENT_BEDS', false, 'Both students are recorded in the same bed.');
      return { ok: false, checks: checks };
    }

    // Gender partition: the allocator's one hard constraint. A swap that moved a
    // student into the other gender's hostel would break it after the fact.
    var genderOk = (pb.hostel.gender === 'CO' || pb.hostel.gender === sa.gender) &&
                   (pa.hostel.gender === 'CO' || pa.hostel.gender === sb.gender);
    chk('GENDER', genderOk, genderOk
      ? 'Both hostels accept the incoming student.'
      : 'The swap would place a student in a hostel not open to their gender.');

    // Accessibility: a student who needs an accessible room must keep one, and
    // an accessible room must not be given up to someone who does not need it
    // while someone who does is waiting for one.
    var appA = Db.byId('Applications', appIdA), appB = Db.byId('Applications', appIdB);
    var needA = !!appA.needsAccessible, needB = !!appB.needsAccessible;
    var accOk = (!needA || pb.room.isAccessible) && (!needB || pa.room.isAccessible);
    chk('ACCESSIBILITY', accOk, accOk
      ? 'Accessibility requirements are preserved on both sides.'
      : 'The swap would move a student who needs an accessible room into one that is not.');

    var accStockOk = true;
    if (pa.room.isAccessible !== pb.room.isAccessible) {
      // One accessible room is being vacated by, or handed to, a student who
      // does not need it. Only allow it if nobody is waiting for accessible stock.
      var waitingAccessible = Db.readAll('Waitlist').filter(function (w) {
        var app = Db.byId('Applications', w.appId);
        return app && app.needsAccessible;
      }).length;
      accStockOk = waitingAccessible === 0 || (needA && needB);
      chk('ACCESSIBLE_STOCK', accStockOk, accStockOk
        ? 'No student is waiting for an accessible room, so the accessible stock may change hands.'
        : 'A student on the waiting list needs an accessible room, so accessible stock cannot be released.');
    }

    // Quota neutrality is structural rather than checked: the reserved seat
    // belongs to the student, not to the bed, so exchanging beds cannot alter
    // any category's count. Stated explicitly because it is the first thing a
    // reviewer asks about.
    chk('QUOTA_NEUTRAL', true,
      'Quota entitlements attach to the student, not the room, so a swap cannot change any category count.');

    var capacityOk = Number(pa.room.capacity) > 0 && Number(pb.room.capacity) > 0 &&
                     pa.room.status === 'ACTIVE' && pb.room.status === 'ACTIVE';
    chk('ROOMS_ACTIVE', capacityOk, capacityOk
      ? 'Both rooms are in service.'
      : 'One of the rooms is out of service.');

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks, a: pa, b: pb, studentA: sa, studentB: sb };
  }

  /** Post an open swap request. */
  function post(appId, opts) {
    opts = opts || {};
    var p = placement(appId);
    if (!p) throw new Error('You need an active room allotment before you can request a swap.');

    var existing = Db.readAll('Transfers').filter(function (t) {
      return t.appId === appId && t.type === 'SWAP' &&
             ['OPEN', 'MATCHED', 'CONSENTED'].indexOf(t.status) >= 0;
    });
    if (existing.length) throw new Error('You already have an open swap request.');

    var reqId = Db.nextId('SWP');
    Db.append('Transfers', {
      reqId: reqId, type: 'SWAP', appId: appId, counterpartAppId: '',
      targetHostelId: opts.targetHostelId || '',
      status: 'OPEN', policyCheck: [], reason: opts.reason || '',
      createdAt: new Date(), decidedAt: ''
    });
    Ledger.append('SWAP_POSTED', {
      reqId: reqId, appId: appId, from: p.room.roomId,
      wants: opts.targetHostelId || 'any'
    }, appId);
    return { reqId: reqId, status: 'OPEN' };
  }

  /**
   * Open requests that would be a legal swap for this student.
   * Only pairs that actually pass validation are shown, so a student is never
   * offered a match that will be refused.
   */
  function findMatches(appId) {
    var mine = placement(appId);
    if (!mine) return [];

    var open = Db.readAll('Transfers').filter(function (t) {
      return t.type === 'SWAP' && t.status === 'OPEN' && t.appId !== appId;
    });

    var out = [];
    open.forEach(function (t) {
      var v = validate(appId, t.appId);
      if (!v.ok) return;
      var theirs = placement(t.appId);
      var student = studentOf(t.appId);
      out.push({
        reqId: t.reqId,
        appId: t.appId,
        name: student ? student.name : '',
        programme: student ? student.programme : '',
        year: student ? student.year : '',
        hostelName: theirs.hostel.name,
        campus: theirs.hostel.campus,
        roomNo: theirs.room.roomNo,
        roomType: theirs.room.roomType,
        isAccessible: theirs.room.isAccessible,
        reason: t.reason,
        wantsToMoveTo: t.targetHostelId,
        compatibility: compatibilityWithNewRoom_(appId, theirs)
      });
    });
    return out;
  }

  /** How well this student would fit the roommates in the room being offered. */
  function compatibilityWithNewRoom_(appId, theirs) {
    var mine = Db.byId('Lifestyle', appId);
    if (!mine) return null;
    var others = Db.where('Beds', { roomId: theirs.room.roomId })
      .filter(function (b) { return b.occupantAppId && b.occupantAppId !== theirs.alloc.appId; });
    if (!others.length) return null;
    var sum = 0, n = 0;
    others.forEach(function (b) {
      var l = Db.byId('Lifestyle', b.occupantAppId);
      if (l) { sum += Roommate.score(mine, l).score; n++; }
    });
    return n ? Math.round(100 * sum / n) : null;
  }

  /**
   * Both sides agree. Validates and, if clean, executes immediately.
   * @param {string} reqId  the posted request being accepted
   * @param {string} appId  the student accepting it
   */
  function accept(reqId, appId) {
    var req = Db.byId('Transfers', reqId);
    if (!req) throw new Error('That swap request no longer exists.');
    if (req.status !== 'OPEN') throw new Error('That swap request is no longer open.');
    if (req.appId === appId) throw new Error('You cannot accept your own swap request.');

    var v = validate(req.appId, appId);
    Db.update('Transfers', reqId, {
      counterpartAppId: appId,
      status: v.ok ? 'CONSENTED' : 'REJECTED',
      policyCheck: v.checks,
      decidedAt: new Date()
    });

    if (!v.ok) {
      var failed = v.checks.filter(function (c) { return !c.ok; });
      Ledger.append('SWAP_REJECTED', {
        reqId: reqId, appId: req.appId, counterpartAppId: appId,
        failedChecks: failed.map(function (c) { return c.name; })
      }, appId);
      return { ok: false, reqId: reqId, checks: v.checks,
               message: failed.map(function (c) { return c.text; }).join(' ') };
    }

    var result = execute(reqId, appId);
    return { ok: true, reqId: reqId, checks: v.checks, swap: result };
  }

  /** Perform the exchange. Only called after validate() passes. */
  function execute(reqId, actor) {
    var req = Db.byId('Transfers', reqId);
    var appIdA = req.appId, appIdB = req.counterpartAppId;

    var v = validate(appIdA, appIdB);
    if (!v.ok) throw new Error('Swap validation failed at execution time.');

    var pa = v.a, pb = v.b;
    var now = new Date();

    // Beds
    Db.update('Beds', pa.bed.bedId, { occupantAppId: appIdB });
    Db.update('Beds', pb.bed.bedId, { occupantAppId: appIdA });

    // Allocations: preference rank no longer reflects the room, so it is
    // cleared rather than left as a stale claim about how the room was won.
    Db.update('Allocations', pa.alloc.allocId, {
      bedId: pb.bed.bedId, prefRankMet: 0, allocatedAt: now,
      reasonCodes: swapTrace_(pa, pb, appIdB, reqId)
    });
    Db.update('Allocations', pb.alloc.allocId, {
      bedId: pa.bed.bedId, prefRankMet: 0, allocatedAt: now,
      reasonCodes: swapTrace_(pb, pa, appIdA, reqId)
    });

    Db.update('Transfers', reqId, { status: 'APPROVED', decidedAt: now });

    Ledger.append('SWAP_APPROVED', {
      reqId: reqId,
      a: { appId: appIdA, from: pa.bed.bedId, to: pb.bed.bedId },
      b: { appId: appIdB, from: pb.bed.bedId, to: pa.bed.bedId },
      checks: v.checks.map(function (c) { return c.name; })
    }, actor || 'system');

    // Reissue letters so the QR on each student's letter resolves to the room
    // they are actually in. A stale letter would verify as genuine and send a
    // warden to the wrong door.
    var reissued = [];
    [pa.alloc.allocId, pb.alloc.allocId].forEach(function (id) {
      try { Letters.generate(id); reissued.push(id); }
      catch (e) { Logger.log('Letter reissue failed for ' + id + ': ' + e.message); }
    });

    return {
      reqId: reqId,
      a: { appId: appIdA, room: pb.room.roomNo, hostel: pb.hostel.name },
      b: { appId: appIdB, room: pa.room.roomNo, hostel: pa.hostel.name },
      lettersReissued: reissued.length
    };
  }

  function swapTrace_(mine, theirs, counterpartAppId, reqId) {
    var other = studentOf(counterpartAppId);
    return [
      reason('SWAP_EXECUTED', true,
        'You moved from room ' + mine.room.roomNo + ' to room ' + theirs.room.roomNo +
        ' in ' + theirs.hostel.name + ' through a mutually agreed swap with ' +
        (other ? other.name : 'another student') + '. Both sides consented and the ' +
        'swap was checked against hostel policy before it was applied.',
        { reqId: reqId, from: mine.room.roomId, to: theirs.room.roomId })
    ];
  }

  /** Withdraw an open request. */
  function cancel(reqId, appId) {
    var req = Db.byId('Transfers', reqId);
    if (!req) throw new Error('No such swap request.');
    if (req.appId !== appId) throw new Error('You can only cancel your own swap request.');
    if (req.status !== 'OPEN') throw new Error('Only an open request can be cancelled.');
    Db.update('Transfers', reqId, { status: 'CANCELLED', decidedAt: new Date() });
    Ledger.append('SWAP_CANCELLED', { reqId: reqId, appId: appId }, appId);
    return { ok: true };
  }

  /** Every open request, for the marketplace view. */
  function board(limit) {
    limit = limit || 50;
    return Db.readAll('Transfers')
      .filter(function (t) { return t.type === 'SWAP' && t.status === 'OPEN'; })
      .slice(0, limit)
      .map(function (t) {
        var p = placement(t.appId);
        var s = studentOf(t.appId);
        return {
          reqId: t.reqId, appId: t.appId,
          name: s ? s.name : '',
          hostelName: p ? p.hostel.name : '',
          roomNo: p ? p.room.roomNo : '',
          roomType: p ? p.room.roomType : '',
          reason: t.reason,
          createdAt: t.createdAt
        };
      });
  }

  return {
    post: post,
    findMatches: findMatches,
    accept: accept,
    cancel: cancel,
    validate: validate,
    execute: execute,
    board: board,
    placement: placement
  };
})();
