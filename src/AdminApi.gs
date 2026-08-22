/**
 * AdminApi.gs - server functions for the administrator dashboard.
 *
 * Every function here starts with Auth.requireAdmin(). The web app is deployed
 * "execute as me", so a student calling these directly from the console would
 * otherwise run them with the deployer's full permissions.
 *
 * The one exception is apiVerifyAllotment, which is deliberately public: a
 * warden at the gate must be able to scan a letter without signing in.
 */

/** Everything the dashboard needs in one round trip. */
function apiAdminOverview() {
  var s = Auth.requireAdmin();

  var apps = Db.readAll('Applications');
  var beds = Db.readAll('Beds');
  var rooms = Db.indexBy('Rooms', 'roomId');
  var hostels = Db.readAll('Hostels');
  var runs = Db.readAll('Runs');
  var latest = runs.length ? runs[runs.length - 1] : null;

  var byStatus = {};
  apps.forEach(function (a) { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });

  // Occupancy per hostel, which is the vacancy-tracking view the problem
  // statement asks for.
  var occupancy = hostels.map(function (h) {
    var hb = beds.filter(function (b) {
      var r = rooms[b.roomId];
      return r && r.hostelId === h.hostelId;
    });
    var occupied = hb.filter(function (b) { return b.status === 'OCCUPIED'; }).length;
    return {
      hostelId: h.hostelId, name: h.name, campus: h.campus, gender: h.gender,
      total: hb.length, occupied: occupied, vacant: hb.length - occupied,
      pct: hb.length ? Math.round(100 * occupied / hb.length) : 0
    };
  });

  var chain = Ledger.verify();

  var docQueue = Db.readAll('Documents').filter(function (d) {
    return d.status === 'UPLOADED';
  }).length;

  return {
    admin: { email: s.email, name: s.name, role: s.role, campus: s.campus },
    counts: {
      applications: apps.length,
      allotted: byStatus.ALLOTTED || 0,
      waitlisted: byStatus.WAITLISTED || 0,
      rejected: byStatus.REJECTED || 0,
      submitted: byStatus.SUBMITTED || 0,
      draft: byStatus.DRAFT || 0,
      withdrawn: byStatus.WITHDRAWN || 0
    },
    capacity: {
      beds: beds.length,
      occupied: beds.filter(function (b) { return b.status === 'OCCUPIED'; }).length,
      vacant: beds.filter(function (b) { return b.status === 'VACANT'; }).length
    },
    occupancy: occupancy,
    latestRun: latest ? {
      runId: latest.runId, mode: latest.mode, seed: latest.seed,
      policyHash: latest.policyHash, notes: latest.notes,
      finishedAt: fmtDate_(latest.finishedAt),
      metrics: typeof latest.metricsJson === 'string'
        ? JSON.parse(latest.metricsJson) : latest.metricsJson
    } : null,
    ledger: {
      intact: chain.intact, length: chain.length,
      reason: chain.reason, brokenAt: chain.brokenAt
    },
    docQueue: docQueue,
    email: {
      enabled: Notify.enabled(),
      remainingQuota: Notify.remainingQuota(),
      sent: Db.readAll('Notifications').filter(function (n) { return n.status === 'SENT'; }).length,
      queued: Db.readAll('Notifications').filter(function (n) { return n.status === 'QUEUED'; }).length
    },
    policy: Policy.describe()
  };
}

/** Run the allocation and commit it. */
function apiAdminRunAllocation(opts) {
  var s = Auth.requireAdmin();
  if (!Auth.canCommit(s)) {
    throw new Error('Your role (' + s.role + ') may view allocations but not commit them.');
  }
  opts = opts || {};
  var result = Allocator.runAndCommit({
    seed: opts.seed || ('GGSIPU-' + Db.cfg('ACADEMIC_YEAR', '2026')),
    triggeredBy: s.email
  });
  return {
    runId: result.runId,
    elapsedSec: result.elapsedSec,
    metrics: result.metrics,
    converted: result.converted
  };
}

