/**
 * Policy.gs - reads the Policy sheet and snapshots it.
 *
 * Policy is DATA, not code: the hostel office edits percentages and weights in
 * the sheet and the engine picks them up on the next run, with no deployment.
 *
 * snapshotHash() is what makes a run defensible months later - it pins the exact
 * rule set that produced an allocation, so re-running with the same seed and the
 * same policy hash reproduces the result byte for byte.
 */

var Policy = (function () {

  var _cache = null;
  var _override = null;      // in-memory only; never written to the sheet

  /**
   * Policy values are mostly numbers, but not all of them.
   *
   * Coercing everything with Number() turned the enrolment-number pattern into
   * NaN, which stringifies to "NaN", compiles to the regex /NaN/, and quietly
   * rejected every enrolment number in the university. A rule that is not a
   * number is kept as written.
   */
  function coerce_(v) {
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    return (s !== '' && isFinite(s)) ? Number(s) : v;
  }

  /** All active policy rows, grouped by category: {category: {key: value}}. */
  function load(fresh) {
    if (_cache && !fresh) return _cache;
    var out = { reservation: {}, eligibility: {}, weight: {}, capacity: {},
                roommate: {}, identity: {} };
    Db.readAll('Policy', { fresh: !!fresh }).forEach(function (r) {
      if (!r.active) return;
      if (!out[r.category]) out[r.category] = {};
      out[r.category][r.key] = coerce_(r.value);
    });

    // Simulation overlay. This is what makes a what-if run genuinely safe:
    // the modified values exist only in memory, so a simulation cannot leave
    // a trace in the sheet even if it throws halfway through.
    if (_override) {
      Object.keys(_override).forEach(function (cat) {
        if (!out[cat]) out[cat] = {};
        Object.keys(_override[cat]).forEach(function (k) {
          out[cat][k] = coerce_(_override[cat][k]);
        });
      });
    }

    _cache = out;
    return out;
  }

  function invalidate() { _cache = null; }

  /**
   * Apply a simulation overlay.
   * @param {Array<{category, key, value}>} changes
   */
  function setOverride(changes) {
    _override = {};
    (changes || []).forEach(function (c) {
      if (!_override[c.category]) _override[c.category] = {};
      _override[c.category][c.key] = coerce_(c.value);
    });
    invalidate();
    return _override;
  }

  function clearOverride() { _override = null; invalidate(); }
  function hasOverride() { return !!_override; }

  /** One value, with a fallback if the rule is missing or inactive. */
  function value(category, key, fallback) {
    var p = load();
    if (p[category] && p[category][key] !== undefined) return p[category][key];
    return fallback;
  }

  /** Vertical reservation percentages only (PwD is horizontal - see below). */
  function verticalReservations() {
    var res = load().reservation;
    var out = {};
    Object.keys(res).forEach(function (k) {
      if (k !== 'PwD') out[k] = res[k];
    });
    return out;
  }

  /** Scoring weights, normalised so they always sum to 1 even if mis-entered. */
  function weights() {
    var w = load().weight;
    var keys = ['W_MERIT', 'W_DISTANCE', 'W_YEAR', 'W_SPECIAL'];
    var sum = keys.reduce(function (s, k) { return s + (Number(w[k]) || 0); }, 0);
    var out = {};
    keys.forEach(function (k) {
      out[k] = sum > 0 ? (Number(w[k]) || 0) / sum : 0.25;
    });
    return out;
  }

  /** Roommate compatibility weights, likewise normalised. */
  function roommateWeights() {
    var w = load().roommate;
    var keys = ['W_SLEEP', 'W_STUDY', 'W_CLEAN', 'W_SOCIAL', 'W_FOOD', 'W_LANG'];
    var sum = keys.reduce(function (s, k) { return s + (Number(w[k]) || 0); }, 0);
    var out = {};
    keys.forEach(function (k) {
      out[k] = sum > 0 ? (Number(w[k]) || 0) / sum : 1 / keys.length;
    });
    return out;
  }

  /**
   * Stable hash of the active policy. Order-independent, so re-sorting the
   * sheet does not change the hash - only actual rule changes do.
   */
  function snapshotHash() {
    // Built from load(), NOT from the sheet, so a simulation overlay changes the
    // hash. A run must never report a policy hash that is not the policy that
    // actually produced it - that is the whole basis of reproducibility.
    var p = load();
    var rows = [];
    Object.keys(p).sort().forEach(function (cat) {
      Object.keys(p[cat]).sort().forEach(function (k) {
        rows.push([cat, k, Number(p[cat][k])].join(':'));
      });
    });
    return Ledger.sha256(rows.join('|')).substring(0, 16);
  }

  /** Human-readable summary for the audit trail and the admin dashboard. */
  function describe() {
    var p = load();
    return {
      reservation: p.reservation,
      eligibility: p.eligibility,
      weights: weights(),
      roommate: roommateWeights(),
      capacity: p.capacity,
      hash: snapshotHash()
    };
  }

  /**
   * Change a policy value for real, as opposed to overriding it for a
   * simulation.
   *
   * Policy has been readable from code and writable only by hand in the sheet.
   * That is right for reservation percentages, which nobody should change from
   * a web page - and wrong for the one setting an officer genuinely toggles
   * during a session, which is whether verification gates allocation at all.
   */
  function set(category, key, value, actor) {
    var rows = Db.readAll('Policy');
    var found = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].category === category && rows[i].key === key) { found = rows[i]; break; }
    }
    var before;
    if (found) {
      before = found.value;
      Db.update('Policy', found.ruleId, { value: String(value) });
    } else {
      // A rule the code reads but the sheet has never held. That happens on
      // any installation seeded before the rule existed, and refusing to write
      // it would leave the setting permanently stuck at its default with no way
      // to change it from anywhere.
      before = '';
      Db.append('Policy', {
        ruleId: 'POL-' + String(category).substring(0, 3).toUpperCase() + '-' +
                String(key).replace(/[^A-Za-z0-9]/g, '').substring(0, 12).toUpperCase(),
        category: category, key: key, value: String(value),
        effectiveFrom: new Date(), notes: 'Added when it was first changed.'
      });
    }
    Db.invalidate('Policy');
    invalidate();

    Ledger.append('POLICY_CHANGED', {
      ruleId: found ? found.ruleId : '(created)', category: category, key: key,
      from: String(before), to: String(value)
    }, actor || 'system');

    return { ok: true, from: before, to: value };
  }

  return {
    load: load,
    set: set,
    invalidate: invalidate,
    setOverride: setOverride,
    clearOverride: clearOverride,
    hasOverride: hasOverride,
    value: value,
    verticalReservations: verticalReservations,
    weights: weights,
    roommateWeights: roommateWeights,
    snapshotHash: snapshotHash,
    describe: describe
  };
})();
