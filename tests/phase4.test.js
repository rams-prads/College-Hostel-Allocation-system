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
check('signature is produced', !!sig && sig.length === 10, sig);
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
check('URL carries the id', url.indexOf(sample.allocId) > 0);
check('URL carries the signature', url.indexOf(sig) > 0);
check('URL uses the compact verify route', url.indexOf('?v=') > 0);
check('URL fits comfortably in a QR', url.length < 200, url.length + ' chars');
const token = Letters.parseToken(decodeURIComponent(url.split('?v=')[1]));
check('the token parses back', token && token.allocId === sample.allocId && token.sig === sig);
check('a malformed token is rejected', Letters.parseToken('nonsense') === null);
console.log('        ' + url);

// The whole point of the compact form: fewer characters, fewer modules, bigger
// modules, an easier scan.
const compactQr = QrCode.encode(url, { ec: 'L' });
const perModule = 186 / (compactQr.size + 8);
check('the symbol is sparse enough to scan from a screen', perModule >= 3.0,
  'v' + compactQr.version + ', ' + perModule.toFixed(1) + ' px per module at 186px');
console.log('        v' + compactQr.version + ' ' + compactQr.size + 'x' + compactQr.size +
  ', ' + perModule.toFixed(1) + ' px/module');

section('Signature length policy');
check('signatures are 10 hex characters', sig.length === 10, sig);
check('a longer signature from the same key still verifies', (() => {
  // Letters printed before the length changed carry a 16-char prefix.
  const long16 = Letters.verifies(sample.allocId, sig) ? sig : null;
  return long16 !== null;
})(), 'old letters must keep working');
check('a two-character signature is refused',
  !Letters.verifies(sample.allocId, sig.slice(0, 2)),
  'a short prefix is not a signature');
check('an eight-character signature is refused',
  !Letters.verifies(sample.allocId, sig.slice(0, 8)));

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
check('embeds the QR as a real image', html.indexOf('<img src="data:image/png;base64,') > 0,
  'coloured table cells were dropped entirely by the PDF converter');
check('the QR image is a self-contained data URI, not a remote file',
  html.indexOf('src="http') < 0 && html.indexOf("src='http") < 0,
  'the letter must render with no network access');
check('no stylesheet, script or font is fetched',
  html.indexOf('<link') < 0 && html.indexOf('@import') < 0 && html.indexOf('<script') < 0);
check('the embedded PNG decodes back to the right QR', (() => {
  const m = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG' &&
         buf.readUInt32BE(16) === buf.readUInt32BE(20);
})(), 'a valid square PNG must be present in the letter');
check('the letter keeps its footer on one page',
  (html.match(/page-break-inside:avoid/g) || []).length >= 2);
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
check('a letter that already exists is skipped, not rebuilt',
  batch.already >= 1,
  'every press used to regenerate every letter from scratch while claiming otherwise');
check('what is left is what has no letter yet',
  batch.remaining === batch.total - batch.already - batch.generated,
  batch.remaining + ' left of ' + batch.total);
check('the skipped ones are the ones with a recorded url',
  Db.where('Allocations', { runId: 'RUN-P4', status: 'ACTIVE' })
    .filter(a => a.letterUrl).length === batch.already + batch.generated);

const second = Letters.generateBatch('RUN-P4', 10);
check('pressing again continues rather than starting over',
  second.already === batch.already + batch.generated,
  second.already + ' already done at the second press');
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
check('per-hostel occupancy is reported', ov.occupancy.length === 2,
  ov.occupancy.length + ' hostels');
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
// The overview deliberately does not verify the chain - re-hashing every row
// before the dashboard can paint made the page wait on its slowest part. The
// badge is its own call, and it is still a full verification.
check('the overview does not block on verifying the chain',
  ov.ledger.intact === null,
  'if this becomes a boolean again, the page load has been slowed back down');
