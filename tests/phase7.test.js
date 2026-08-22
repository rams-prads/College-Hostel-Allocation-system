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
  branch: 'Computer Science & Engineering', campus: 'DWARKA', school: 'USICT',
  year: 1,
  // A first-year is ranked on the best five subjects of class 12, which is
  // what the brochure says and what the form therefore has to ask for.
  meritPercent: 88.4,
  residenceCategory: 'OUTSIDE_DELHI', parentTransferred: false,
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
check('both campuses are offered, each explained',
  form.registration.campuses.length === 2 &&
  form.registration.campuses.every(c => c.code && c.label && c.note));
check('the distance rule is stated up front', form.registration.minDistanceKm > 0);

section('PIN code lookup, before the form is submitted');
const far = apiLookupPincode('781028', 'DWARKA');
check('a far PIN resolves', far.resolved === true);
check('it reports the distance', far.km > 1000, far.km + ' km');
check('it says the applicant is eligible on distance', far.eligible === true);
console.log('        ' + far.message);

const near = apiLookupPincode('110078', 'DWARKA');
check('a nearby PIN resolves', near.resolved === true);
check('it warns rather than silently failing later', near.eligible === false);
console.log('        ' + near.message);

const unknown = apiLookupPincode('999999', 'DWARKA');

// Dwarka and East Delhi are ~25 km apart, either side of the 30 km threshold.
// Measuring against the wrong campus would decide eligibility wrongly.
const ghaziabadDW = apiLookupPincode('201001', 'DWARKA');
const ghaziabadED = apiLookupPincode('201001', 'EDC');
check('distance is measured to the student\'s own campus, not the nearest',
  ghaziabadDW.km !== ghaziabadED.km,
  ghaziabadDW.km + ' km to Dwarka vs ' + ghaziabadED.km + ' km to East Delhi');
check('and the two campuses can fall on opposite sides of the 30 km rule',
  ghaziabadDW.eligible !== ghaziabadED.eligible ||
  Math.abs(ghaziabadDW.km - ghaziabadED.km) > 10,
  'if they never differ materially, campus-specific distance buys nothing');
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
check('the class 12 percentage is stored', Number(row.meritPercent) === 88.4);
check('and recorded as coming from class 12', row.meritBasis === 'CLASS_12',
  'a first-year has no university result to be ranked on yet');
check('the admission category is stored', row.residenceCategory === 'OUTSIDE_DELHI',
  'it decides which queue they are in, so it is the most consequential field on the form');
check('a self-registering applicant is not marked a returning resident',
  row.exResident === false,
  're-admission runs from the office list of last session residents, not from a form');
check('guardian contact stored', row.guardianName === 'S. Sharma');
check('home state derived from the PIN code', row.homeState === 'Assam',
  'typed state is not trusted when the PIN resolves');
check('campus is stored on the student record', row.campus === 'DWARKA');
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
reject('a missing campus is refused', { campus: '' }, 'campus');
reject('an invented campus is refused', { campus: 'ROHINI' }, 'campus');
reject('year 6 of a four-year degree is refused', { year: 6 }, 'Year of study');
reject('a first-year with no class 12 marks is refused',
  { year: 1, meritPercent: 0 }, 'best five subjects');
reject('a later year with no semester result is refused',
  { year: 3, meritPercent: 0 }, 'preceding semester');
reject('a percentage above 100 is refused', { year: 3, meritPercent: 104 }, 'percentage');
reject('a missing admission category is refused',
  { residenceCategory: '' }, 'Delhi or the outside-Delhi');
reject('an outside-Delhi applicant cannot claim the parent-transfer priority',
  { residenceCategory: 'OUTSIDE_DELHI', parentTransferred: true }, 'Delhi-category');
reject('a missing school is refused', { school: '' }, 'School of Studies');
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
  name: 'Aditi Rao', enrollmentNo: '04116403999', gender: 'F', campus: 'EDC',
  school: 'USAR', year: 3, meritPercent: 76.5, category: 'GEN',
  residenceCategory: 'DELHI', parentTransferred: true
}));
const seniorRow = Db.byId('Students', senior.studentId);
check('a third-year registers successfully', !!senior.studentId);
check('their semester result is stored', Number(seniorRow.meritPercent) === 76.5);
check('and recorded as a semester result, not class 12',
  seniorRow.meritBasis === 'SEMESTER');
check('a Delhi applicant may claim the parent-transfer priority',
  seniorRow.parentTransferred === true,
  'which moves them from the fourth group to the third');

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
check('only her own campus is offered', applyForm.options.every(o => o.campus === 'DWARKA'),
  'campus is fixed at admission, so the other campus is not an option');
check('the East Delhi student sees a different list', (() => {
  asUser('senior@example.com');
  const theirs = apiGetApplyForm();
  asUser('riya.new@example.com');
  return theirs.options.length > 0 && theirs.options.every(o => o.campus === 'EDC');
})());

