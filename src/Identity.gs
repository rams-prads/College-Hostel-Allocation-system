/**
 * Identity.gs - RETIRED, and kept deliberately.
 *
 * Aadhaar is no longer collected anywhere in this system. The GGSIPU admission
 * confirmation page replaced it: every student holds one before they have a
 * college email address, it carries the same correspondence address, and it
 * additionally carries the four fields the allocation actually turns on - the
 * region the qualifying exam was passed in, the reservation category, the
 * disability sub-category and the qualifying percentage - none of which an
 * Aadhaar card carries and all of which were previously self-declared and
 * checked by nobody.
 *
 * What is left here is not dead weight. screen() is still the applicant-level
 * cross-check that the verification console shows, and it still finds reused
 * documents, malformed enrolment numbers, implausible ages and addresses that
 * do not resolve. Only the Aadhaar-specific parts are dormant: the vault, the
 * Verhoeff validation, and the submit/decide pair that the portal no longer
 * calls.
 *
 * They are kept rather than deleted because the decision to stop asking for
 * Aadhaar is a policy decision, and reversing it should be a configuration
 * change rather than a rewrite. Nothing writes to the Identity tab any more,
 * so nothing here runs unless something calls it.
 *
 * ---------------------------------------------------------------------------
 * Identity.gs - identity verification for hostel applicants.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This does NOT authenticate an Aadhaar number against UIDAI. Online e-KYC and
 * OTP authentication are available only to entities licensed by UIDAI as an AUA
 * or KUA. A university department is not one, and pretending otherwise would put
 * a claim in front of judges that the code cannot support.
 *
 * What it does instead is everything that CAN be established without UIDAI, and
 * does it properly:
 *
 *   1. Verhoeff check-digit validation. The twelfth digit of an Aadhaar number
 *      is a Verhoeff checksum. This catches every single-digit error, every
 *      transposition of adjacent digits, and roughly 90% of invented numbers.
 *      It proves a number is WELL FORMED, never that it belongs to the person.
 *   2. Enrolment-number validation against the university's own format.
 *   3. Automated cross-checks over the whole application, producing findings a
 *      human verifier reads before deciding.
 *   4. A recorded human decision, appended to the tamper-evident ledger.
 *
 * The identity assertion is therefore made by a person looking at a document.
 * That is what the hostel office does today; this makes it faster, consistent,
 * and auditable.
 *
 * HOW AADHAAR NUMBERS ARE STORED
 * ------------------------------
 * They are not. Storing Aadhaar numbers in a spreadsheet would be the single
 * worst security decision available here, and §29 of the Aadhaar Act 2016
 * restricts sharing identity information regardless.
 *
 * What is stored is a keyed hash - HMAC-SHA256 under a secret held in Script
 * Properties, never in the sheet and never in the repository - plus the last
 * four digits, which is what UIDAI itself permits for display. The hash is a
 * REFERENCE KEY: it lets the system detect two applicants claiming one identity
 * without ever holding the identity. It cannot be reversed, and because the key
 * lives outside the spreadsheet, someone who exfiltrates the entire sheet still
 * cannot test a guessed number against it.
 *
 * The raw number exists only as a local variable for the length of one request.
 * It is never written to a sheet, never placed in a ledger payload, never
 * logged, and never returned to the browser.
 */

