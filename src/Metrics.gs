/**
 * Metrics.gs - fairness and efficiency measures for an allocation run.
 *
 * These are not decoration. They are the evidence base a warden uses to answer
 * a grievance, and the numbers the what-if simulator diffs when a policy
 * changes. Every metric is computed from the run result, never from live state,
 * so a draft run can be measured without touching the database.
 */

var Metrics = (function () {

  /**
   * Gini coefficient of a value distribution. 0 = everyone equal.
   *
   * READ THIS BEFORE QUOTING IT: a merit-based allocation is INTENTIONALLY
   * unequal, so a low Gini is not automatically "good". It is useful as a
   * comparison between runs - if a policy change raises the Gini sharply, the
   * benefit has concentrated on fewer students, which is worth knowing.
   */
  function gini(values) {
    if (!values.length) return 0;
    var xs = values.slice().sort(function (a, b) { return a - b; });
    var n = xs.length;
    var sum = xs.reduce(function (s, x) { return s + x; }, 0);
    if (sum === 0) return 0;
    var weighted = 0;
    for (var i = 0; i < n; i++) weighted += (i + 1) * xs[i];
    return Util.clamp((2 * weighted) / (n * sum) - (n + 1) / n, 0, 1);
  }

  /** Preference satisfaction in [0,1]: rank 1 scores 1, a fallback scores 0. */
  function satisfaction(prefRankMet, maxPrefs) {
    if (!prefRankMet || prefRankMet < 1) return 0;
    return (maxPrefs - prefRankMet + 1) / maxPrefs;
  }

  function compute(result, ctx) {
    var maxPrefs = ctx.maxPrefs || 5;
    var allocs = result.allocations;
    var n = allocs.length;

    // --- preference satisfaction -------------------------------------------
    var rankCounts = {};
    var satisfactions = [];
    var rankSum = 0, ranked = 0;
    allocs.forEach(function (a) {
      var r = a.prefRankMet || 0;
      rankCounts[r] = (rankCounts[r] || 0) + 1;
      satisfactions.push(satisfaction(r, maxPrefs));
      if (r >= 1) { rankSum += r; ranked++; }
    });

    var pref1 = rankCounts[1] || 0;
    var fallback = rankCounts[0] || 0;

    // Waitlisted students count as zero satisfaction - excluding them would
    // flatter the numbers by measuring only the winners.
    var allEligibleSat = satisfactions.concat(
      result.waitlist.map(function () { return 0; })
    );

    // --- quota compliance ---------------------------------------------------
    var byQuota = {};
    allocs.forEach(function (a) {
      byQuota[a.quotaUsed] = (byQuota[a.quotaUsed] || 0) + 1;
    });

    // "unfilled" here does NOT mean a wasted seat. Seats a category could not
    // fill are dereserved and reissued to the waiting list in merit order, and
    // land in the CONVERTED row below. Reporting the shortfall without that row
    // would make the engine look like it strands seats when it does not.
    var quotaTable = [];
    var plan = result.quota;
    Object.keys(plan.reserved).forEach(function (cat) {
      quotaTable.push({
        category: cat,
        reservedSeats: plan.reserved[cat],
        filled: byQuota[cat] || 0,
        unfilled: plan.reserved[cat] - (byQuota[cat] || 0)
      });
    });
    quotaTable.push({
      category: 'OPEN', reservedSeats: plan.open,
      filled: byQuota.OPEN || 0, unfilled: plan.open - (byQuota.OPEN || 0)
    });
    quotaTable.push({
      category: 'PwD (horizontal)', reservedSeats: plan.pwdHorizontal,
      filled: byQuota.PWD_HORIZONTAL || 0,
      unfilled: plan.pwdHorizontal - (byQuota.PWD_HORIZONTAL || 0)
    });
    quotaTable.push({
      category: 'CONVERTED', reservedSeats: 0,
      filled: byQuota.CONVERTED || 0, unfilled: 0,
      note: 'unfilled reserved seats reissued to the waiting list in merit order'
    });

    // Who actually got seats, by social category - distinct from which pool
    // they consumed, and the number a transparency report should show.
    var byCategory = {};
    allocs.forEach(function (a) {
      var cat = a.candidate.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    // --- accessibility -------------------------------------------------------
    var accessibleNeeded = 0, accessibleHonoured = 0;
    allocs.forEach(function (a) {
      if (!a.candidate.needsAccessible) return;
      accessibleNeeded++;
      var room = ctx.roomById[a.roomId];
      if (room && room.isAccessible) accessibleHonoured++;
    });
    var accessibleWaitlisted = result.waitlist.filter(function (w) {
      return w.candidate.needsAccessible;
    }).length;

    // --- roommate compatibility ---------------------------------------------
    var compats = allocs
      .filter(function (a) { return a.compatScore !== undefined && a.compatScore < 1; })
      .map(function (a) { return a.compatScore; });
    var meanCompat = compats.length
      ? compats.reduce(function (s, x) { return s + x; }, 0) / compats.length
      : 1;

    // --- utilisation ---------------------------------------------------------
    var totalBeds = plan.totalBeds;
    var utilisation = totalBeds ? n / totalBeds : 0;

    // --- gender breakdown ----------------------------------------------------
    var byGender = { M: { allocated: 0, waitlisted: 0 }, F: { allocated: 0, waitlisted: 0 } };
    allocs.forEach(function (a) {
      var g = a.candidate.gender;
      if (byGender[g]) byGender[g].allocated++;
    });
    result.waitlist.forEach(function (w) {
      var g = w.candidate.gender;
      if (byGender[g]) byGender[g].waitlisted++;
    });

    var summary = {
      allocated: n,
      waitlisted: result.waitlist.length,
      rejected: result.rejected.length,
      pref1Pct: n ? Util.round(100 * pref1 / n, 1) : 0,
      fallbackPct: n ? Util.round(100 * fallback / n, 1) : 0,
      meanPrefRank: ranked ? Util.round(rankSum / ranked, 2) : 0,
      utilisationPct: Util.round(100 * utilisation, 1),
      meanCompatPct: Util.round(100 * meanCompat, 1),
      paretoSwaps: result.paretoSwaps,
      giniSatisfaction: Util.round(gini(allEligibleSat), 3),
      accessibilityHonouredPct: accessibleNeeded
        ? Util.round(100 * accessibleHonoured / accessibleNeeded, 1) : 100
    };

    return {
      summary: summary,
      prefRankDistribution: rankCounts,
      quotaTable: quotaTable,
      allocatedByCategory: byCategory,
      byGender: byGender,
      accessibility: {
        needed: accessibleNeeded,
        honoured: accessibleHonoured,
        waitlisted: accessibleWaitlisted
      },
      capacity: {
        totalBeds: plan.totalBeds,
        allocatable: plan.allocatable,
        buffer: plan.buffer,
        occupied: n,
        vacant: plan.totalBeds - n
      },
      policyHash: result.policyHash,
      seed: result.seed
    };
  }

  /** Console-friendly report, also used by the admin dashboard. */
  function format(metrics) {
    var s = metrics.summary;
    var lines = [];
    lines.push('Allotted ' + s.allocated + ' | Waitlisted ' + s.waitlisted + ' | Rejected ' + s.rejected);
    lines.push('First preference met: ' + s.pref1Pct + '%   Fallback assignments: ' + s.fallbackPct + '%');
    lines.push('Mean preference granted: ' + s.meanPrefRank);
    lines.push('Room utilisation: ' + s.utilisationPct + '%');
    lines.push('Mean roommate compatibility: ' + s.meanCompatPct + '%');
    lines.push('Accessibility requirements honoured: ' + s.accessibilityHonouredPct + '%');
    lines.push('Pareto-improving swaps found: ' + s.paretoSwaps + ' (0 means the result is already efficient)');
    lines.push('Gini of preference satisfaction: ' + s.giniSatisfaction);
    lines.push('');
    lines.push('Quota compliance:');
    metrics.quotaTable.forEach(function (q) {
      var right = q.category === 'CONVERTED'
        ? String(q.filled) + ' seats reissued in merit order'
        : pad_(String(q.filled) + '/' + q.reservedSeats, 12) +
          (q.unfilled > 0 ? q.unfilled + ' unfilled -> converted' : 'fully filled');
      lines.push('  ' + pad_(q.category, 18) + right);
    });
    return lines.join('\n');
  }

  function pad_(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  return { compute: compute, format: format, gini: gini, satisfaction: satisfaction };
})();
