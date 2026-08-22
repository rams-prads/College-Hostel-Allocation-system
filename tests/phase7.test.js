/**
 * Self-registration tests.
 *
 *   node tests/phase7.test.js
 *
 * A student not already in the university registry must still be able to apply.
 * The claims that matter: the record is created correctly, it cannot collide
 * with or impersonate an existing one, a first-year is judged on the entrance
 * rank they actually have rather than a CGPA they cannot have yet, and every
 * rule the browser enforces is enforced again on the server.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };

function asUser(email) {
  global.Session = { getActiveUser: () => ({ getEmail: () => email }) };
}

const VALID = {
  name: 'Riya Sharma', enrollmentNo: '04116403223', phone: '9876543210',
  dob: '2006-03-14', gender: 'F', programme: 'BTech',
  branch: 'Computer Science & Engineering', year: 1, entranceRank: 1842,
  category: 'OBC', isPwD: false,
  homeAddress: '12 Beltola Road, Beltola', homeCity: 'Guwahati', homePincode: '781028',
  guardianName: 'S. Sharma', guardianPhone: '9812345678',
  guardianEmail: 's.sharma@example.com', bloodGroup: 'B+', medicalNotes: ''
};

section('A new visitor is offered registration, not a dead end');
asUser('riya.new@example.com');
let form = apiGetApplyForm();
check('registration is offered', form.needsRegistration === true);
check('the signed-in address comes back', form.email === 'riya.new@example.com');
check('programme list is supplied', form.registration.programmes.length >= 5);
check('every programme declares its branches and duration',
  form.registration.programmes.every(p => p.branches.length > 0 && p.years >= 2));
check('all five categories are offered', form.registration.categories.length === 5);
check('the distance rule is stated up front', form.registration.minDistanceKm > 0);

section('PIN code lookup, before the form is submitted');
const far = apiLookupPincode('781028');
check('a far PIN resolves', far.resolved === true);
check('it reports the distance', far.km > 1000, far.km + ' km');
check('it says the applicant is eligible on distance', far.eligible === true);
console.log('        ' + far.message);

const near = apiLookupPincode('110078');
check('a nearby PIN resolves', near.resolved === true);
check('it warns rather than silently failing later', near.eligible === false);
console.log('        ' + near.message);

const unknown = apiLookupPincode('999999');
check('an unknown PIN does not block the applicant', unknown.resolved === false);
check('and says so plainly', unknown.message.indexOf('still apply') > 0);

section('Registration creates the record');
const before = Db.readAll('Students').length;
const res = apiRegisterStudent(VALID);
check('a student id is issued', !!res.studentId);
check('exactly one student was added', Db.readAll('Students').length === before + 1);

const row = Db.byId('Students', res.studentId);
check('the id does not collide with the seeded cohort', row.name === 'Riya Sharma',
  'nextId must skip ids the seed generator already wrote');
check('name stored', row.name === VALID.name);
check('enrolment number stored', row.enrollmentNo === VALID.enrollmentNo);
check('the signed-in address is linked', row.email === 'riya.new@example.com',
  'the account, not anything typed into the form');
check('programme and branch stored', row.programme === 'BTech' && !!row.branch);
check('entrance rank stored for a first-year', Number(row.entranceRank) === 1842);
check('no CGPA is invented for a first-year', Number(row.cgpa) === 0);
check('guardian contact stored', row.guardianName === 'S. Sharma');
check('home state derived from the PIN code', row.homeState === 'Assam',
  'typed state is not trusted when the PIN resolves');
check('the record is flagged as self-declared', row.selfDeclared === true,
  'it is a claim until documents verify it');
check('registration is written to the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'STUDENT_REGISTERED'));
check('the ledger chain is still intact', Ledger.verify().intact);

section('Impersonation and duplication are refused');
let blocked = false, msg = '';
try { apiRegisterStudent(VALID); } catch (e) { blocked = true; msg = e.message; }
check('the same account cannot register twice', blocked);

asUser('someone.else@example.com');
blocked = false;
try {
  apiRegisterStudent(Object.assign({}, VALID, { name: 'Someone Else' }));
} catch (e) { blocked = true; msg = e.message; }
check('a second account cannot claim the same enrolment number', blocked,
  'otherwise one student could hold two applications');
console.log('        -> "' + msg + '"');

blocked = false;
global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
try { apiRegisterStudent(VALID); } catch (e) { blocked = true; }
check('a signed-out visitor cannot register', blocked);

section('Server-side validation - the browser can be bypassed');
function reject(label, patch, expectFragment) {
  asUser('probe' + Math.random().toString(36).slice(2, 8) + '@example.com');
  // A unique enrolment number keeps each probe from tripping the duplicate
  // check instead of the rule under test - unless the rule under test IS the
  // enrolment number, in which case the patch must win.
  const base = Object.assign({}, VALID,
    { enrollmentNo: 'EN' + Math.random().toString(36).slice(2, 9) });
  let threw = false, m = '';
  try {
    apiRegisterStudent(Object.assign(base, patch));
  } catch (e) { threw = true; m = e.message; }
  check(label, threw && (!expectFragment || m.indexOf(expectFragment) >= 0), m || 'was accepted');
}

reject('a one-character name is refused', { name: 'R' }, 'full name');
reject('a missing enrolment number is refused', { enrollmentNo: '' }, 'enrolment');
reject('a seven-digit phone number is refused', { phone: '1234567' }, 'mobile');
reject('a landline-style number is refused', { phone: '0112345678' }, 'mobile');
reject('an unknown gender is refused', { gender: 'X' }, 'gender');
reject('an unknown programme is refused', { programme: 'PhD' }, 'programme');
reject('year 6 of a four-year degree is refused', { year: 6 }, 'Year of study');
reject('a first-year with no entrance rank is refused',
  { year: 1, entranceRank: 0 }, 'entrance');
reject('a later year with no CGPA is refused',
  { year: 3, cgpa: 0, entranceRank: 0 }, 'CGPA');
reject('a CGPA above 10 is refused', { year: 3, cgpa: 11 }, 'CGPA');
reject('an unknown category is refused', { category: 'XYZ' }, 'category');
reject('PwD without a type is refused', { isPwD: true, pwdType: '' }, 'disability');
reject('a five-digit PIN code is refused', { homePincode: '12345' }, 'PIN code');
reject('a missing address is refused', { homeAddress: 'x' }, 'address');
reject('a missing guardian is refused', { guardianName: '' }, 'guardian');
reject('a bad guardian number is refused', { guardianPhone: '123' }, 'guardian');
reject('a malformed guardian email is refused',
  { guardianEmail: 'not-an-email' }, 'email');

section('A continuing student registers on CGPA instead');
asUser('senior@example.com');
const senior = apiRegisterStudent(Object.assign({}, VALID, {
  name: 'Aditi Rao', enrollmentNo: '04116403999', gender: 'F',
  year: 3, cgpa: 8.4, entranceRank: 0, category: 'GEN'
}));
const seniorRow = Db.byId('Students', senior.studentId);
check('a third-year registers successfully', !!senior.studentId);
check('CGPA is stored', Number(seniorRow.cgpa) === 8.4);
check('no entrance rank is required of them', Number(seniorRow.entranceRank) === 0);

section('Eligibility treats the two fairly');
const elig = Eligibility.evaluateAll();
const riyaApp = Db.findOne('Applications', { studentId: res.studentId });
asUser('riya.new@example.com');
const applyForm = apiGetApplyForm();
check('the form now shows preferences rather than registration',
  !applyForm.needsRegistration);
check('only same-gender hostels are offered', (() => {
  const hostels = Db.indexBy('Hostels', 'hostelId');
  return applyForm.options.every(o => hostels[o.hostelId].gender === 'F');
})());

const saved = apiSaveApplication({
  campusPref: 'ANY', needsAccessible: false,
  preferences: applyForm.options.slice(0, 3).map(o => o.key),
  lifestyle: { sleepTime: 'LATE', wakeTime: 'LATE', studyStyle: 'QUIET', cleanliness: 4,
               sociability: 2, foodPref: 'VEG', language: 'Assamese',
               smokingTolerance: false, guestsFrequency: 'SOMETIMES' },
  submit: true
});
check('the application is created', saved.status === 'SUBMITTED');
check('its id does not collide either',
  Db.readAll('Applications').filter(a => a.appId === saved.appId).length === 1);

const ev = Eligibility.evaluateAll().byAppId[saved.appId];
check('a first-year is NOT failed for having no CGPA', ev.eligible === true,
  ev.reasons.filter(r => !r.ok).map(r => r.code).join(', '));
check('and is told why that is fine',
  ev.reasons.some(r => r.code === 'ELIG_PASS_ENTRANCE'));
console.log('        ' + (ev.reasons.find(r => r.code === 'ELIG_PASS_ENTRANCE') || {}).text);

section('Allocation ranks first-years on entrance rank');
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-REG' });
asUser('riya.new@example.com');
const view = apiGetStudentView();
check('the new student is in the run',
  !!view.allocation || !!view.waitlist,
  'registered, applied, and then ignored would be the worst outcome');
check('and gets a full explanation', !!view.explanation);

const meritLine = view.explanation.groups
  .reduce((a, g) => a.concat(g.items), [])
  .find(i => i.code === 'MERIT_POSITION');
check('the explanation names the basis used', !!meritLine &&
  meritLine.text.indexOf('entrance rank') > 0,
  'a first-year must not be told they were ranked on a CGPA they do not have');
console.log('        ' + (meritLine ? meritLine.text : ''));

check('every first-year in the run was scored on entrance rank', (() => {
  const stu = Db.indexBy('Students', 'studentId');
  const apps = Db.indexBy('Applications', 'appId');
  return run.allocations.concat(run.waitlist).every(x => {
    const s = stu[apps[x.appId].studentId];
    if (Number(s.cgpa) >= 1) return true;
    return x.candidate.meritBasis === 'ENTRANCE_RANK' ||
           x.candidate.meritBasis === 'NOT_RECORDED';
  });
})());

section('Nothing else broke');
check('no bed double-booked', (() => {
  const used = run.allocations.map(a => a.bedId);
  return new Set(used).size === used.length;
})());
check('gender partition holds', (() => {
  const rooms = Db.indexBy('Rooms', 'roomId'), hostels = Db.indexBy('Hostels', 'hostelId');
  const apps = Db.indexBy('Applications', 'appId'), stu = Db.indexBy('Students', 'studentId');
  return run.allocations.every(a => {
    const s = stu[apps[a.appId].studentId];
    const h = hostels[rooms[a.roomId].hostelId];
    return h.gender === 'CO' || h.gender === s.gender;
  });
})());
check('ledger intact', Ledger.verify().intact, Ledger.verify().reason);

process.exit(summarise());
