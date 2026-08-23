/**
 * Verification.gs - one applicant, one screen, one decision.
 *
 * WHAT WAS WRONG WITH THE OLD SHAPE
 * ---------------------------------
 * Verification was three separate lists: documents needing a decision, an
 * identity queue, and a scan summary. Each was individually correct and the
 * combination was unusable, because the unit of work in this job is not a
 * document. It is a PERSON. An officer deciding a document had the identity on
 * a different card; an officer verifying an identity could not see the document
 * it was supposed to be matched against; and an applicant who needed both was
 * touched twice, from two screens, with no record that the two decisions were
 * about the same person.
 *
 * Every serious review console - KYC review tools, moderation queues, benefit
 * claim systems - is built around a CASE: everything known about one subject on
 * one screen, the automated signals beside the evidence, and a single decision
 * that closes it. That is what this is.
 *
 * THE THREE DECISIONS
 * -------------------
 * Two were not enough. "Verify" and "Reject" left no way to say the commonest
 * thing an officer actually needs to say, which is "this is probably fine, the
 * photograph is unreadable, send me another one". Doing that as a rejection
 * killed the application; doing it by hand meant an email outside the system.
 *
 *   VERIFY    the declaration is supported by the evidence. Documents and
 *             identity are both marked, the case closes.
 *   RESUBMIT  something specific is wrong with the evidence, not with the
 *             applicant. The named documents go back to the student with the
 *             reason attached, and the application STAYS ALIVE.
 *   REJECT    the declaration is not supported and the application fails.
 *
 * WHY THE APPLICATION NEEDED ITS OWN STATE
 * ----------------------------------------
 * `docStatus` is a roll-up of the document rows: it says what the documents
 * are, not what the office decided. Asking for a better copy set a document to
 * REJECTED, which rolled the application up to REJECTED, which made the
 * applicant ineligible - for a blurred photograph. `verifyStatus` is the
 * office's decision and is a different fact, so it is stored as one.
 */

