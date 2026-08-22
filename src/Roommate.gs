/**
 * Roommate.gs - compatibility scoring and room grouping (novelty feature 2).
 *
 * Most mid-year transfer requests are roommate conflicts, so solving this at
 * allocation time removes downstream administrative work rather than adding a
 * feature. See PROJECT_CONTEXT.md section 4.2.
 *
 * IMPORTANT: grouping runs only among students who already received the SAME
 * (hostel, roomType) outcome. It therefore cannot change anyone's preference
 * rank - compatibility is optimised strictly inside the space the allocation
 * already fixed, so it can never trade fairness for comfort.
 */

var Roommate = (function () {

  var SLEEP_ORDINAL = { EARLY: 0, MODERATE: 1, LATE: 2 };

  var STUDY_MATRIX = {
    'QUIET|QUIET': 1.0, 'MUSIC|MUSIC': 1.0, 'GROUP|GROUP': 1.0,
    'QUIET|MUSIC': 0.30, 'MUSIC|QUIET': 0.30,
    'QUIET|GROUP': 0.05, 'GROUP|QUIET': 0.05,
    'MUSIC|GROUP': 0.60, 'GROUP|MUSIC': 0.60
  };

  var FOOD_MATRIX = {
    'VEG|VEG': 1.0, 'NONVEG|NONVEG': 1.0, 'EGG|EGG': 1.0,
    'VEG|EGG': 0.70, 'EGG|VEG': 0.70,
    'VEG|NONVEG': 0.40, 'NONVEG|VEG': 0.40,
    'EGG|NONVEG': 0.85, 'NONVEG|EGG': 0.85
  };

  /**
   * Pairwise compatibility in [0,1] with a per-dimension breakdown.
   * The breakdown is kept because it is shown to students - "you were paired on
   * sleep schedule and cleanliness" is far more useful than a bare 0.87.
   */
  function score(a, b) {
    if (!a || !b) return { score: 0.5, parts: {} };
    var w = Policy.roommateWeights();

    var sleepDiff = Math.abs(SLEEP_ORDINAL[a.sleepTime] - SLEEP_ORDINAL[b.sleepTime]) / 2;
    var wakeDiff  = Math.abs(SLEEP_ORDINAL[a.wakeTime] - SLEEP_ORDINAL[b.wakeTime]) / 2;
    var sleep = 1 - (sleepDiff + wakeDiff) / 2;

    var study = STUDY_MATRIX[a.studyStyle + '|' + b.studyStyle];
    if (study === undefined) study = 0.5;

    var clean  = 1 - Math.abs(Number(a.cleanliness) - Number(b.cleanliness)) / 4;
    var social = 1 - Math.abs(Number(a.sociability) - Number(b.sociability)) / 4;

    var food = FOOD_MATRIX[a.foodPref + '|' + b.foodPref];
    if (food === undefined) food = 0.5;

    // Shared language is a mild bonus, never a hard rule - grouping students by
    // language would quietly segregate hostels by region, which is exactly what
    // a public university should not do.
    var lang = a.language === b.language ? 1.0 : 0.5;

    var parts = { sleep: sleep, study: study, clean: clean, social: social, food: food, lang: lang };

    // Smoking is deliberately NOT a factor. Hostels are non-smoking, so asking
    // students to declare a tolerance for it would treat a prohibited act as a
    // lifestyle preference and quietly build it into the pairing score.
    var total = w.W_SLEEP * sleep + w.W_STUDY * study + w.W_CLEAN * clean +
                w.W_SOCIAL * social + w.W_FOOD * food + w.W_LANG * lang;

    return { score: Util.clamp(total, 0, 1), parts: parts };
  }

  /** Mean pairwise compatibility across a group of students. */
  function groupScore(members, lifestyleByApp) {
    if (members.length < 2) return 1;
    var sum = 0, n = 0;
    for (var i = 0; i < members.length; i++) {
      for (var j = i + 1; j < members.length; j++) {
        sum += score(lifestyleByApp[members[i]], lifestyleByApp[members[j]]).score;
        n++;
      }
    }
    return n ? sum / n : 1;
  }

  /**
   * Partition appIds into groups of `size`, maximising within-group compatibility.
   *
   * Greedy seeded matching: repeatedly take the best remaining pair, then grow it
   * to `size` with whoever fits the group best. Optimal maximum-weight matching
   * would need blossom; greedy gets within a few percent on cohorts this size
   * and stays comfortably inside the Apps Script execution limit.
   */
  function formGroups(appIds, size, lifestyleByApp) {
    if (size <= 1) return appIds.map(function (id) { return [id]; });

    var pool = appIds.slice();
    var groups = [];

    // Precompute pairwise scores once - O(n^2), with n per bucket in the tens.
    var pairScore = {};
    function pairKey(x, y) { return x < y ? x + '|' + y : y + '|' + x; }
    for (var i = 0; i < pool.length; i++) {
      for (var j = i + 1; j < pool.length; j++) {
        pairScore[pairKey(pool[i], pool[j])] =
          score(lifestyleByApp[pool[i]], lifestyleByApp[pool[j]]).score;
      }
    }

    while (pool.length >= size) {
      // Best remaining pair seeds the group.
      var best = null;
      for (var a = 0; a < pool.length; a++) {
        for (var b = a + 1; b < pool.length; b++) {
          var s = pairScore[pairKey(pool[a], pool[b])];
          if (!best || s > best.s) best = { a: a, b: b, s: s };
        }
      }
      if (!best) break;

      var group = [pool[best.a], pool[best.b]];
      pool.splice(Math.max(best.a, best.b), 1);
      pool.splice(Math.min(best.a, best.b), 1);

      // Grow to size with the best-fitting remaining member.
      while (group.length < size && pool.length) {
        var bestIdx = -1, bestAvg = -1;
        for (var k = 0; k < pool.length; k++) {
          var sum = 0;
          for (var m = 0; m < group.length; m++) sum += pairScore[pairKey(pool[k], group[m])];
          var avg = sum / group.length;
          if (avg > bestAvg) { bestAvg = avg; bestIdx = k; }
        }
        group.push(pool[bestIdx]);
        pool.splice(bestIdx, 1);
      }
      groups.push(group);
    }

    // Whatever is left forms a final under-full group (a partly empty room).
    if (pool.length) groups.push(pool);
    return groups;
  }

  /** Lifestyle rows indexed by appId. */
  function lifestyleIndex() {
    return Db.indexBy('Lifestyle', 'appId');
  }

  return {
    score: score,
    groupScore: groupScore,
    formGroups: formGroups,
    lifestyleIndex: lifestyleIndex
  };
})();
