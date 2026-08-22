/**
 * DocScan.gs - read the uploaded document and check it against what was declared.
 *
 * THE PROBLEM
 * -----------
 * Distance from home decides eligibility and carries weight in the merit score,
 * so the home address is the single most valuable field to misstate. Checking it
 * by hand means an officer opening several hundred scans before a run, which is
 * slow enough that in practice it does not happen and the declaration stands
 * unverified. Both outcomes are bad.
 *
 * WHAT IS EXTRACTED, AND WHY IT IS NOT THE ADDRESS
 * ------------------------------------------------
 * Not the address. The PIN CODE.
 *
 * Matching free-text addresses out of OCR is hopeless and, worse, pointless.
 * Hopeless because a scanned Aadhaar carries two scripts, line breaks in
 * arbitrary places, abbreviations that vary by writer, and OCR noise on every
 * one of them. Pointless because none of that reaches the allocator: eligibility
 * and score are computed from the PIN code alone. "House 4, Shivaji Nagar" and
 * "H.No 4, Shivajinagar" are the same input to this system.
 *
 * A PIN code is six digits, printed in a predictable place, resilient to OCR
 * error in everything around it, and checkable against our own geography table.
 * It is also exactly the field that has to be wrong for the fraud to work. So
 * that is what is read, and the rest of the address is ignored on purpose.
 *
 * Alongside it: the person's name, to catch somebody else's document, and on a
 * college ID the enrolment number.
 *
 * WHAT THIS CANNOT DO
 * -------------------
 * It cannot tell a forged document from a real one. OCR reads what is printed.
 * A convincing fake carrying a distant PIN code passes this check, and should -
 * detecting forgery is a human's job and always was.
 *
 * The claim is narrower and still worth a great deal: THE DECLARED ADDRESS
 * AGREES WITH THE DOCUMENT SUPPLIED. That catches the ordinary case, which is a
 * real document uploaded next to a typed address that does not match it, and it
 * reduces the officer's queue from every applicant to the ones who disagree.
 *
 * MATERIALITY
 * -----------
 * A mismatch is only raised when it CHANGES SOMETHING. A student who declares a
 * PIN 4 km from the one on their document has made a clerical error; both are
 * 1,400 km from campus, both are eligible, and their merit score is unchanged.
 * Sending that to a person is how a queue of five hundred is rebuilt out of the
 * queue of eight this exists to produce.
 */