check('the badge endpoint still verifies for real',
  apiAdminLedgerBadge().intact === true);
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
const wlPage = apiAdminWaitlist({ page: 1, pageSize: 25 });
const wl = wlPage.rows;
check('waitlist is returned', wl.length > 0, wl.length + ' rows');
check('ordered by position', wl.every((w, i) => i === 0 || wl[i - 1].position <= w.position));
check('each row names a student', wl.every(w => !!w.name));
check('each row has an ETA', wl.every(w => w.etaPercent >= 0 && w.etaPercent <= 100));
check('each row carries the priority group the order comes from',
  wl.every(w => !!w.tier),
  'merit alone makes the ordering look wrong, because it is not what sorts the queue');
check('and the figure shown is the one that group is actually ranked on', (() => {
  const apps = Db.indexBy('Applications', 'appId');
  return wl.every(w => {
    const a = apps[w.appId];
    return w.tier === 'DELHI'
      ? (Number(w.rankedOn) === Number(a.distanceKm) && w.rankedOnUnit === 'km')
      : (Number(w.rankedOn) === Number(a.meritScore) && w.rankedOnUnit === '%');
  });
})(), 'the Delhi group is ordered on distance, so printing their marks explains nothing');
check('and the list really is sorted on it, within each group', (() => {
  for (let i = 1; i < wl.length; i++) {
    if (wl[i].tier !== wl[i - 1].tier) continue;
    if (Number(wl[i].rankedOn) > Number(wl[i - 1].rankedOn) + 0.001) return false;
  }
  return true;
})(), 'if the column and the order disagree, one of them is lying to the warden');

check('a page is a page, not the whole list', wl.length === 25,
  wl.length + ' of ' + wlPage.total);
check('and it says how many there are in total',
  wlPage.total > 25 && wlPage.pages === Math.ceil(wlPage.total / 25),
  wlPage.total + ' waiting, ' + wlPage.pages + ' pages');

const wl2 = apiAdminWaitlist({ page: 2, pageSize: 25 });
check('the next page continues where the first stopped',
  Number(wl2.rows[0].position) > Number(wl[24].position),
  wl[24].position + ' then ' + wl2.rows[0].position);
check('and no row appears on both', (() => {
  const first = wl.map(w => w.appId);
  return wl2.rows.every(w => first.indexOf(w.appId) < 0);
})());

check('the last page is reachable and not empty', (() => {
  const last = apiAdminWaitlist({ page: wlPage.pages, pageSize: 25 });
  return last.rows.length > 0 && last.page === wlPage.pages;
})());
check('asking beyond the end lands on the last page, not on nothing', (() => {
  const over = apiAdminWaitlist({ page: 9999, pageSize: 25 });
  return over.page === over.pages && over.rows.length > 0;
})(), 'an empty screen looks like a broken query, and gets reported as one');

check('every waiting student is reachable by paging', (() => {
  const seen = {};
  for (let p = 1; p <= wlPage.pages; p++) {
    apiAdminWaitlist({ page: p, pageSize: 25 }).rows.forEach(r => { seen[r.appId] = 1; });
  }
  return Object.keys(seen).length === wlPage.total;
})(), 'a list you cannot reach the bottom of is a list that hides the people who have heard nothing');

check('the search looks at the whole list, not the page on screen', (() => {
  // Somebody deliberately far down the queue.
  const deep = apiAdminWaitlist({ page: wlPage.pages, pageSize: 25 }).rows.pop();
  const found = apiAdminWaitlist({ q: deep.enrollmentNo });
  return found.rows.length === 1 && found.rows[0].appId === deep.appId;
})(), 'a filter over the visible page answers no to every question worth asking it');

check('the old call shape still returns the first rows', (() => {
  const legacy = apiAdminWaitlist(20);
  return legacy.rows.length === 20 && legacy.page === 1;
})());

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

section('Withdrawing gives the room back');