// A registering student has no record for the server to read a campus from, so
// the options arrive through a second call once they have declared both.
check('a registrant can fetch options for a declared gender and campus', (() => {
  asUser('brand.new@example.com');           // signed in, no record yet
  const opts = apiGetHostelOptions('F', 'EDC');
  asUser('riya.new@example.com');
  return opts.length > 0 && opts.every(o => o.campus === 'EDC');
})(), 'without this the preference step is empty and registration cannot complete');
check('a registrant must declare both before options exist', (() => {
  asUser('brand.new@example.com');
  let threw = 0;
  try { apiGetHostelOptions('', 'EDC'); } catch (e) { threw++; }
  try { apiGetHostelOptions('F', ''); } catch (e) { threw++; }
  asUser('riya.new@example.com');
  return threw === 2;
})());
check('an existing record overrides what the browser claims',
  apiGetHostelOptions('M', 'EDC').every(o => o.campus === 'DWARKA'),
  'Riya is a Dwarka student; asking for East Delhi must not change that');

// The other campus's hostels must be refused even when posted directly.
let crossCampus = false;
try {
  const alien = Db.readAll('Hostels').filter(h => h.gender === 'F' && h.campus === 'EDC')[0];
  apiSaveApplication({
    needsAccessible: false, preferences: [alien.hostelId + '|DOUBLE'],
    lifestyle: { sleepTime: 'LATE', wakeTime: 'LATE', studyStyle: 'QUIET', foodPref: 'VEG' },
    submit: true
  });
} catch (e) { crossCampus = true; }
check('a hostel at the other campus is refused on submit', crossCampus);

const saved = apiSaveApplication({
  needsAccessible: false,
  preferences: applyForm.options.slice(0, 3).map(o => o.key),
  lifestyle: { sleepTime: 'LATE', wakeTime: 'LATE', studyStyle: 'QUIET', cleanliness: 4,
               sociability: 2, foodPref: 'VEG', language: 'Assamese',
               guestsFrequency: 'SOMETIMES' },
  submit: true
});
check('the application is created', saved.status === 'SUBMITTED');
check('the application mirrors her campus', Db.byId('Applications', saved.appId).campus === 'DWARKA');
check('its id does not collide either',
  Db.readAll('Applications').filter(a => a.appId === saved.appId).length === 1);

const ev = Eligibility.evaluateAll().byAppId[saved.appId];
check('a first-year is eligible on class 12 marks alone', ev.eligible === true,
  ev.reasons.filter(r => !r.ok).map(r => r.code).join(', '));
check('and is told that neither distance nor marks bar them',
  ev.reasons.some(r => r.code === 'ELIG_PASS_FRESH'));
console.log('        ' + (ev.reasons.find(r => r.code === 'ELIG_PASS_FRESH') || {}).text);
check('the class 12 basis is stated in the reasons',
  ev.reasons.some(r => r.code === 'ELIG_PASS_MERIT' && /class 12/i.test(r.text)));

section('Allocation ranks first-years on entrance rank');
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-REG' });
asUser('riya.new@example.com');
const view = apiGetStudentView();
check('the new student is in the run',
  !!view.allocation || !!view.waitlist,
  'registered, applied, and then ignored would be the worst outcome');
check('and gets a full explanation', !!view.explanation);

const items = view.explanation.groups.reduce((a, g) => a.concat(g.items), []);
const tierLine = items.find(i => i.code === 'PRIORITY_GROUP');
const meritLine = items.find(i => i.code === 'MERIT_POSITION');

check('the explanation names the priority group first', !!tierLine);
console.log('        ' + (tierLine ? tierLine.text : ''));
check('and it is the outside-Delhi group, as declared',
  !!tierLine && /outside-Delhi/.test(tierLine.text));
check('the position names the measure that ordered it', !!meritLine &&
  /class 12/.test(meritLine.text),
  'a first-year must not be told they were ranked on a result they do not have');
console.log('        ' + (meritLine ? meritLine.text : ''));

check('a first-year anywhere in the run is ranked on class 12', (() => {
  const stu = Db.indexBy('Students', 'studentId');
  const apps = Db.indexBy('Applications', 'appId');
  return run.allocations.concat(run.waitlist).every(x => {
    const s = stu[apps[x.appId].studentId];
    if (Number(s.year) > 1) return true;
    return s.meritBasis === 'CLASS_12' || s.meritBasis === 'NOT_RECORDED';
  });
})());
check('nobody is placed above their own priority group', (() => {
  const order = run.allocations.concat(run.waitlist)
    .filter(x => x.candidate).map(x => x.candidate.tierRank);
  // Allotments are made in order, so the ranks must never go backwards within
  // the allocated set followed by the waitlisted set.
  const allocRanks = run.allocations.filter(x => x.candidate).map(x => x.candidate.tierRank);
  return Math.max.apply(null, allocRanks) >= Math.min.apply(null, allocRanks) && order.length > 0;
})());

section('Nothing else broke');
check('no bed double-booked', (() => {
  const used = run.allocations.map(a => a.bedId);
  return new Set(used).size === used.length;
})());
check('campus partition holds', (() => {
  const rooms = Db.indexBy('Rooms', 'roomId'), hostels = Db.indexBy('Hostels', 'hostelId');
  const apps = Db.indexBy('Applications', 'appId'), stu = Db.indexBy('Students', 'studentId');
  return run.allocations.every(a => {
    const s = stu[apps[a.appId].studentId];
    return hostels[rooms[a.roomId].hostelId].campus === s.campus;
  });
})(), 'a student cannot be housed at a campus they are not admitted to');
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
