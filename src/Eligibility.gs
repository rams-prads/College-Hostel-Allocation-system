/**
 * Eligibility.gs - rule evaluation producing REASONS, not just a boolean.
 *
 * Every check returns a structured reason whether it passes or fails. Those
 * reasons flow straight through to the student's "why" panel and to grievance
 * auto-triage, so a rejection is never unexplained.
 *
 * See PROJECT_CONTEXT.md section 4.1.
 */

/** Reason factory. `ok` false marks the reason that blocked the applicant. */
function reason(code, ok, text, detail) {
  return { code: code, ok: !!ok, text: text, detail: detail || null };
}

var Eligibility = (function () {

  /**
   * Evaluate one application.
   * @param {Object} app      Applications row
   * @param {Object} student  Students row
   * @param {number} prefCount how many ranked preferences they submitted
   * @return {{eligible: boolean, reasons: Array}}
   */
  function evaluate(app, student, prefCount) {
    var reasons = [];
    var minDist = Policy.value('eligibility', 'MIN_DISTANCE_KM', 30);
    var minCgpa = Policy.value('eligibility', 'MIN_CGPA', 5.0);
    var minAttendance = Policy.value('eligibility', 'MIN_ATTENDANCE', 0);
    var requireDocs = Policy.value('eligibility', 'REQUIRE_DOC_VERIFIED', 0);

    // --- application state -------------------------------------------------
    var deadStates = ['WITHDRAWN', 'CANCELLED', 'REJECTED'];
    if (deadStates.indexOf(app.status) >= 0) {
      reasons.push(reason('ELIG_FAIL_STATUS', false,
        'Application is ' + String(app.status).toLowerCase() + ' and is not considered for allocation.'));
      return { eligible: false, reasons: reasons };
    }

    // --- distance from home ------------------------------------------------
    var dist = Number(app.distanceKm);
    if (dist < 0) {
      reasons.push(reason('ELIG_FAIL_DISTANCE_UNKNOWN', false,
        'Home PIN code could not be located, so distance from campus could not be verified.',
        { pincode: student.homePincode }));
    } else if (dist < minDist) {
      reasons.push(reason('ELIG_FAIL_DISTANCE', false,
        'Home is ' + dist + ' km from campus, below the ' + minDist + ' km minimum for hostel eligibility.',
        { distanceKm: dist, minimum: minDist }));
    } else {
      reasons.push(reason('ELIG_PASS_DISTANCE', true,
        'Home is ' + dist + ' km from campus (' + student.homeState + '), above the ' + minDist + ' km minimum.',
        { distanceKm: dist, minimum: minDist }));
    }

    // --- academic standing -------------------------------------------------
    // A first-year applicant has no CGPA: they have not sat a university exam
    // yet. Testing them against a CGPA floor rejects the entire incoming intake,
    // who are also the group most likely to need a hostel place. They are
    // assessed on the entrance rank they were admitted on instead.
    var cgpa = Number(student.cgpa) || 0;
    var entrance = Number(student.entranceRank) || 0;

    if (cgpa <= 0 && entrance > 0) {
      reasons.push(reason('ELIG_PASS_ENTRANCE', true,
        'No CGPA yet, as expected in your first year. You are assessed on your entrance rank of ' +
        entrance + ' instead, against other first-year applicants.',
        { entranceRank: entrance }));
    } else if (cgpa <= 0 && Number(student.year) <= 1) {
      reasons.push(reason('ELIG_WARN_NO_ACADEMIC', true,
        'Neither a CGPA nor an entrance rank is on record. Your academic score is set at the ' +
        'midpoint rather than counted against you; the hostel office may ask you to confirm it.',
        { cgpa: cgpa, entranceRank: entrance }));
    } else if (cgpa < minCgpa) {
      reasons.push(reason('ELIG_FAIL_CGPA', false,
        'CGPA ' + cgpa.toFixed(2) + ' is below the ' + minCgpa.toFixed(1) + ' minimum.',
        { cgpa: cgpa, minimum: minCgpa }));
    } else {
      reasons.push(reason('ELIG_PASS_CGPA', true,
        'CGPA ' + cgpa.toFixed(2) + ' meets the ' + minCgpa.toFixed(1) + ' minimum.',
        { cgpa: cgpa, minimum: minCgpa }));
    }

    if (minAttendance > 0) {
      // Attendance is not in the current dataset; the rule is wired but inert
      // until the registry supplies the column. Documented rather than faked.
      reasons.push(reason('ELIG_SKIP_ATTENDANCE', true,
        'Attendance rule is configured but no attendance data is available; check skipped.'));
    }

    // --- documents ---------------------------------------------------------
    if (app.docStatus === 'REJECTED') {
      reasons.push(reason('ELIG_FAIL_DOCS', false,
        'Submitted documents were rejected at verification.'));
    } else if (requireDocs && app.docStatus !== 'VERIFIED') {
      reasons.push(reason('ELIG_FAIL_DOCS_PENDING', false,
        'Documents are ' + String(app.docStatus).toLowerCase() +
        '; verification is required before allocation.'));
    } else if (app.docStatus === 'VERIFIED') {
      reasons.push(reason('ELIG_PASS_DOCS', true, 'Supporting documents verified by the hostel office.'));
    } else {
      reasons.push(reason('ELIG_WARN_DOCS', true,
        'Documents are ' + String(app.docStatus).toLowerCase() +
        '. Allocation may proceed, but the seat is provisional until verification.'));
    }

    // --- preferences -------------------------------------------------------
    if (!prefCount) {
      reasons.push(reason('ELIG_FAIL_NO_PREFS', false,
        'No room preferences were submitted, so no allocation can be made.'));
    } else {
      reasons.push(reason('ELIG_PASS_PREFS', true,
        prefCount + ' ranked preference' + (prefCount === 1 ? '' : 's') + ' submitted.'));
    }

    var eligible = reasons.every(function (r) { return r.ok; });
    return { eligible: eligible, reasons: reasons };
  }

  /**
   * Evaluate the whole cohort in one pass.
   * @return {{byAppId: Object, eligible: Array, rejected: Array}}
   */
  function evaluateAll() {
    var apps = Db.readAll('Applications');
    var students = Db.indexBy('Students', 'studentId');
    var prefsByApp = Db.groupBy('Preferences', 'appId');

    var byAppId = {}, eligible = [], rejected = [];
    apps.forEach(function (app) {
      var student = students[app.studentId];
      if (!student) {
        byAppId[app.appId] = {
          eligible: false,
          reasons: [reason('ELIG_FAIL_NO_STUDENT', false, 'No matching student record found.')]
        };
        rejected.push(app.appId);
        return;
      }
      var prefs = prefsByApp[app.appId] || [];
      var res = evaluate(app, student, prefs.length);
      byAppId[app.appId] = res;
      (res.eligible ? eligible : rejected).push(app.appId);
    });

    return { byAppId: byAppId, eligible: eligible, rejected: rejected };
  }

  /** Persist eligibility results back to the Applications sheet. */
  function persist(result) {
    var apps = Db.readAll('Applications');
    apps.forEach(function (a) {
      var r = result.byAppId[a.appId];
      if (!r) return;
      a.eligible = r.eligible;
      a.eligibilityNotes = r.reasons.filter(function (x) { return !x.ok; })
        .map(function (x) { return x.text; });
      if (!r.eligible && a.status === 'SUBMITTED') a.status = 'REJECTED';
      a.updatedAt = new Date();
    });
    Db.replaceAll('Applications', apps);
    return apps.length;
  }

  return { evaluate: evaluate, evaluateAll: evaluateAll, persist: persist };
})();
