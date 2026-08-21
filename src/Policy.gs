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

  /** All active policy rows, grouped by category: {category: {key: value}}. */
  function load(fresh) {
    if (_cache && !fresh) return _cache;
    var out = { reservation: {}, eligibility: {}, weight: {}, capacity: {}, roommate: {} };
    Db.readAll('Policy', { fresh: !!fresh }).forEach(function (r) {
      if (!r.active) return;
      if (!out[r.category]) out[r.category] = {};
      out[r.category][r.key] = Number(r.value);
    });
    _cache = out;
    return out;
  }

  function invalidate() { _cache = null; }

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
    var rows = Db.readAll('Policy')
      .filter(function (r) { return r.active; })
      .map(function (r) { return [r.category, r.key, Number(r.value)].join(':'); })
      .sort();
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

  return {
    load: load,
    invalidate: invalidate,
    value: value,
    verticalReservations: verticalReservations,
    weights: weights,
    roommateWeights: roommateWeights,
    snapshotHash: snapshotHash,
    describe: describe
  };
})();