/** Run WITHOUT committing - the read-only preview the simulator builds on. */
function apiAdminPreviewAllocation(opts) {
  Auth.requireAdmin();
  opts = opts || {};
  var result = Allocator.run({
    seed: opts.seed || ('GGSIPU-' + Db.cfg('ACADEMIC_YEAR', '2026'))
  });
  return { runId: result.runId, metrics: result.metrics, converted: result.converted };
}

/**
 * Mint a read-only demo link for one application.
 *
 * Admin-only, ledger-recorded, and refused outright unless ALLOW_DEMO_LINKS is
 * TRUE in Config - so turning it on is a deliberate act with a record, not a
 * default nobody noticed.
 */
function apiAdminDemoLink(appId, hours) {
  var s = Auth.requireAdmin();
  if (!Auth.demoEnabled()) {
    throw new Error('Demo links are switched off. Set ALLOW_DEMO_LINKS to TRUE in the ' +
                    'Config sheet to enable them, and switch it back off afterwards.');
  }
  var app = Db.byId('Applications', appId);
  if (!app) throw new Error('No such application.');

  var token = Auth.demoToken(appId, hours || 24);
  Ledger.append('DEMO_LINK_ISSUED', {
    appId: appId, hours: Number(hours) || 24
  }, s.email);

  return {
    url: (function () {
      try { return ScriptApp.getService().getUrl() + '?demo=' + encodeURIComponent(token); }
      catch (e) { return '?demo=' + encodeURIComponent(token); }
    })(),
    expiresInHours: Number(hours) || 24
  };
}

/**
 * Read every document that has not been read yet.
 *
 * Batched, because OCR takes seconds per file and Apps Script stops a script at
 * six minutes. Returns how many are left so the caller can simply call again -
 * a resumable loop is more honest than a progress bar over a job that might be
 * killed halfway.
 */
function apiAdminScanDocuments(batch) {
  Auth.requireAdmin();
  batch = Math.min(Number(batch) || 25, 60);

  var stu = Db.indexBy('Students', 'studentId');
  var apps = Db.indexBy('Applications', 'appId');

  var pending = Db.readAll('Documents').filter(function (d) {
    return d.driveFileId && (!d.scanVerdict || d.scanVerdict === 'UNSCANNED');
  });

  var done = 0, tally = {};
  pending.slice(0, batch).forEach(function (d) {
    var app = apps[d.appId];
    var student = app ? stu[app.studentId] : null;
    if (!student) return;
    try {
      var v = Documents.scanIfNeeded(d, student, false);
      if (v) { tally[v] = (tally[v] || 0) + 1; done++; }
    } catch (e) { /* one unreadable file must not stop the batch */ }
  });

  return { scanned: done, remaining: Math.max(pending.length - done, 0), byVerdict: tally };
}

/**
 * How much of the queue actually needs a person.
 *
 * This is the number the whole feature exists to move. An officer who has to
 * open five hundred scans before a run will not do it, and the declaration goes
 * unchecked - which is the situation this replaced.
 */
function apiAdminVerificationSummary() {
  Auth.requireAdmin();
  var docs = Db.readAll('Documents').filter(function (d) { return d.driveFileId; });

  var byVerdict = { MATCH: 0, MINOR: 0, CONFLICT: 0, UNREADABLE: 0, UNSCANNED: 0 };
  docs.forEach(function (d) {
    var v = d.scanVerdict || 'UNSCANNED';
    byVerdict[v] = (byVerdict[v] || 0) + 1;
  });

  var needsPerson = docs.filter(function (d) {
    return d.status === 'UPLOADED' &&
           (d.scanVerdict === 'CONFLICT' || d.scanVerdict === 'UNREADABLE');
  }).length;

  var clearable = docs.filter(function (d) {
    return d.status === 'UPLOADED' && (d.scanVerdict === 'MATCH' || d.scanVerdict === 'MINOR');
  }).length;

  return {
    total: docs.length,
    byVerdict: byVerdict,
    needsPerson: needsPerson,
    clearable: clearable,
    unscanned: byVerdict.UNSCANNED || 0
  };
}

