/**
 * Phase 4 tests - letters, QR verification, notifications, admin dashboard.
 *
 *   node tests/phase4.test.js
 *
 * The anti-forgery claim is the one that matters most here: a letter with a
 * plausible reference number but no valid signature must fail verification.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();

// Give every applicant a verified document set so the run is realistic.
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-P4',
                                     triggeredBy: 'admin@ipu.ac.in' });
const allocs = Db.readAll('Allocations');
const sample = allocs[0];

section('Letter signing');
const sig = Letters.signature(sample.allocId);
check('signature is produced', !!sig && sig.length === 16, sig);
check('signature is stable', Letters.signature(sample.allocId) === sig);
check('signature is unique per allotment',
  Letters.signature(allocs[1].allocId) !== sig);
check('a valid signature verifies', Letters.verifies(sample.allocId, sig));
check('a wrong signature is rejected',
  !Letters.verifies(sample.allocId, 'deadbeefdeadbeef'));
check('a truncated signature is rejected',
  !Letters.verifies(sample.allocId, sig.slice(0, 8)));
check('an extended signature is rejected',
  !Letters.verifies(sample.allocId, sig + '00'));
check('a signature from another allotment is rejected',
  !Letters.verifies(sample.allocId, Letters.signature(allocs[1].allocId)),
  'this is the forgery case that matters');
check('an empty signature is rejected', !Letters.verifies(sample.allocId, ''));
check('a null id is rejected', !Letters.verifies(null, sig));
check('flipping one character breaks it', (() => {
  const bad = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  return !Letters.verifies(sample.allocId, bad);
})());

section('Verification URL');
const url = Letters.verifyUrl(sample.allocId);
check('URL carries the id', url.indexOf(encodeURIComponent(sample.allocId)) > 0);
check('URL carries the signature', url.indexOf('sig=' + sig) > 0);
check('URL routes to the verify page', url.indexOf('page=verify') > 0);
check('URL fits comfortably in a QR', url.length < 200, url.length + ' chars');
console.log('        ' + url);

section('Letter HTML');
const html = Letters.buildHtml(sample.allocId);
const data = Letters.letterData(sample.allocId);
check('letter is produced', html.length > 1500, html.length + ' bytes');
check('names the student', html.indexOf(data.student.name) > 0);
check('names the enrolment number', html.indexOf(data.student.enrollmentNo) > 0);
check('names the hostel', html.indexOf(data.hostel.name) > 0);
check('names the room', html.indexOf(data.room.roomNo) > 0);
check('carries the reference', html.indexOf(sample.allocId) > 0);
check('names the warden as signatory', html.indexOf(data.hostel.warden) > 0);
check('includes terms of allotment', html.toLowerCase().indexOf('terms of allotment') > 0);
check('states the letter is non-transferable',
  html.toLowerCase().indexOf('not transferable') > 0);
check('embeds a QR grid', html.indexOf('<table cellpadding="0"') > 0);
check('makes no external requests',
  html.indexOf('http://') < 0 && html.indexOf('https://') < 0 && html.indexOf('src=') < 0,
  'the letter must render with no network access');
check('contains no script tags', html.toLowerCase().indexOf('<script') < 0);
check('flags an accessible room when relevant', (() => {
  const acc = allocs.find(a => {
    const bed = Db.byId('Beds', a.bedId);
    return Db.byId('Rooms', bed.roomId).isAccessible;
  });
  if (!acc) return true;
  return Letters.buildHtml(acc.allocId).indexOf('Accessible room') > 0;
})());

section('Letter generation to Drive');
const beforeFiles = global.__drive.files.length;
const fileUrl = Letters.generate(sample.allocId);
check('a file is created', global.__drive.files.length > beforeFiles);
check('a URL is returned', !!fileUrl);
check('issuing a letter is recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'LETTER_ISSUED'));
check('the ledger entry records the signature', (() => {
  const e = Db.readAll('AuditLog').filter(x => x.action === 'LETTER_ISSUED').pop();
  const p = typeof e.payloadJson === 'string' ? JSON.parse(e.payloadJson) : e.payloadJson;
  return p.signature === sig;
})());

const batch = Letters.generateBatch('RUN-P4', 10);
check('batch generation is bounded', batch.generated === 10, batch.generated + '');
check('batch reports what remains', batch.remaining === batch.total - 10,
  batch.remaining + ' of ' + batch.total);
check('batching matters at this scale', batch.total > 100,
  batch.total + ' letters would never finish in one execution');

section('QR verification endpoint');
const good = apiVerifyAllotment(sample.allocId, sig);
check('a genuine letter verifies', good.valid === true);
check('verification returns the student name', good.studentName === data.student.name);
check('verification returns the room', good.roomNo === data.room.roomNo);
check('verification returns the hostel', good.hostel === data.hostel.name);
check('verification is timestamped', !!good.checkedAt);

const forged = apiVerifyAllotment(sample.allocId, 'ffffffffffffffff');
check('a forged signature is refused', forged.valid === false);
check('the refusal explains itself', forged.reason.length > 30);
console.log('        forged -> "' + forged.reason + '"');

const invented = apiVerifyAllotment('ALC-RUN-FAKE-9999', 'ffffffffffffffff');
check('an invented reference is refused', invented.valid === false);

// A correctly signed but cancelled allotment must stop verifying.
Db.update('Allocations', sample.allocId, { status: 'CANCELLED' });
const cancelled = apiVerifyAllotment(sample.allocId, sig);
check('a cancelled allotment stops verifying even with a valid signature',
  cancelled.valid === false,
  'otherwise an old letter would still open the gate');
console.log('        cancelled -> "' + cancelled.reason + '"');
Db.update('Allocations', sample.allocId, { status: 'ACTIVE' });

section('Notifications');
check('email is disabled by default', Notify.enabled() === false,
  'so a rehearsal cannot mail 741 real people');
const skipped = Notify.send(sample.appId, 'ALLOTTED', {
  allocId: sample.allocId, hostel: data.hostel.name, roomNo: data.room.roomNo,
  block: data.room.block, floor: data.room.floor, bedNo: data.bed.bedNo, campus: 'Dwarka Campus'
});
check('a send with email disabled is recorded, not silently dropped',
  skipped.status === 'SKIPPED');
check('the notification row exists', Db.readAll('Notifications').length > 0);
check('nothing was actually mailed', global.__mail.length === 0);

Db.setCfg('EMAIL_ENABLED', 'TRUE');
check('email can be enabled', Notify.enabled() === true);
const sent = Notify.send(allocs[2].appId, 'ALLOTTED', {
  allocId: allocs[2].allocId, hostel: 'X', roomNo: 'Y', block: 'A', floor: 1,
  bedNo: 1, campus: 'Dwarka Campus'
});
check('an enabled send goes out', sent.status === 'SENT');
check('the mail was actually dispatched', global.__mail.length === 1);
check('the mail has a subject', !!global.__mail[0].subject);
check('the mail names the room', global.__mail[0].htmlBody.indexOf('Y') > 0);
check('the mail is HTML', global.__mail[0].htmlBody.indexOf('<div') === 0);
check('the mail carries no reply-to trap',
  global.__mail[0].htmlBody.indexOf('do not reply') > 0);

check('every template renders without throwing', (() => {
  const templates = Object.keys(Notify.TEMPLATES);
  for (const t of templates) {
    try {
      Notify.send(sample.appId, t, {
        allocId: sample.allocId, hostel: 'H', roomNo: 'R', block: 'A', floor: 1,
        bedNo: 1, campus: 'C', position: 5, etaPercent: 40, reasons: ['a reason'], note: 'n'
      });
    } catch (e) { return false; }
  }
  return true;
})(), Object.keys(Notify.TEMPLATES).join(', '));

section('Send quota is respected');
Db.setCfg('EMAIL_DAILY_CAP', '3');
const before = global.__mail.length;
const counts = Notify.notifyRun('RUN-P4', 100);
check('sending stops at the configured cap',
  global.__mail.length - before <= 3,
  (global.__mail.length - before) + ' sent against a cap of 3');
check('what could not be sent is reported as remaining',
  counts.remaining > 0, counts.remaining + ' remaining');
check('dispatch is recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'NOTIFICATIONS_DISPATCHED'));
check('a student is never notified twice for the same event', (() => {
  const seen = {};
  for (const n of Db.readAll('Notifications')) {
    if (n.status !== 'SENT') continue;
    const k = n.appId + '|' + n.template;
    if (seen[k]) return false;
    seen[k] = true;
  }
  return true;
})());
Db.setCfg('EMAIL_ENABLED', 'FALSE');

section('Admin dashboard requires admin');
global.Session = { getActiveUser: () => ({ getEmail: () => 'random.student@example.edu' }) };
let denied = false, denyMsg = '';
try { apiAdminOverview(); } catch (e) { denied = true; denyMsg = e.message; }
check('a non-admin is refused', denied, 'the web app runs as the deployer, so this must bite');
console.log('        -> "' + denyMsg + '"');

let deniedRun = false;
try { apiAdminRunAllocation({}); } catch (e) { deniedRun = true; }
check('a non-admin cannot run the allocation', deniedRun);
let deniedDocs = false;
try { apiAdminDocQueue(); } catch (e) { deniedDocs = true; }
check('a non-admin cannot see the document queue', deniedDocs);

check('verification stays public for a warden at the gate',
  apiVerifyAllotment(sample.allocId, sig).valid === true);

section('Admin overview');
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };

const ov = apiAdminOverview();
check('overview loads for an admin', !!ov.admin);
check('counts are present', ov.counts.applications > 0);
check('allotted count matches the run',
  ov.counts.allotted === run.allocations.length,
  ov.counts.allotted + ' vs ' + run.allocations.length);
check('capacity accounting balances',
  ov.capacity.occupied + ov.capacity.vacant === ov.capacity.beds);
check('per-hostel occupancy is reported', ov.occupancy.length === 6);
check('occupancy percentages are sane',
  ov.occupancy.every(h => h.pct >= 0 && h.pct <= 100));
check('every hostel accounts for all its beds',
  ov.occupancy.every(h => h.occupied + h.vacant === h.total));
check('hostel bed totals sum to the whole estate',
  ov.occupancy.reduce((s, h) => s + h.total, 0) === ov.capacity.beds);
check('the latest run is reported', !!ov.latestRun);
check('the run carries its seed and policy hash',
  !!ov.latestRun.seed && !!ov.latestRun.policyHash);
check('metrics come through', !!ov.latestRun.metrics.summary.pref1Pct);
check('ledger status is reported', ov.ledger.intact === true);
check('policy is exposed for the dashboard', !!ov.policy.weights);

console.log('        occupancy: ' + ov.occupancy.map(h =>
  h.name.replace('Hostel ', '') + ' ' + h.pct + '%').join(' | '));

section('Ledger tamper detection through the admin API');
const led = apiAdminVerifyLedger();
check('ledger verification is reported', led.verification.intact === true);
check('recent entries are listed', led.recent.length > 0);
check('entries carry a truncated hash', led.recent.every(e => e.hash.length === 12));

// Hand-edit a historical row, exactly as a bad actor with sheet access would.
const auditRows = Db._store.AuditLog;
const victim = Math.floor(auditRows.length / 2);
const originalPayload = auditRows[victim][4];
auditRows[victim][4] = JSON.stringify({ tampered: true });
const broken = apiAdminVerifyLedger();
check('editing a historical entry is detected', broken.verification.intact === false);
check('detection names the row', broken.verification.brokenAt === victim,
  'brokenAt=' + broken.verification.brokenAt + ', edited row ' + victim);
console.log('        -> "' + broken.verification.reason + '"');
auditRows[victim][4] = originalPayload;
check('restoring the value re-validates the chain',
  apiAdminVerifyLedger().verification.intact === true);

section('Waitlist view');
const wl = apiAdminWaitlist(20);
check('waitlist is returned', wl.length > 0, wl.length + ' rows');
check('ordered by position', wl.every((w, i) => i === 0 || wl[i - 1].position <= w.position));
check('each row names a student', wl.every(w => !!w.name));
check('each row has an ETA', wl.every(w => w.etaPercent >= 0 && w.etaPercent <= 100));

section('Preview does not mutate state');
const bedsBefore = JSON.stringify(Db.readAll('Beds'));
const appsBefore = JSON.stringify(Db.readAll('Applications'));
const prev = apiAdminPreviewAllocation({ seed: 'PREVIEW-ONLY' });
check('preview returns metrics', !!prev.metrics.summary);
check('preview leaves beds untouched', JSON.stringify(Db.readAll('Beds')) === bedsBefore);
check('preview leaves applications untouched',
  JSON.stringify(Db.readAll('Applications')) === appsBefore);
check('preview writes no run record',
  Db.readAll('Runs').every(r => r.runId !== prev.runId));

process.exit(summarise());
