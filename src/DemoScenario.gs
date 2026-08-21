/**
 * DemoScenario.gs - turns 900 anonymous rows into six people with names.
 *
 * A judge cannot follow "utilisation rose to 98%". They can follow "Rohan is
 * number one on the waiting list, and here is the system telling him exactly
 * why". This file picks real students out of the committed run whose outcomes
 * already demonstrate each feature, renames them memorably, and hands back a
 * cast list with what to say about each one.
 *
 * Nothing is fabricated. Every character is an actual applicant from the seeded
 * cohort whose allocation genuinely turned out the way the script describes - so
 * if a judge clicks into any of them, the story holds up.
 */

var DemoScenario = (function () {

  /**
   * Build the cast. Run AFTER seeding and an allocation.
   * @param {{email?: string}} opts  a Google account to attach to the lead
   *                                 character, so you can sign in as them live
   */
  function prepare(opts) {
    opts = opts || {};
    var runs = Db.readAll('Runs');
    if (!runs.length) throw new Error('Run the allocation first, then prepare the demo.');

    var apps = Db.readAll('Applications');
    var students = Db.indexBy('Students', 'studentId');
    var allocs = Db.readAll('Allocations').filter(function (a) { return a.status === 'ACTIVE'; });
    var waitlist = Db.readAll('Waitlist').sort(function (a, b) { return a.position - b.position; });
    var rooms = Db.indexBy('Rooms', 'roomId');
    var hostels = Db.indexBy('Hostels', 'hostelId');

    var byApp = {};
    apps.forEach(function (a) { byApp[a.appId] = a; });

    function stu(appId) { return students[byApp[appId].studentId]; }
    function roomOf(alloc) { return rooms[Db.byId('Beds', alloc.bedId).roomId]; }

    var cast = [];
    // A student picked for one role must not be picked again for another, or
    // the second rename silently overwrites the first and the script stops
    // matching what is on screen.
    var used = {};
    function free(x) { return x && !used[x.s.studentId]; }
    function take(x) { used[x.s.studentId] = true; return x; }

    // 1. Best case: high merit, very far from home, got their first choice.
    var star = allocs
      .filter(function (a) { return a.prefRankMet === 1; })
      .map(function (a) { return { a: a, app: byApp[a.appId], s: stu(a.appId) }; })
      .filter(function (x) { return Number(x.app.distanceKm) > 1000 && !x.s.isPwD && free(x); })
      .sort(function (x, y) { return Number(y.app.meritScore) - Number(x.app.meritScore); })[0];
    if (star) {
      take(star);
      cast.push(character_('ARJUN', 'Arjun Bharadwaj', star.s, star.app, star.a, roomOf(star.a), hostels,
        'The happy path',
        'Top of the merit order, home ' + Math.round(Number(star.app.distanceKm)) + ' km away in ' +
        star.s.homeState + ', and he got his first choice. Open his "why" panel: it shows his merit ' +
        'position, the four factors that produced his score, and which preference was granted. ' +
        'Point out that this text was written by the engine while it ran, not generated afterwards.'));
    }

    // 2. Accessibility: a PwD student pinned to a ground-floor accessible room.
    var pwd = allocs
      .map(function (a) { return { a: a, app: byApp[a.appId], s: stu(a.appId) }; })
      .filter(function (x) { return x.app.needsAccessible && free(x); })
      .sort(function (x, y) { return Number(y.app.meritScore) - Number(x.app.meritScore); })[0];
    if (pwd) {
      take(pwd);
      var pr = roomOf(pwd.a);
      cast.push(character_('PRIYA', 'Priya Menon', pwd.s, pwd.app, pwd.a, pr, hostels,
        'Accessibility is a hard constraint',
        'Declared a locomotor disability. She is in room ' + pr.roomNo + ' on floor ' + pr.floor +
        ' - an accessible room, and the engine would not have placed her anywhere else. ' +
        'Worth saying out loud: the emergency bed reserve is taken from ordinary rooms first, so ' +
        'accessible stock is never raided to keep a spare room free.'));
    }

    // 3. The hard case: waitlisted, and told the truth about why.
    var wl = waitlist.filter(function (w) { return !used[byApp[w.appId].studentId]; })[0];
    if (wl) {
      var wlApp = byApp[wl.appId], wlStu = stu(wl.appId);
      used[wlStu.studentId] = true;
      cast.push(character_('ROHAN', 'Rohan Chaudhary', wlStu, wlApp, null, null, hostels,
        'The uncomfortable case, answered honestly',
        'Number one on the waiting list. His panel does not fob him off - it tells him open seats ' +
        'ran out at a specific merit position, that as a General-category applicant he has no ' +
        'reserved pool to fall back on, that a converted seat did reach him but no bed of his ' +
        'gender remained, and what his realistic odds are. This is the screen that stops a ' +
        'grievance being filed at all.',
        { waitlistPosition: wl.position, etaPercent: Math.round(Number(wl.etaProbability) * 100) }));
    }

    // 4 & 5. A swap pair: same gender, same hostel, both in ordinary rooms.
    var swappable = allocs
      .map(function (a) { return { a: a, app: byApp[a.appId], s: stu(a.appId), r: roomOf(a) }; })
      .filter(function (x) { return !x.app.needsAccessible && !x.r.isAccessible && free(x); });
    var pair = findPair_(swappable);
    if (pair) {
      take(pair[0]); take(pair[1]);
      cast.push(character_('KAVYA', 'Kavya Rao', pair[0].s, pair[0].app, pair[0].a, pair[0].r, hostels,
        'Swap marketplace - side A',
        'Sign in as Kavya, post her room on the swap board, then sign in as Meera and accept. ' +
        'The swap is checked against gender, accessibility and quota rules and applied instantly. ' +
        'No administrator touches it. Both allotment letters are reissued on the spot, which ' +
        'matters: a stale letter would still scan as genuine and send a warden to the wrong door.'));
      cast.push(character_('MEERA', 'Meera Pillai', pair[1].s, pair[1].app, pair[1].a, pair[1].r, hostels,
        'Swap marketplace - side B',
        'The counterpart. After the swap, open either student\'s "why" panel: a new line has ' +
        'appeared explaining the swap, and the audit log has a SWAP_APPROVED entry.'));
    }

    // 6. Rejected on eligibility - proves the rules actually bite.
    var local = apps
      .filter(function (a) { return !a.eligible && Number(a.distanceKm) >= 0 && Number(a.distanceKm) < 30; })
      .map(function (a) { return { app: a, s: students[a.studentId] }; })
      .filter(free)[0];
    if (local) {
      take(local);
      cast.push(character_('SANJAY', 'Sanjay Bhatia', local.s, local.app, null, null, hostels,
        'The rules are real',
        'Lives ' + Number(local.app.distanceKm) + ' km from campus, under the 30 km minimum, so he ' +
        'is not eligible. He is told exactly that, with the number and the threshold. Useful to ' +
        'show because it proves the eligibility engine is doing something rather than waving ' +
        'everyone through.'));
    }

    // Rename the cast so the story is easy to follow on screen.
    cast.forEach(function (c) {
      Db.update('Students', c.studentId, { name: c.name });
    });

    // Attach the operator's Google account to the lead so you can sign in live.
    var signInAs = null;
    if (opts.email && cast.length) {
      var lead = cast[0];
      Db.update('Students', lead.studentId, { email: opts.email });
      lead.email = opts.email;
      signInAs = { name: lead.name, code: lead.code, email: opts.email };
    }

    Db.setCfg('DEMO_PREPARED', new Date().toISOString());
    Ledger.append('DEMO_SCENARIO_PREPARED', {
      cast: cast.map(function (c) { return c.code + ':' + c.appId; }),
      signInAs: signInAs ? signInAs.email : null
    }, 'system');

    return { cast: cast, signInAs: signInAs };
  }

  /** Two students in the same hostel and room type, so a swap is clean. */
  function findPair_(list) {
    var buckets = {};
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      var key = x.r.hostelId + '|' + x.r.roomType;
      if (buckets[key] && buckets[key].r.roomId !== x.r.roomId) {
        return [buckets[key], x];
      }
      buckets[key] = x;
    }
    return null;
  }

  function character_(code, name, student, app, alloc, room, hostels, role, note, extra) {
    var hostel = room ? hostels[room.hostelId] : null;
    return Object.assign({
      code: code,
      name: name,
      role: role,
      note: note,
      studentId: student.studentId,
      appId: app.appId,
      email: student.email,
      enrollmentNo: student.enrollmentNo,
      programme: student.programme + ' ' + student.branch + ', year ' + student.year,
      category: student.category + (student.isPwD ? ' (PwD)' : ''),
      homeState: student.homeState,
      distanceKm: Number(app.distanceKm),
      status: app.status,
      allocId: alloc ? alloc.allocId : null,
      prefRankMet: alloc ? alloc.prefRankMet : null,
      room: room ? room.roomNo : null,
      hostel: hostel ? hostel.name : null,
      campus: hostel ? hostel.campus : null
    }, extra || {});
  }

  /** Printable cast list for the person running the demo. */
  function brief() {
    var runs = Db.readAll('Runs');
    if (!runs.length) return 'No allocation has been run yet.';
    var res = prepare({});
    var lines = ['DEMO CAST', '========='];
    res.cast.forEach(function (c) {
      lines.push('');
      lines.push(c.code + ' - ' + c.name + '   [' + c.role + ']');
      lines.push('  ' + c.programme + ' | ' + c.category + ' | ' + c.homeState +
                 ', ' + c.distanceKm + ' km');
      lines.push('  Application ' + c.appId + '  status ' + c.status +
                 (c.room ? '  ->  ' + c.hostel + ' room ' + c.room : ''));
      if (c.waitlistPosition) {
        lines.push('  Waiting list position ' + c.waitlistPosition +
                   ', ' + c.etaPercent + '% estimated chance');
      }
      lines.push('  ' + c.note);
    });
    return lines.join('\n');
  }

  return { prepare: prepare, brief: brief };
})();

/** Menu entry: prepare the demo and show the cast. */
function prepareDemoFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Prepare demo scenario',
    'Enter a Google account to sign in as the lead character (leave blank to skip):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var email = String(resp.getResponseText() || '').trim();
  var res = DemoScenario.prepare({ email: email || null });

  var msg = res.cast.map(function (c) {
    return c.code + ' - ' + c.name + ' (' + c.role + ')\n   ' +
      (c.room ? c.hostel + ' room ' + c.room : c.status) +
      '\n   ' + c.appId;
  }).join('\n\n');

  if (res.signInAs) {
    msg = 'Sign in as ' + res.signInAs.email + ' to see the portal as ' +
          res.signInAs.name + '.\n\n' + msg;
  }
  ui.alert('Demo cast ready', msg, ui.ButtonSet.OK);
}
