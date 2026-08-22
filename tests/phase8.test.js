/**
 * Identity verification tests.
 *
 *   node tests/phase8.test.js
 *
 * Two things are being proved here, and the second matters more than the first.
 *
 *   1. The checks work: a fabricated Aadhaar number is rejected, a recycled
 *      document is caught, an inconsistent application is flagged.
 *   2. The system never holds what it is checking. An Aadhaar number goes in and
 *      a keyed hash comes out; nothing anywhere - sheet, ledger, API response -
 *      can be walked back to the number. That property is asserted directly, by
 *      searching every stored byte for the digits.
 */
const { check, section, summarise, store } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };

function asUser(email) {
  global.Session = { getActiveUser: () => ({ getEmail: () => email }) };
}
function resetLimits() { CacheService._reset(); }

/** A well-formed Aadhaar number: 11 chosen digits plus its Verhoeff digit. */
function makeAadhaar(prefix11) {
  return prefix11 + Identity.verhoeffDigit(prefix11);
}

// =========================================================== Verhoeff
section('Verhoeff check digit');

check('a generated check digit validates', (() => {
  for (let i = 0; i < 500; i++) {
    const p = String(2 + (i % 8)) + String(10000000000 + i * 7919).slice(-10);
    if (!Identity.verhoeffValid(makeAadhaar(p))) return false;
  }
  return true;
})(), 'generate then validate must round-trip');

check('every single-digit error is caught', (() => {
  const n = makeAadhaar('23456789012');
  for (let pos = 0; pos < 12; pos++) {
    for (let d = 0; d <= 9; d++) {
      if (String(d) === n[pos]) continue;
      const bad = n.slice(0, pos) + d + n.slice(pos + 1);
      if (Identity.verhoeffValid(bad)) return false;
    }
  }
  return true;
})(), 'this is the property Verhoeff exists for');

check('every adjacent transposition is caught', (() => {
  const n = makeAadhaar('98765432101');
  for (let i = 0; i < 11; i++) {
    if (n[i] === n[i + 1]) continue;
    const bad = n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2);
    if (Identity.verhoeffValid(bad)) return false;
  }
  return true;
})(), 'a plain modulus checksum would miss these');

check('most invented numbers are rejected', (() => {
  let accepted = 0;
  for (let i = 0; i < 1000; i++) {
    let n = '';
    for (let j = 0; j < 12; j++) n += (i * 7 + j * 13 + (j * j)) % 10;
    if (Identity.verhoeffValid(n)) accepted++;
  }
  return accepted < 150;                       // ~10% pass by chance, as expected
})(), 'roughly one in ten random numbers passes by chance - that is the ceiling');

// =========================================================== form rules
section('Aadhaar form rules');

