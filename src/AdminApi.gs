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
/**
 * The run whose result is still standing.
 *
 * Not simply the last row of Runs. A run that has been cleared leaves its row
 * behind on purpose - the record of what was decided is worth keeping - but
 * its numbers stopped describing the hostel the moment the beds were emptied.
 * Reading the last row regardless is how a dashboard ends up reporting 96%
 * occupancy and a full quota table over an allocation that no longer exists.
 */
function liveRun_() {
  var runs = Db.readAll('Runs');
  for (var i = runs.length - 1; i >= 0; i--) {
    if (runs[i].mode === 'COMMITTED') return runs[i];
  }
  return null;
}

function apiAdminOverview() {
  var s = Auth.requireAdmin();

  var apps = Db.readAll('Applications');
  var beds = Db.readAll('Beds');
  var rooms = Db.indexBy('Rooms', 'roomId');
  var hostels = Db.readAll('Hostels');
  var runs = Db.readAll('Runs');
  var latest = liveRun_();

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

  // Deliberately NOT Ledger.verify() here. Verifying re-hashes every row in the
  // audit log, which grows without bound, and doing it before the dashboard can
  // paint means the whole page waits on the slowest thing it shows. The badge
  // loads on its own; see apiAdminLedgerBadge.
  var chain = { intact: null, reason: '', length: 0 };

  // Cheap: Allocations is already loaded for the counts above.
  var lettersDone = Db.readAll('Allocations').filter(function (a) {
    return a.status === 'ACTIVE' && a.letterUrl;
  }).length;

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
    // Whether an allocation has ever been run, which is a different question
    // from whether one is standing now. "Not run yet" and "cleared" look
    // identical in the numbers and are not the same thing to be told.
    hadRun: runs.length > 0,
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
    lettersDone: lettersDone,
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
 * Clear the committed allocation, so the next run starts from empty beds.
 *
 * Guarded by the same role check that gates committing one. The run history in
 * Runs is left alone - what was decided, and when, is not ours to erase.
 */
function apiAdminClearAllocation() {
  var s = Auth.requireAdmin();
  if (!Auth.canCommit(s)) {
    throw new Error('Your role (' + s.role + ') may view allocations but not clear one.');
  }
  return Allocator.clearCommitted(s.email);
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
/**
 * Would clearing this document automatically be safe, and if not, why not?
 *
 * ONE answer, asked by three callers that used to answer it separately and
 * disagree: the summary that counts what the button will do, the button that
 * does it, and the queue that decides whether a person needs to see it.
 *
 * When they disagreed, a document fell straight through the gap. Its scan
 * agreed with the declaration, so the decision queue left it out; its
 * application was flagged by screening, so auto-clear refused it - silently,
 * because refusing was a `return` inside a loop. It was on no admin screen at
 * all, could not be cleared, and the student's portal went on saying "under
 * review" indefinitely. That is not a rare state: it is what happens to the
 * first person whose Aadhaar or document turns up twice.
 *
 * @return {{ok: boolean, reason: string, level: string}}
 */
function autoClearable_(doc, screener) {
  if (doc.status !== 'UPLOADED') return { ok: false, reason: 'already decided', level: '' };
  if (doc.scanVerdict !== 'MATCH' && doc.scanVerdict !== 'MINOR') {
    return { ok: false, reason: 'the reading did not settle it', level: '' };
  }

  // Never clear an application screening has flagged, whatever the document
  // says. A reused Aadhaar is not made acceptable by a tidy scan - but the
  // reason has to travel with the refusal, or the button appears to do nothing.
  var risk;
  try { risk = screener(doc.appId); }
  catch (e) { return { ok: false, reason: 'the applicant could not be screened', level: 'UNKNOWN' }; }

  if (risk.level === 'HIGH') {
    var blocking = (risk.findings || []).filter(function (f) { return f.severity === 'BLOCK'; });
    return {
      ok: false, level: 'HIGH',
      reason: blocking.length
        ? blocking[0].text
        : 'the applicant is flagged by identity screening'
    };
  }
  return { ok: true, reason: '', level: risk.level };
}

/** Identity.screen, computed once per application per request. */
function screenerFor_() {
  var cache = {};
  return function (appId) {
    if (cache[appId] === undefined) cache[appId] = Identity.screen(appId);
    return cache[appId];
  };
}

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

  // Counted by the same rule the button obeys. Counting "agrees with its
  // declaration" and then clearing rather fewer is how a button comes to be
  // labelled with a number it cannot deliver.
  var screener = screenerFor_();
  var clearable = 0, blocked = 0, blockedReason = '';
  docs.forEach(function (d) {
    if (d.status !== 'UPLOADED') return;
    if (d.scanVerdict !== 'MATCH' && d.scanVerdict !== 'MINOR') return;
    var can = autoClearable_(d, screener);
    if (can.ok) { clearable++; return; }
    blocked++;
    if (!blockedReason) blockedReason = can.reason;
  });

  // How many are finished, so the card can say what is true rather than what
  // sounds tidy. "Everything agrees" over two contradictions and two unreadable
  // scans - all of them settled by hand earlier - was an untrue sentence in a
  // green box, which is the worst place for one.
  var decided = docs.filter(function (d) {
    return d.status === 'VERIFIED' || d.status === 'REJECTED' || d.status === 'WAIVED';
  }).length;

  return {
    total: docs.length,
    byVerdict: byVerdict,
    needsPerson: needsPerson + blocked,
    clearable: clearable,
    // Documents whose reading agreed but whose applicant is flagged. They need
    // a person, they are in the decision queue, and they are the reason the
    // "clear" button used to report a number it could not deliver.
    blocked: blocked,
    blockedReason: blockedReason,
    decided: decided,
    held: docs.filter(function (d) { return d.status === 'UPLOADED'; }).length,
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
  var cleared = 0, touchedApps = {}, skipped = [];
  var screener = screenerFor_();

  Db.readAll('Documents').forEach(function (d) {
    if (d.status !== 'UPLOADED') return;
    if (d.scanVerdict !== 'MATCH' && d.scanVerdict !== 'MINOR') return;

    var can = autoClearable_(d, screener);
    if (!can.ok) {
      // Refusing used to be a bare `return`, so the button reported clearing
      // nothing and gave no reason. Whoever pressed it is owed the reason.
      var a = apps[d.appId];
      var who = a ? stu[a.studentId] : null;
      skipped.push({
        docId: d.docId, appId: d.appId,
        studentName: who ? who.name : '(unknown)',
        reason: can.reason
      });
      return;
    }

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
    count: cleared, applications: Object.keys(touchedApps).length,
    skipped: skipped.length
  }, s.email);

  return {
    cleared: cleared,
    applications: Object.keys(touchedApps).length,
    skipped: skipped
  };
}

/**
 * The ledger integrity badge, on its own so the dashboard need not wait for it.
 *
 * Still a full verification - re-hashing the whole chain is the entire point of
 * having one, and an incremental check that trusted its own previous answer
 * would not detect a row rewritten after that answer was cached.
 */
function apiAdminLedgerBadge() {
  Auth.requireAdmin();
  return Ledger.verify();
}

/**
 * The document verification queue.
 *
 * Ordered by risk, not by arrival. Four hundred applications reviewed in upload
 * order means the one with a reused document gets the same thirty seconds as the
 * four hundred clean ones. Each entry carries the automated findings, so the
 * verifier opens the scan already knowing what to look for.
 */
/**
 * Documents an officer might want to look at.
 *
 * TWO VIEWS, because there are two questions and they have different answers.
 *
 *   onlyConflicts (the default) - "what is waiting on me?" Held documents the
 *   machine could not settle. Everything it COULD settle is deliberately left
 *   out; without that the queue is every applicant again and nothing has been
 *   gained by reading them automatically.
 *
 *   onlyConflicts = false - "where is a particular document?" Every document
 *   with a file behind it, whatever its state, including the ones already
 *   decided. This view exists because the first one cannot answer that
 *   question, and a student whose portal says "under review" while the office
 *   can find no trace of it is a support call the office cannot resolve.
 */
function apiAdminDocQueue(limit, onlyConflicts) {
  Auth.requireAdmin();
  limit = limit || 40;
  onlyConflicts = onlyConflicts !== false;      // default: only what needs a person
  var stu = Db.indexBy('Students', 'studentId');
  var apps = Db.indexBy('Applications', 'appId');
  var screened = {};
  var queueScreener = function (appId) {
    if (screened[appId] === undefined) {
      try { screened[appId] = Identity.screen(appId); }
      catch (e) { screened[appId] = { score: 0, level: 'UNKNOWN', findings: [] }; }
    }
    return screened[appId];
  };

  var rows = Db.readAll('Documents')
    .filter(function (d) {
      // The full view still needs a FILE - a slot nobody has uploaded to is not
      // a document, it is an absence, and the student's own page reports it.
      if (!onlyConflicts) return !!d.driveFileId;
      return d.status === 'UPLOADED';
    })
    .filter(function (d) {
      if (!onlyConflicts) return true;
      if (d.scanVerdict === 'CONFLICT' || d.scanVerdict === 'UNREADABLE' ||
          !d.scanVerdict || d.scanVerdict === 'UNSCANNED') return true;
      // A document the reading settled but screening will not let through has
      // to appear here. It cannot be cleared automatically and it is nobody's
      // task otherwise, which is exactly how one becomes invisible.
      return !autoClearable_(d, queueScreener).ok;
    })
    .map(function (d) {
      var app = apps[d.appId];
      var student = app ? stu[app.studentId] : null;
      var risk = queueScreener(d.appId);
      var idRow = student ? Db.byId('Identity', student.studentId) : null;

      return {
        docId: d.docId, appId: d.appId, docType: d.docType,
        label: (DOC_TYPES[d.docType] || {}).label || d.docType,
        // Carried so the full view can say what became of it, and so the
        // decision buttons are not offered on something already decided.
        status: d.status,
        decidedBy: d.verifiedBy || '',
        decidedAt: fmtDate_(d.verifiedAt),
        note: d.note || '',
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
 * number and are waiting on a human to match it to their Aadhaar card.
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

/**
 * Offer every empty bed to the waiting list.
 *
 * Withdrawal does this by itself for the one bed it frees. This is for the
 * other ways a room empties - a cancellation entered by hand, a batch of
 * no-shows written off at the counter - and for catching up an installation
 * where beds were freed before promotion existed.
 */
function apiAdminFillVacancies(limit) {
  var s = Auth.requireAdmin();
  return Vacancy.fillAll(limit || 25, s.email);
}

/** Generate allotment letters in bounded batches. */
function apiAdminGenerateLetters(runId, limit) {
  Auth.requireAdmin();
  if (!runId) {
    var live = liveRun_();
    // Not "the last run": letters for a cleared allocation would be letters
    // for rooms nobody now holds.
    if (!live) throw new Error('There is no allocation to write letters for. ' +
                               'Run the allocation first.');
    runId = live.runId;
  }
  return Letters.generateBatch(runId, limit || 25);
}

/** Dispatch notifications for a run, in bounded batches. */
function apiAdminNotify(runId, limit) {
  Auth.requireAdmin();
  if (!runId) {
    var live = liveRun_();
    if (!live) throw new Error('There is no allocation to notify anybody about. ' +
                               'Run the allocation first.');
    runId = live.runId;
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

/**
 * The waiting list, one page at a time.
 *
 * Paged rather than capped. A cap answers "who are the first fifty?" and
 * silently drops the rest - and on a list several hundred long, the people
 * furthest down it are exactly the ones the office is asked about, because
 * they are the ones who have heard nothing.
 *
 * @param {Object=} opts {page:1-based, pageSize, q:free-text}
 * @return {{rows, total, matched, page, pages, pageSize, q}}
 */
function apiAdminWaitlist(opts) {
  Auth.requireAdmin();

  // Tolerates a bare number, which is what this used to take. An old call site
  // asking for 20 rows gets the first 20, not a page numbered 20.
  if (typeof opts === 'number') opts = { pageSize: opts };
  opts = opts || {};

  var pageSize = Math.min(Math.max(Math.floor(Number(opts.pageSize) || 25), 1), 100);
  var page = Math.max(Math.floor(Number(opts.page) || 1), 1);

  var apps = Db.indexBy('Applications', 'appId');
  var stu = Db.indexBy('Students', 'studentId');
  var hostels = Db.indexBy('Hostels', 'hostelId');

  var all = Db.readAll('Waitlist').slice()
    .sort(function (a, b) { return Number(a.position) - Number(b.position); });
  var total = all.length;

  // Searching the WHOLE list, not the page on screen. A filter that only looks
  // at what is already visible is a filter that answers "no" to every question
  // worth asking it.
  var q = String(opts.q || '').trim().toLowerCase();
  if (q) {
    all = all.filter(function (w) {
      var app = apps[w.appId];
      var s = app ? stu[app.studentId] : null;
      if (!s) return false;
      return String(s.name || '').toLowerCase().indexOf(q) >= 0 ||
             String(s.enrollmentNo || '').toLowerCase().indexOf(q) >= 0 ||
             String(w.appId || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  var matched = all.length;
  var pages = Math.max(Math.ceil(matched / pageSize), 1);
  if (page > pages) page = pages;
  var from = (page - 1) * pageSize;

  var rows = all.slice(from, from + pageSize).map(function (w) {
    var app = apps[w.appId];
    var student = app ? stu[app.studentId] : null;
    return {
      position: w.position, appId: w.appId,
      studentId: student ? student.studentId : '',
      name: student ? student.name : '',
      enrollmentNo: student ? student.enrollmentNo : '',
      programme: student ? student.programme : '',
      year: student ? student.year : '',
      campus: student ? student.campus : '',
      category: student ? student.category : '',
      gender: student ? student.gender : '',
      // What the queue is actually ordered by: the group first, then the
      // measure inside it. Showing merit alone would make the order look wrong.
      tier: app ? app.priorityTier : '',
      meritScore: app ? app.meritScore : 0,
      // What this student was ACTUALLY ordered by inside their group. The
      // Delhi group is ranked on distance, everyone else on marks, so showing
      // the percentage for all of them would make a correct queue look wrong -
      // a 60% ahead of an 85% with nothing on screen explaining it.
      rankedOn: app
        ? (app.priorityTier === 'DELHI' ? Number(app.distanceKm) : Number(app.meritScore))
        : 0,
      rankedOnUnit: (app && app.priorityTier === 'DELHI') ? 'km' : '%',
      etaPercent: Math.round(Number(w.etaProbability) * 100),
      topChoice: (hostels[w.hostelId] || {}).name || ''
    };
  });

  return {
    rows: rows, total: total, matched: matched,
    page: page, pages: pages, pageSize: pageSize, q: opts.q || ''
  };
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

// ======================================================= Wander rule book

/** What is loaded, what still needs embedding, and the last failure if any. */
function apiAdminRuleBookStatus() {
  Auth.requireAdmin();
  var s = RuleBook.stats();
  s.agent = Chatbot.AGENT;
  s.enabled = Chatbot.enabled();
  s.hasKey = Gemini.available();
  s.model = Gemini.chatModel();
  s.remainingToday = Chatbot.remainingQuota();

  // Anything that did not answer, not only what carried an error string. A
  // student is deliberately shown a soft message when Wander fails - a
  // rejected model id means nothing to them - but that left the person who
  // CAN fix it with no way to see it either, unless they knew to open the
  // ChatLog tab. Every failure is already recorded; this puts the most recent
  // one where the person fixing it is already looking.
  var turns = Db.readAll('ChatLog');
  var failures = turns.filter(function (r) { return r.status && r.status !== 'ANSWERED'; });
  if (failures.length) {
    var last = failures[failures.length - 1];
    s.lastError = {
      status: last.status,
      question: last.question,
      detail: String(last.error || last.answer || '(the server recorded no reason)').substring(0, 400)
    };
    s.errorCount = failures.length;
  }
  s.turnsLogged = turns.length;
  return s;
}

/**
 * Reload the hostel rules from the source that ships with this project.
 *
 * There is no upload. The brochures are fixed for the session and live in
 * RuleText.gs, so they arrive with the code and setupEverything loads them
 * automatically - a deployment cannot end up running the assistant with an
 * empty or mismatched rule book, and a diff shows exactly what changed when
 * the university reissues them.
 *
 * Reloading does NOT re-embed. Vectors are preserved wherever the text is
 * byte-identical, so this is cheap to run and only genuinely new or altered
 * passages cost an API call afterwards.
 */
function apiAdminReloadRuleBook() {
  Auth.requireAdmin();
  var res = RuleBook.loadBundled();
  Ledger.append('RULEBOOK_INGESTED', res, Auth.session().email);
  return res;
}

/**
 * Embed one batch and report what is left.
 *
 * Resumable by design: the client calls again while `remaining` is non-zero.
 * A rate limit from Google is reported, not thrown - everything already
 * embedded is stored, so waiting it out and continuing loses nothing.
 */
function apiAdminEmbedChunks(batch) {
  Auth.requireAdmin();
  if (!Gemini.available()) {
    throw new Error('No Gemini API key is set, so nothing can be embedded yet.');
  }
  var size = Math.min(Number(batch) || 25, 25);
  var rows = RuleBook.pending(size);
  if (!rows.length) return { embedded: 0, remaining: 0 };

  var vectors;
  try {
    vectors = Gemini.embed(rows.map(function (r) {
      // The heading is embedded with the body. Retrieval otherwise cannot tell
      // a fee clause in the boys' brochure from the same words under a
      // different section, and the citation would name a heading the vector
      // never saw.
      return (r.heading ? r.heading + '\n' : '') + r.text;
    }), 'RETRIEVAL_DOCUMENT');
  } catch (e) {
    if (e.kind === 'QUOTA') {
      return {
        embedded: 0, remaining: RuleBook.pending().length, throttled: true,
        retryAfterMs: e.retryAfterMs || 15000,
        note: 'Google is limiting how fast passages can be embedded on the free tier.'
      };
    }
    throw e;
  }

  var n = RuleBook.storeVectors(rows.map(function (r, i) {
    return { chunkId: r.chunkId, vector: vectors[i] };
  }));

  var left = RuleBook.pending().length;
  if (!left) {
    Ledger.append('RULEBOOK_EMBEDDED',
      { count: RuleBook.stats().embedded, model: Gemini.embedModel() }, Auth.session().email);
  }
  return { embedded: n, remaining: left };
}
