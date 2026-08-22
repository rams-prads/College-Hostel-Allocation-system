/**
 * Grievance.gs - ticket handling with auto-triage.
 *
 * The valuable part is not the keyword classifier. It is that an allocation
 * dispute is AUDITED rather than answered: the system re-checks the student's
 * outcome against the recorded run and only then composes a reply.
 *
 * That distinction matters. Replaying the stored explanation back at a
 * complainant proves nothing - if the engine made a mistake, the explanation
 * would faithfully describe the mistake. So audit_() independently verifies:
 *
 *   - that nobody below them in merit took a seat they were entitled to
 *   - that the preferences they missed really were full at their position
 *   - that their own placement satisfies the hard constraints
 *
 * Only if every check holds is the ticket auto-answered. A failed check
 * escalates to a human WITH the anomaly named, which is exactly the case a
 * warden needs to see and would otherwise never find.
 *
 * This is the payoff of building explainability first: the two features compound.
 */

var Grievance = (function () {

  var KEYWORDS = [
    ['DOCUMENT', ['document', 'certificate', 'upload', 'verifi', 'scan', 'proof', 'admission letter', 'id card']],
    ['FEE',      ['fee', 'payment', 'refund', 'money', 'charge', 'paid', 'receipt']],
    ['ROOMMATE', ['roommate', 'room mate', 'roomie', 'partner', 'sharing with', 'my room mate']],
    ['FACILITY', ['water', 'electricity', 'wifi', 'internet', 'clean', 'maintenance', 'fan',
                  'washroom', 'toilet', 'bathroom', 'furniture', 'broken', 'leak', 'mess food']],
    ['ALLOCATION', ['allot', 'allocat', 'waitlist', 'waiting list', 'seat', 'merit', 'quota',
                    'reject', 'preference', 'room type', 'not fair', 'unfair', 'why did', 'rank']]
  ];

  /** Best-guess category from free text. */
  function classify(text) {
    var t = String(text || '').toLowerCase();
    var best = { category: 'OTHER', hits: 0 };
    KEYWORDS.forEach(function (pair) {
      var hits = pair[1].filter(function (k) { return t.indexOf(k) >= 0; }).length;
      if (hits > best.hits) best = { category: pair[0], hits: hits };
    });
    return best.category;
  }

  /** Raise a ticket and immediately attempt triage. */
  function raise(appId, text, actor) {
    if (!text || String(text).trim().length < 10) {
      throw new Error('Please describe the problem in a sentence or two.');
    }
    var app = Db.byId('Applications', appId);
    if (!app) throw new Error('No such application.');

    // A non-numeric or blank setting produced NaN here, and NaN days later
    // becomes an Invalid Date - which is written to the sheet as a value nothing
    // can read back, and which breaks the whole response when the inbox is read.
    var slaDays = Number(Db.cfg('GRIEVANCE_SLA_DAYS', 7));
    if (!isFinite(slaDays) || slaDays <= 0) slaDays = 7;
    var ticketId = Db.nextId('GRV');
    var now = new Date();

    Db.append('Grievances', {
      ticketId: ticketId, appId: appId,
      category: classify(text), text: String(text).trim(),
      autoTriage: null, status: 'OPEN', resolution: '',
      createdAt: now,
      slaDueAt: new Date(now.getTime() + slaDays * 24 * 3600 * 1000)
    });

    Ledger.append('GRIEVANCE_RAISED', {
      ticketId: ticketId, appId: appId, category: classify(text)
    }, actor || appId);

    return triage(ticketId);
  }

  /** Run triage on an existing ticket. */
  function triage(ticketId) {
    var t = Db.byId('Grievances', ticketId);
    if (!t) throw new Error('No such ticket.');

    var result;
    switch (t.category) {
      case 'ALLOCATION': result = triageAllocation_(t); break;
      case 'DOCUMENT':   result = triageDocument_(t);   break;
      case 'ROOMMATE':   result = triageRoommate_(t);   break;
      default:
        result = {
          status: 'ESCALATED',
          headline: 'Passed to the hostel office',
          body: 'This request needs a person to look at it. It has been passed to the ' +
                'hostel office and you will receive a response within the service window.',
          findings: []
        };
    }

    Db.update('Grievances', ticketId, {
      autoTriage: result,
      status: result.status,
      resolution: result.status === 'AUTO_ANSWERED' ? result.headline : ''
    });

    Ledger.append(result.status === 'AUTO_ANSWERED' ? 'GRIEVANCE_AUTO_ANSWERED'
                                                    : 'GRIEVANCE_ESCALATED', {
      ticketId: ticketId, category: t.category,
      anomalies: result.findings.filter(function (f) { return !f.ok; })
                                .map(function (f) { return f.check; })
    }, 'system');

    return Object.assign({ ticketId: ticketId, category: t.category }, result);
  }

  // ------------------------------------------------------ allocation disputes

  function triageAllocation_(t) {
    var audit = audit_(t.appId);

    if (!audit.findings.every(function (f) { return f.ok; })) {
      var bad = audit.findings.filter(function (f) { return !f.ok; });
      return {
        status: 'ESCALATED',
        headline: 'Escalated for review - a possible irregularity was found',
        body: 'The automatic check of your allocation did not come back clean. ' +
              'This has been escalated to the hostel office with the details below, ' +
              'and will be reviewed by a person.',
        findings: audit.findings,
        anomalies: bad.map(function (f) { return f.text; }),
        ledgerRef: audit.ledgerRef
      };
    }

    return {
      status: 'AUTO_ANSWERED',
      headline: audit.outcomeHeadline,
      body: audit.explanation,
      findings: audit.findings,
      ledgerRef: audit.ledgerRef,
      appealable: true
    };
  }

  /**
   * Independently re-verify one student's outcome against the recorded run.
   * Returns findings, not a verdict - the caller decides what to do with them.
   */
  function audit_(appId) {
    var findings = [];
    function f(check, ok, text) { findings.push({ check: check, ok: !!ok, text: text }); }

    var app = Db.byId('Applications', appId);
    var student = Db.byId('Students', app.studentId);
    var alloc = Db.findOne('Allocations', { appId: appId });
    var wait = Db.findOne('Waitlist', { appId: appId });
    var trace = readTrace_(alloc || wait);

    var meritEntry = trace.filter(function (r) { return r.code === 'MERIT_POSITION'; })[0];
    var position = meritEntry && meritEntry.detail ? meritEntry.detail.position : null;
    var score = Number(app.meritScore);

    var ledgerRef = null;
    var runEntry = Db.readAll('AuditLog').filter(function (e) {
      return e.action === 'ALLOCATION_COMMITTED';
    }).pop();
    if (runEntry) {
      ledgerRef = { seq: runEntry.seq, hash: String(runEntry.hash).substring(0, 12) };
    }

    // --- check 0: the ledger itself ---------------------------------------
    var chain = Ledger.verify();
    f('LEDGER_INTACT', chain.intact,
      chain.intact
        ? 'The audit log covering this allocation is intact and unmodified.'
        : 'The audit log has been modified since the allocation ran: ' + chain.reason);

    // --- not allocated at all ----------------------------------------------
    if (!alloc && !wait) {
      f('HAS_OUTCOME', app.status === 'REJECTED',
        app.status === 'REJECTED'
          ? 'Your application was found ineligible before allocation, so no room was assigned.'
          : 'No allocation record was found for your application, which should not happen.');
      return {
        findings: findings,
        ledgerRef: ledgerRef,
        outcomeHeadline: 'Your application was not eligible for allocation',
        explanation: (app.eligibilityNotes || []).join(' ') ||
                     'Your application did not meet the eligibility criteria.'
      };
    }

    // --- check 1: nobody below you took a seat you were entitled to ---------
    // The precise claim: among students who could have used the SAME BED - same
    // gender, same campus - none with a strictly lower merit score was allotted
    // while you were not. Comparing across a hard partition would raise false
    // alarms: a lower-ranked East Delhi student holding an East Delhi bed has
    // taken nothing from a Dwarka applicant, because that bed was never open to
    // them. Flagging it would bury the real irregularities this check exists for.
    if (wait && !alloc) {
      var apps = Db.indexBy('Applications', 'appId');
      var stu = Db.indexBy('Students', 'studentId');
      var overtaken = Db.readAll('Allocations').filter(function (a) {
        if (a.status !== 'ACTIVE') return false;
        var other = apps[a.appId];
        if (!other) return false;
        var os = stu[other.studentId];
        if (!os || os.gender !== student.gender) return false;
        if (os.campus !== student.campus) return false;
        if (Number(other.meritScore) >= score) return false;
        // A lower-scoring student may legitimately hold a seat through a
        // reserved quota this student had no claim to.
        var viaQuota = a.quotaUsed && a.quotaUsed !== 'OPEN' && a.quotaUsed !== 'CONVERTED';
        if (viaQuota && a.quotaUsed !== student.category) return false;
        return true;
      });

      f('MERIT_ORDER_HELD', overtaken.length === 0,
        overtaken.length === 0
          ? 'No student with a lower merit score was allotted a seat you were entitled to.'
          : overtaken.length + ' student(s) with a lower merit score hold a seat you appear to ' +
            'have been entitled to. This needs a human review.');
    }

    // --- check 2: the preferences you missed really were full ---------------
    if (position) {
      var missed = trace.filter(function (r) { return r.code === 'PREF_UNAVAILABLE'; });
      var suspicious = missed.filter(function (r) {
        if (!r.detail) return false;
        // Entries from the dereservation pass are exempt: a waitlisted student
        // is reconsidered after students ranked below them were already seated,
        // so a later fill position is expected there rather than suspicious.
        if (r.detail.pass === 2) return false;
        var at = r.detail.filledAtPosition;
        return at !== null && at !== undefined && at > position;
      });
      f('PREFERENCES_GENUINELY_FULL', suspicious.length === 0,
        suspicious.length === 0
          ? 'Every preference you missed was already full at the point your application was processed.'
          : 'A preference recorded as full appears to have filled AFTER your position in the ' +
            'merit order, which should not be possible.');
    }

    // --- check 3: your own placement is legal -------------------------------
    if (alloc) {
      var bed = Db.byId('Beds', alloc.bedId);
      var room = bed ? Db.byId('Rooms', bed.roomId) : null;
      var hostel = room ? Db.byId('Hostels', room.hostelId) : null;

      f('PLACEMENT_VALID', !!(bed && room && hostel),
        bed && room && hostel
          ? 'Your allotment points to a real room in a real hostel.'
          : 'Your allotment record is incomplete.');

      if (hostel) {
        var genderOk = hostel.gender === 'CO' || hostel.gender === student.gender;
        f('GENDER_CORRECT', genderOk, genderOk
          ? 'You were placed in a hostel open to your gender.'
          : 'You appear to be placed in a hostel not open to your gender.');

        var campusOk = !student.campus || hostel.campus === student.campus;
        f('CAMPUS_CORRECT', campusOk, campusOk
          ? 'You were placed in a hostel at the campus you are admitted to.'
          : 'You appear to be placed at a campus you are not admitted to.');
      }
      if (app.needsAccessible && room) {
        f('ACCESSIBILITY_HONOURED', room.isAccessible, room.isAccessible
          ? 'Your accessible-room requirement was honoured.'
          : 'You requested an accessible room but were not placed in one.');
      }

      var sharing = Db.readAll('Allocations').filter(function (a) {
        return a.status === 'ACTIVE' && a.bedId === alloc.bedId;
      });
      f('BED_NOT_SHARED', sharing.length === 1, sharing.length === 1
        ? 'Your bed is assigned to you alone.'
        : 'Your bed appears to be assigned to more than one student.');
    }

    // --- compose the reply --------------------------------------------------
    var headline, explanation;
    if (alloc) {
      headline = alloc.prefRankMet >= 1
        ? 'Your allotment matched preference ' + alloc.prefRankMet + ' and has been verified as correct'
        : 'Your allotment has been verified as correct';
      explanation = composeAllocated_(trace, position, alloc);
    } else {
      headline = 'Your waiting-list position has been verified as correct';
      explanation = composeWaitlisted_(trace, wait);
    }

    return {
      findings: findings, ledgerRef: ledgerRef,
      outcomeHeadline: headline, explanation: explanation
    };
  }

  function composeAllocated_(trace, position, alloc) {
    var parts = [];
    var seat = trace.filter(function (r) { return r.code.indexOf('SEAT_') === 0; })[0];
    if (position) parts.push('You were ranked ' + position + ' in the merit order.');
    if (seat) parts.push(seat.text);
    var met = trace.filter(function (r) { return r.code === 'PREF_MET'; })[0];
    if (met) parts.push(met.text);
    var missed = trace.filter(function (r) { return r.code === 'PREF_UNAVAILABLE'; });
    if (missed.length) {
      parts.push('Preferences you did not receive were already full: ' +
        missed.map(function (m) { return m.text.replace(/\.$/, ''); }).join('; ') + '.');
    }
    parts.push('We re-checked this outcome against the recorded allocation run and it is correct.');
    return parts.join(' ');
  }

  function composeWaitlisted_(trace, wait) {
    var parts = [];
    trace.filter(function (r) { return r.code.indexOf('WAITLIST') === 0; })
         .forEach(function (r) { parts.push(r.text); });
    if (wait) {
      parts.push('You are currently at position ' + wait.position + ' with an estimated ' +
        Math.round(Number(wait.etaProbability) * 100) + '% chance of being allotted if students withdraw.');
    }
    parts.push('We re-checked the merit order and confirmed that no student below you was ' +
               'allotted a seat you were entitled to.');
    return parts.join(' ');
  }

  function readTrace_(row) {
    if (!row) return [];
    var t = row.reasonCodes;
    if (typeof t === 'string') {
      try { t = JSON.parse(t); } catch (e) { return []; }
    }
    return t || [];
  }

  // ------------------------------------------------------- other categories

  function triageDocument_(t) {
    var app = Db.byId('Applications', t.appId);
    var student = app ? Db.byId('Students', app.studentId) : null;
    if (!student) {
      return { status: 'ESCALATED', headline: 'Passed to the hostel office',
               body: 'Your record could not be read automatically.', findings: [] };
    }

    var docs = Documents.statusFor(t.appId, student);
    var problems = docs.filter(function (d) {
      return d.status === 'REJECTED' || d.status === 'REQUIRED';
    });

    if (!problems.length) {
      return {
        status: 'AUTO_ANSWERED',
        headline: 'All your documents are in order',
        body: 'Every document required for your application has been received and verified: ' +
              docs.map(function (d) { return d.label; }).join(', ') + '. ' +
              'No further action is needed from you.',
        findings: [{ check: 'DOCS_COMPLETE', ok: true, text: 'All required documents verified.' }]
      };
    }

    return {
      status: 'AUTO_ANSWERED',
      headline: problems.length + ' document(s) still need your attention',
      body: problems.map(function (d) {
        return d.label + ' - ' + (d.status === 'REJECTED'
          ? 'rejected at verification' + (d.note ? ' (' + d.note + ')' : '') + '. Please upload a replacement.'
          : 'not yet uploaded.');
      }).join(' ') + ' You can upload these from the portal.',
      findings: [{ check: 'DOCS_INCOMPLETE', ok: true,
                   text: problems.length + ' document(s) outstanding.' }]
    };
  }

  function triageRoommate_(t) {
    var alloc = Db.findOne('Allocations', { appId: t.appId });
    if (!alloc || alloc.status !== 'ACTIVE') {
      return { status: 'ESCALATED', headline: 'Passed to the hostel office',
               body: 'You do not currently hold a room allotment.', findings: [] };
    }
    var score = Math.round(Number(alloc.compatScore) * 100);
    var openRequests = Swap.board(50).length;

    return {
      status: 'AUTO_ANSWERED',
      headline: 'You can arrange a room swap yourself',
      body: 'Your recorded roommate compatibility for this room is ' + score + '%. ' +
            'Rather than waiting for an administrative transfer, you can post a swap request ' +
            'on the portal. There ' + (openRequests === 1 ? 'is' : 'are') + ' currently ' +
            openRequests + ' open request' + (openRequests === 1 ? '' : 's') + '. ' +
            'Swaps that both students agree to and that pass the hostel rules are approved ' +
            'automatically, with no waiting. If you would rather a warden intervened, reply to ' +
            'this ticket and it will be escalated.',
      findings: [{ check: 'SWAP_AVAILABLE', ok: true,
                   text: 'Self-service swap is available to this student.' }]
    };
  }

  // ---------------------------------------------------------------- admin

  /** Escalate a ticket to a human, keeping the automatic findings attached. */
  function escalate(ticketId, note, actor) {
    var t = Db.byId('Grievances', ticketId);
    if (!t) throw new Error('No such ticket.');
    Db.update('Grievances', ticketId, {
      status: 'ESCALATED',
      resolution: note || ''
    });
    Ledger.append('GRIEVANCE_ESCALATED', { ticketId: ticketId, note: note || '' },
      actor || 'system');
    return { ok: true };
  }

  /** Close a ticket with a written resolution. */
  function resolve(ticketId, resolution, actor) {
    var t = Db.byId('Grievances', ticketId);
    if (!t) throw new Error('No such ticket.');
    Db.update('Grievances', ticketId, { status: 'RESOLVED', resolution: resolution || '' });
    Ledger.append('GRIEVANCE_RESOLVED', {
      ticketId: ticketId, resolution: resolution || ''
    }, actor || 'admin');
    return { ok: true };
  }

  /** The grievance inbox. */
  function inbox(filter, limit) {
    limit = limit || 50;
    var apps = Db.indexBy('Applications', 'appId');
    var stu = Db.indexBy('Students', 'studentId');

    return Db.readAll('Grievances')
      .filter(function (g) { return !filter || g.status === filter; })
      .slice(0, limit)
      .map(function (g) {
        var app = apps[g.appId];
        var student = app ? stu[app.studentId] : null;
        var triageData = typeof g.autoTriage === 'string'
          ? (function () { try { return JSON.parse(g.autoTriage); } catch (e) { return null; } })()
          : g.autoTriage;
        return {
          ticketId: g.ticketId, appId: g.appId,
          name: student ? student.name : '',
          enrollmentNo: student ? student.enrollmentNo : '',
          category: g.category, status: g.status,
          text: g.text,
          headline: triageData ? triageData.headline : '',
          anomalies: triageData && triageData.anomalies ? triageData.anomalies : [],
          // Formatted here rather than handed over as Date objects. Every other
          // endpoint in the project returns dates as strings, and a Date that
          // failed to parse serialises as null - which took the entire payload
          // with it and left the admin dashboard with nothing to render.
          resolution: g.resolution || '',
          createdAt: fmtWhen_(g.createdAt), slaDueAt: fmtWhen_(g.slaDueAt)
        };
      });
  }

  /** A date the client can display, or '' - never an unparseable object. */
  function fmtWhen_(d) {
    if (!d) return '';
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    try {
      return Utilities.formatDate(dt, 'Asia/Kolkata', 'd MMM yyyy');
    } catch (e) {
      return '';
    }
  }

  function stats() {
    var all = Db.readAll('Grievances');
    var byStatus = {}, byCategory = {};
    all.forEach(function (g) {
      byStatus[g.status] = (byStatus[g.status] || 0) + 1;
      byCategory[g.category] = (byCategory[g.category] || 0) + 1;
    });
    var auto = byStatus.AUTO_ANSWERED || 0;
    return {
      total: all.length, byStatus: byStatus, byCategory: byCategory,
      autoResolvedPct: all.length ? Math.round(100 * auto / all.length) : 0
    };
  }

  return {
    classify: classify,
    raise: raise,
    triage: triage,
    escalate: escalate,
    resolve: resolve,
    inbox: inbox,
    stats: stats,
    _audit: audit_
  };
})();
