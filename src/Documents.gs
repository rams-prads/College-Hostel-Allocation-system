/**
 * Documents.gs - which documents an applicant must supply, and their status.
 *
 * The required set is COMPUTED per applicant rather than stored as a fixed
 * checklist, so a student is never asked for a certificate that cannot apply to
 * them. A General-category applicant is not asked for a category certificate; a
 * first-year student is not asked for an ID card they have not been issued yet.
 *
 * Rules confirmed with the hostel office (see PROJECT_CONTEXT.md section 15).
 */

/**
 * The documents the EDC brochure actually asks for, and when.
 *
 * The list is computed per applicant rather than stored as a fixed checklist,
 * so nobody is asked for a certificate that cannot apply to them - a
 * General-category applicant is not asked for a category certificate, and a
 * Delhi-category applicant with no transferred parent is not asked for a
 * transfer certificate they have no reason to hold.
 */
/**
 * Two documents, and only two.
 *
 * The full brochure checklist runs to a dozen forms and affidavits, all of
 * which are collected on paper at the counter when the student physically
 * reports. Asking for them again here achieved nothing except a screen of
 * upload buttons long enough that nobody reached the bottom of it - and a
 * verification queue long enough that nobody worked through that either.
 *
 * What the portal actually needs is what the ALLOCATION depends on:
 *
 *   Aadhaar    identity, and the address the distance is computed from. It
 *              carries the PIN code, which is the one field the priority order
 *              turns on for a Delhi-category applicant.
 *   ID card    proof that a continuing student is still enrolled. A first-year
 *              has not been issued one, so they are not asked for it.
 *
 * The rest is the counter's business, and the counter is better at it.
 */
/**
 * ONE document, and it is the university's own.
 *
 * WHY THE ADMISSION CONFIRMATION PAGE AND NOT AADHAAR
 * --------------------------------------------------
 * Aadhaar proved one thing this system uses - the PIN code an address sits in -
 * and cost a great deal to hold: a keyed vault, a Verhoeff check, masking on
 * every screen, and a permanent obligation under §29 of the Aadhaar Act over
 * data the hostel office has no business keeping.
 *
 * The GGSIPU admission confirmation page proves EVERY input the allocation
 * actually turns on, and the university issued it:
 *
 *   Region of the qualifying exam   Delhi (NCT) or not. This decides which
 *                                   priority group the applicant is in, which
 *                                   the brochure exhausts before looking at the
 *                                   next. Nothing else on the application
 *                                   matters as much, and until now it was
 *                                   self-declared and unchecked.
 *   Sub-category: PwD               The FIRST priority group. Also self-declared.
 *   Category                        GEN/OBC/SC/ST/EWS - the quota pass.
 *   Qualifying exam percentage      What applicants are ranked on inside a group.
 *   Correspondence address, PIN     Distance, which orders the Delhi group.
 *   Application number              A key the university can check against its
 *                                   own counselling data.
 *
 * So the swap is not "a different identity document". It is the difference
 * between checking one field and checking all six - and every student holds
 * this page months before they have a college email address, which was the
 * original problem.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not proof of identity. It shows an admission record exists with these
 * details; it does not show that the person uploading it is that person.
 * Neither did an Aadhaar photocopy - we never had UIDAI authentication and
 * never claimed it - so nothing is lost. What replaces it is better: the
 * application number is checkable against the university's own list, which is
 * a stronger control than anything available for an Aadhaar number.
 */
var DOC_TYPES = {
  ADMISSION_FORM: {
    label: 'GGSIPU admission confirmation page',
    hint: 'The confirmation page from your university admission application - ' +
          'the one with your application number, category and address on it. ' +
          'A PDF is best; a clear photo works.',
    why: 'It carries everything your hostel place is decided on: whether you ' +
         'were admitted in the Delhi category, your reservation category, ' +
         'whether you declared a disability, your qualifying marks and your ' +
         'home address.'
  },
  ID_CARD: {
    label: 'College ID card',
    hint: 'A clear photo or scan of your current college identity card.',
    why: 'Accepted instead of the admission page if you no longer have it. It ' +
         'proves you are still enrolled, but it does not carry your category or ' +
         'your address, so anything that depends on those is checked by hand.'
  },
  // Kept, unused. Aadhaar is no longer asked for anywhere; Identity.gs and this
  // slot remain so that turning it back on is a configuration change rather
  // than a rewrite. Nothing provisions it.
  AADHAAR: {
    label: 'Aadhaar card',
    hint: 'A clear photo or scan of your Aadhaar card, showing your address.',
    why: 'No longer collected. The admission confirmation page carries the same ' +
         'address and a great deal more.',
    retired: true
  }
};