/**
 * Mark every document that agrees with its declaration as verified.
 *
 * Deliberately an explicit action, not something an upload does by itself.
 * Somebody has to decide that reading the document is good enough for the clean
 * cases, and that decision is recorded per document with a machine verifier name
 * so nobody later mistakes it for a person having looked.
 *
 * Only MATCH and MINOR. A conflict, an unreadable scan and an unread document
 * all stay exactly where they are.
 */
function apiAdminAutoClear() {
  var s = Auth.requireAdmin();

  var stu = Db.indexBy('Students', 'studentId');
  var apps = Db.indexBy('Applications', 'appId');
  var cleared = 0, touchedApps = {};

  Db.readAll('Documents').forEach(function (d) {
    if (d.status !== 'UPLOADED') return;
    if (d.scanVerdict !== 'MATCH' && d.scanVerdict !== 'MINOR') return;

    // Never clear an application that screening has flagged, whatever the
    // document says. A reused Aadhaar is not made acceptable by a tidy scan.
    var risk;
    try { risk = Identity.screen(d.appId); } catch (e) { return; }
    if (risk.level === 'HIGH') return;

    Documents.decide(d.docId, true, 'AUTOMATIC (document matched declaration)',
      d.scanVerdict === 'MINOR'
        ? 'Read automatically. The PIN code differs from the declaration but not by ' +
          'enough to change eligibility or the merit score.'
        : 'Read automatically. The document confirms the declared PIN code and name.');
    cleared++;
    touchedApps[d.appId] = true;
  });

  Object.keys(touchedApps).forEach(function (appId) {
    var app = apps[appId];
    var student = app ? stu[app.studentId] : null;
    if (student) {
      Db.update('Applications', appId, {
        docStatus: Documents.rollUp(appId, student), updatedAt: new Date()
      });
    }
  });

  Ledger.append('DOCUMENTS_AUTO_CLEARED', {
    count: cleared, applications: Object.keys(touchedApps).length
  }, s.email);

  return { cleared: cleared, applications: Object.keys(touchedApps).length };
}

/**
 * The document verification queue.
 *
 * Ordered by risk, not by arrival. Four hundred applications reviewed in upload
 * order means the one with a reused document gets the same thirty seconds as the
 * four hundred clean ones. Each entry carries the automated findings, so the
 * verifier opens the scan already knowing what to look for.
 */
function apiAdminDocQueue(limit, onlyConflicts) {
  Auth.requireAdmin();
  limit = limit || 40;
  onlyConflicts = onlyConflicts !== false;      // default: only what needs a person
  var stu = Db.indexBy('Students', 'studentId');
  var apps = Db.indexBy('Applications', 'appId');
  var screened = {};

  var rows = Db.readAll('Documents')
    .filter(function (d) { return d.status === 'UPLOADED'; })
    // Anything the machine could settle is not the officer's problem. Without
    // this the queue is still every applicant and nothing has been gained.
    .filter(function (d) {
      if (!onlyConflicts) return true;
      return d.scanVerdict === 'CONFLICT' || d.scanVerdict === 'UNREADABLE' ||
             !d.scanVerdict || d.scanVerdict === 'UNSCANNED';
    })
    .map(function (d) {
      var app = apps[d.appId];
      var student = app ? stu[app.studentId] : null;
      if (screened[d.appId] === undefined) {
        try { screened[d.appId] = Identity.screen(d.appId); }
        catch (e) { screened[d.appId] = { score: 0, level: 'UNKNOWN', findings: [] }; }
      }
      var risk = screened[d.appId];
      var idRow = student ? Db.byId('Identity', student.studentId) : null;

      return {
        docId: d.docId, appId: d.appId, docType: d.docType,
        label: (DOC_TYPES[d.docType] || {}).label || d.docType,
        fileName: d.fileName, driveFileId: d.driveFileId,
        mimeType: d.mimeType || '',
        sizeKb: d.sizeBytes ? Math.round(Number(d.sizeBytes) / 1024) : 0,
        studentName: student ? student.name : '(unknown)',
        enrollmentNo: student ? student.enrollmentNo : '',
        category: student ? student.category : '',
        campus: student ? student.campus : '',
        // Only ever the masked form. The queue is a screen a verifier may share.
        aadhaarMasked: idRow ? Identity.mask(idRow.aadhaarLast4) : '',
        identityStatus: idRow ? idRow.status : 'REQUIRED',
        riskScore: risk.score,
        riskLevel: risk.level,
        findings: (risk.findings || []).concat(scanFindings_(d)),
        scanVerdict: d.scanVerdict || 'UNSCANNED',
        uploadedAt: fmtDate_(d.uploadedAt)
      };
    });

  rows.sort(function (a, b) { return b.riskScore - a.riskScore; });
  return rows.slice(0, limit);
}