var Identity = (function () {

  // ------------------------------------------------------------- Verhoeff

  /** Dihedral group D5 multiplication table. */
  var D5 = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];

  /** Permutation table, applied cyclically by digit position. */
  var PERM = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  /** Multiplicative inverse in D5. */
  var INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

  /**
   * Verhoeff checksum over a digit string. Returns 0 for a valid number.
   * Digits are consumed right to left, which is what makes the positional
   * permutation catch transpositions.
   */
  function verhoeffSum(digits) {
    var c = 0;
    for (var i = 0; i < digits.length; i++) {
      var d = digits.charCodeAt(digits.length - 1 - i) - 48;
      if (d < 0 || d > 9) return -1;
      c = D5[c][PERM[i % 8][d]];
    }
    return c;
  }

  /** True if the last digit is a correct Verhoeff check digit. */
  function verhoeffValid(digits) {
    return verhoeffSum(digits) === 0;
  }

  /** The check digit that would make `digits` (without one) valid. */
  function verhoeffDigit(digits) {
    return INV[verhoeffSum(String(digits) + '0')];
  }

  // -------------------------------------------------------------- Aadhaar

  /**
   * Validate an Aadhaar number's FORM. Never asserts ownership.
   * @return {{ok: boolean, reason: string, last4: string, digits: string}}
   *         `digits` is present only when ok, and the caller must not persist it.
   */
  function checkAadhaar(raw) {
    var digits = String(raw == null ? '' : raw).replace(/\D/g, '');

    if (!digits) {
      return fail_('Enter your 12-digit Aadhaar number.');
    }
    if (digits.length !== 12) {
      return fail_('An Aadhaar number is exactly 12 digits. You entered ' +
                   digits.length + '.');
    }
    // UIDAI never issues a number beginning 0 or 1, which keeps Aadhaar numbers
    // distinguishable from the older 11-digit enrolment IDs.
    if (digits.charAt(0) === '0' || digits.charAt(0) === '1') {
      return fail_('An Aadhaar number never begins with 0 or 1. Please check the number.');
    }
    if (/^(\d)\1{11}$/.test(digits)) {
      return fail_('That is not a valid Aadhaar number.');
    }
    if (!verhoeffValid(digits)) {
      // Deliberately vague about WHICH digit is wrong. Naming the position would
      // let someone repair an invented number one digit at a time.
      return fail_('That Aadhaar number failed its checksum. Please re-enter it ' +
                   'exactly as printed on your card.');
    }

    return {
      ok: true,
      reason: '',
      last4: digits.substring(8),
      digits: digits
    };
  }

  function fail_(reason) {
    return { ok: false, reason: reason, last4: '', digits: '' };
  }

  /** 'XXXX XXXX 1234' - the only form that may ever be displayed. */
  function mask(last4) {
    return last4 ? 'XXXX XXXX ' + last4 : '';
  }

  // ---------------------------------------------------------------- vault

  /**
   * The vault key. Generated once, held in Script Properties, never written to
   * the spreadsheet and never committed. Rotating it invalidates every stored
   * reference, which is the intended behaviour after a suspected key compromise.
   */
  function vaultKey_() {
    var props = PropertiesService.getScriptProperties();
    var k = props.getProperty('IDENTITY_VAULT_KEY');
    if (!k) {
      k = Utilities.getUuid() + '.' + Utilities.getUuid();
      props.setProperty('IDENTITY_VAULT_KEY', k);
    }
    return k;
  }

  /**
   * Irreversible reference key for an Aadhaar number.
   *
   * HMAC rather than a plain digest: a bare SHA-256 of a 12-digit number is
   * trivially brute-forced - the whole space is 10^12 and fits in an afternoon.
   * With a secret key held outside the spreadsheet, an attacker holding the
   * sheet cannot test candidate numbers at all.
   */
  function vaultRef(digits) {
    var sig = Utilities.computeHmacSha256Signature(String(digits), vaultKey_());
    return sig.map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    }).join('');
  }

  /**
   * Constant-time string comparison. Reference keys are compared on a path a
   * caller can trigger repeatedly, so an early-exit compare would leak how much
   * of a guess was correct through response timing.
   */
  function refsEqual(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ------------------------------------------------------------- enrolment

  /**
   * Validate an enrolment number against the university format.
   *
   * The pattern lives in the Policy sheet rather than in code. We do not have an
   * authoritative published spec for GGSIPU enrolment numbers, and hard-coding a
   * guess would reject real students - the worst possible failure for a
   * verification step. The default is deliberately permissive about structure
   * and strict about the things we KNOW: length, digits only, and that the
   * admission year encoded in it agrees with the declared year of study.
   */
  function checkEnrolment(raw, student) {
    var value = String(raw == null ? '' : raw).replace(/\s/g, '').toUpperCase();
    var findings = [];

    var pattern = String(Policy.value('identity', 'ENROLMENT_PATTERN', '^\\d{11}$'));
    var re;
    try { re = new RegExp(pattern); } catch (e) { re = /^\d{11}$/; }

    if (!value) {
      return { ok: false, reason: 'Enter your university enrolment number.', findings: findings };
    }
    if (!re.test(value)) {
      return {
        ok: false,
        reason: 'That does not look like a GGSIPU enrolment number. It should match ' +
                'the format printed on your ID card.',
        findings: findings
      };
    }

    // The admission year is encoded in the last two digits of the seeded format
    // (NNNNNPPYY). Where it is readable, it must agree with the declared year of
    // study - a fourth-year student cannot have been admitted last year.
    var yearOffset = Number(Policy.value('identity', 'ENROLMENT_YEAR_POS', 9));
    var yy = value.substring(yearOffset, yearOffset + 2);
    if (/^\d{2}$/.test(yy) && student && Number(student.year) > 0) {
      var admitted = 2000 + Number(yy);
      var thisYear = Number(Db.cfg('ACADEMIC_YEAR', '2026'));
      var impliedYear = thisYear - admitted + 1;
      if (impliedYear >= 1 && impliedYear <= 8 && impliedYear !== Number(student.year)) {
        findings.push({
          code: 'ENROLMENT_YEAR_MISMATCH',
          severity: 'REVIEW',
          text: 'The enrolment number indicates admission in ' + admitted +
                ', which would make this a year-' + impliedYear + ' student, but year ' +
                student.year + ' was declared.'
        });
      }
    }

    return { ok: true, reason: '', normalised: value, findings: findings };
  }

  // ------------------------------------------------------------- screening

  /**
   * Cross-check one application against everything else on file.
   *
   * This is where the real value is. Whether a document is genuine is a
   * judgement a person makes from the scan; whether the application is INTERNALLY
   * CONSISTENT is a question a machine answers better than a person reading four
   * hundred of them. Each finding is evidence handed to the verifier, never a
   * decision taken on their behalf.
   *
   * @return {{score: number, level: string, findings: Array}}
   */
  function screen(appId) {
    var findings = [];
    var app = Db.byId('Applications', appId);
    if (!app) return { score: 0, level: 'UNKNOWN', findings: findings };

    var student = Db.byId('Students', app.studentId);
    if (!student) {
      return {
        score: 100, level: 'HIGH',
        findings: [{ code: 'NO_STUDENT_RECORD', severity: 'BLOCK',
                     text: 'No student record is linked to this application.' }]
      };
    }

    var idRow = Db.byId('Identity', student.studentId);

    // --- 1. one identity, one application --------------------------------
    if (idRow && idRow.aadhaarRef) {
      var sharing = Db.readAll('Identity').filter(function (r) {
        return r.studentId !== student.studentId && refsEqual(r.aadhaarRef, idRow.aadhaarRef);
      });
      if (sharing.length) {
        findings.push({
          code: 'AADHAAR_REUSED', severity: 'BLOCK',
          text: 'The same Aadhaar number is registered against ' + sharing.length +
                ' other student record(s): ' +
                sharing.map(function (r) { return r.studentId; }).join(', ') + '.'
        });
      }
    }

    // --- 2. one enrolment number, one person ------------------------------
    var enrol = String(student.enrollmentNo || '').trim().toUpperCase();
    if (enrol) {
      var twins = Db.readAll('Students').filter(function (s) {
        return s.studentId !== student.studentId &&
               String(s.enrollmentNo || '').trim().toUpperCase() === enrol;
      });
      if (twins.length) {
        findings.push({
          code: 'ENROLMENT_REUSED', severity: 'BLOCK',
          text: 'Enrolment number ' + enrol + ' also appears on ' +
                twins.map(function (s) { return s.studentId; }).join(', ') + '.'
        });
      }
    }

    var enrolCheck = checkEnrolment(student.enrollmentNo, student);
    if (!enrolCheck.ok) {
      findings.push({ code: 'ENROLMENT_MALFORMED', severity: 'REVIEW', text: enrolCheck.reason });
    }
    (enrolCheck.findings || []).forEach(function (f) { findings.push(f); });

    // --- 3. the same file uploaded by two people --------------------------
    // A recycled scan is one of the few fraud signals available offline, and it
    // is decisive: two applications cannot legitimately hold byte-identical
    // documents.
    var myDocs = Db.where('Documents', { appId: appId })
      .filter(function (d) { return d.contentHash; });
    if (myDocs.length) {
      var mine = {};
      myDocs.forEach(function (d) { mine[d.contentHash] = d.docType; });
      var collisions = Db.readAll('Documents').filter(function (d) {
        return d.appId !== appId && d.contentHash && mine[d.contentHash];
      });
      collisions.forEach(function (d) {
        findings.push({
          code: 'DOCUMENT_REUSED', severity: 'BLOCK',
          text: 'The ' + (mine[d.contentHash] || 'uploaded') + ' file is byte-identical to ' +
                'a document uploaded by application ' + d.appId + '.'
        });
      });
    }

    // A category or PwD claim is verified against the certificate at the
    // counter, not here - those documents are no longer collected through the
    // portal, and a finding that asks for one nobody uploads is noise.

    // --- 5. does the address stand up? ------------------------------------
    var geo = Geo.distanceFromHome(student.homePincode, student.campus);
    if (!geo.resolved) {
      findings.push({
        code: 'PIN_UNRESOLVED', severity: 'INFO',
        text: 'The home PIN code is not in the reference table, so distance was not ' +
              'computed automatically. Confirm it against the address proof.'
      });
    } else if (student.homeState && geo.state &&
               String(student.homeState).toLowerCase() !== String(geo.state).toLowerCase()) {
      findings.push({
        code: 'STATE_MISMATCH', severity: 'REVIEW',
        text: 'PIN code ' + student.homePincode + ' is in ' + geo.state +
              ', but the record says ' + student.homeState + '.'
      });
    }

    var minDist = Number(Policy.value('eligibility', 'MIN_DISTANCE_KM', 30));
    if (geo.resolved && Math.abs(geo.km - minDist) <= 5) {
      findings.push({
        code: 'DISTANCE_BORDERLINE', severity: 'INFO',
        text: 'Home is ' + geo.km + ' km away, within 5 km of the ' + minDist +
              ' km eligibility threshold. Check the address proof carefully - this is ' +
              'the boundary worth misstating.'
      });
    }

    // --- 6. is the person plausible for the course? -----------------------
    if (student.dob) {
      var age = ageAt_(student.dob);
      if (age !== null && (age < 15 || age > 60)) {
        findings.push({
          code: 'AGE_IMPLAUSIBLE', severity: 'REVIEW',
          text: 'Declared date of birth gives an age of ' + age + '.'
        });
      }
    }

    // --- 7. self-declared records have had nothing checked ----------------
    if (student.selfDeclared && (!idRow || idRow.status !== 'VERIFIED')) {
      findings.push({
        code: 'SELF_DECLARED', severity: 'INFO',
        text: 'Every field on this record was typed by the applicant and none has been ' +
              'checked against a document yet.'
      });
    }

    return summarise_(findings);
  }

  /** Weight findings into a single score the queue can sort on. */
  function summarise_(findings) {
    var WEIGHT = { BLOCK: 50, REVIEW: 15, INFO: 3 };
    var score = 0;
    findings.forEach(function (f) { score += WEIGHT[f.severity] || 0; });
    score = Math.min(100, score);

    var level = 'LOW';
    if (findings.some(function (f) { return f.severity === 'BLOCK'; })) level = 'HIGH';
    else if (score >= 15) level = 'MEDIUM';

    return { score: score, level: level, findings: findings };
  }

  function ageAt_(dob) {
    var d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var age = now.getFullYear() - d.getFullYear();
    var m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Record an applicant's identity claim.
   *
   * `aadhaar` is consumed and discarded. What survives this function is a keyed
   * hash and four digits.
   */
  function submit(studentId, aadhaarRaw) {
    var student = Db.byId('Students', studentId);
    if (!student) throw new Error('No student record found.');

    var a = checkAadhaar(aadhaarRaw);
    if (!a.ok) throw new Error(a.reason);

    var ref = vaultRef(a.digits);

    // Refuse the duplicate at the door. Letting it through and flagging it later
    // would mean two live applications against one identity in the meantime.
    var clash = Db.readAll('Identity').filter(function (r) {
      return r.studentId !== studentId && refsEqual(r.aadhaarRef, ref);
    })[0];
    if (clash) {
      throw new Error('This Aadhaar number is already registered against another student ' +
                      'record. If you believe this is an error, contact the hostel office - ' +
                      'do not register a second time.');
    }

    var existing = Db.byId('Identity', studentId);
    var row = {
      studentId: studentId,
      aadhaarRef: ref,
      aadhaarLast4: a.last4,
      enrolmentNorm: String(student.enrollmentNo || '').trim().toUpperCase(),
      status: 'SUBMITTED',
      riskScore: 0,
      findingsJson: [],
      submittedAt: new Date(),
      verifiedBy: '',
      verifiedAt: '',
      note: ''
    };

    if (existing) {
      // A verified identity is not re-openable by the student. Changing it after
      // verification would silently invalidate the check that was performed.
      if (existing.status === 'VERIFIED') {
        throw new Error('Your identity has already been verified and cannot be changed. ' +
                        'Contact the hostel office if something is wrong.');
      }
      Db.update('Identity', studentId, row);
    } else {
      Db.append('Identity', row);
    }

    // The ledger records THAT an identity was submitted, never what it was.
    Ledger.append('IDENTITY_SUBMITTED', {
      studentId: studentId, last4: a.last4, refPrefix: ref.substring(0, 8)
    }, student.email);

    return { ok: true, masked: mask(a.last4) };
  }

  /** A verifier's decision on one identity. */
  function decide(studentId, approve, verifier, note) {
    var row = Db.byId('Identity', studentId);
    if (!row) throw new Error('No identity record for ' + studentId + '.');

    Db.update('Identity', studentId, {
      status: approve ? 'VERIFIED' : 'REJECTED',
      verifiedBy: verifier,
      verifiedAt: new Date(),
      note: note || ''
    });

    Ledger.append(approve ? 'IDENTITY_VERIFIED' : 'IDENTITY_REJECTED', {
      studentId: studentId, last4: row.aadhaarLast4, note: note || ''
    }, verifier);

    return { ok: true, status: approve ? 'VERIFIED' : 'REJECTED' };
  }

  /** Store the latest screening result against the identity row. */
  function rescreen(appId) {
    var app = Db.byId('Applications', appId);
    if (!app) return null;
    var result = screen(appId);
    if (Db.byId('Identity', app.studentId)) {
      Db.update('Identity', app.studentId, {
        riskScore: result.score, findingsJson: result.findings
      });
    }
    return result;
  }

  /** What the student is allowed to see about their own identity record. */
  /**
   * Send a verified identity back for checking.
   *
   * Called when the name or enrolment number the check was made against is
   * corrected. Silently doing nothing to an identity that was never verified is
   * the point: this is a downgrade, never an upgrade, so it cannot be used to
   * push a record forward.
   */
  function reopen(studentId, why, actor) {
    var row = Db.byId('Identity', studentId);
    if (!row || row.status !== 'VERIFIED') return false;
    Db.update('Identity', studentId, {
      status: 'SUBMITTED', verifiedBy: '', verifiedAt: '',
      note: 'Sent back for checking because ' + why + '.'
    });
    Ledger.append('IDENTITY_REOPENED', { studentId: studentId, why: why },
      actor || 'system');
    return true;
  }

  function statusFor(studentId) {
    var row = Db.byId('Identity', studentId);
    if (!row) {
      return { status: 'REQUIRED', masked: '', note: '',
               help: 'Add your Aadhaar number so the hostel office can match it to your ' +
                     'address proof. Only the last four digits are ever stored.' };
    }
    return {
      status: row.status,
      masked: mask(row.aadhaarLast4),
      note: row.note || '',
      verifiedAt: row.verifiedAt || '',
      help: {
        SUBMITTED: 'Waiting for the hostel office to check it against your documents.',
        VERIFIED: 'Your identity has been verified against your documents.',
        REJECTED: 'The hostel office could not verify your identity. See the note below.'
      }[row.status] || ''
    };
  }

  return {
    verhoeffValid: verhoeffValid,
    verhoeffDigit: verhoeffDigit,
    checkAadhaar: checkAadhaar,
    checkEnrolment: checkEnrolment,
    mask: mask,
    vaultRef: vaultRef,
    refsEqual: refsEqual,
    screen: screen,
    rescreen: rescreen,
    submit: submit,
    decide: decide,
    reopen: reopen,
    statusFor: statusFor
  };
})();
