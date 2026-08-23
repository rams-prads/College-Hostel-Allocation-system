/**
 * Vacancy.gs - a bed that comes free goes to the next person entitled to it.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ALLOCATOR
 * --------------------------------------------
 * The allocator answers "who gets the 264 beds?" and it answers it for
 * everybody at once. Re-running it is the only way it can react to a single
 * withdrawal - and re-running re-decides every applicant, including the ones
 * already holding a printed letter with a room number on it. That is not a
 * thing to do because one student went home.
 *
 * This answers a much smaller question: "one specific bed is empty - who is
 * the next person allowed to have THAT bed?" It seats exactly one applicant
 * and touches nobody else's allotment.
 *
 * WHAT "ENTITLED TO IT" MEANS
 * --------------------------
 * The waiting list is already in the order the policy produced: priority group
 * first, then marks or distance within it. So the answer is the person nearest
 * the top of that list who could actually live in this bed - which is not
 * simply the person at position 1, because a bed is in a particular hostel:
 *
 *   - the hostel is single-gender, and campus is a hard partition;
 *   - somebody who needs an accessible room cannot take a room that is not one;
 *   - single rooms are reserved for PG and PhD students by the brochure.
 *
 * Skipping somebody is therefore never a judgement about them. It is that the
 * bed on offer is one they were never eligible for, and the trace written onto
 * the promotion says which of the four reasons applied.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not re-rank, re-open quotas, or reconsider anybody already seated.
 * The quota was apportioned by the run; a bed released afterwards is filled
 * from the queue in queue order, which is what the office does with a key when
 * somebody hands it back.
 */

