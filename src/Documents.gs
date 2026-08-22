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

var DOC_TYPES = {
  ADMISSION_LETTER: {
    label: 'Admission letter',
    hint: 'Your university admission or offer letter for the current session.',
    why: 'You are in your first year, so a college ID card has not been issued yet.'
  },
  ID_CARD: {
    label: 'College ID card',
    hint: 'A clear photo or scan of your current college identity card.',
    why: 'You are a continuing student, so your ID card serves as proof of enrolment.'
  },
  CATEGORY_CERT: {
    label: 'Category certificate',
    hint: 'SC/ST caste certificate, OBC non-creamy-layer certificate, or EWS certificate, as applicable.',
    why: 'You are claiming a seat under a reserved category, which must be verified.'
  },
  PWD_CERT: {
    label: 'Disability certificate',
    hint: 'UDID card or a disability certificate from a competent medical authority.',
    why: 'Required to apply the PwD reservation and to reserve an accessible ground-floor room for you.'
  },
  ADDRESS_PROOF: {
    label: 'Permanent address proof',
    hint: 'Aadhaar, domicile certificate, ration card or a utility bill showing your permanent address.',
    why: 'Distance from your hometown affects both eligibility and your merit score, so the address on file must be verifiable.'
  }
};

var Documents = (function () {

  /**
   * The document set this specific applicant must supply.
   * @param {Object} student Students row
   * @return {Array<{docType, label, hint, why, mandatory}>}
   */
  function requiredFor(student) {
    var out = [];

    // Proof of enrolment: first-years have no ID card yet, continuing students do.
    if (Number(student.year) <= 1) {
      out.push(spec_('ADMISSION_LETTER'));
    } else {
      out.push(spec_('ID_CARD'));
    }

    // Category proof only where a reserved seat is actually being claimed.
    // Asking a General-category applicant for one would be pointless friction.
    if (student.category && student.category !== 'GEN') {
      var s = spec_('CATEGORY_CERT');
      s.label = student.category + ' category certificate';
      s.why = 'You are claiming a seat under the ' + student.category +
              ' category, which must be verified before a reserved seat is granted.';
      out.push(s);
    }

    if (student.isPwD) out.push(spec_('PWD_CERT'));

    // Everyone. Distance gates eligibility at the minimum-radius rule and
    // carries significant weight in the merit score, so an unverified home
    // address is the easiest way to game the allocation.
    out.push(spec_('ADDRESS_PROOF'));

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
    var existing = Db.where('Documents', { appId: appId });
    var have = {};
    existing.forEach(function (d) { have[d.docType] = true; });

    var rows = requiredFor(student)
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
    var rows = Db.where('Documents', { appId: appId });
    var byType = {};
    rows.forEach(function (d) { byType[d.docType] = d; });

    return requiredFor(student).map(function (req) {
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