/**
 * The identity verification queue - applicants who have declared an Aadhaar
 * number and are waiting on a human to match it to their address proof.
 */
function apiAdminIdentityQueue(limit) {
  Auth.requireAdmin();
  limit = limit || 40;
  var stu = Db.indexBy('Students', 'studentId');
  var appByStudent = {};
  Db.readAll('Applications').forEach(function (a) { appByStudent[a.studentId] = a; });

  var rows = Db.readAll('Identity')
    .filter(function (r) { return r.status === 'SUBMITTED'; })
    .map(function (r) {
      var student = stu[r.studentId] || {};
      var app = appByStudent[r.studentId];
      var risk = { score: Number(r.riskScore) || 0, level: 'LOW', findings: r.findingsJson || [] };
      if (app) {
        try { risk = Identity.screen(app.appId); } catch (e) { /* keep the stored one */ }
      }
      return {
        studentId: r.studentId,
        appId: app ? app.appId : '',
        studentName: student.name || '(unknown)',
        enrollmentNo: student.enrollmentNo || '',
        programme: student.programme || '',
        year: student.year || '',
        campus: student.campus || '',
        category: student.category || '',
        aadhaarMasked: Identity.mask(r.aadhaarLast4),
        docFolderUrl: app ? app.docFolderUrl : '',
        riskScore: risk.score,
        riskLevel: risk.level,
        findings: risk.findings,
        submittedAt: fmtDate_(r.submittedAt)
      };
    });

  rows.sort(function (a, b) { return b.riskScore - a.riskScore; });
  return rows.slice(0, limit);
}

/**
 * Approve or reject one identity.
 *
 * A rejection must say why. An applicant told only "rejected" cannot fix
 * anything, and the grievance that follows costs the office more than the note
 * would have.
 */
function apiAdminDecideIdentity(studentId, approve, note) {
  var s = Auth.requireAdmin();
  if (!approve && !String(note || '').trim()) {
    throw new Error('Give a reason when rejecting an identity - the student is told ' +
                    'what it says and has to be able to act on it.');
  }
  var result = Identity.decide(studentId, !!approve, s.email, note || '');

  var app = Db.readAll('Applications').filter(function (a) {
    return a.studentId === studentId;
  })[0];
  if (app) {
    try { Identity.rescreen(app.appId); } catch (e) { /* advisory */ }
  }
  return result;
}

/** What reading the document concluded, as findings the queue can render. */
function scanFindings_(doc) {
  var s = doc.scanJson;
  if (!s) return [];
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch (e) { return []; }
  }
  return (s && s.findings) || [];
}

/** Approve or reject one document. */
function apiAdminDecideDocument(docId, approve, note) {
  var s = Auth.requireAdmin();
  var doc = Db.byId('Documents', docId);
  if (!doc) throw new Error('No such document.');

  Documents.decide(docId, approve, s.email, note || '');

  var app = Db.byId('Applications', doc.appId);
  var student = app ? Db.byId('Students', app.studentId) : null;
  if (student) {
    Db.update('Applications', doc.appId, {
      docStatus: Documents.rollUp(doc.appId, student), updatedAt: new Date()
    });
    if (!approve) {
      try { Notify.send(doc.appId, 'DOC_REJECTED', { note: note || '' }); } catch (e) { /* logged */ }
    }
  }
  return { ok: true, docStatus: app ? Documents.rollUp(doc.appId, student) : null };
}