const good = makeAadhaar('34567890123');
check('a well-formed number is accepted', Identity.checkAadhaar(good).ok, good);
check('spaces and dashes are tolerated',
  Identity.checkAadhaar(good.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2-$3')).ok);
check('the last four digits are extracted',
  Identity.checkAadhaar(good).last4 === good.slice(-4));

function rejects(label, value, fragment) {
  const r = Identity.checkAadhaar(value);
  check(label, !r.ok && (!fragment || r.reason.indexOf(fragment) >= 0), r.reason || 'accepted');
}
rejects('an empty value is rejected', '', '12-digit');
rejects('eleven digits are rejected', good.slice(0, 11), 'exactly 12');
rejects('thirteen digits are rejected', good + '5', 'exactly 12');
rejects('a number starting with 0 is rejected', makeAadhaar('01234567890'), 'never begins');
rejects('a number starting with 1 is rejected', makeAadhaar('11234567890'), 'never begins');
rejects('all-same digits are rejected', '222222222222');
rejects('a bad checksum is rejected', good.slice(0, 11) + ((Number(good[11]) + 1) % 10), 'checksum');

check('the checksum error does not say which digit is wrong',
  Identity.checkAadhaar('345678901234').reason.indexOf('digit ') < 0,
  'naming the position would let an invented number be repaired one digit at a time');

// =========================================================== the vault
section('The vault - what is stored instead of the number');

const ref = Identity.vaultRef(good);
check('the reference is 64 hex characters', /^[0-9a-f]{64}$/.test(ref), ref.slice(0, 24) + '...');
check('it is stable for the same number', Identity.vaultRef(good) === ref);
check('a different number gives a different reference',
  Identity.vaultRef(makeAadhaar('34567890124')) !== ref);
check('the number does not appear in its own reference', ref.indexOf(good) < 0);

check('the key is not in the spreadsheet', (() => {
  const key = PropertiesService.getScriptProperties().getProperty('IDENTITY_VAULT_KEY');
  return !!key && JSON.stringify(store).indexOf(key) < 0;
})(), 'a key stored beside the hashes it protects would protect nothing');

check('comparison is length-safe', !Identity.refsEqual(ref, ref.slice(0, 32)));
check('comparison accepts an exact match', Identity.refsEqual(ref, Identity.vaultRef(good)));
check('comparison rejects a near miss',
  !Identity.refsEqual(ref, ref.slice(0, 63) + (ref[63] === 'a' ? 'b' : 'a')));

// =========================================================== submission
section('Submitting an identity');

const target = Db.readAll('Students')[0];
asUser(target.email);
resetLimits();

const AADHAAR = makeAadhaar('45678901234');
const sub = apiSubmitIdentity(AADHAAR);
check('submission succeeds', sub.ok === true);
check('only the masked form comes back', sub.masked === 'XXXX XXXX ' + AADHAAR.slice(-4));
check('the response carries nothing else',
  JSON.stringify(sub).indexOf(AADHAAR) < 0);

const idRow = Db.byId('Identity', target.studentId);
check('an identity row was written', !!idRow);
check('its status is SUBMITTED', idRow.status === 'SUBMITTED');
check('the last four digits are kept', idRow.aadhaarLast4 === AADHAAR.slice(-4));
check('the reference is the keyed hash', idRow.aadhaarRef === Identity.vaultRef(AADHAAR));

// ---- THE test -------------------------------------------------------------
section('The number itself is nowhere');

check('no sheet holds the Aadhaar number',
  JSON.stringify(store).indexOf(AADHAAR) < 0,
  'searched every cell of every tab');
check('no sheet holds the first eight digits either',
  JSON.stringify(store).indexOf(AADHAAR.slice(0, 8)) < 0,
  'the last four are permitted; anything more is not');
check('the ledger records that it happened, not what it was', (() => {
  const entries = Db.readAll('AuditLog').filter(e => e.action === 'IDENTITY_SUBMITTED');
  return entries.length > 0 && !entries.some(e => JSON.stringify(e.payloadJson).indexOf(AADHAAR) >= 0);
})());
check('the student view never returns it', (() => {
  const v = apiGetStudentView();
  return JSON.stringify(v).indexOf(AADHAAR.slice(0, 8)) < 0;
})());
check('the student sees their own masked number',
  Identity.statusFor(target.studentId).masked === 'XXXX XXXX ' + AADHAAR.slice(-4));

// =========================================================== duplicates
section('One identity, one application');

const other = Db.readAll('Students')[1];
asUser(other.email);
resetLimits();
let dupBlocked = false, dupMsg = '';
try { apiSubmitIdentity(AADHAAR); } catch (e) { dupBlocked = true; dupMsg = e.message; }
check('a second student cannot claim the same Aadhaar', dupBlocked);
check('and is told to contact the office rather than retry',
  dupMsg.indexOf('hostel office') > 0, dupMsg);
console.log('        -> "' + dupMsg + '"');

check('the duplicate left no record behind', !Db.byId('Identity', other.studentId));

asUser(other.email);
resetLimits();
const OTHER_AADHAAR = makeAadhaar('56789012345');
apiSubmitIdentity(OTHER_AADHAAR);
check('a different number is accepted from the same student', !!Db.byId('Identity', other.studentId));

// =========================================================== lifecycle
section('Verification is a recorded human decision');

asUser('admin@ipu.ac.in');
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
Db.invalidate('Admins');

let noteRequired = false;
try {
  apiAdminDecideIdentity(target.studentId, false, '');
} catch (e) { noteRequired = true; }
check('a rejection without a reason is refused', noteRequired,
  'a student told only "rejected" cannot act on it');

apiAdminDecideIdentity(target.studentId, true, 'Matched against address proof.');
check('approval is recorded', Db.byId('Identity', target.studentId).status === 'VERIFIED');
check('the verifier is named', Db.byId('Identity', target.studentId).verifiedBy === 'admin@ipu.ac.in');
check('approval is in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'IDENTITY_VERIFIED'));
check('the ledger chain is still intact', Ledger.verify().intact);

asUser(target.email);
resetLimits();
let locked = false, lockMsg = '';
try { apiSubmitIdentity(makeAadhaar('67890123456')); } catch (e) { locked = true; lockMsg = e.message; }
check('a verified identity cannot be swapped by the student', locked,
  'otherwise the check that was performed silently stops applying');
console.log('        -> "' + lockMsg + '"');

// =========================================================== uploads
section('Upload hardening');

const app = Db.findOne('Applications', { studentId: other.studentId });
Db.update('Applications', app.appId, { status: 'DRAFT' });
asUser(other.email);
resetLimits();
Documents.provision(app.appId, other);

const PNG = Utilities.base64Encode([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
const required = Documents.requiredFor(other)[0].docType;

function upload(payload) {
  return apiUploadDocument(Object.assign(
    { docType: required, fileName: 'scan.png', mimeType: 'image/png', bytes: PNG }, payload));
}
function refuses(label, payload, fragment) {
  let threw = false, msg = '';
  try { upload(payload); } catch (e) { threw = true; msg = e.message; }
  check(label, threw && (!fragment || msg.indexOf(fragment) >= 0), msg || 'was accepted');
}

refuses('an HTML upload is refused', { mimeType: 'text/html' }, 'PDF or a photo');
refuses('an executable is refused', { mimeType: 'application/x-msdownload' }, 'PDF or a photo');
refuses('an SVG is refused', { mimeType: 'image/svg+xml' }, 'PDF or a photo');
refuses('a spoofed content-type parameter does not slip through',
  { mimeType: 'text/html; charset=utf-8' }, 'PDF or a photo');
refuses('an empty file is refused', { bytes: '' }, 'empty');
refuses('a document type that was never required is refused',
  { docType: 'RULES_UNDERTAKING' }, 'not required');
refuses('an oversized file is refused',
  { bytes: Utilities.base64Encode(new Array(9 * 1024 * 1024).fill(65)) }, 'larger than');

const okUpload = upload({});
check('a real PNG uploads', okUpload.ok === true);
check('the stored name is generated, not the one supplied',
  okUpload.fileName.indexOf('scan.png') < 0 && okUpload.fileName.indexOf(required) === 0,
  okUpload.fileName);
check('a path-traversal filename cannot reach the stored name', (() => {
  const r = upload({ fileName: '../../etc/passwd.png' });
  return r.fileName.indexOf('..') < 0 && r.fileName.indexOf('/') < 0;
})());

const stored = Db.findOne('Documents', { appId: app.appId, docType: required });
check('the content hash was recorded', /^[0-9a-f]{64}$/.test(stored.contentHash));
check('the size was recorded', Number(stored.sizeBytes) > 0);
check('the mime type was recorded from the allow-list', stored.mimeType === 'image/png');

section('Rate limiting');
resetLimits();
let hitLimit = false;
for (let i = 0; i < 40 && !hitLimit; i++) {
  try { upload({}); } catch (e) { hitLimit = e.message.indexOf('Too many') >= 0; }
}
check('repeated uploads eventually hit the limit', hitLimit,
  'without a ceiling one account can exhaust the Drive quota');

resetLimits();
let idLimit = false;
asUser('nobody@example.com');
for (let i = 0; i < 20 && !idLimit; i++) {
  try { apiSubmitIdentity(makeAadhaar('3456789012' + (i % 10))); }
  catch (e) { idLimit = e.message.indexOf('Too many') >= 0; }
}
check('identity submissions are rate limited too', idLimit,
  'a 12-digit space is walkable if the endpoint is unmetered');

// =========================================================== screening
section('Cross-checks over the whole application');

// A recycled document: the same bytes submitted by a second applicant.
const third = Db.readAll('Students')[2];
const app3 = Db.findOne('Applications', { studentId: third.studentId });
Db.update('Applications', app3.appId, { status: 'DRAFT' });
Documents.provision(app3.appId, third);
asUser(third.email);
resetLimits();
apiUploadDocument({ docType: Documents.requiredFor(third)[0].docType,
                    fileName: 'x.png', mimeType: 'image/png', bytes: PNG });

const dupScreen = Identity.screen(app3.appId);
check('a byte-identical document is detected across applications',
  dupScreen.findings.some(f => f.code === 'DOCUMENT_REUSED'),
  dupScreen.findings.map(f => f.code).join(', '));
check('and it is treated as blocking', dupScreen.level === 'HIGH');
console.log('        -> "' +
  (dupScreen.findings.find(f => f.code === 'DOCUMENT_REUSED') || {}).text + '"');

// A category claim is checked against the certificate at the counter, where
// the certificate actually is. Screening must not manufacture a finding about a
// document the portal never asked anybody to upload - a queue full of those is
// a queue nobody reads.
const claimant = Db.readAll('Students').find(s => s.category !== 'GEN');
const claimApp = Db.findOne('Applications', { studentId: claimant.studentId });
const claimScreen = Identity.screen(claimApp.appId);
check('a reserved-category claim raises nothing the portal cannot check',
  !claimScreen.findings.some(f => f.code === 'CATEGORY_UNSUPPORTED' ||
                                  f.code === 'PWD_UNSUPPORTED'),
  claimScreen.findings.map(f => f.code).join(', '));

// The address, which is what actually moves the score.
const mismatch = Db.readAll('Students')[3];
Db.update('Students', mismatch.studentId, { homeState: 'Nowhere' });
const misApp = Db.findOne('Applications', { studentId: mismatch.studentId });
check('a PIN code that disagrees with the declared state is flagged',
  Identity.screen(misApp.appId).findings.some(f => f.code === 'STATE_MISMATCH'));

check('a clean application scores low', (() => {
  const clean = Db.readAll('Students').find(s =>
    s.category === 'GEN' && !s.isPwD && !s.selfDeclared);
  const a = Db.findOne('Applications', { studentId: clean.studentId });
  return a && Identity.screen(a.appId).level === 'LOW';
})(), 'a screen that flags everyone tells the verifier nothing');

check('findings are evidence, never a verdict', (() => {
  const r = Identity.screen(app3.appId);
  return r.findings.every(f => f.code && f.severity && f.text) &&
         Object.keys(r).indexOf('decision') < 0;
})());

// =========================================================== enrolment
section('Enrolment numbers');

check('a seeded enrolment number passes', Identity.checkEnrolment(target.enrollmentNo, target).ok,
  target.enrollmentNo);
check('a short one is rejected', !Identity.checkEnrolment('123', target).ok);
check('letters are rejected under the default pattern',
  !Identity.checkEnrolment('ABCDEFGHIJK', target).ok);
check('the pattern is policy, not code', (() => {
  const original = Db.byId('Policy', 'POL-ID-PATTERN').value;
  Db.update('Policy', 'POL-ID-PATTERN', { value: '^[A-Z]{2}\\d{9}$' });
  Policy.invalidate();
  const ok = Identity.checkEnrolment('AB123456789', target).ok &&
             !Identity.checkEnrolment(target.enrollmentNo, target).ok;
  Db.update('Policy', 'POL-ID-PATTERN', { value: original });
  Policy.invalidate();
  return ok;
})(), 'the office must be able to correct the format without a code change');

check('an enrolment number that disagrees with the declared year is flagged', (() => {
  const senior = Db.readAll('Students').find(s => Number(s.year) >= 3);
  if (!senior) return true;
  const wrong = senior.enrollmentNo.slice(0, 9) + '25';   // claims a 2025 intake
  const r = Identity.checkEnrolment(wrong, senior);
  return r.ok && r.findings.some(f => f.code === 'ENROLMENT_YEAR_MISMATCH');
})(), 'the admission year is encoded in the number and must agree with the record');

// =========================================================== admin queue
section('The verification queue');

asUser('admin@ipu.ac.in');
const queue = apiAdminDocQueue(50);
check('the queue is returned', queue.length > 0, queue.length + ' entries');
check('it is ordered by risk, not arrival',
  queue.every((r, i) => i === 0 || queue[i - 1].riskScore >= r.riskScore),
  'reviewing in upload order gives the risky one the same attention as the clean ones');
check('each entry carries its findings', queue.every(r => Array.isArray(r.findings)));
check('the queue never carries a full Aadhaar number',
  JSON.stringify(queue).indexOf(AADHAAR.slice(0, 8)) < 0 &&
  JSON.stringify(queue).indexOf(OTHER_AADHAAR.slice(0, 8)) < 0);
check('masked numbers are shown where an identity exists',
  queue.every(r => !r.aadhaarMasked || /^XXXX XXXX \d{4}$/.test(r.aadhaarMasked)));

const idQueue = apiAdminIdentityQueue(50);
check('the identity queue lists those awaiting a decision',
  idQueue.every(r => r.studentId && r.aadhaarMasked));
check('an identity already decided is not in it',
  !idQueue.some(r => r.studentId === target.studentId),
  'target was verified above');

section('Only admins may see any of it');
asUser(other.email);
['apiAdminDocQueue', 'apiAdminIdentityQueue'].forEach(fn => {
  let denied = false;
  try { global[fn](10); } catch (e) { denied = true; }
  check(fn + ' is closed to students', denied);
});
let decideDenied = false;
try { apiAdminDecideIdentity(other.studentId, true, 'ok'); } catch (e) { decideDenied = true; }
check('a student cannot verify their own identity', decideDenied,
  'the whole point of the step is that someone else performs it');

section('Read-only preview links');

// Session.getActiveUser() returns an empty string for every visitor except the
// owner when a web app is deployed "execute as me" from a consumer Google
// account. These links exist so a student's own screen can be shown on a device
// that is not the owner's. Being a bypass, what matters is what they CANNOT do.

const previewApp = Db.findOne('Applications', { studentId: other.studentId });

asUser('admin@ipu.ac.in');
Db.setCfg('ALLOW_DEMO_LINKS', 'FALSE');
Db.invalidate('Config');

let offRefused = false, offMsg = '';
try { apiAdminDemoLink(previewApp.appId, 24); } catch (e) { offRefused = true; offMsg = e.message; }
check('links are refused while the feature is off', offRefused,
  'a bypass that ships enabled is a hole');
check('and the refusal says how to enable it', offMsg.indexOf('ALLOW_DEMO_LINKS') > 0);
check('a token minted while off does not validate',
  Auth.checkDemoToken(Auth.demoToken(previewApp.appId, 24)) === null);

Db.setCfg('ALLOW_DEMO_LINKS', 'TRUE');
Db.invalidate('Config');
Policy.invalidate();

const link = apiAdminDemoLink(previewApp.appId, 24);
check('an admin can mint one when it is on', !!link.url && link.url.indexOf('?demo=') > 0);
check('issuing one is recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'DEMO_LINK_ISSUED'));

const token = decodeURIComponent(link.url.split('?demo=')[1]);
check('the token resolves to that application',
  Auth.checkDemoToken(token) === previewApp.appId);

// ---- what it must NOT allow ------------------------------------------------
global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };   // a stranger

const view = apiGetStudentView(null, token);
check('an unauthenticated holder sees the portal', view.signedIn === true);
check('it is marked read-only', view.demoMode === true);
check('it is not admin', view.isAdmin !== true);
check('it shows the right student', view.student.studentId === other.studentId);

function refusedWithoutSession(label, fn) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  check(label, threw, 'a preview link must not be able to change anything');
}
refusedWithoutSession('it cannot save an application',
  () => apiSaveApplication({ preferences: [], lifestyle: {}, submit: false }));
refusedWithoutSession('it cannot submit an identity',
  () => apiSubmitIdentity('999000111220'));
refusedWithoutSession('it cannot upload a document',
  () => apiUploadDocument({ docType: 'ID_CARD', fileName: 'x.png',
                            mimeType: 'image/png', bytes: 'AAAA' }));
refusedWithoutSession('it cannot withdraw the application',
  () => apiWithdrawApplication());
refusedWithoutSession('it cannot raise a grievance', () => apiRaiseGrievance('let me in'));
refusedWithoutSession('it cannot reach the admin dashboard', () => apiAdminOverview());
refusedWithoutSession('it cannot mint another link',
  () => apiAdminDemoLink(previewApp.appId, 24));

// ---- forgery ---------------------------------------------------------------
const parts = token.split('~');
check('a re-pointed token is refused',
  Auth.checkDemoToken(previewApp.appId.replace(/\d$/, '9') + '~' + parts[1] + '~' + parts[2]) === null,
  'otherwise one link would open every portal');
check('an extended expiry is refused',
  Auth.checkDemoToken(parts[0] + '~' + (Number(parts[1]) + 86400000) + '~' + parts[2]) === null);
check('a tampered signature is refused',
  Auth.checkDemoToken(parts[0] + '~' + parts[1] + '~' + parts[2].replace(/.$/, 'z')) === null);
check('a truncated signature is refused',
  Auth.checkDemoToken(parts[0] + '~' + parts[1] + '~' + parts[2].slice(0, 8)) === null);
check('an unsigned token is refused',
  Auth.checkDemoToken(previewApp.appId) === null);
check('an expired token is refused', (() => {
  const past = Date.now() - 1000;
  // Signed correctly, just old - the only thing wrong with it is the clock.
  return Auth.checkDemoToken(Auth.demoToken(previewApp.appId, -1)) === null;
})());

Db.setCfg('ALLOW_DEMO_LINKS', 'FALSE');
Db.invalidate('Config');
check('turning it back off invalidates links already issued',
  Auth.checkDemoToken(token) === null,
  'the switch has to be a real off switch, not a hint');

section('Nothing else broke');
check('ledger intact', Ledger.verify().intact, Ledger.verify().reason);
check('no policy override left active', (() => {
  Policy.invalidate();
  return Policy.value('identity', 'ENROLMENT_PATTERN', '') === '^\\d{11}$';
})());

process.exit(summarise());