var DocScan = (function () {

  // ------------------------------------------------------------------- OCR

  /**
   * Text of a Drive file, via Google's own OCR.
   *
   * Converting an image or PDF to a Google Doc runs OCR as a side effect, which
   * is free and needs no third-party service or key. The temporary Doc is
   * deleted immediately - it holds the applicant's identity document, and it has
   * no business outliving the read.
   *
   * @return {{ok: boolean, text: string, reason: string}}
   */
  function ocrText(driveFileId) {
    if (!driveFileId) return { ok: false, text: '', reason: 'No file attached.' };

    var tempId = null;
    try {
      var blob = DriveApp.getFileById(driveFileId).getBlob();

      // Advanced Drive service. v3 first, v2 as the fallback - Apps Script
      // projects may have either enabled.
      var created;
      if (typeof Drive === 'undefined' || !Drive.Files) {
        return {
          ok: false, text: '',
          reason: 'The Drive advanced service is not enabled for this project, so ' +
                  'documents cannot be read automatically.'
        };
      }
      if (Drive.Files.create) {
        created = Drive.Files.create(
          { name: 'ocr-scratch', mimeType: 'application/vnd.google-apps.document' },
          blob, { ocrLanguage: 'en' });
      } else {
        created = Drive.Files.insert(
          { title: 'ocr-scratch', mimeType: 'application/vnd.google-apps.document' },
          blob, { ocr: true, ocrLanguage: 'en' });
      }
      tempId = created.id;

      var text = DocumentApp.openById(tempId).getBody().getText() || '';
      return { ok: true, text: text, reason: '' };

    } catch (e) {
      return { ok: false, text: '', reason: 'Could not read the document: ' + e.message };
    } finally {
      // Always, including after a throw. A copy of somebody's Aadhaar left in
      // Drive because the parse failed is the worst possible failure mode.
      if (tempId) {
        try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) { /* nothing further to do */ }
      }
    }
  }

  // -------------------------------------------------------------- extraction

  /**
   * Every plausible Indian PIN code in the text.
   *
   * Six digits, first digit 1-8 (0 and 9 are not issued as leading digits), not
   * part of a longer run of digits - which is what keeps an Aadhaar number, a
   * phone number or an enrolment number from being read as a PIN. OCR routinely
   * splits a PIN as "411 038", so a single space or hyphen inside is tolerated.
   */
  function pincodes(text) {
    var out = [], seen = {};
    var re = /(?:^|[^\d])([1-8]\d{2})[\s-]?(\d{3})(?![\d])/g;
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
      var pin = m[1] + m[2];
      if (!seen[pin]) { seen[pin] = true; out.push(pin); }
    }
    return out;
  }

  /** Last four digits of any Aadhaar-shaped number, however it is spaced. */
  function aadhaarLast4(text) {
    var out = [], seen = {};
    var re = /(?:^|[^\d])(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d])/g;
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
      var last = m[3];
      if (!seen[last]) { seen[last] = true; out.push(last); }
    }
    return out;
  }

  /** Digit runs long enough to be an enrolment number. */
  function longNumbers(text, length) {
    var out = [], seen = {};
    var re = new RegExp('(?:^|[^\\d])(\\d{' + length + '})(?![\\d])', 'g');
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
    }
    return out;
  }

  // ------------------------------------------------------------ name matching

  function norm_(s) {
    return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Edit distance, capped - we only ever care whether it is 0, 1 or 2. */
  function editDistance_(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 99;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /**
   * How much of a declared name appears in the document text, 0..1.
   *
   * Token-wise with a one-character tolerance, because OCR turns rn into m and
   * l into 1 far more often than it loses a whole word. Short tokens are ignored:
   * initials and honorifics match everything and prove nothing.
   */
  function nameScore(declared, text) {
    var want = norm_(declared).split(' ').filter(function (t) { return t.length >= 3; });
    if (!want.length) return 0;
    var have = norm_(text).split(' ');

    var hits = 0;
    want.forEach(function (t) {
      var found = have.some(function (h) {
        if (h === t) return true;
        return t.length >= 5 && editDistance_(t, h) <= 1;
      });
      if (found) hits++;
    });
    return hits / want.length;
  }

  // ---------------------------------------------------------------- the check

  /**
   * Compare one uploaded document against the student record.
   *
   * @return {{verdict, findings: Array, detail: Object}}
   *   MATCH        the document supports what was declared
   *   CONFLICT     it contradicts it, in a way that changes the outcome
   *   MINOR        it differs, but nothing about the allocation changes
   *   UNREADABLE   nothing usable came back from OCR
   */
  function checkDocument(doc, student, reader) {
    var findings = [];
    var detail = { docType: doc.docType };

    // The reader is a parameter so the rest of this - extraction, matching,
    // materiality, all the parts that can be subtly wrong - can be exercised
    // against known text. It also means the OCR provider can be replaced without
    // touching any of the logic that depends on it.
    var read = (reader || ocrText)(doc.driveFileId);
    // Raw length, not letters-only: a document is unreadable when nothing came
    // back, and stripping the digits first would have called a card that scanned
    // perfectly but carries a short name unreadable.
    if (!read.ok || String(read.text || '').trim().length < 20) {
      return {
        verdict: 'UNREADABLE',
        findings: [{ code: 'DOC_UNREADABLE', severity: 'REVIEW',
                     text: 'The ' + (doc.docType === 'ID_CARD' ? 'ID card' : 'document') +
                           ' could not be read automatically' +
                           (read.reason ? ' (' + read.reason + ')' : '') +
                           ', so it needs a person to look at it.' }],
        detail: detail
      };
    }

    var text = read.text;

    // --- is this even this student's document? ---------------------------
    var nScore = nameScore(student.name, text);
    detail.nameScore = Math.round(nScore * 100) / 100;
    if (nScore < 0.5) {
      findings.push({
        code: 'NAME_NOT_ON_DOCUMENT', severity: 'BLOCK',
        text: 'The name "' + student.name + '" does not appear on the uploaded ' +
              'document. It may belong to somebody else.'
      });
    }

    // --- the college ID proves enrolment, not address --------------------
    if (doc.docType === 'ID_CARD') {
      var enrol = String(student.enrollmentNo || '').replace(/\D/g, '');
      if (enrol) {
        var numbers = longNumbers(text, enrol.length).concat(longNumbers(text, enrol.length + 1));
        detail.enrolmentFound = numbers.indexOf(enrol) >= 0;
        if (!detail.enrolmentFound) {
          findings.push({
            code: 'ENROLMENT_NOT_ON_DOCUMENT', severity: 'REVIEW',
            text: 'Enrolment number ' + student.enrollmentNo + ' was not found on the ' +
                  'document. It may be printed in a form the scan could not read.'
          });
        }
      }
      return { verdict: verdictOf_(findings), findings: findings, detail: detail };
    }

    // --- the Aadhaar: everything hinges on the PIN code ------------------
    // It is the identity document and the address proof at once, which is why
    // it is the one document asked of everybody.
    var declared = String(student.homePincode || '').replace(/\D/g, '');
    var found = pincodes(text);
    detail.declaredPincode = declared;
    detail.pincodesFound = found;

    if (!found.length) {
      findings.push({
        code: 'NO_PINCODE_ON_DOCUMENT', severity: 'REVIEW',
        text: 'No PIN code could be read from the Aadhaar card, so the distance ' +
              'from home could not be confirmed automatically.'
      });
      return { verdict: 'UNREADABLE', findings: findings, detail: detail };
    }

    if (found.indexOf(declared) >= 0) {
      detail.pincodeConfirmed = true;
      return { verdict: verdictOf_(findings), findings: findings, detail: detail };
    }

    // The declared PIN is not on the document. Whether that matters depends
    // entirely on whether it would have changed the outcome.
    var assessment = materiality_(declared, found, student.campus);
    detail.declaredKm = assessment.declaredKm;
    detail.documentKm = assessment.documentKm;
    detail.material = assessment.material;

    if (assessment.material) {
      findings.push({
        code: 'ADDRESS_CONFLICT', severity: 'BLOCK',
        text: assessment.text
      });
      return { verdict: 'CONFLICT', findings: findings, detail: detail };
    }

    findings.push({
      code: 'ADDRESS_MINOR_DIFFERENCE', severity: 'INFO',
      text: assessment.text
    });
    return { verdict: findings.some(isBlocking_) ? 'CONFLICT' : 'MINOR',
             findings: findings, detail: detail };
  }

  function isBlocking_(f) { return f.severity === 'BLOCK'; }

  function verdictOf_(findings) {
    if (findings.some(isBlocking_)) return 'CONFLICT';
    if (findings.some(function (f) { return f.severity === 'REVIEW'; })) return 'UNREADABLE';
    return 'MATCH';
  }

  /**
   * Would believing the document instead of the declaration change anything?
   *
   * Two ways it can: the applicant crosses the eligibility threshold, or their
   * distance moves far enough to move their merit score. Anything smaller is a
   * clerical difference and is recorded, not raised.
   */
  function materiality_(declared, found, campus) {
    var minDist = Number(Policy.value('eligibility', 'MIN_DISTANCE_KM', 30));
    var tolerance = Number(Policy.value('eligibility', 'ADDRESS_TOLERANCE_KM', 50));

    var d = Geo.distanceFromHome(declared, campus);
    var declaredKm = d.resolved ? d.km : -1;

    var worst = null;
    found.forEach(function (pin) {
      var g = Geo.distanceFromHome(pin, campus);
      if (!g.resolved) return;
      var flips = (declaredKm >= minDist) !== (g.km >= minDist);
      var gap = Math.abs(g.km - declaredKm);
      var score = (flips ? 1e6 : 0) + gap;
      if (!worst || score > worst.score) {
        worst = { pin: pin, km: g.km, flips: flips, gap: gap, score: score, place: g.district };
      }
    });

    if (!worst) {
      return {
        material: false, declaredKm: declaredKm, documentKm: -1,
        text: 'The PIN code on the document (' + found.join(', ') + ') is not in the ' +
              'reference table, so it could not be compared.'
      };
    }

    if (worst.flips) {
      var gained = declaredKm >= minDist;
      return {
        material: true, declaredKm: declaredKm, documentKm: worst.km,
        text: 'Declared PIN ' + declared + ' is ' + declaredKm + ' km from campus, but the ' +
              'document shows ' + worst.pin + ' (' + worst.place + '), ' + worst.km + ' km. ' +
              'That crosses the ' + minDist + ' km eligibility line' +
              (gained ? ' — the declared address qualifies for a hostel place and the one on ' +
                        'the document does not.' : '.')
      };
    }

    if (worst.gap > tolerance) {
      return {
        material: true, declaredKm: declaredKm, documentKm: worst.km,
        text: 'Declared PIN ' + declared + ' is ' + declaredKm + ' km from campus; the ' +
              'document shows ' + worst.pin + ' (' + worst.place + ') at ' + worst.km +
              ' km. The ' + Math.round(worst.gap) + ' km difference is large enough to ' +
              'change the distance component of the merit score.'
      };
    }

    return {
      material: false, declaredKm: declaredKm, documentKm: worst.km,
      text: 'The document shows PIN ' + worst.pin + ' rather than the declared ' + declared +
            ', but both are about the same distance from campus (' + declaredKm + ' km vs ' +
            worst.km + ' km), so nothing about the allocation changes.'
    };
  }

  return {
    ocrText: ocrText,
    pincodes: pincodes,
    aadhaarLast4: aadhaarLast4,
    longNumbers: longNumbers,
    nameScore: nameScore,
    checkDocument: checkDocument
  };
})();
