/**
 * Letters.gs - allotment letters as PDFs, with a signed verification QR.
 *
 * The QR resolves to a live page on this same web app that confirms the letter
 * is genuine. The URL carries an HMAC over the allotment id, so a forged letter
 * with a plausible-looking id fails verification instead of passing.
 *
 * PDF is produced from HTML rather than a Google Doc because the QR is a grid of
 * table cells: Docs-to-PDF mangles dense tables, HTML-to-PDF does not.
 */

var Letters = (function () {

  var SIG_LENGTH = 16;

  /**
   * The HMAC key, created once and kept in Script Properties.
   * If this key is lost every previously issued QR stops verifying, so it is
   * generated once and never rotated automatically.
   */
  function secret_() {
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('LETTER_HMAC_KEY');
    if (!key) {
      key = Utilities.getUuid() + '-' + Utilities.getUuid();
      props.setProperty('LETTER_HMAC_KEY', key);
    }
    return key;
  }

  /** Short hex HMAC over the allotment id. */
  function signature(allocId) {
    var raw = Utilities.computeHmacSha256Signature(String(allocId), secret_());
    return raw.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('').substring(0, SIG_LENGTH);
  }

  function verifies(allocId, sig) {
    if (!allocId || !sig) return false;
    var expected = signature(allocId);
    // Length-safe comparison. Timing is not a real concern here, but comparing
    // the whole string rather than short-circuiting costs nothing.
    if (expected.length !== String(sig).length) return false;
    var diff = 0;
    for (var i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ String(sig).charCodeAt(i);
    }
    return diff === 0;
  }

  function verifyUrl(allocId) {
    var base = '';
    try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
    return base + '?page=verify&id=' + encodeURIComponent(allocId) +
           '&sig=' + signature(allocId);
  }

  // ------------------------------------------------------------- gather data

  /** Everything one letter needs, in one pass. */
  function letterData(allocId) {
    var alloc = Db.byId('Allocations', allocId);
    if (!alloc) throw new Error('Letters: no allotment ' + allocId);

    var app = Db.byId('Applications', alloc.appId);
    var student = app ? Db.byId('Students', app.studentId) : null;
    var bed = Db.byId('Beds', alloc.bedId);
    var room = bed ? Db.byId('Rooms', bed.roomId) : null;
    var hostel = room ? Db.byId('Hostels', room.hostelId) : null;
    if (!student || !room || !hostel) throw new Error('Letters: incomplete records for ' + allocId);

    return {
      allocId: allocId, alloc: alloc, app: app, student: student,
      bed: bed, room: room, hostel: hostel,
      session: Db.cfg('ACADEMIC_YEAR', '2026') + '-' +
               String(Number(Db.cfg('ACADEMIC_YEAR', '2026')) + 1).slice(-2),
      institution: Db.cfg('INSTITUTION_NAME', 'Guru Gobind Singh Indraprastha University'),
      support: Db.cfg('SUPPORT_EMAIL', '')
    };
  }

  // ------------------------------------------------------------------- HTML

  function buildHtml(allocId) {
    var d = letterData(allocId);
    var qr = QrCode.encode(verifyUrl(allocId), { ec: 'M' });
    var qrHtml = QrCode.toHtmlTable(qr, 3, 3);
    var issued = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMMM yyyy');

    var roomLabel = { SINGLE: 'Single occupancy', DOUBLE: 'Double occupancy (2-seater)',
                      TRIPLE: 'Triple occupancy (3-seater)' }[d.room.roomType] || d.room.roomType;
    var campusLabel = { DWARKA: 'Dwarka Campus', EDC: 'East Delhi Campus' }[d.hostel.campus] ||
                      d.hostel.campus;

    return '<html><head><meta charset="utf-8"><style>' +
      'body{font-family:Georgia,"Times New Roman",serif;color:#111;margin:0;padding:34px 44px;font-size:12pt}' +
      '.hdr{text-align:center;border-bottom:2.5px solid #1f3864;padding-bottom:12px;margin-bottom:6px}' +
      '.uni{font-size:17pt;font-weight:bold;color:#1f3864;letter-spacing:.3px}' +
      '.est{font-size:9pt;color:#555;margin-top:2px}' +
      '.doct{text-align:center;font-size:13pt;font-weight:bold;margin:18px 0 4px;' +
        'text-transform:uppercase;letter-spacing:1.2px}' +
      '.sess{text-align:center;font-size:10pt;color:#555;margin-bottom:18px}' +
      '.meta{width:100%;font-size:10pt;color:#444;margin-bottom:16px}' +
      '.meta td{padding:0}' +
      'table.d{width:100%;border-collapse:collapse;margin:10px 0 16px}' +
      'table.d th,table.d td{border:1px solid #c9cfd8;padding:6px 9px;font-size:10.5pt;' +
        'text-align:left;vertical-align:top}' +
      'table.d th{background:#eef2f8;width:31%;font-weight:bold;color:#1f3864}' +
      '.sec{font-size:11pt;font-weight:bold;color:#1f3864;margin:16px 0 4px;' +
        'border-bottom:1px solid #c9cfd8;padding-bottom:3px}' +
      'ol.terms{font-size:10pt;margin:6px 0 0;padding-left:20px}' +
      'ol.terms li{margin-bottom:4px}' +
      '.foot{width:100%;margin-top:26px}' +
      '.foot td{vertical-align:bottom;font-size:10pt}' +
      '.sign{text-align:right}' +
      '.sigline{border-top:1px solid #333;display:inline-block;padding-top:3px;margin-top:44px;' +
        'min-width:190px;text-align:center}' +
      '.qrbox{text-align:center;font-size:8pt;color:#555;line-height:1.3}' +
      '.note{font-size:8.5pt;color:#666;margin-top:20px;border-top:1px solid #ddd;padding-top:8px}' +
      '</style></head><body>' +

      '<div class="hdr">' +
        '<div class="uni">' + esc_(d.institution) + '</div>' +
        '<div class="est">Sector 16C, Dwarka, New Delhi 110078 &middot; Office of the Dean of Student Welfare</div>' +
      '</div>' +

      '<div class="doct">Hostel Allotment Letter</div>' +
      '<div class="sess">Academic Session ' + esc_(d.session) + '</div>' +

      '<table class="meta"><tr>' +
        '<td>Ref: ' + esc_(d.allocId) + '</td>' +
        '<td style="text-align:right">Date of issue: ' + esc_(issued) + '</td>' +
      '</tr></table>' +

      '<p style="font-size:11pt;margin:0 0 10px">This is to certify that the student named below has ' +
      'been allotted hostel accommodation for the academic session ' + esc_(d.session) +
      ', in accordance with the hostel allotment policy of the University.</p>' +

      '<div class="sec">Student particulars</div>' +
      '<table class="d">' +
        row_('Name', d.student.name) +
        row_('Enrolment number', d.student.enrollmentNo) +
        row_('Programme', d.student.programme + ' (' + d.student.branch + '), Year ' + d.student.year) +
        row_('Category', d.student.category + (d.student.isPwD ? ' &middot; Person with Disability' : '')) +
        row_('Application ID', d.app.appId) +
      '</table>' +

      '<div class="sec">Accommodation allotted</div>' +
      '<table class="d">' +
        row_('Hostel', d.hostel.name) +
        row_('Campus', campusLabel) +
        row_('Room number', d.room.roomNo + '  (Block ' + d.room.block + ', Floor ' + d.room.floor + ')') +
        row_('Bed number', String(d.bed.bedNo)) +
        row_('Occupancy', roomLabel + (d.room.isAccessible ? ' &middot; Accessible room' : '')) +
        row_('Warden', d.hostel.warden) +
      '</table>' +

      '<div class="sec">Terms of allotment</div>' +
      '<ol class="terms">' +
        '<li>This allotment is valid for the academic session ' + esc_(d.session) +
          ' only and is not transferable to any other student.</li>' +
        '<li>The allottee must report to the hostel warden with this letter and the original ' +
          'documents submitted during verification.</li>' +
        '<li>Hostel fees must be paid in full by the notified deadline. Failure to do so will ' +
          'result in the allotment being cancelled and the seat offered to the waiting list.</li>' +
        '<li>The allottee is bound by the hostel rules and the disciplinary regulations of the ' +
          'University. Rooms may not be exchanged without written approval.</li>' +
        '<li>The University reserves the right to reallocate rooms where required for maintenance, ' +
          'accessibility, or disciplinary reasons.</li>' +
      '</ol>' +

      '<table class="foot"><tr>' +
        '<td style="width:34%" class="qrbox">' + qrHtml +
          '<div style="margin-top:5px">Scan to verify this letter</div>' +
          '<div>Ref ' + esc_(d.allocId) + '</div></td>' +
        '<td class="sign">' +
          '<div class="sigline">Warden, ' + esc_(d.hostel.name) + '</div>' +
          '<div style="margin-top:26px" class="sigline">Dean of Student Welfare</div>' +
        '</td>' +
      '</tr></table>' +

      '<div class="note">This letter was generated electronically and carries a verification code. ' +
      'Its authenticity can be confirmed at any time by scanning the QR code above, which resolves ' +
      'to the University hostel portal. A letter that does not verify should be treated as invalid. ' +
      (d.support ? 'Queries: ' + esc_(d.support) : '') + '</div>' +

      '</body></html>';
  }

  function row_(label, value) {
    return '<tr><th>' + esc_(label) + '</th><td>' + esc_(value) + '</td></tr>';
  }

  function esc_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // -------------------------------------------------------------------- PDF

  function toPdf(allocId) {
    var html = buildHtml(allocId);
    var name = 'Allotment-' + allocId + '.pdf';
    return Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);
  }

  /** Generate and file one letter in Drive. Returns the file URL. */
  function generate(allocId) {
    var blob = toPdf(allocId);
    var folder = lettersFolder_();
    // Replace an existing letter rather than accumulating duplicates.
    var existing = folder.getFilesByName(blob.getName());
    while (existing.hasNext()) existing.next().setTrashed(true);

    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    Ledger.append('LETTER_ISSUED', {
      allocId: allocId, fileId: file.getId(), signature: signature(allocId)
    }, 'system');
    return file.getUrl();
  }

  function lettersFolder_() {
    var id = Db.cfg('LETTER_FOLDER_ID', '');
    if (id) {
      try { return DriveApp.getFolderById(id); } catch (e) { /* fall through */ }
    }
    var root = DriveApp.getRootFolder();
    var it = root.getFoldersByName('GGSIPU Hostel Letters');
    var folder = it.hasNext() ? it.next() : root.createFolder('GGSIPU Hostel Letters');
    Db.setCfg('LETTER_FOLDER_ID', folder.getId());
    return folder;
  }

  /**
   * Generate letters for a whole run, in chunks.
   * Apps Script will not finish 700 PDFs in one execution, so this does a bounded
   * batch and reports what is left. The admin dashboard calls it repeatedly.
   */
  function generateBatch(runId, limit) {
    limit = limit || 25;
    var allocs = Db.where('Allocations', { runId: runId, status: 'ACTIVE' });
    var done = 0, remaining = 0;
    var startedAt = new Date().getTime();

    for (var i = 0; i < allocs.length; i++) {
      if (done >= limit || (new Date().getTime() - startedAt) > 240000) {
        remaining = allocs.length - i;
        break;
      }
      try { generate(allocs[i].allocId); done++; }
      catch (e) { Logger.log('Letter failed for ' + allocs[i].allocId + ': ' + e.message); }
    }
    return { generated: done, remaining: remaining, total: allocs.length };
  }

  /** Data behind the public verification page. */
  function verifyAllotment(allocId, sig) {
    if (!verifies(allocId, sig)) {
      return { valid: false, reason: 'The verification code does not match this reference number. ' +
                                     'This letter may have been altered or is not genuine.' };
    }
    var alloc = Db.byId('Allocations', allocId);
    if (!alloc) {
      return { valid: false, reason: 'No allotment exists with this reference number.' };
    }
    if (alloc.status !== 'ACTIVE') {
      return { valid: false, reason: 'This allotment is no longer active (' +
               String(alloc.status).toLowerCase() + '). A superseded letter is not valid for entry.' };
    }

    var d = letterData(allocId);
    return {
      valid: true,
      allocId: allocId,
      studentName: d.student.name,
      enrollmentNo: d.student.enrollmentNo,
      programme: d.student.programme + ' (' + d.student.branch + ')',
      hostel: d.hostel.name,
      campus: { DWARKA: 'Dwarka Campus', EDC: 'East Delhi Campus' }[d.hostel.campus] || d.hostel.campus,
      roomNo: d.room.roomNo,
      block: d.room.block,
      floor: d.room.floor,
      bedNo: d.bed.bedNo,
      warden: d.hostel.warden,
      session: d.session,
      allocatedAt: Utilities.formatDate(new Date(d.alloc.allocatedAt), 'Asia/Kolkata', 'd MMM yyyy'),
      checkedAt: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM yyyy, HH:mm')
    };
  }

  return {
    signature: signature,
    verifies: verifies,
    verifyUrl: verifyUrl,
    buildHtml: buildHtml,
    toPdf: toPdf,
    generate: generate,
    generateBatch: generateBatch,
    verifyAllotment: verifyAllotment,
    letterData: letterData
  };
})();
