/**
 * Simulator.gs - what-if policy analysis (novelty feature 3).
 *
 * An administrator changes a quota percentage or a scoring weight and sees the
 * resulting allocation, INCLUDING WHO MOVES, before committing anything.
 *
 * Two design decisions make the answer trustworthy:
 *
 *   1. Baseline and candidate are BOTH computed fresh from the same seed, with
 *      only the policy differing. Diffing against the stored committed run would
 *      confuse a policy effect with any data that changed since that run.
 *
 *   2. The modified policy exists only in memory (Policy.setOverride). A
 *      simulation cannot leave a mark in the sheet even if it throws halfway.
 *
 * Nothing is written until commit() is called explicitly.
 */

var Simulator = (function () {

  /**
   * Run a what-if analysis.
   * @param {{changes: Array<{category,key,value}>, seed?: string}} opts
   */
  function simulate(opts) {
    opts = opts || {};
    var changes = opts.changes || [];
    if (!changes.length) throw new Error('Simulator: no policy changes supplied.');

    var seed = opts.seed || ('GGSIPU-' + Db.cfg('ACADEMIC_YEAR', '2026'));
    var t0 = new Date().getTime();

    // Record the current values so the UI can show "from -> to".
    Policy.clearOverride();
    var current = Policy.load(true);
    var annotated = changes.map(function (c) {
      var from = (current[c.category] || {})[c.key];
      return {
        category: c.category, key: c.key,
        from: from === undefined ? null : from,
        to: Number(c.value)
      };
    });

    var baseline, candidate;
    try {
      baseline = Allocator.run({ seed: seed, runId: 'SIM-BASE' });
      Policy.setOverride(changes);
      candidate = Allocator.run({ seed: seed, runId: 'SIM-CAND' });
    } finally {
      // Always clear, even if the allocator threw. A stuck override would
      // silently poison every later run in this execution.
      Policy.clearOverride();
    }

    var diff = compare(baseline, candidate);

    return {
      seed: seed,
      changes: annotated,
      before: baseline.metrics.summary,
      after: candidate.metrics.summary,
      deltas: deltas(baseline.metrics.summary, candidate.metrics.summary),
      movement: diff.movement,
      sample: diff.sample,
      quotaBefore: baseline.metrics.quotaTable,
      quotaAfter: candidate.metrics.quotaTable,
      policyHashBefore: baseline.policyHash,
      policyHashAfter: candidate.policyHash,
      elapsedSec: Util.round((new Date().getTime() - t0) / 1000, 2)
    };
  }

  /** Numeric deltas between two metric summaries. */
  function deltas(before, after) {
    var out = {};
    Object.keys(after).forEach(function (k) {
      if (typeof after[k] === 'number' && typeof before[k] === 'number') {
        out[k] = Util.round(after[k] - before[k], 2);
      }
    });
    return out;
  }

  /**
   * Who moved, and how. This is the part an administrator actually acts on:
   * a percentage change is abstract, "these fourteen students lose their seat"
   * is not.
   */
  function compare(baseline, candidate) {
    var rooms = Db.indexBy('Rooms', 'roomId');
    var hostels = Db.indexBy('Hostels', 'hostelId');
    var apps = Db.indexBy('Applications', 'appId');
    var students = Db.indexBy('Students', 'studentId');

    function placeOf(alloc) {
      var room = rooms[alloc.roomId];
      var hostel = room ? hostels[room.hostelId] : null;
      return {
        hostelId: room ? room.hostelId : '',
        hostelName: hostel ? hostel.name : '',
        roomNo: room ? room.roomNo : '',
        roomType: room ? room.roomType : '',
        prefRankMet: alloc.prefRankMet
      };
    }

    var beforeMap = {}, afterMap = {};
    baseline.allocations.forEach(function (a) { beforeMap[a.appId] = a; });
    candidate.allocations.forEach(function (a) { afterMap[a.appId] = a; });

    var gained = [], lost = [], moved = [], unchanged = 0;

    Object.keys(afterMap).forEach(function (appId) {
      var a = afterMap[appId], b = beforeMap[appId];
      if (!b) { gained.push(appId); return; }
      if (a.bedId !== b.bedId) moved.push(appId); else unchanged++;
    });
    Object.keys(beforeMap).forEach(function (appId) {
      if (!afterMap[appId]) lost.push(appId);
    });

    function describe(appId, kind) {
      var app = apps[appId];
      var student = app ? students[app.studentId] : null;
      var b = beforeMap[appId], a = afterMap[appId];
      return {
        appId: appId,
        name: student ? student.name : '',
        category: student ? student.category : '',
        gender: student ? student.gender : '',
        change: kind,
        from: b ? placeOf(b) : null,
        to: a ? placeOf(a) : null
      };
    }

    // A readable sample rather than 700 rows: the cases that matter most are
    // the ones who gain or lose a seat entirely.
    var sample = []
      .concat(lost.slice(0, 8).map(function (id) { return describe(id, 'LOST'); }))
      .concat(gained.slice(0, 8).map(function (id) { return describe(id, 'GAINED'); }))
      .concat(moved.slice(0, 6).map(function (id) { return describe(id, 'MOVED'); }));

    return {
      movement: {
        gained: gained.length,
        lost: lost.length,
        moved: moved.length,
        unchanged: unchanged,
        totalAffected: gained.length + lost.length + moved.length
      },
      sample: sample,
      ids: { gained: gained, lost: lost, moved: moved }
    };
  }

  /**
   * Accept a simulation: write the policy changes to the sheet, then run and
   * commit for real. The committed run is a fresh allocation, not the simulated
   * object, so what is committed is always produced by the policy now on record.
   */
  function commit(changes, actor, seed) {
    if (!changes || !changes.length) throw new Error('Simulator: nothing to commit.');

    var rows = Db.readAll('Policy');
    var applied = [];

    changes.forEach(function (c) {
      var match = rows.filter(function (r) {
        return r.category === c.category && r.key === c.key && r.active;
      })[0];
      if (match) {
        applied.push({ ruleId: match.ruleId, category: c.category, key: c.key,
                       from: Number(match.value), to: Number(c.value) });
        Db.update('Policy', match.ruleId, { value: Number(c.value) });
      } else {
        var ruleId = 'POL-' + String(c.category).toUpperCase().slice(0, 3) + '-' +
                     String(c.key).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        Db.append('Policy', {
          ruleId: ruleId, category: c.category, key: c.key, value: Number(c.value),
          effectiveFrom: new Date(), active: true, notes: 'Added via simulator'
        });
        applied.push({ ruleId: ruleId, category: c.category, key: c.key,
                       from: null, to: Number(c.value) });
      }
    });

    Policy.clearOverride();
    Policy.invalidate();

    Ledger.append('POLICY_CHANGED', { changes: applied }, actor || 'admin');

    var result = Allocator.runAndCommit({
      seed: seed || ('GGSIPU-' + Db.cfg('ACADEMIC_YEAR', '2026')),
      triggeredBy: actor || 'admin'
    });

    return {
      applied: applied,
      runId: result.runId,
      policyHash: result.policyHash,
      metrics: result.metrics.summary
    };
  }

  /**
   * Discard a simulation. There is nothing to undo - the override was never
   * written - but clearing explicitly keeps the intent obvious at the call site
   * and guards against a stuck overlay.
   */
  function discard() {
    Policy.clearOverride();
    return { ok: true, discarded: true };
  }

  /** The policy knobs the dashboard offers, with sensible bounds. */
  function knobs() {
    var p = Policy.load(true);
    var out = [];
    function add(category, key, label, min, max, step, help) {
      out.push({
        category: category, key: key, label: label,
        value: (p[category] || {})[key],
        min: min, max: max, step: step, help: help
      });
    }
    add('reservation', 'SC',  'SC reservation %',  0, 50, 0.5, 'Vertical reservation for Scheduled Caste applicants.');
    add('reservation', 'ST',  'ST reservation %',  0, 50, 0.5, 'Vertical reservation for Scheduled Tribe applicants.');
    add('reservation', 'OBC', 'OBC reservation %', 0, 50, 0.5, 'Vertical reservation for Other Backward Classes.');
    add('reservation', 'EWS', 'EWS reservation %', 0, 50, 0.5, 'Vertical reservation for Economically Weaker Section.');
    add('reservation', 'PwD', 'PwD reservation %', 0, 20, 0.5, 'Horizontal minimum, carved out of the open share.');
    add('weight', 'W_MERIT',    'Weight: academic merit',    0, 1, 0.05, 'How much CGPA drives the merit score.');
    add('weight', 'W_DISTANCE', 'Weight: distance from home',0, 1, 0.05, 'How much living far away drives the merit score.');
    add('weight', 'W_YEAR',     'Weight: seniority',         0, 1, 0.05, 'How much year of study drives the merit score.');
    add('weight', 'W_SPECIAL',  'Weight: special need',      0, 1, 0.05, 'How much a declared special need drives the score.');
    add('eligibility', 'MIN_DISTANCE_KM', 'Minimum distance (km)', 0, 200, 5, 'Applicants living nearer than this are not eligible.');
    add('eligibility', 'MIN_CGPA',        'Minimum CGPA',          0, 10, 0.25, 'Academic floor for hostel eligibility.');
    add('capacity', 'VACANCY_BUFFER_PCT', 'Vacancy buffer %',      0, 20, 1, 'Beds held back per hostel for emergencies and transfers.');
    return out.filter(function (k) { return k.value !== undefined; });
  }

  return {
    simulate: simulate,
    commit: commit,
    discard: discard,
    compare: compare,
    knobs: knobs
  };
})();
