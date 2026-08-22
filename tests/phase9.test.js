/**
 * Sign-in tests.
 *
 *   node tests/phase9.test.js
 *
 * A first-year applicant has no college email address for three or four months
 * after they join, and hostel allocation happens before they arrive. Google will
 * only identify visitors on the project owner's own domain, so those students
 * cannot be identified at all - and they are the ones most likely to need a bed.
 *
 * The answer is a one-time code sent to whatever address they actually have.
 * This is authentication, so most of what follows is about what it REFUSES.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };

/** Nobody, as far as Google is concerned. */
function anonymous() {
  global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
}
function asGoogle(email) {
  global.Session = { getActiveUser: () => ({ getEmail: () => email }) };
}
function lastCode() {
  const mail = global.__mail[global.__mail.length - 1];
  return (mail.subject.match(/^(\d{6})/) || [])[1];
}
function fresh() { CacheService._reset(); global.__mail = []; }

// ============================================================ the happy path
section('A student with no college address can still sign in');

anonymous();
fresh();

const before = apiWhoAmI();
check('an unidentified visitor is signed out', before.signedIn === false);

const req = apiRequestSignInCode('first.year@gmail.com');
check('a code is issued', req.sent === true);
check('the code is emailed', global.__mail.length === 1);
check('it goes to the address given', global.__mail[0].to === 'first.year@gmail.com');
check('the code is in the subject, where a phone shows it',
  /^\d{6} is your/.test(global.__mail[0].subject), global.__mail[0].subject);
check('the response does not contain the code',
  JSON.stringify(req).indexOf(lastCode()) < 0,
  'returning it would make the email pointless');

const session = apiVerifySignInCode('first.year@gmail.com', lastCode());
check('a valid code returns a session token', !!session.token);
check('the session says who it is for', session.email === 'first.year@gmail.com');

const who = apiCall(session.token, 'apiWhoAmI', []);
check('the token identifies the caller', who.signedIn && who.email === 'first.year@gmail.com');
check('and reports how they got in', who.via === 'EMAIL_CODE');
check('they are not an administrator', who.isAdmin === false);

// ============================================================ code handling
section('One-time codes are one-time');

fresh();
apiRequestSignInCode('reuse@example.com');
const used = lastCode();
apiVerifySignInCode('reuse@example.com', used);

let reused = false;
try { apiVerifySignInCode('reuse@example.com', used); } catch (e) { reused = true; }
check('a code cannot be used twice', reused);

fresh();
apiRequestSignInCode('guess@example.com');
const real = lastCode();
const wrong = String((Number(real) + 1) % 1000000).padStart(6, '0');

let attempts = 0, lockedOut = false;
for (let i = 0; i < 6; i++) {
  try { apiVerifySignInCode('guess@example.com', wrong); attempts++; }
  catch (e) { if (/Ask for a new code/.test(e.message)) { lockedOut = true; break; } }
}
check('guessing is cut off after five attempts', lockedOut,
  'six digits is a million values - unlimited guesses would walk it');
check('and the real code dies with them', (() => {
  try { apiVerifySignInCode('guess@example.com', real); return false; }
  catch (e) { return true; }
})(), 'otherwise an attacker just keeps going after the counter resets');

fresh();
let noCode = false;
try { apiVerifySignInCode('never.asked@example.com', '123456'); } catch (e) { noCode = true; }
check('a code that was never issued is refused', noCode);

section('Asking for codes is capped');
fresh();
let capped = false;
for (let i = 0; i < 10 && !capped; i++) {
  try { apiRequestSignInCode('spam.target@example.com'); }
  catch (e) { capped = /Too many/.test(e.message); }
}
check('one address cannot be mailed indefinitely', capped,
  'otherwise this endpoint is a way to flood somebody else\'s inbox');

section('Addresses are validated before anything is sent');
fresh();
['', 'notanemail', 'no@domain', 'a b@c.com', '@example.com'].forEach(bad => {
  let threw = false;
  try { apiRequestSignInCode(bad); } catch (e) { threw = true; }
  check('"' + bad + '" is refused', threw);
});
check('nothing was emailed to any of them', global.__mail.length === 0);

section('It does not leak who is registered');
fresh();
const known = Db.readAll('Students')[0].email;
const unknown = 'definitely.not.a.student.' + Date.now() + '@example.com';
const a = apiRequestSignInCode(known);
const b = apiRequestSignInCode(unknown);
check('a registered and an unregistered address answer identically',
  JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) &&
  a.sent === b.sent,
  'a different answer would turn this into a way to test who has applied');

// ============================================================ tokens
section('Session tokens cannot be forged');

fresh();
apiRequestSignInCode('victim@example.com');
const good = apiVerifySignInCode('victim@example.com', lastCode()).token;
const parts = good.split('~');

check('a valid token resolves', SignIn.emailFromToken(good) === 'victim@example.com');
check('an unsigned token is refused', SignIn.emailFromToken('attacker@example.com') === '');
check('swapping the address is refused',
  SignIn.emailFromToken('attacker@example.com~' + parts[1] + '~' + parts[2]) === '',
  'the signature covers the address, which is the whole point');
check('extending the expiry is refused',
  SignIn.emailFromToken(parts[0] + '~' + (Number(parts[1]) + 8.64e7) + '~' + parts[2]) === '');
check('altering the signature is refused', (() => {
  // Must differ from what is there. Substituting a fixed digit was a coin flip:
  // when the signature already ended in it, the test altered nothing and the
  // failure was blamed on the code.
  const last = parts[2].slice(-1);
  const other = last === 'a' ? 'b' : 'a';
  return SignIn.emailFromToken(parts[0] + '~' + parts[1] + '~' + parts[2].slice(0, -1) + other) === '';
})());
check('truncating the signature is refused',
  SignIn.emailFromToken(parts[0] + '~' + parts[1] + '~' + parts[2].slice(0, 8)) === '');
