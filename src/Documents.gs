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
var DOC_TYPES = {
  AADHAAR: {
    label: 'Aadhaar card',
    hint: 'A clear photo or scan of your Aadhaar card, showing your address.',
    why: 'Confirms who you are, and the address your distance from campus is ' +
         'calculated from.'
  },
  ID_CARD: {
    label: 'College ID card',
    hint: 'A clear photo or scan of your current college identity card.',
    why: 'You are a continuing student, so your ID card is your proof that you ' +
         'are still enrolled.'
  }
};

var Documents = (function () {

  /**
   * The document set this specific applicant must supply.
   * @param {Object} student Students row
   * @return {Array<{docType, label, hint, why, mandatory}>}
   */
  function requiredFor(student, app) {
    var out = [spec_('AADHAAR')];

    // A student in their first year has not been issued an ID card yet. For a
    // lateral-entry programme that first year is the second, which is why this
    // asks the catalogue rather than comparing against 1.
    var firstYear = 1;
    try { firstYear = Catalogue.entryYear(student.programme); } catch (e) { firstYear = 1; }

    if (Number(student.year) > firstYear) out.push(spec_('ID_CARD'));

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

    var rows = requiredFor(student, app)
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

    return requiredFor(student, app).map(function (req) {
      var row = byType[req.docType];
      return {
        docType: req.docType,
        label: req.label,
        hint: req.hint,
        why: req.why,
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
  function rollUp(appId, student) {
    var docs = statusFor(appId, student);
    if (!docs.length) return 'VERIFIED';
    if (docs.some(function (d) { return d.status === 'REJECTED'; })) return 'REJECTED';
    if (docs.every(function (d) {
      return d.status === 'VERIFIED' || d.status === 'WAIVED';
    })) return 'VERIFIED';
    if (docs.every(function (d) {
      return d.status !== 'REQUIRED';
    })) return 'SUBMITTED';
    return 'PENDING';
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
    provision: provision,
    statusFor: statusFor,
    rollUp: rollUp,
    recordUpload: recordUpload,
    recordScan: recordScan,
    scanIfNeeded: scanIfNeeded,
    decide: decide
  };
})();
