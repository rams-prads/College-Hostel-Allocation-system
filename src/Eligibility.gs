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
    var minAttendance = Number(Policy.value('eligibility', 'MIN_ATTENDANCE_PCT', 75));
    var requirePromotion = Number(Policy.value('eligibility', 'REQUIRE_PROMOTION', 1));
    var requireDocs = Policy.value('eligibility', 'REQUIRE_DOC_VERIFIED', 0);

    // --- application state -------------------------------------------------
    var deadStates = ['WITHDRAWN', 'CANCELLED', 'REJECTED'];
    if (deadStates.indexOf(app.status) >= 0) {
      reasons.push(reason('ELIG_FAIL_STATUS', false,
        'Application is ' + String(app.status).toLowerCase() + ' and is not considered for allocation.'));
      return { eligible: false, reasons: reasons };
    }

    // --- who may apply at all ----------------------------------------------
    // Only regular full-time students of a school on that campus. This is the
    // brochure's own limit and the reason campus is a hard partition.
    if (!student.campus) {
      reasons.push(reason('ELIG_FAIL_NO_CAMPUS', false,
        'No campus is recorded against your student record, so eligibility cannot be established.'));
    } else {
      reasons.push(reason('ELIG_PASS_ENROLLED', true,
        'Enrolled at ' + Geo.campusName(student.campus) +
        (student.school ? ' (' + student.school + ')' : '') +
        ', where hostel accommodation is offered to regular full-time students.'));
    }

    // --- RE-ADMISSION: the conditions the brochure actually imposes ---------
    //
    // There is no minimum distance and no minimum CGPA for a fresh applicant.
    // A Delhi student living ten minutes away is eligible - simply last in the
    // priority order. The conditions below exist, and they apply to somebody
    // returning for another session.
    if (app.admissionType === 'READMISSION') {
      if (!student.exResident) {
        reasons.push(reason('ELIG_FAIL_NOT_RESIDENT', false,
          'Re-admission is open only to residents of the preceding academic session.'));
      } else {
        reasons.push(reason('ELIG_PASS_RESIDENT', true,
          'You were a resident in the preceding academic session, so you may seek re-admission.'));
      }

      if (student.detained) {
        reasons.push(reason('ELIG_FAIL_DETAINED', false,
          'A student detained from appearing in university examinations ceases to be a ' +
          'bona-fide resident and cannot be re-admitted.'));
      }

      if (requirePromotion && student.promoted === false) {
        reasons.push(reason('ELIG_FAIL_NOT_PROMOTED', false,
          'Re-admission requires promotion to the next academic session. A year-back case ' +
          'is not eligible.'));
      } else if (requirePromotion) {
        reasons.push(reason('ELIG_PASS_PROMOTED', true,
          'Promoted to the next academic session.'));
      }

      if (student.disciplinaryFlag) {
        reasons.push(reason('ELIG_FAIL_DISCIPLINE', false,
          'A disciplinary notice from the preceding session bars re-admission.'));
      }

      var att = Number(student.attendancePct);
      if (isFinite(att) && att > 0) {
        if (att < minAttendance) {
          reasons.push(reason('ELIG_FAIL_ATTENDANCE', false,
            'Attendance of ' + att + '% across your school and the hostel is below the ' +
            minAttendance + '% the rules require for residency in the next session.',
            { attendancePct: att, minimum: minAttendance }));
        } else {
          reasons.push(reason('ELIG_PASS_ATTENDANCE', true,
            'Attendance of ' + att + '% meets the ' + minAttendance + '% requirement.',
            { attendancePct: att, minimum: minAttendance }));
        }
      }
    } else {
      // Fresh applicants: say plainly that neither of the two things people
      // most often assume will disqualify them actually does.
      reasons.push(reason('ELIG_PASS_FRESH', true,
        'A fresh application. There is no minimum distance and no minimum marks to apply ' +
        '\u2014 how far you live and what you scored decide your position in the queue, ' +
        'not whether you are allowed in it.'));
    }

    // --- the figure the queue is ordered on ---------------------------------
    var merit = Number(student.meritPercent) || 0;
    if (merit > 0) {
      reasons.push(reason('ELIG_PASS_MERIT', true,
        (student.meritBasis === 'CLASS_12'
          ? 'Class 12 best-five marks of ' + merit + '% recorded, which is what a first-year ' +
            'applicant is ranked on.'
          : 'Result up to the preceding semester recorded as ' + merit + '%.'),
        { meritPercent: merit, basis: student.meritBasis }));
    } else if (student.residenceCategory !== 'DELHI' || student.parentTransferred) {
      // Only groups ordered BY merit need it. A Delhi applicant is ordered by
      // distance, so a missing percentage costs them nothing.
      reasons.push(reason('ELIG_WARN_NO_MERIT', true,
        'No marks are on record. Your group is ranked on marks, so the hostel office will ' +
        'ask for them before the list is finalised.',
        { meritPercent: 0 }));
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