check('an empty token is refused', SignIn.emailFromToken('') === '');
check('a token with no signature is refused',
  SignIn.emailFromToken(parts[0] + '~' + parts[1]) === '');
check('an expired token is refused', (() => {
  const past = Date.now() - 1000;
  // Correctly signed for a moment that has passed - only the clock is wrong.
  return SignIn.emailFromToken(SignIn.mintToken('x@y.com').replace(/~\d+~/, '~' + past + '~')) === '';
})());

// ============================================================ the dispatcher
section('The dispatcher only dispatches endpoints');

anonymous();
['seedAll', 'resetDatabase', 'setupEverything', 'createDatabase',
 'apiCall', 'eval', 'constructor', 'Db', 'toString'].forEach(name => {
  let threw = false;
  try { apiCall(good, name, []); } catch (e) { threw = /Unknown operation/.test(e.message); }
  check('"' + name + '" is not callable through it', threw);
});
check('a genuine endpoint still is',
  apiCall(good, 'apiWhoAmI', []).email === 'victim@example.com');

check('the token does not leak into the next call', (() => {
  apiCall(good, 'apiWhoAmI', []);
  return apiWhoAmI().signedIn === false;      // called with no token at all
})(), 'a token left set would sign the next visitor in as the previous one');

// ============================================================ precedence
section('Google wins when Google has an answer');

asGoogle('real.person@ipu.ac.in');
check('a platform session is used even when a token is supplied',
  apiCall(good, 'apiWhoAmI', []).email === 'real.person@ipu.ac.in',
  'the platform answer cannot be forged, so it must not be overridable by one that can');
check('and it is reported as a Google sign-in',
  apiCall(good, 'apiWhoAmI', []).via === 'GOOGLE');

anonymous();

// ============================================================ authorisation
section('A session is identity, not permission');

check('an email-code visitor is refused the admin dashboard', (() => {
  try { apiCall(good, 'apiAdminOverview', []); return false; }
  catch (e) { return true; }
})(), 'signing in must not be the same thing as being allowed');

// The Admins tab, not the sign-in method, is what grants access.
Db.append('Admins', { email: 'victim@example.com', name: 'Promoted',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
Db.invalidate('Admins');
check('the same visitor is admitted once listed as an administrator',
  apiCall(good, 'apiAdminOverview', []).admin.email === 'victim@example.com');

check('another signed-in visitor is still refused', (() => {
  fresh();
  apiRequestSignInCode('nobody.special@example.com');
  const t = apiVerifySignInCode('nobody.special@example.com', lastCode()).token;
  try { apiCall(t, 'apiAdminOverview', []); return false; }
  catch (e) { return true; }
})());

// ============================================================ end to end
section('A first-year registers and applies, start to finish');

fresh();
anonymous();
apiRequestSignInCode('brand.new.student@gmail.com');
const token = apiVerifySignInCode('brand.new.student@gmail.com', lastCode()).token;

const form = apiCall(token, 'apiGetApplyForm', []);
check('the form offers registration', form.needsRegistration === true);
check('it knows the address they signed in with',
  form.email === 'brand.new.student@gmail.com');

const reg = apiCall(token, 'apiRegisterStudent', [{
  name: 'Ananya Deshpande', enrollmentNo: '04101099927', phone: '9876501234',
  dob: '2007-05-02', gender: 'F', programme: 'BTech', campus: 'DWARKA',
  branch: 'Information Technology', year: 1, entranceRank: 903,
  category: 'GEN', isPwD: false,
  homeAddress: '4 Shivaji Nagar, Kothrud', homeCity: 'Pune', homePincode: '411038',
  guardianName: 'R. Deshpande', guardianPhone: '9820011223',
  guardianEmail: 'r.deshpande@example.com', bloodGroup: 'O+', medicalNotes: ''
}]);
check('registration succeeds', !!reg.studentId);

const stored = Db.byId('Students', reg.studentId);
check('the record carries the address they signed in with',
  stored.email === 'brand.new.student@gmail.com',
  'not a college address, because they will not have one for months');

const opts = apiCall(token, 'apiGetApplyForm', []);
const saved = apiCall(token, 'apiSaveApplication', [{
  needsAccessible: false,
  preferences: opts.options.slice(0, 2).map(o => o.key),
  lifestyle: { sleepTime: 'EARLY', wakeTime: 'EARLY', studyStyle: 'QUIET',
               cleanliness: 4, sociability: 3, foodPref: 'VEG',
               language: 'Marathi', guestsFrequency: 'NEVER' },
  submit: true
}]);
check('the application is submitted', saved.status === 'SUBMITTED');

const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-SIGNIN' });
const view = apiCall(token, 'apiGetStudentView', []);
check('they appear in the allocation', !!view.allocation || !!view.waitlist,
  'signed in, registered, applied and then ignored would be the worst outcome');
check('and can read their own explanation', !!view.explanation);
console.log('        ' + (view.allocation
  ? 'allotted ' + view.allocation.roomNo + ', ' + view.allocation.hostelName
  : 'waitlisted at position ' + view.waitlist.position));

section('Nothing else broke');
check('the sign-in was recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'SIGNIN_EMAIL_VERIFIED'));
check('the ledger never holds a code', (() => {
  return !Db.readAll('AuditLog').some(e =>
    /\b\d{6}\b/.test(JSON.stringify(e.payloadJson || '')));
})());
check('ledger intact', Ledger.verify().intact, Ledger.verify().reason);
check('no bed double-booked', (() => {
  const used = run.allocations.map(a => a.bedId);
  return new Set(used).size === used.length;
})());

process.exit(summarise());