/** Generate allotment letters in bounded batches. */
function apiAdminGenerateLetters(runId, limit) {
  Auth.requireAdmin();
  if (!runId) {
    var runs = Db.readAll('Runs');
    if (!runs.length) throw new Error('No allocation run exists yet.');
    runId = runs[runs.length - 1].runId;
  }
  return Letters.generateBatch(runId, limit || 25);
}

/** Dispatch notifications for a run, in bounded batches. */
function apiAdminNotify(runId, limit) {
  Auth.requireAdmin();
  if (!runId) {
    var runs = Db.readAll('Runs');
    if (!runs.length) throw new Error('No allocation run exists yet.');
    runId = runs[runs.length - 1].runId;
  }
  return Notify.notifyRun(runId, limit || 50);
}

/** Ledger integrity, on demand. */
function apiAdminVerifyLedger() {
  Auth.requireAdmin();
  var v = Ledger.verify();
  var entries = Db.readAll('AuditLog').slice(-12).reverse().map(function (e) {
    return {
      seq: e.seq, ts: fmtDate_(e.ts), actor: e.actor, action: e.action,
      hash: String(e.hash).substring(0, 12)
    };
  });
  return { verification: v, recent: entries };
}

/** The waiting list, for the vacancy-management view. */
function apiAdminWaitlist(limit) {
  Auth.requireAdmin();
  limit = limit || 50;
  var apps = Db.indexBy('Applications', 'appId');
  var stu = Db.indexBy('Students', 'studentId');
  var hostels = Db.indexBy('Hostels', 'hostelId');

  return Db.readAll('Waitlist')
    .sort(function (a, b) { return a.position - b.position; })
    .slice(0, limit)
    .map(function (w) {
      var app = apps[w.appId];
      var student = app ? stu[app.studentId] : null;
      return {
        position: w.position, appId: w.appId,
        name: student ? student.name : '',
        programme: student ? student.programme : '',
        category: student ? student.category : '',
        gender: student ? student.gender : '',
        meritScore: app ? app.meritScore : 0,
        etaPercent: Math.round(Number(w.etaProbability) * 100),
        topChoice: (hostels[w.hostelId] || {}).name || ''
      };
    });
}

/**
 * PUBLIC - no auth. A warden scanning a letter at the hostel gate must be able
 * to verify it without an account.
 */
function apiVerifyAllotment(allocId, sig) {
  return Letters.verifyAllotment(allocId, sig);
}

// ============================================================ simulator

/** The policy knobs the simulator offers. */
function apiAdminSimulatorKnobs() {
  Auth.requireAdmin();
  return Simulator.knobs();
}

/** Run a what-if. Writes nothing. */
function apiAdminSimulate(changes, seed) {
  Auth.requireAdmin();
  return Simulator.simulate({ changes: changes, seed: seed });
}

/** Accept a simulation: write the policy, then run and commit for real. */
function apiAdminCommitSimulation(changes, seed) {
  var s = Auth.requireAdmin();
  if (!Auth.canCommit(s)) {
    throw new Error('Your role (' + s.role + ') may simulate but not commit policy changes.');
  }
  return Simulator.commit(changes, s.email, seed);
}

function apiAdminDiscardSimulation() {
  Auth.requireAdmin();
  return Simulator.discard();
}

// ============================================================ grievances

function apiAdminGrievanceInbox(filter, limit) {
  Auth.requireAdmin();
  return { tickets: Grievance.inbox(filter, limit), stats: Grievance.stats() };
}

function apiAdminResolveGrievance(ticketId, resolution) {
  var s = Auth.requireAdmin();
  return Grievance.resolve(ticketId, resolution, s.email);
}

