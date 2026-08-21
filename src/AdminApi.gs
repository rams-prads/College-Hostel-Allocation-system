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

/** The document verification queue. */
function apiAdminDocQueue(limit) {
  Auth.requireAdmin();
  limit = limit || 40;
  var stu = Db.indexBy('Students', 'studentId');
  var apps = Db.indexBy('Applications', 'appId');

  return Db.readAll('Documents')
    .filter(function (d) { return d.status === 'UPLOADED'; })
    .slice(0, limit)
    .map(function (d) {
      var app = apps[d.appId];
      var student = app ? stu[app.studentId] : null;
      return {
        docId: d.docId, appId: d.appId, docType: d.docType,
        label: (DOC_TYPES[d.docType] || {}).label || d.docType,
        fileName: d.fileName, driveFileId: d.driveFileId,
        studentName: student ? student.name : '(unknown)',
        enrollmentNo: student ? student.enrollmentNo : '',
        category: student ? student.category : '',
        uploadedAt: fmtDate_(d.uploadedAt)
      };
    });
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