var Verification = (function () {

  /**
   * Why a case was sent back or refused.
   *
   * A fixed list rather than free text, for the reason every review system
   * ends up with one: the student has to be told what to DO, and "rejected"
   * is not an instruction. Each carries the sentence the student reads, so
   * the officer picks a reason and the applicant gets a task.
   *
   * `note` is still there for the case that does not fit - it is appended, not
   * substituted, so the instruction never disappears.
   */
  var REASONS = {
    UNREADABLE: {
      label: 'Too blurred or dark to read',
      student: 'The copy you uploaded could not be read. Please upload a clearer ' +
               'photo or scan - flat, in good light, with all four corners visible.',
      resubmit: true
    },
    WRONG_DOCUMENT: {
      label: 'Not the document that was asked for',
      student: 'The file you uploaded is not the document this slot asks for. ' +
               'Please check the label and upload the right one.',
      resubmit: true
    },
    PARTIAL: {
      label: 'Cut off, or only part of the document',
      student: 'Part of the document is missing from the copy you uploaded. Please ' +
               'upload the whole document in one image, including the edges.',
      resubmit: true
    },
    NAME_MISMATCH: {
      label: 'The name does not match the application',
      student: 'The name on your document does not match the name on your ' +
               'application. If your application has a spelling mistake, correct it ' +
               'and upload the document again.',
      resubmit: true
    },
    ADDRESS_MISMATCH: {
      label: 'The address does not match what was declared',
      student: 'The address on your document does not match the address you ' +
               'declared. Distance from home is part of how places are ranked, so ' +
               'the two have to agree. Correct your application or upload the ' +
               'document that matches it.',
      resubmit: true
    },
    ENROLMENT_MISMATCH: {
      label: 'The enrolment number does not match',
      student: 'The enrolment number on your ID card does not match the one on ' +
               'your application. Please check it and correct whichever is wrong.',
      resubmit: true
    },
    EXPIRED: {
      label: 'Out of date',
      student: 'The document you uploaded is out of date. Please upload a current one.',
      resubmit: true
    },
    DUPLICATE: {
      label: 'Already used by another applicant',
      student: 'This document has already been submitted against another ' +
               'application. Contact the hostel office before uploading anything ' +
               'further.',
      resubmit: false
    },
    NOT_ELIGIBLE: {
      label: 'The applicant is not eligible',
      student: 'Your application has not been accepted at verification. The hostel ' +
               'office can explain the reason.',
      resubmit: false
    },
    OTHER: {
      label: 'Something else (write it below)',
      student: 'The hostel office needs something changed before your application ' +
               'can go forward. The note below explains what.',
      resubmit: true
    }
  };

  function reasons() {
    return Object.keys(REASONS).map(function (code) {
      return {
        code: code, label: REASONS[code].label,
        student: REASONS[code].student, resubmit: !!REASONS[code].resubmit
      };
    });
  }

  // ------------------------------------------------------------------ the case

  /**
   * Everything needed to decide one applicant, in one object.
   *
   * Deliberately one call. The old screen needed three, which is why the three
   * cards could disagree with each other about the same person.
   */
  function caseFor(appId) {
    var app = Db.byId('Applications', appId);
    if (!app) throw new Error('No such application.');
    var student = Db.byId('Students', app.studentId);
    if (!student) throw new Error('That application has no student record.');

    var docs = Db.where('Documents', { appId: appId });
    var idRow = null;
    try { idRow = Db.byId('Identity', student.studentId); } catch (e) { idRow = null; }

    var risk;
    try { risk = Identity.screen(appId); }
    catch (e) { risk = { score: 0, level: 'UNKNOWN', findings: [] }; }

    var geo = Geo.distanceFromHome(student.homePincode, student.campus);

    return {
      appId: appId,
      studentId: student.studentId,
      status: app.status,
      verifyStatus: verifyStatusOf_(app),
      docStatus: app.docStatus,
      submittedAt: fmtDate_(app.submittedAt),
      waitingDays: ageDays_(app.submittedAt),

      // What the applicant says about themselves.
      declared: {
        name: student.name,
        enrollmentNo: student.enrollmentNo,
        email: student.email,
        phone: student.phone,
        dob: student.dob,
        gender: student.gender,
        programme: student.programme,
        branch: student.branch,
        year: student.year,
        campus: student.campus,
        category: student.category,
        isPwD: !!student.isPwD,
        residenceCategory: student.residenceCategory,
        meritPercent: student.meritPercent,
        homeAddress: student.homeAddress,
        homeCity: student.homeCity,
        homePincode: student.homePincode,
        homeState: student.homeState,
        distanceKm: geo.resolved ? geo.km : null,
        guardianName: student.guardianName,
        guardianPhone: student.guardianPhone,
        selfDeclared: !!student.selfDeclared
      },

      identity: idRow ? {
        status: idRow.status,
        masked: Identity.mask(idRow.aadhaarLast4),
        submittedAt: fmtDate_(idRow.submittedAt),
        decidedBy: idRow.verifiedBy || '',
        decidedAt: fmtDate_(idRow.verifiedAt),
        note: idRow.note || ''
      } : { status: 'REQUIRED', masked: '', submittedAt: '', decidedBy: '',
            decidedAt: '', note: '' },

      documents: docs.map(function (d) { return docView_(d, student); }),
      // Slots the student has not filled yet, so the officer can see what is
      // outstanding rather than inferring it from what is absent.
      missing: Documents.statusFor(appId, student)
        .filter(function (r) { return r.status === 'REQUIRED'; })
        .map(function (r) { return { docType: r.docType, label: r.label }; }),

      // The applicant-level screening AND what reading each document said, in
      // one list. They were on different cards, which meant a BLOCK finding on
      // a document sat below an INFO finding about the applicant - the wrong
      // way round, and the officer had to know to look in two places.
      risk: {
        score: risk.score,
        level: worstLevel_(risk, docs),
        findings: (risk.findings || []).concat(docFindings_(docs))
      },
      comparisons: comparisonsFor_(docs, student),
      ready: readiness_(docs, idRow, appId, student)
    };
  }

  /** Everything reading the documents said, labelled with which document. */
  function docFindings_(docs) {
    var out = [];
    docs.forEach(function (d) {
      if (!d.driveFileId) return;
      var scan = typeof d.scanJson === 'string'
        ? (function () { try { return JSON.parse(d.scanJson); } catch (e) { return null; } })()
        : d.scanJson;
      var label = (DOC_TYPES[d.docType] || {}).label || d.docType;
      ((scan && scan.findings) || []).forEach(function (f) {
        out.push({ code: f.code, severity: f.severity, text: label + ': ' + f.text });
      });
    });
    return out;
  }

  /** A blocking finding anywhere makes the case a blocking case. */
  function worstLevel_(risk, docs) {
    if (risk.level === 'HIGH') return 'HIGH';
    var f = docFindings_(docs);
    if (f.some(function (x) { return x.severity === 'BLOCK'; })) return 'HIGH';
    if (risk.level === 'MEDIUM') return 'MEDIUM';
    if (f.some(function (x) { return x.severity === 'REVIEW'; })) return 'MEDIUM';
    return risk.level;
  }

  /** One document, with everything the officer needs to judge it. */
  function docView_(d, student) {
    var scan = typeof d.scanJson === 'string'
      ? (function () { try { return JSON.parse(d.scanJson); } catch (e) { return null; } })()
      : d.scanJson;

    return {
      docId: d.docId, docType: d.docType,
      label: (DOC_TYPES[d.docType] || {}).label || d.docType,
      status: d.status,
      fileName: d.fileName || '',
      driveFileId: d.driveFileId || '',
      // Google serves a rendered image of any Drive file at this address, which
      // is what lets the document sit BESIDE the declaration instead of behind
      // a link to another tab. Comparing two things you cannot see at once is
      // the slowest possible way to do this job.
      previewUrl: d.driveFileId
        ? 'https://drive.google.com/file/d/' + d.driveFileId + '/preview' : '',
      thumbUrl: d.driveFileId
        ? 'https://drive.google.com/thumbnail?id=' + d.driveFileId + '&sz=w900' : '',
      openUrl: d.driveFileId
        ? 'https://drive.google.com/file/d/' + d.driveFileId + '/view' : '',
      mimeType: d.mimeType || '',
      sizeKb: d.sizeBytes ? Math.round(Number(d.sizeBytes) / 1024) : 0,
      uploadedAt: fmtDate_(d.uploadedAt),
      scanVerdict: d.scanVerdict || 'UNSCANNED',
      scannedAt: fmtDate_(d.scannedAt),
      findings: (scan && scan.findings) || [],
      detail: (scan && scan.detail) || {},
      decidedBy: d.verifiedBy || '',
      decidedAt: fmtDate_(d.verifiedAt),
      note: d.note || ''
    };
  }

  /**
   * Declared against found, field by field.
   *
   * This is the whole job written down. An officer's actual task is to compare
   * what the applicant typed with what the document says, and until now the
   * system did that comparison, formed an opinion, and then showed only the
   * opinion. Showing the comparison lets a person disagree with it, which is
   * the entire reason a person is here.
   */
  function comparisonsFor_(docs, student) {
    var out = [];

    docs.forEach(function (d) {
      var scan = typeof d.scanJson === 'string'
        ? (function () { try { return JSON.parse(d.scanJson); } catch (e) { return null; } })()
        : d.scanJson;
      var detail = (scan && scan.detail) || {};
      if (!d.driveFileId) return;

      var label = (DOC_TYPES[d.docType] || {}).label || d.docType;

      if (detail.nameScore !== undefined) {
        out.push({
          docType: d.docType, source: label, field: 'Name',
          declared: student.name,
          found: detail.nameScore >= 0.5
            ? 'matched (' + Math.round(detail.nameScore * 100) + '% of the words)'
            : 'not found on the document',
          ok: detail.nameScore >= 0.5
        });
      }

      if (detail.declaredPincode !== undefined) {
        var found = (detail.pincodesFound || []);
        out.push({
          docType: d.docType, source: label, field: 'PIN code',
          declared: String(detail.declaredPincode || ''),
          found: found.length ? found.join(', ') : 'none could be read',
          ok: !!detail.pincodeConfirmed,
          // A difference that changes nothing is not a discrepancy worth an
          // officer's attention, and saying so is what keeps the queue short.
          minor: !detail.pincodeConfirmed && detail.material === false,
          note: detail.declaredKm !== undefined && detail.documentKm !== undefined
            ? 'Declared address is ' + detail.declaredKm + ' km from campus; the ' +
              'address on the document is ' + detail.documentKm + ' km.'
            : ''
        });
      }

      // The four fields that used to be self-declared and checked by nobody.
      // They decide which priority group the applicant is in, which quota they
      // draw on, and where they sit inside their group - which is to say, they
      // decide the outcome.
      if (detail.regionRead) {
        out.push({
          docType: d.docType, source: label, field: 'Admission region',
          declared: student.residenceCategory === 'DELHI' ? 'Delhi' : 'Outside Delhi',
          found: detail.regionRead + (detail.regionIsDelhi ? ' (Delhi)' : ' (outside Delhi)'),
          ok: detail.regionAgrees !== false,
          note: 'This decides which priority group the applicant is in. One group is ' +
                'exhausted before the next is looked at.'
        });
      }
      if (detail.categoryOnForm) {
        out.push({
          docType: d.docType, source: label, field: 'Category',
          declared: String(student.category || ''),
          found: detail.categoryOnForm,
          ok: detail.categoryOnForm === String(student.category)
        });
      }
      if (detail.pwdOnForm !== undefined) {
        out.push({
          docType: d.docType, source: label, field: 'Disability',
          declared: student.isPwD ? 'Declared' : 'Not declared',
          found: detail.pwdOnForm ? 'Recorded on the form' : 'Not recorded',
          ok: !!student.isPwD === !!detail.pwdOnForm,
          note: 'Disabled applicants are the first priority group.'
        });
      }
      if (detail.percentOnForm !== undefined) {
        out.push({
          docType: d.docType, source: label, field: 'Qualifying marks',
          declared: String(student.meritPercent || '') + '%',
          found: detail.percentOnForm + '%',
          ok: Number(detail.percentGap || 0) <= 0.5,
          minor: Number(detail.percentGap || 0) > 0.5,
          note: 'A continuing student is ranked on a semester result, which is not ' +
                'on this page at all.'
        });
      }
      if (detail.applicationNo) {
        out.push({
          docType: d.docType, source: label, field: 'Application number',
          declared: '—',
          found: detail.applicationNo,
          ok: true,
          note: 'Checkable against the university admission list.'
        });
      }

      if (detail.enrolmentFound !== undefined) {
        out.push({
          docType: d.docType, source: label, field: 'Enrolment number',
          declared: student.enrollmentNo,
          found: detail.enrolmentFound ? 'found on the document' : 'not found',
          ok: !!detail.enrolmentFound
        });
      }
    });

    return out;
  }

  /** Can this case be decided at all, and if not, what is missing? */
  function readiness_(docs, idRow, appId, student) {
    // By REQUIREMENT, not by row. An unused alternative slot stays REQUIRED for
    // ever, and counting it as outstanding disabled the Verify button on every
    // continuing student who sent the admission page.
    var outstanding = Documents.outstanding(appId, student);
    var unread = docs.filter(function (d) {
      return d.driveFileId && (!d.scanVerdict || d.scanVerdict === 'UNSCANNED');
    });

    return {
      canDecide: outstanding.length === 0,
      awaitingUpload: outstanding.map(function (r) { return r.label; }),
      // Named so the console can say "or their ID card instead" rather than
      // implying the one named document is the only thing that would do.
      alternatives: outstanding.map(function (r) {
        return (r.alternatives || []).map(function (a) {
          return (DOC_TYPES[a] || {}).label || a;
        });
      }),
      awaitingScan: unread.length,
      identityDeclared: !!(idRow && idRow.status !== 'REQUIRED')
    };
  }

  // ----------------------------------------------------------------- the queue

  /**
   * The work, in the order it should be done.
   *
   * Risk first, then age. Doing it purely by arrival lets a fraudulent
   * application sit behind two hundred clean ones; doing it purely by risk
   * lets a clean applicant wait a month. Both matter, so the sort is both, and
   * the age is on the row so nobody has to guess.
   */
  function queue(opts) {
    opts = opts || {};
    var filter = opts.filter || 'NEEDS_DECISION';
    var q = String(opts.q || '').trim().toLowerCase();

    var stu = Db.indexBy('Students', 'studentId');
    var docsByApp = Db.groupBy('Documents', 'appId');
    var idByStudent = {};
    try { idByStudent = Db.indexBy('Identity', 'studentId'); } catch (e) { idByStudent = {}; }

    var counts = { NEEDS_DECISION: 0, FLAGGED: 0, WAITING_ON_STUDENT: 0, DONE: 0, ALL: 0 };
    var rows = [];

    Db.readAll('Applications').forEach(function (app) {
      if (app.status === 'DRAFT' || app.status === 'WITHDRAWN') return;
      var student = stu[app.studentId];
      if (!student) return;

      var docs = docsByApp[app.appId] || [];
      var state = stateOf_(app, docs, student);
      counts[state] = (counts[state] || 0) + 1;
      counts.ALL++;

      var risk;
      try { risk = Identity.screen(app.appId); }
      catch (e) { risk = { score: 0, level: 'UNKNOWN', findings: [] }; }
      if (risk.level === 'HIGH' && state !== 'DONE') counts.FLAGGED++;

      if (filter !== 'ALL') {
        if (filter === 'FLAGGED') {
          if (risk.level !== 'HIGH' || state === 'DONE') return;
        } else if (state !== filter) return;
      }

      if (q) {
        var hay = (student.name + ' ' + student.enrollmentNo + ' ' + app.appId).toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }

      var idRow = idByStudent[student.studentId];
      rows.push({
        appId: app.appId,
        studentId: student.studentId,
        name: student.name,
        enrollmentNo: student.enrollmentNo,
        programme: student.programme,
        year: student.year,
        campus: student.campus,
        category: student.category,
        isPwD: !!student.isPwD,
        state: state,
        verifyStatus: verifyStatusOf_(app),
        riskLevel: risk.level,
        riskScore: risk.score,
        blockers: (risk.findings || []).filter(function (f) { return f.severity === 'BLOCK'; }).length,
        identityStatus: idRow ? idRow.status : 'REQUIRED',
        documents: docs.length,
        uploaded: docs.filter(function (d) { return !!d.driveFileId; }).length,
        worstVerdict: worstVerdict_(docs),
        waitingDays: ageDays_(app.submittedAt),
        submittedAt: fmtDate_(app.submittedAt)
      });
    });

    rows.sort(function (a, b) {
      if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
      return b.waitingDays - a.waitingDays;
    });

    var limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 300);
    return { rows: rows.slice(0, limit), counts: counts, filter: filter, total: rows.length };
  }

  /**
   * Which of the four states a case is in.
   *
   * Named for what the office is waiting on, not for what the record contains,
   * because "who do I chase" is the question a queue is for.
   */
  function stateOf_(app, docs, student) {
    var v = verifyStatusOf_(app);
    if (v === 'VERIFIED' || v === 'REJECTED') return 'DONE';
    if (v === 'ACTION_REQUIRED') return 'WAITING_ON_STUDENT';

    // Whether anything is still owed is a question about REQUIREMENTS. Asking
    // it of the rows - "is any slot still REQUIRED?" - files every applicant
    // who used one of two alternatives under "waiting on the student", for
    // ever, over a slot they were never going to fill.
    if (student) {
      try {
        return Documents.outstanding(app.appId, student).length
          ? 'WAITING_ON_STUDENT' : 'NEEDS_DECISION';
      } catch (e) { /* fall through to the row-level reading below */ }
    }

    var uploaded = docs.filter(function (d) { return !!d.driveFileId; });
    if (!uploaded.length) return 'WAITING_ON_STUDENT';
    return 'NEEDS_DECISION';
  }

  /** verifyStatus, tolerating a sheet migrated before the column existed. */
  function verifyStatusOf_(app) {
    var v = app.verifyStatus;
    if (v) return v;
    // Fall back to what the documents say, so an installation that has not run
    // migrateSchema() still behaves sensibly rather than showing everything as
    // undecided.
    if (app.docStatus === 'VERIFIED') return 'VERIFIED';
    if (app.docStatus === 'REJECTED') return 'REJECTED';
    return 'PENDING';
  }

  var VERDICT_RANK = { CONFLICT: 4, UNREADABLE: 3, UNSCANNED: 2, MINOR: 1, MATCH: 0 };

  function worstVerdict_(docs) {
    var worst = '', rank = -1;
    docs.forEach(function (d) {
      if (!d.driveFileId) return;
      var v = d.scanVerdict || 'UNSCANNED';
      var r = VERDICT_RANK[v] === undefined ? 0 : VERDICT_RANK[v];
      if (r > rank) { rank = r; worst = v; }
    });
    return worst;
  }

  function ageDays_(since) {
    if (!since) return 0;
    var t = (since instanceof Date) ? since.getTime() : new Date(since).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }

  // -------------------------------------------------------------- the decision

  /**
   * Decide one case. The only way a verification decision is ever made.
   *
   * One call, one ledger entry, one consistent end state - as opposed to the
   * previous arrangement where an officer made two or three decisions on two
   * or three screens and nothing tied them together.
   *
   * @param {string} appId
   * @param {string} verdict  VERIFY | RESUBMIT | REJECT
   * @param {Object} opts     {reason, note, docTypes:[...]}
   */
  function decide(appId, verdict, opts, actor) {
    opts = opts || {};
    var app = Db.byId('Applications', appId);
    if (!app) throw new Error('No such application.');
    var student = Db.byId('Students', app.studentId);
    if (!student) throw new Error('That application has no student record.');

    if (['VERIFY', 'RESUBMIT', 'REJECT'].indexOf(verdict) < 0) {
      throw new Error('Unknown decision.');
    }

    var reason = REASONS[opts.reason] || null;
    if (verdict !== 'VERIFY' && !reason) {
      throw new Error('Choose a reason. The student is told what it says, so ' +
                      '"rejected" on its own is not an instruction they can act on.');
    }
    if (opts.reason === 'OTHER' && !String(opts.note || '').trim()) {
      throw new Error('Write what needs to change. "Something else" with nothing ' +
                      'after it leaves the student with no idea what to do.');
    }

    var note = String(opts.note || '').trim();
    var message = reason ? reason.student + (note ? ' ' + note : '') : '';
    var docs = Db.where('Documents', { appId: appId });
    var touched = [];

    if (verdict === 'VERIFY') {
      docs.forEach(function (d) {
        if (!d.driveFileId) return;
        if (d.status === 'VERIFIED') return;
        Documents.decide(d.docId, true, actor, note || 'Checked against the declaration.');
        touched.push(d.docType);
      });
      try {
        var idRow = Db.byId('Identity', student.studentId);
        if (idRow && idRow.status !== 'VERIFIED') {
          Identity.decide(student.studentId, true, actor, note || 'Matched against the documents.');
        }
      } catch (e) { /* no Identity tab yet - not a reason to fail the decision */ }

    } else {
      // Only the documents the officer named, so "the ID card is blurred" does
      // not throw away an Aadhaar that was perfectly readable.
      var wanted = (opts.docTypes && opts.docTypes.length)
        ? opts.docTypes
        : docs.filter(function (d) { return !!d.driveFileId; })
              .map(function (d) { return d.docType; });

      docs.forEach(function (d) {
        if (wanted.indexOf(d.docType) < 0) return;
        Documents.decide(d.docId, false, actor, message);
        touched.push(d.docType);
      });

      if (verdict === 'REJECT') {
        try {
          var idr = Db.byId('Identity', student.studentId);
          if (idr) Identity.decide(student.studentId, false, actor, message);
        } catch (e) { /* as above */ }
      }
    }

    Db.invalidate('Documents');

    var verifyStatus = { VERIFY: 'VERIFIED', RESUBMIT: 'ACTION_REQUIRED',
                         REJECT: 'REJECTED' }[verdict];

    Db.update('Applications', appId, {
      verifyStatus: verifyStatus,
      docStatus: Documents.rollUp(appId, student),
      verifyReason: opts.reason || '',
      verifyNote: message,
      verifiedBy: actor || '',
      verifiedAt: new Date(),
      updatedAt: new Date()
    });
    Db.invalidate('Applications');

    Ledger.append('VERIFICATION_DECIDED', {
      appId: appId, studentId: student.studentId, verdict: verdict,
      reason: opts.reason || '', documents: touched
    }, actor || 'system');

    // Tell the student, now, with the instruction in it. A decision they find
    // out about by refreshing the portal a week later is a decision that
    // wasted a week.
    var notified = false;
    if (verdict !== 'VERIFY') {
      try {
        notified = !!Notify.send(appId,
          verdict === 'RESUBMIT' ? 'VERIFY_RESUBMIT' : 'VERIFY_REJECTED',
          { message: message });
      } catch (e) {
        // Email is a courtesy on top of a decision that has already been made
        // and recorded. A send that fails must not undo it.
        notified = false;
      }
    }

    return {
      ok: true, appId: appId, verdict: verdict, verifyStatus: verifyStatus,
      documents: touched, message: message, notified: notified
    };
  }

  // ------------------------------------------------------------------ metrics

  /**
   * How the queue is doing, in the terms the research on review operations
   * actually uses: what is outstanding, how old the oldest is, and how much of
   * the work the machine took off the pile.
   */
  function stats() {
    var apps = Db.readAll('Applications').filter(function (a) {
      return a.status !== 'DRAFT' && a.status !== 'WITHDRAWN';
    });
    var docsByApp = Db.groupBy('Documents', 'appId');

    var byState = { NEEDS_DECISION: 0, WAITING_ON_STUDENT: 0, DONE: 0 };
    var ages = [];
    var stu = Db.indexBy('Students', 'studentId');
    apps.forEach(function (a) {
      var st = stateOf_(a, docsByApp[a.appId] || [], stu[a.studentId]);
      byState[st] = (byState[st] || 0) + 1;
      if (st === 'NEEDS_DECISION') ages.push(ageDays_(a.submittedAt));
    });

    var docs = Db.readAll('Documents').filter(function (d) { return !!d.driveFileId; });
    var read = docs.filter(function (d) {
      return d.scanVerdict && d.scanVerdict !== 'UNSCANNED';
    }).length;
    var settled = docs.filter(function (d) {
      return d.scanVerdict === 'MATCH' || d.scanVerdict === 'MINOR';
    }).length;
    var auto = docs.filter(function (d) {
      return /AUTOMATIC/.test(String(d.verifiedBy || ''));
    }).length;

    // How many the "clear what the reading settled" button would actually
    // clear - asked of the same rule the button obeys, because a button
    // labelled with a number it cannot deliver is how this went wrong before.
    var clearable = 0;
    if (typeof autoClearable_ === 'function') {
      var cache = {};
      var screener = function (appId) {
        if (cache[appId] === undefined) cache[appId] = Identity.screen(appId);
        return cache[appId];
      };
      docs.forEach(function (d) {
        try { if (autoClearable_(d, screener).ok) clearable++; } catch (e) { /* skip */ }
      });
    }

    ages.sort(function (a, b) { return a - b; });

    return {
      applications: apps.length,
      byState: byState,
      oldestWaitingDays: ages.length ? ages[ages.length - 1] : 0,
      medianWaitingDays: ages.length ? ages[Math.floor(ages.length / 2)] : 0,
      documents: docs.length,
      read: read,
      unread: docs.length - read,
      // The number that says whether reading documents automatically is worth
      // anything: the share of the pile a person never had to open.
      settledByMachinePct: docs.length ? Math.round(100 * settled / docs.length) : 0,
      clearedAutomatically: auto,
      clearable: clearable
    };
  }

  return {
    reasons: reasons,
    caseFor: caseFor,
    queue: queue,
    decide: decide,
    stats: stats,
    _stateOf: stateOf_,
    _verifyStatusOf: verifyStatusOf_
  };
})();