var Documents = (function () {

  /**
   * The document set this specific applicant must supply.
   * @param {Object} student Students row
   * @return {Array<{docType, label, hint, why, mandatory}>}
   */
  /**
   * What this applicant has to produce.
   *
   * One slot, satisfied by EITHER document. A first-year has only the admission
   * page; a third-year may no longer have it to hand but certainly has a card.
   * Insisting on the page from everybody would fail the people it was meant to
   * help, and asking for both is asking twice for one fact.
   *
   * The admission page is named first because it is the one worth having: the
   * card proves enrolment and nothing else, so a case resting on it has four
   * fields the machine cannot check and a person must.
   */
  function requiredFor(student, app) {
    var firstYear = 1;
    try { firstYear = Catalogue.entryYear(student.programme); } catch (e) { firstYear = 1; }
    var continuing = Number(student.year) > firstYear;

    var primary = spec_('ADMISSION_FORM');
    primary.alternatives = continuing ? ['ID_CARD'] : [];
    if (continuing) {
      primary.hint = primary.hint +
        ' If you no longer have it, upload your college ID card instead.';
    }
    return [primary];
  }

  /**
   * Every slot an applicant MAY fill, including the alternatives.
   *
   * provision() creates a row for each so that a student who chooses the ID
   * card has somewhere to put it - a slot that only appears once the student
   * has guessed its name is not a slot.
   */
  function slotsFor(student, app) {
    var out = [];
    requiredFor(student, app).forEach(function (r) {
      out.push(r);
      (r.alternatives || []).forEach(function (alt) {
        var a = spec_(alt);
        a.altFor = r.docType;
        out.push(a);
      });
    });
    return out;
  }

  function spec_(type) {
    var d = DOC_TYPES[type];
    return {
      docType: type, label: d.label, hint: d.hint, why: d.why, mandatory: true
    };
  }

  /**
   * Create the REQUIRED placeholder rows for an application.
   * Idempotent - existing rows for the application are left untouched.
   */
  function provision(appId, student) {
    var app = Db.byId('Applications', appId);
    var existing = Db.where('Documents', { appId: appId });
    var have = {};
    existing.forEach(function (d) { have[d.docType] = true; });

    var rows = slotsFor(student, app)
      .filter(function (r) { return !have[r.docType]; })
      .map(function (r, i) {
        return {
          docId: appId + '-DOC-' + Util.pad(existing.length + i + 1, 2),
          appId: appId,
          docType: r.docType,
          status: 'REQUIRED',
          driveFileId: '', fileName: '',
          uploadedAt: '', verifiedBy: '', verifiedAt: '', note: '',
          mimeType: '', sizeBytes: 0, contentHash: '',
          scanVerdict: 'UNSCANNED', scanJson: null, scannedAt: ''
        };
      });

    if (rows.length) Db.appendMany('Documents', rows);
    return rows.length;
  }

  /** Requirement list merged with the applicant's current upload status. */
  function statusFor(appId, student) {
    var app = Db.byId('Applications', appId);
    var rows = Db.where('Documents', { appId: appId });
    var byType = {};
    rows.forEach(function (d) { byType[d.docType] = d; });

    return slotsFor(student, app).map(function (req) {
      var row = byType[req.docType];
      return {
        docType: req.docType,
        label: req.label,
        hint: req.hint,
        why: req.why,
        // An alternative is not a second requirement. The student's page has to
        // be able to say "or this instead" rather than listing two things and
        // implying both.
        altFor: req.altFor || '',
        alternatives: req.alternatives || [],
        status: row ? row.status : 'REQUIRED',
        fileName: row ? row.fileName : '',
        note: row ? row.note : '',
        docId: row ? row.docId : null
      };
    });
  }

  /**
   * Roll the per-document statuses up to the single docStatus on Applications,
   * which is what the eligibility engine reads.
   */
  /**
   * Requirements with nothing uploaded against ANY member.
   *
   * The one question worth asking about an applicant's evidence, and the one
   * that has to be asked in exactly one place. Asking it row by row - "is any
   * slot still REQUIRED?" - is wrong the moment a requirement has an
   * alternative, because the alternative slot stays REQUIRED for ever once the
   * student uploads the other one. That is not an outstanding task; it is an
   * offer they declined.
   *
   * It cost an applicant their place in the queue: their admission page was
   * uploaded and waiting, their unused ID-card slot said REQUIRED, and the
   * verification console therefore filed them under "waiting on the student"
   * and never showed them to anybody.
   */
  function outstanding(appId, student) {
    var app = Db.byId('Applications', appId);
    var rows = Db.where('Documents', { appId: appId });
    var byType = {};
    rows.forEach(function (d) { byType[d.docType] = d; });

    return requiredFor(student, app).filter(function (g) {
      var members = [g.docType].concat(g.alternatives || []);
      return !members.some(function (t) {
        var r = byType[t];
        return r && (!!r.driveFileId || r.status === 'WAIVED');
      });
    });
  }

  /**
   * The state of the requirement, not of the rows.
   *
   * A requirement satisfied by either of two documents is met when EITHER is
   * verified. Rolling up row by row would leave an applicant permanently
   * "pending" over an empty slot they were never expected to fill.
   */
  function rollUp(appId, student) {
    var app = Db.byId('Applications', appId);
    var rows = Db.where('Documents', { appId: appId });
    var byType = {};
    rows.forEach(function (d) { byType[d.docType] = d; });

    var groups = requiredFor(student, app);
    if (!groups.length) return 'VERIFIED';

    var worst = 'VERIFIED';
    var rank = { VERIFIED: 0, SUBMITTED: 1, PENDING: 2, REJECTED: 3 };

    for (var i = 0; i < groups.length; i++) {
      var members = [groups[i].docType].concat(groups[i].alternatives || []);
      var states = members.map(function (t) {
        return byType[t] ? byType[t].status : 'REQUIRED';
      });

      var g;
      if (states.some(function (x) { return x === 'VERIFIED' || x === 'WAIVED'; })) g = 'VERIFIED';
      else if (states.some(function (x) { return x === 'UPLOADED'; })) g = 'SUBMITTED';
      else if (states.some(function (x) { return x === 'REJECTED'; })) g = 'REJECTED';
      else g = 'PENDING';

      if (rank[g] > rank[worst]) worst = g;
    }
    return worst;
  }

  /**
   * Record an upload against one document slot.
   * @param {Object=} meta {mimeType, sizeBytes, contentHash}
   */
  function recordUpload(appId, docType, fileId, fileName, meta) {
    var row = Db.findOne('Documents', { appId: appId, docType: docType });
    if (!row) throw new Error('Documents: no ' + docType + ' slot for ' + appId);
    meta = meta || {};
    Db.update('Documents', row.docId, {
      status: 'UPLOADED', driveFileId: fileId || '',
      fileName: fileName || '', uploadedAt: new Date(),
      mimeType: meta.mimeType || '',
      sizeBytes: Number(meta.sizeBytes) || 0,
      contentHash: meta.contentHash || '',
      // A replacement invalidates whatever the previous file said.
      scanVerdict: 'UNSCANNED', scanJson: null, scannedAt: ''
    });
    return row.docId;
  }

  /**
   * Store what reading the document concluded. Advisory: it never changes the
   * document's own status, which stays a decision somebody made.
   */
  function recordScan(docId, result) {
    Db.update('Documents', docId, {
      scanVerdict: result.verdict,
      scanJson: { findings: result.findings || [], detail: result.detail || {} },
      scannedAt: new Date()
    });
    return result.verdict;
  }

  /** Scan one document if it has a file and has not been read yet. */
  function scanIfNeeded(doc, student, force) {
    if (!doc || !doc.driveFileId) return null;
    if (!force && doc.scanVerdict && doc.scanVerdict !== 'UNSCANNED') return doc.scanVerdict;
    var result = DocScan.checkDocument(doc, student);
    recordScan(doc.docId, result);
    return result.verdict;
  }

  /** Verifier decision. Writes to the ledger - document checks are auditable. */
  function decide(docId, approve, verifier, note) {
    var row = Db.byId('Documents', docId);
    if (!row) throw new Error('Documents: no such document ' + docId);
    Db.update('Documents', docId, {
      status: approve ? 'VERIFIED' : 'REJECTED',
      verifiedBy: verifier, verifiedAt: new Date(), note: note || ''
    });
    Ledger.append(approve ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED',
      { docId: docId, appId: row.appId, docType: row.docType, note: note || '' }, verifier);
    return true;
  }

  return {
    requiredFor: requiredFor,
    slotsFor: slotsFor,
    outstanding: outstanding,
    provision: provision,
    statusFor: statusFor,
    rollUp: rollUp,
    recordUpload: recordUpload,
    recordScan: recordScan,
    scanIfNeeded: scanIfNeeded,
    decide: decide
  };
})();
