/**
 * Util.gs - shared helpers.
 *
 * The seeded RNG here is load-bearing, not a convenience. It is used both to
 * generate demo data AND by the allocator for deterministic tie-breaking, which
 * is what makes an allocation run exactly reproducible months later - see
 * PROJECT_CONTEXT.md section 4.3.
 */

var Util = (function () {

  /**
   * Deterministic PRNG (mulberry32 seeded by an xfnv1a hash of the string).
   * Same seed string always yields the same sequence, in Node and in Apps Script.
   */
  function rng(seedStr) {
    var h = 1779033703 ^ String(seedStr).length;
    for (var i = 0; i < String(seedStr).length; i++) {
      h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    var a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Stable 32-bit hash of a string, as a 0..1 float. Used for tie-breaks. */
  function hashUnit(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  /** Pick one item from a [[value, weight], ...] list. */
  function weighted(rand, pairs) {
    var total = pairs.reduce(function (s, p) { return s + p[1]; }, 0);
    var r = rand() * total;
    for (var i = 0; i < pairs.length; i++) {
      r -= pairs[i][1];
      if (r <= 0) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  }

  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

  function intBetween(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }

  /** Box-Muller normal sample, clamped to [lo, hi]. */
  function normal(rand, mean, sd, lo, hi) {
    var u = Math.max(rand(), 1e-9), v = Math.max(rand(), 1e-9);
    var z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return clamp(mean + z * sd, lo, hi);
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  function round(x, dp) {
    var f = Math.pow(10, dp || 0);
    return Math.round(x * f) / f;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** Fisher-Yates using the supplied RNG. Returns a new array. */
  function shuffle(rand, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Largest-remainder apportionment.
   * Distributes `total` seats across categories by percentage so the parts sum
   * EXACTLY to total. Plain rounding does not, and the resulting off-by-one is a
   * genuine source of quota disputes - see PROJECT_CONTEXT.md section 8 stage D.
   *
   * @param {number} total
   * @param {Object} pctByKey  e.g. { SC: 15, ST: 7.5, OBC: 27 }
   * @return {Object} integer seats per key, summing to total
   */
  function largestRemainder(total, pctByKey) {
    var keys = Object.keys(pctByKey);
    var exact = {}, floors = {}, out = {}, assigned = 0;

    keys.forEach(function (k) {
      exact[k] = total * (Number(pctByKey[k]) / 100);
      floors[k] = Math.floor(exact[k]);
      out[k] = floors[k];
      assigned += floors[k];
    });

    // The apportionment target is the RESERVED subtotal, not the whole pool.
    // Reservation percentages sum to well under 100 (the rest is open category),
    // so distributing `total - assigned` would hand every unreserved seat to a
    // quota. Only the fractional remainders get distributed.
    var sumPct = keys.reduce(function (s, k) { return s + Number(pctByKey[k]); }, 0);
    var target = Math.round(total * sumPct / 100);

    var remaining = target - assigned;
    if (remaining <= 0) return out;

    // Largest fractional remainder wins; ties broken by key name for determinism.
    var order = keys.slice().sort(function (a, b) {
      var fa = exact[a] - floors[a], fb = exact[b] - floors[b];
      if (fb !== fa) return fb - fa;
      return a < b ? -1 : 1;
    });
    for (var i = 0; i < remaining && i < order.length; i++) out[order[i]] += 1;

    // If percentages summed under 100 there may still be seats left over; they
    // stay unreserved (open category), which is the correct behaviour.
    return out;
  }

  /** Min-max normalise to 0..1. Returns 0.5 for a degenerate range. */
  function normalise(x, min, max) {
    if (max === min) return 0.5;
    return clamp((x - min) / (max - min), 0, 1);
  }

  return {
    rng: rng,
    hashUnit: hashUnit,
    weighted: weighted,
    pick: pick,
    intBetween: intBetween,
    normal: normal,
    clamp: clamp,
    round: round,
    pad: pad,
    shuffle: shuffle,
    largestRemainder: largestRemainder,
    normalise: normalise
  };
})();