function apiAdminEscalateGrievance(ticketId, note) {
  var s = Auth.requireAdmin();
  return Grievance.escalate(ticketId, note, s.email);
}

// ============================================================ swaps

function apiAdminSwapBoard() {
  Auth.requireAdmin();
  var all = Db.readAll('Transfers').filter(function (t) { return t.type === 'SWAP'; });
  var byStatus = {};
  all.forEach(function (t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
  return { open: Swap.board(50), counts: byStatus, total: all.length };
}

/**
 * Deliberately corrupt one ledger row so the tamper detection can be shown
 * live. Guarded behind an explicit Config flag - this must never be reachable
 * on a real deployment.
 */
function apiAdminTamperDemo() {
  var s = Auth.requireAdmin();
  if (String(Db.cfg('ALLOW_TAMPER_DEMO', 'FALSE')).toUpperCase() !== 'TRUE') {
    throw new Error('The tamper demonstration is disabled. Set ALLOW_TAMPER_DEMO to TRUE in Config to enable it.');
  }
  var rows = Db.readAll('AuditLog');
  if (rows.length < 3) throw new Error('Not enough ledger entries to demonstrate tampering.');
  var target = rows[Math.floor(rows.length / 2)];
  var sheet = Db.sheet('AuditLog');
  sheet.getRange(target._row, schemaColIndex('AuditLog', 'payloadJson'))
       .setValue(JSON.stringify({ tamperedForDemonstration: true }));
  Db.invalidate('AuditLog');
  return { tamperedRow: target.seq, verification: Ledger.verify() };
}

// ============================================================ demo support

/** The demo cast, with talking points. Admin only. */
function apiAdminDemoCast() {
  Auth.requireAdmin();
  return DemoScenario.prepare({});
}

/**
 * Look up applicants by name or enrolment number, so a demo operator can jump
 * straight to a student without knowing their application id.
 */
function apiAdminFindStudent(query) {
  Auth.requireAdmin();
  var q = String(query || '').toLowerCase().trim();
  if (q.length < 2) return [];

  var apps = Db.readAll('Applications');
  var students = Db.indexBy('Students', 'studentId');

  return apps.filter(function (a) {
    var s = students[a.studentId];
    if (!s) return false;
    return String(s.name).toLowerCase().indexOf(q) >= 0 ||
           String(s.enrollmentNo).toLowerCase().indexOf(q) >= 0 ||
           String(a.appId).toLowerCase().indexOf(q) >= 0;
  }).slice(0, 12).map(function (a) {
    var s = students[a.studentId];
    return {
      appId: a.appId, name: s.name, enrollmentNo: s.enrollmentNo,
      programme: s.programme, category: s.category + (s.isPwD ? ' PwD' : ''),
      status: a.status
    };
  });
}

/**
 * PUBLIC - verify by typing the code printed on the letter, with no camera.
 *
 * Accepts the compact token, a full URL pasted from anywhere, or just the
 * reference number with the signature given separately. Gate staff should never
 * be blocked because a phone camera will not focus.
 */
function apiVerifyByCode(input) {
  var raw = String(input || '').trim();
  if (!raw) return { valid: false, reason: 'Enter the code printed beneath the QR on the letter.' };

  // A whole URL pasted in.
  var vMatch = raw.match(/[?&]v=([^&\s]+)/);
  if (vMatch) raw = decodeURIComponent(vMatch[1]);

  var idMatch = raw.match(/[?&]id=([^&\s]+)/);
  var sigMatch = raw.match(/[?&]sig=([^&\s]+)/);
  if (idMatch && sigMatch) {
    return Letters.verifyAllotment(decodeURIComponent(idMatch[1]), decodeURIComponent(sigMatch[1]));
  }

  var parsed = Letters.parseToken(raw);
  if (parsed) return Letters.verifyAllotment(parsed.allocId, parsed.sig);

  return {
    valid: false,
    reason: 'That does not look like a verification code. Copy the whole line printed ' +
            'under the QR code on the letter, or scan the QR.'
  };
}