var Vacancy = (function () {

  /**
   * Fill one bed from the waiting list.
   *
   * @param {string} bedId
   * @param {string=} actor
   * @return {{filled:boolean, appId:?string, allocId:?string, reason:string,
   *           skipped:number}}
   */
  function fill(bedId, actor) {
    var bed = Db.byId('Beds', bedId);
    if (!bed) return no_('No such bed.');
    if (bed.status !== 'VACANT' || bed.occupantAppId) {
      return no_('That bed is not free.');
    }

    var room = Db.byId('Rooms', bed.roomId);
    var hostel = room ? Db.byId('Hostels', room.hostelId) : null;
    if (!room || !hostel) return no_('That bed does not belong to a room on record.');

    var queue = Db.readAll('Waitlist').slice()
      .sort(function (a, b) { return Number(a.position) - Number(b.position); });
    if (!queue.length) return no_('Nobody is on the waiting list.');

    var apps = Db.indexBy('Applications', 'appId');
    var stu = Db.indexBy('Students', 'studentId');
    var skipped = 0;

    for (var i = 0; i < queue.length; i++) {
      var w = queue[i];
      var app = apps[w.appId];
      var student = app ? stu[app.studentId] : null;
      if (!app || !student) { skipped++; continue; }

      // Somebody who withdrew, was cancelled, or has since been seated by a
      // fresh run is not waiting any more, whatever the row says.
      if (app.status !== 'WAITLISTED') { skipped++; continue; }

      var why = ineligibleFor_(bed, room, hostel, app, student);
      if (why) { skipped++; continue; }

      var seated = seat_(w, app, student, bed, room, hostel, i, skipped, actor);
      return {
        filled: true, appId: app.appId, allocId: seated.allocId,
        studentName: student.name, position: Number(w.position),
        roomNo: room.roomNo, hostelName: hostel.name,
        reason: '', skipped: skipped
      };
    }

    return {
      filled: false, appId: null, allocId: null, skipped: skipped,
      reason: 'Nobody on the waiting list can be housed in this bed. It is in ' +
              hostel.name + ' (' + genderWord_(hostel.gender) + ', ' +
              Geo.campusName(hostel.campus) + '), a ' + room.roomType.toLowerCase() +
              ' room, and every waiting applicant is barred from it by gender, ' +
              'campus, accessibility or the postgraduate rule on single rooms.'
    };
  }

  /**
   * Every vacant bed, in one pass, for the times a batch of rooms is released
   * at once. Bounded, because this writes and Apps Script has six minutes.
   */
  function fillAll(limit, actor) {
    limit = Math.min(Math.max(Number(limit) || 25, 1), 200);

    var free = Db.readAll('Beds').filter(function (b) {
      return b.status === 'VACANT' && !b.occupantAppId;
    });

    var filled = [], examined = 0;
    for (var i = 0; i < free.length && filled.length < limit; i++) {
      examined++;
      var r = fill(free[i].bedId, actor);
      if (r.filled) filled.push(r);
    }

    return {
      filled: filled.length,
      examined: examined,
      vacantBefore: free.length,
      // What is left after this pass, so a caller knows whether to run again.
      vacantAfter: Db.readAll('Beds', { fresh: true }).filter(function (b) {
        return b.status === 'VACANT' && !b.occupantAppId;
      }).length,
      details: filled
    };
  }

  // ------------------------------------------------------------- eligibility

  /** Why this applicant cannot have this bed, or '' if they can. */
  function ineligibleFor_(bed, room, hostel, app, student) {
    if (hostel.gender !== 'CO' && hostel.gender !== student.gender) return 'GENDER';
    if (student.campus && hostel.campus !== student.campus) return 'CAMPUS';
    if (app.needsAccessible && !room.isAccessible) return 'ACCESSIBILITY';

    if (room.roomType === 'SINGLE') {
      var pgOnly = Number(Policy.value('capacity', 'SINGLE_ROOM_PG_ONLY', 1));
      if (pgOnly) {
        var isPg = false;
        try { isPg = Catalogue.isPgOrPhd(student.programme, student.year); } catch (e) { isPg = false; }
        if (!isPg) return 'SINGLE_ROOM_PG_ONLY';
      }
    }
    return '';
  }

  function genderWord_(g) {
    return { M: "men's", F: "women's", CO: 'co-educational' }[g] || g;
  }

  // ------------------------------------------------------------------ seating

  function seat_(w, app, student, bed, room, hostel, index, skipped, actor) {
    var now = new Date();
    var allocId = 'ALC-PROMO-' + app.appId + '-' + now.getTime();

    // The promotion joins the run that produced the waiting list, so the
    // letter generator and the notifier pick it up with everybody else rather
    // than needing a special case.
    var runId = w.runId || '';

    // The trace IS the explanation the student reads. It has to say what
    // happened, not merely that something did.
    var trace = [
      { code: 'WAITLIST_PROMOTED',
        text: 'A place came free after the allocation ran, and you were the ' +
              'highest-placed applicant on the waiting list who could be housed in it. ' +
              'You were at position ' + w.position + '.',
        detail: { fromPosition: Number(w.position), bedId: bed.bedId,
                  passedOver: skipped } },
      { code: 'SEAT_FROM_VACANCY',
        text: 'Room ' + room.roomNo + ' in ' + hostel.name + ' (' +
              room.roomType.toLowerCase() + ') was released and reassigned to you.',
        detail: { roomNo: room.roomNo, hostelId: hostel.hostelId,
                  roomType: room.roomType } }
    ];

    // Anyone this bed was not open to is named in the trace, because "why did
    // number three get it when I am number two?" is the question a promotion
    // always produces, and it deserves an answer already written down.
    if (skipped) {
      trace.push({
        code: 'VACANCY_ELIGIBILITY',
        text: skipped + ' applicant' + (skipped === 1 ? '' : 's') + ' ahead of you on ' +
              'the list could not be housed in this particular bed - it is in a ' +
              genderWord_(hostel.gender) + ' hostel at ' + Geo.campusName(hostel.campus) +
              ', and single rooms are kept for postgraduate students.',
        detail: { passedOver: skipped }
      });
    }

    Db.append('Allocations', {
      allocId: allocId, runId: runId, appId: app.appId, bedId: bed.bedId,
      allocatedAt: now, prefRankMet: prefRankFor_(app.appId, hostel.hostelId, room.roomType),
      quotaUsed: 'VACANCY', reasonCodes: trace, compatScore: 0,
      status: 'ACTIVE', letterUrl: '', letterAt: ''
    });

    Db.update('Beds', bed.bedId, { status: 'OCCUPIED', occupantAppId: app.appId });
    Db.update('Applications', app.appId, { status: 'ALLOTTED', updatedAt: now });

    // Off the list, and the rest close up behind them. Leaving a hole would
    // make position 2 permanently absent from a list people read as a queue.
    var rest = Db.readAll('Waitlist').filter(function (r) { return r.appId !== w.appId; })
      .sort(function (a, b) { return Number(a.position) - Number(b.position); });
    rest.forEach(function (r, i) { r.position = i + 1; });
    Db.replaceAll('Waitlist', rest);

    Db.invalidate('Allocations');
    Db.invalidate('Beds');
    Db.invalidate('Applications');

    Ledger.append('WAITLIST_PROMOTED', {
      appId: app.appId, allocId: allocId, bedId: bed.bedId,
      fromPosition: Number(w.position), passedOver: skipped, runId: runId
    }, actor || 'system');

    return { allocId: allocId };
  }

  /** Which of their ranked preferences this bed satisfies, or 0 for none. */
  function prefRankFor_(appId, hostelId, roomType) {
    var prefs = Db.rowsWhere('Preferences', 'appId', appId);
    for (var i = 0; i < prefs.length; i++) {
      if (prefs[i].hostelId === hostelId && prefs[i].roomType === roomType) {
        return Number(prefs[i].rank) || 0;
      }
    }
    return 0;
  }

  function no_(reason) {
    return { filled: false, appId: null, allocId: null, reason: reason, skipped: 0 };
  }

  return {
    fill: fill,
    fillAll: fillAll,
    _ineligibleFor: ineligibleFor_
  };
})();
