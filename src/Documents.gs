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
var DOC_TYPES = {
  ADMISSION_LETTER: {
    label: 'University admission slip',
    hint: 'The admission slip card issued when you took your seat in the university.',
    why: 'You are in your first year, so a college ID card has not been issued yet.'
  },
  ID_CARD: {
    label: 'College ID card',
    hint: 'A clear photo or scan of your current college identity card.',
    why: 'You are a continuing student, so your ID card is your proof of enrolment.'
  },
  MARKSHEET: {
    label: 'Marksheets',
    hint: 'Class 10 and 12 marksheets, or the marksheets of your preceding semesters.',
    why: 'Your position in the priority list is calculated from these marks, so they ' +
         'are the document the allotment order actually rests on.'
  },
  ACADEMIC_FEE_PROOF: {
    label: 'Proof of university fee payment',
    hint: 'The receipt for your academic fee for this session.',
    why: 'A hostel seat is offered only to a currently enrolled full-time student.'
  },
  CATEGORY_CERT: {
    label: 'Category certificate',
    hint: 'SC/ST caste certificate, OBC non-creamy-layer certificate, or EWS certificate.',
    why: 'You are claiming a seat under a reserved category, which must be verified.'
  },
  PWD_CERT: {
    label: 'Disability certificate',
    hint: 'UDID card, or a certificate from the Vocational Rehabilitation Centre.',
    why: 'Disabled applicants are the FIRST priority group for a hostel seat, so this ' +
         'certificate is what places you there.'
  },
  TRANSFER_CERT: {
    label: "Parent's transfer order",
    hint: 'The transfer order posting your parent out of Delhi (Central or State ' +
          'Government, PSU or an autonomous body under Government only).',
    why: 'You are claiming the third priority group, which is open to Delhi-category ' +
         'applicants whose parent has been transferred out of Delhi.'
  },
  ADDRESS_PROOF: {
    label: 'Permanent address proof',
    hint: 'Aadhaar, domicile certificate, ration card or a utility bill.',
    why: 'Delhi-category applicants are ordered by distance from campus, so the address ' +
         'on file decides your position.'
  },
  AADHAAR_PARENT: {
    label: "Aadhaar of parent",
    hint: "A copy of a parent's Aadhaar card.",
    why: 'Required with the hostel application form for every applicant.'
  },
  LOCAL_GUARDIAN: {
    label: "Local guardian's consent form",
    hint: 'The signed local guardian form, with a copy of their Aadhaar.',
    why: 'The hostel requires a local guardian who can be contacted in an emergency.'
  },
  MEDICAL_CERT: {
    label: 'Medical certificate',
    hint: 'Signed by a registered practitioner holding at least an MBBS, with their stamp.',
    why: 'Required at admission so the hostel knows of any condition needing care.'
  },
  ANTI_RAGGING: {
    label: 'Anti-ragging affidavit',
    hint: 'The UGC affidavit, signed by you and by a parent or guardian.',
    why: 'Required once, under the UGC Regulations on Curbing the Menace of Ragging.'
  },
  RULES_UNDERTAKING: {
    label: 'Undertaking on hostel rules',
    hint: 'Signed by you and by a parent or guardian.',
    why: 'Confirms that you and your parent have read the hostel regulations.'
  }
};

var Documents = (function () {

  /**
   * The document set this specific applicant must supply.
   * @param {Object} student Students row
   * @return {Array<{docType, label, hint, why, mandatory}>}
   */
  function requiredFor(student, app) {
    var out = [];
    var readmission = app && app.admissionType === 'READMISSION';

    // Proof of enrolment: a first-year has no ID card yet.
    if (Number(student.year) <= 1 && !readmission) out.push(spec_('ADMISSION_LETTER'));
    else out.push(spec_('ID_CARD'));

    // The marks the priority list is built from, and proof of enrolment fee.
    out.push(spec_('MARKSHEET'));
    out.push(spec_('ACADEMIC_FEE_PROOF'));

    // Only where a claim is actually being made.
    if (student.category && student.category !== 'GEN') {
      var c = spec_('CATEGORY_CERT');
      c.label = student.category + ' category certificate';
      c.why = 'You are claiming a seat under the ' + student.category +
              ' category, which must be verified before a reserved seat is granted.';
      out.push(c);
    }
    if (student.isPwD) out.push(spec_('PWD_CERT'));
    if (student.parentTransferred) out.push(spec_('TRANSFER_CERT'));

    // Distance decides the order within the Delhi group, so their address proof
    // carries real weight. Everyone supplies one, but say WHY it matters to them.
    var addr = spec_('ADDRESS_PROOF');
    if (student.residenceCategory !== 'DELHI') {
      addr.why = 'Confirms the permanent address on your application. Your group is ranked ' +
                 'on marks rather than distance, so this is a check rather than a factor.';
    }
    out.push(addr);

    out.push(spec_('AADHAAR_PARENT'));
    out.push(spec_('LOCAL_GUARDIAN'));
    out.push(spec_('MEDICAL_CERT'));

    // Once only. A returning resident who has already filed the affidavit is
    // not asked for it again, which is what the brochure says in as many words.
    if (!readmission) {
      out.push(spec_('ANTI_RAGGING'));
    }
    out.push(spec_('RULES_UNDERTAKING'));

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