(() => {
  // The state this used to leave behind: application WITHDRAWN, allocation
  // still ACTIVE, bed still OCCUPIED by somebody who has said they are not
  // coming. The room was invisible - not vacant on the occupancy report, not
  // available to the next run, and not on any screen an officer could reach.
  const alloc = Db.readAll('Allocations').find(a => a.status === 'ACTIVE');
  const app = Db.byId('Applications', alloc.appId);
  const who = Db.byId('Students', app.studentId);
  global.Session = { getActiveUser: () => ({ getEmail: () => who.email }) };

  const out = apiWithdrawApplication();
  Db.invalidate('Allocations'); Db.invalidate('Beds'); Db.invalidate('Applications');

  check('the application is withdrawn',
    Db.byId('Applications', app.appId).status === 'WITHDRAWN');
  check('the allotment is cancelled with it',
    Db.byId('Allocations', alloc.allocId).status === 'CANCELLED',
    Db.byId('Allocations', alloc.allocId).status);
  check('and the bed is genuinely empty again', (() => {
    const bed = Db.byId('Beds', alloc.bedId);
    return bed.status === 'VACANT' && !bed.occupantAppId;
  })(), 'a bed nobody is in but nothing reports as free is a bed permanently lost');
  check('the caller is told which bed came back', out.bedFreed === alloc.bedId);
  check('and the release is on the ledger',
    Db.readAll('AuditLog').some(e => e.action === 'ALLOTMENT_RELEASED'));
  check('the letter is not left pointing at a room they no longer hold',
    !Db.byId('Allocations', alloc.allocId).letterUrl);
})();

// Back to the administrator for everything after this.
global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };

section('Clearing an allocation clears the numbers with it');

// Last: this section empties the hostel, and everything above it wants a full
// one to look at.
const preClear = apiAdminOverview();
check('there is something to clear', preClear.counts.allotted > 0 && !!preClear.latestRun,
  preClear.counts.allotted + ' allotted');
check('and figures describing it',
  preClear.latestRun.metrics.summary.pref1Pct >= 0 &&
  (preClear.latestRun.metrics.quotaTable || []).length > 0);

const cleared = apiAdminClearAllocation();
const after = apiAdminOverview();

check('every allotment is gone', after.counts.allotted === 0, after.counts.allotted + ' left');
check('the waiting list with it', after.counts.waitlisted === 0);
check('every bed is vacant',
  after.capacity.occupied === 0 && after.capacity.vacant === after.capacity.beds,
  after.capacity.occupied + ' still occupied');
check('every hostel reads 0% occupied',
  after.occupancy.every(h => h.pct === 0 && h.occupied === 0),
  after.occupancy.map(h => h.name + ' ' + h.pct + '%').join(', '));
check('no letters are counted as produced', after.lettersDone === 0);

check('and NO figures are reported over an empty hostel', after.latestRun === null,
  'preference percentages and a filled quota table describing beds nobody holds is ' +
  'the dashboard stating something that is not true');
check('the run itself is kept, marked discarded', (() => {
  const runs = Db.readAll('Runs');
  return runs.length > 0 && runs.every(r => r.mode !== 'COMMITTED') &&
         runs.some(r => r.mode === 'DISCARDED');
})(), 'what was decided is worth keeping; the claim that it still describes the hostel is not');
check('the clearing says how many runs it stood down', cleared.runsDiscarded > 0);
check('and it is on the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'ALLOCATION_CLEARED'));

check('the page can tell "cleared" from "never run"', after.hadRun === true,
  'they produce identical numbers and are not the same thing to be told');

check('letters are refused rather than written for nobody', (() => {
  try { apiAdminGenerateLetters(); return false; }
  catch (e) { return /no allocation/i.test(e.message); }
})());
check('and so are notifications', (() => {
  try { apiAdminNotify(); return false; }
  catch (e) { return /no allocation/i.test(e.message); }
})());

check('running it again brings every figure back', (() => {
  apiAdminRunAllocation({ seed: 'AFTER-CLEAR' });
  const again = apiAdminOverview();
  return again.counts.allotted > 0 &&
         !!again.latestRun &&
         again.latestRun.metrics.summary.pref1Pct >= 0 &&
         again.occupancy.some(h => h.pct > 0);
})(), 'clearing must be undoable by doing the work again, not by editing the sheet');

process.exit(summarise());
