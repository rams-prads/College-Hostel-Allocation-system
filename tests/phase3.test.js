/**
 * Phase 3 tests - document rules and the student portal API.
 *
 *   node tests/phase3.test.js
 *
 * The HTML itself cannot be exercised in Node, so these test the layer the HTML
 * depends on: what the API returns, and that ownership checks actually bite.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();

section("One document, and it is the university's own");

const firstYearGen = { year: 1, category: 'GEN', isPwD: false, programme: 'BTMT' };
const seniorGen    = { year: 3, category: 'GEN', isPwD: false, programme: 'BTMT' };
const firstYearSC  = { year: 1, category: 'SC',  isPwD: false, programme: 'BTMT' };
const seniorPwdOBC = { year: 2, category: 'OBC', isPwD: true,  programme: 'BTMT' };

const types = s => Documents.requiredFor(s).map(d => d.docType).sort();
const slots = s => Documents.slotsFor(s).map(d => d.docType).sort();

check('everybody is asked for their admission confirmation page',
  [firstYearGen, seniorGen, firstYearSC, seniorPwdOBC].every(s =>
    types(s).includes('ADMISSION_FORM')),
  'it carries the region, the category, the disability sub-category, the qualifying ' +
  'marks and the address - every input the allocation turns on');

check('and it is ONE requirement, not a checklist',
  [firstYearGen, seniorGen, firstYearSC, seniorPwdOBC].every(s => types(s).length === 1),
  types(seniorGen).join(', '));

check('a continuing student may send their ID card instead', (() => {
  const req = Documents.requiredFor(seniorGen)[0];
  return req.alternatives.indexOf('ID_CARD') >= 0 &&
         slots(seniorGen).join(',') === 'ADMISSION_FORM,ID_CARD';
})(), 'a third-year may no longer have a two-year-old confirmation page to hand');

check('a first-year has no such alternative', (() => {
  const req = Documents.requiredFor(firstYearGen)[0];
  return req.alternatives.length === 0 && slots(firstYearGen).join(',') === 'ADMISSION_FORM';
})(), 'ID cards are not issued yet in year 1');

check('and the offer is spelled out on the requirement itself',
  /upload your college ID card instead/.test(Documents.requiredFor(seniorGen)[0].hint),
  'an alternative nobody is told about is not an alternative');

check('a lateral-entry student is a first-year in their second year', (() => {
  const le = { year: 2, category: 'GEN', isPwD: false, programme: 'LE-BTMT' };
  return slots(le).join(',') === 'ADMISSION_FORM';
})(), 'asking a brand-new student for a card nobody has issued them is a dead end');

check('nobody is asked for an Aadhaar number or card any more',
  [firstYearGen, seniorGen, firstYearSC, seniorPwdOBC].every(s =>
    slots(s).indexOf('AADHAAR') < 0),
  'it proved one field this system uses and cost a keyed vault to hold');

check('nothing is asked for on account of a category or a PwD claim',
  types(firstYearSC).join(',') === types(firstYearGen).join(',') &&
  types(seniorPwdOBC).join(',') === types(seniorGen).join(','),
  'the admission page already records both, so a certificate would be asking twice');

check('a student with no programme on record still gets a sane answer',
  Documents.requiredFor({ year: 1, category: 'GEN' }).length === 1,
  'an unknown course must not throw on the way to the upload screen');

check('every requirement explains why it is being asked for',
  Documents.slotsFor(seniorPwdOBC).every(d => d.why && d.why.length > 25));

section('Either document satisfies the requirement');

(() => {
  // Taken from the END of the list: the next section works from the start, and
  // two sections quietly sharing an application is how a test fails three
  // sections after the thing that broke it.
  const app = Db.readAll('Applications').slice().reverse().find(a =>
    Number(Db.byId('Students', a.studentId).year) > 1);
  const st = Db.byId('Students', app.studentId);
  Documents.provision(app.appId, st);
  Db.invalidate('Documents');

  const rows = Db.where('Documents', { appId: app.appId });
  check('both slots exist, so the student can choose', rows.length === 2,
    'a slot that only appears once the student has guessed its name is not a slot');

  const card = rows.find(d => d.docType === 'ID_CARD');
  Documents.decide(card.docId, true, 'warden@ipu.ac.in', '');
  Db.invalidate('Documents');
  check('verifying the ID card alone satisfies the requirement',
    Documents.rollUp(app.appId, st) === 'VERIFIED',
    'rolling up row by row leaves an applicant permanently pending over a slot ' +
    'they were never expected to fill');
})();

section('Document provisioning and roll-up');
const students = Db.readAll('Students');
const apps = Db.readAll('Applications');
const stuById = Db.indexBy('Students', 'studentId');
const sampleApp = apps[0];
const sampleStu = stuById[sampleApp.studentId];

const n = Documents.provision(sampleApp.appId, sampleStu);
check('provisioning creates a row per SLOT, alternatives included',
  n === Documents.slotsFor(sampleStu, sampleApp).length, n + ' rows',
  'the student has to have somewhere to put whichever one they have');
check('provisioning is idempotent',
  Documents.provision(sampleApp.appId, sampleStu) === 0);
check('rolls up to PENDING when nothing is uploaded',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'PENDING');

Documents.requiredFor(sampleStu, sampleApp).forEach(d =>
  Documents.recordUpload(sampleApp.appId, d.docType, 'file-' + d.docType, d.docType + '.pdf'));
check('rolls up to SUBMITTED once everything is uploaded',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'SUBMITTED');

const docs = Db.where('Documents', { appId: sampleApp.appId });
docs.forEach(d => Documents.decide(d.docId, true, 'warden@ipu.ac.in', ''));
check('rolls up to VERIFIED once everything is approved',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'VERIFIED');

// Rejecting EVERY document that could satisfy the requirement. Rejecting one of
// two alternatives no longer condemns the application, which is the point of
// there being two - so the test has to say which it means.
docs.forEach(d => Documents.decide(d.docId, false, 'warden@ipu.ac.in', 'Blurred scan'));
check('a requirement with nothing left to satisfy it rolls up to REJECTED',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'REJECTED');

check('but one surviving alternative keeps the requirement met', (() => {
  const card = docs.find(d => d.docType === 'ID_CARD');
  if (!card) return true;                      // a first-year has no alternative
  Documents.decide(card.docId, true, 'warden@ipu.ac.in', 'Accepted instead.');
  Db.invalidate('Documents');
  const up = Documents.rollUp(sampleApp.appId, sampleStu) === 'VERIFIED';
  Documents.decide(card.docId, false, 'warden@ipu.ac.in', 'Blurred scan');
  Db.invalidate('Documents');
  return up;
})(), 'the requirement is met by either document, so one rejection is not the end of it');
check('verification decisions are written to the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'DOCUMENT_REJECTED'));
check('ledger chain survives document activity', Ledger.verify().intact);

section('Apply form API');
// Impersonate a real seeded student by pointing the session at their email.
// Dwarka deliberately: it has two women's hostels, so this student is offered
// more options than MAX_PREFERENCES and the over-length case below is reachable.
// A single-hostel campus cannot produce one, which is itself worth knowing.
const target = students.find(s => s.gender === 'F' && s.year >= 2 && s.campus === 'EDC');
global.Session = { getActiveUser: () => ({ getEmail: () => target.email }) };

const form = apiGetApplyForm();
check('form loads for a signed-in student', form.signedIn && !form.unregistered);
check('form carries the student record', form.student.studentId === target.studentId);
check('options are offered', form.options.length > 0, form.options.length + ' options');
check('options never cross the gender partition', (() => {
  const hostels = Db.indexBy('Hostels', 'hostelId');
  return form.options.every(o => hostels[o.hostelId].gender === target.gender);
})(), 'a hard partition of the allocator - the form must not offer across it');
check('options never cross the campus partition', (() => {
  const hostels = Db.indexBy('Hostels', 'hostelId');
  return form.options.every(o => hostels[o.hostelId].campus === target.campus);
})(), 'a student admitted to one campus can only be housed there');
check('every option has real rooms behind it', form.options.every(o => o.rooms > 0));
check('the document list matches this student',
  form.documents.length ===
  Documents.slotsFor(target, Db.findOne('Applications', { studentId: target.studentId })).length);
check('an existing application is returned as a draft', !!form.draft);
check('the draft preserves the saved preference order', (() => {
  const saved = Db.where('Preferences', { appId: form.draft.appId })
    .sort((a, b) => a.rank - b.rank)
    .map(p => p.hostelId + '|' + p.roomType);
  return JSON.stringify(saved) === JSON.stringify(form.draft.preferences);
})());

section('Saving an application');
const myApp = Db.findOne('Applications', { studentId: target.studentId });
// The seed marks some applications as document-verified for realism, and a
// verified application is - correctly - no longer the student's to change. This
// section is about editing one, so it starts from one that has not been decided.
Db.update('Applications', myApp.appId,
  { status: 'DRAFT', docStatus: 'PENDING', verifyStatus: '' });
Db.invalidate('Applications');

// The menu is as long as the room types open to THIS student - two for an
// undergraduate, three for a PG who may also ask for a single room.
const goodPrefs = form.options.map(o => o.key);
const goodLifestyle = {
  sleepTime: 'LATE', wakeTime: 'LATE', studyStyle: 'QUIET', cleanliness: 4,
  sociability: 2, foodPref: 'VEG', language: 'Hindi',
  guestsFrequency: 'SOMETIMES'
};

const saved = apiSaveApplication({
  needsAccessible: false,
  preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
});
check('submit succeeds', saved.ok && saved.status === 'SUBMITTED');
check('preferences are written in the given order', (() => {
  const p = Db.where('Preferences', { appId: saved.appId })
    .sort((a, b) => a.rank - b.rank).map(x => x.hostelId + '|' + x.roomType);
  return JSON.stringify(p) === JSON.stringify(goodPrefs);
})());
check('ranks are 1..N contiguous', (() => {
  const ranks = Db.where('Preferences', { appId: saved.appId })
    .map(p => p.rank).sort((a, b) => a - b);
  return JSON.stringify(ranks) ===
         JSON.stringify(goodPrefs.map((_, i) => i + 1));
})());
check('saving does not disturb other applicants\' preferences',
  Db.readAll('Preferences').filter(p => p.appId !== saved.appId).length > 0);
check('lifestyle answers are stored',
  Db.byId('Lifestyle', saved.appId).studyStyle === 'QUIET');
check('distance is recomputed from the registry pincode, not trusted from the client',
  Number(Db.byId('Applications', saved.appId).distanceKm) > 0);
check('documents are provisioned on submit',
  Db.where('Documents', { appId: saved.appId }).length > 0);
check('submission is written to the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'APPLICATION_SUBMITTED'));

section('Re-submitting an edited registration');

// The reported fault, in the shape it was reported: open an existing
// registration, change something, submit. The form sends the roommate answers
// back exactly as it received them - and it received a raw sheet row, _row and
// all - so the save died on `Db: no column "_row" in "Lifestyle"`.
(() => {
  Db.update('Applications', myApp.appId,
    { status: 'SUBMITTED', docStatus: 'PENDING', verifyStatus: '' });
  Db.invalidate('Applications');

  const form = apiCall(null, 'apiGetApplyForm', []);
  check('the form hands back the roommate answers it holds', !!form.draft.lifestyle,
    'an edit that starts blank is a re-typing exercise');
  check('and hands over no sheet coordinates with them',
    form.draft.lifestyle._row === undefined,
    'a page that sends _row back is asking Db to write a column that does not exist');

  let threw = null;
  try {
    apiSaveApplication({
      details: details({}),
      needsAccessible: !!form.draft.needsAccessible,
      preferences: form.draft.preferences,
      // Verbatim, the way the page does it.
      lifestyle: form.draft.lifestyle,
      submit: true
    });
  } catch (e) { threw = e.message; }

  check('re-submitting it works', threw === null, threw || '');
  check('and the answers survived the round trip', (() => {
    Db.invalidate('Lifestyle');
    const life = Db.byId('Lifestyle', myApp.appId);
    return life && life.studyStyle === form.draft.lifestyle.studyStyle;
  })());
  check('the application is submitted, not left half-written',
    Db.byId('Applications', myApp.appId).status === 'SUBMITTED');
})();

section('Validation rejects bad input');
function expectReject(label, payload) {
  let threw = false, msg = '';
  try { apiSaveApplication(payload); } catch (e) { threw = true; msg = e.message; }
  check(label, threw, 'was accepted');
  if (threw) console.log('        -> "' + msg + '"');
}

Db.update('Applications', myApp.appId, { status: 'DRAFT' });
expectReject('duplicate preferences are rejected', {
  preferences: [goodPrefs[0], goodPrefs[0]],
  lifestyle: goodLifestyle, submit: true
});
expectReject('submitting with no preferences is rejected', {
  preferences: [], lifestyle: goodLifestyle, submit: true
});
// One hostel per gender and at most three room types, so the menu is short and
// the limit must never be shorter than it - a choice offered and then refused
// for exceeding a cap is a choice that should not have been offered.
check('the limit is never smaller than the menu',
  Number(Db.cfg('MAX_PREFERENCES', 0)) >= form.options.length,
  form.options.length + ' options, limit ' + Db.cfg('MAX_PREFERENCES', 0));

// Testing the cap therefore means lowering it, rather than inventing choices
// that do not exist.
Db.setCfg('MAX_PREFERENCES', String(Math.max(goodPrefs.length - 1, 1)));
Db.invalidate('Config');
expectReject('more preferences than the limit are rejected', {
  preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
});
Db.setCfg('MAX_PREFERENCES', '3');
Db.invalidate('Config');
expectReject('an incomplete roommate questionnaire is rejected on submit', {
  preferences: goodPrefs, lifestyle: { sleepTime: 'LATE' }, submit: true
});

// The security case: a hostel of the wrong gender must never enter the list,
// even if the client sends it directly.
const wrongGenderHostel = Db.readAll('Hostels').find(h => h.gender !== target.gender);
expectReject('a wrong-gender hostel is rejected even if posted directly', {
  preferences: [wrongGenderHostel.hostelId + '|DOUBLE'],
  lifestyle: goodLifestyle, submit: true
});
expectReject('an unknown hostel id is rejected', {
  preferences: ['NOT-A-HOSTEL|DOUBLE'],
  lifestyle: goodLifestyle, submit: true
});

// Campus is a property of admission. A student who could post a preference for
// another campus could apply for a hostel they can never be housed in. Seeded
// data is one campus, so the other one has to be constructed - the rule under
// test is the server refusing it, not the fixture happening to contain one.
expectReject('a hostel at another campus is rejected even if posted directly', (() => {
  const mine = Db.readAll('Hostels').find(h => h.gender === target.gender);
  Db.update('Hostels', mine.hostelId, { campus: 'DWARKA' });
  Db.invalidate('Hostels');
  return { preferences: [mine.hostelId + '|TRIPLE'],
           lifestyle: goodLifestyle, submit: true };
})());
Db.readAll('Hostels').forEach(h => Db.update('Hostels', h.hostelId, { campus: 'EDC' }));
Db.invalidate('Hostels');
check('the application records the campus from the student record, not the browser',
  Db.byId('Applications', saved.appId).campus === target.campus);

section('Drafts are permitted to be incomplete');
Db.update('Applications', myApp.appId, { status: 'DRAFT' });
const draft = apiSaveApplication({
  preferences: [], lifestyle: {}, submit: false
});
check('an empty draft saves without error', draft.ok && draft.status === 'DRAFT');

section('Correcting the details, until the office has finished checking');

Db.update('Applications', myApp.appId, { status: 'SUBMITTED', docStatus: 'PENDING' });
Db.invalidate('Applications');

check('a submitted application is still the student to correct',
  apiGetApplyForm().editable === true,
  'verification is what fixes a declaration, not the act of submitting it');

check('the form carries what is needed to render the details again',
  !!apiGetApplyForm().registration &&
  apiGetApplyForm().registration.programmes.length > 0,
  'the reference data used to be sent only to students who had not registered');

const before = Db.byId('Students', target.studentId);
const newPin = String(before.homePincode) === '110078' ? '560001' : '110078';

// The seeded registry never held a guardian or a full address - a real import
// would. The form asks for them with a red asterisk, so a correction carries
// them; these tests do the same rather than pretending the form does not.
function details(over) {
  return Object.assign({}, Db.byId('Students', target.studentId), {
    homeAddress: 'House 12, Main Road, Sector 4',
    guardianName: 'Ramesh Kumar', guardianPhone: '9812345670'
  }, over || {});
}

const edited = apiSaveApplication({
  details: details({ homePincode: newPin, phone: '9876500011' }),
  needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
});
check('the correction is accepted', edited.ok === true);
check('and it reached the record', String(
  Db.byId('Students', target.studentId).homePincode) === newPin,
  'this is the field the whole priority order turns on for a Delhi applicant');
check('the distance is recomputed from the corrected address, not left stale', (() => {
  const geo = Geo.distanceFromHome(newPin, Db.byId('Students', target.studentId).campus);
  return geo.resolved &&
         Number(Db.byId('Applications', myApp.appId).distanceKm) === Number(geo.km);
})(), 'a corrected address that leaves the old distance behind has corrected nothing');

check('the ledger records WHICH fields moved, not merely that something did', (() => {
  const e = Db.readAll('AuditLog').filter(x => x.action === 'STUDENT_DETAILS_UPDATED').pop();
  if (!e) return false;
  const p = typeof e.payloadJson === 'string' ? JSON.parse(e.payloadJson) : e.payloadJson;
  return p.fields.indexOf('homePincode') >= 0 && !!p.changes.homePincode.from;
})(), 'an officer who verified an address has to see that the address moved afterwards');

check('a field nobody may set themselves is refused', (() => {
  const held = Db.byId('Students', target.studentId);
  apiSaveApplication({
    details: details({ disciplinaryFlag: !held.disciplinaryFlag,
                       exResident: !held.exResident,
                       attendancePct: 99, category: 'SC' }),
    needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
  });
  const after = Db.byId('Students', target.studentId);
  // The whitelisted field moved; the three that are not on the list did not.
  return after.category === 'SC' &&
         !!after.disciplinaryFlag === !!held.disciplinaryFlag &&
         !!after.exResident === !!held.exResident &&
         Number(after.attendancePct) === Number(held.attendancePct);
})(), 'a blacklist would quietly hand over any column added to Students later');

check('an invalid correction is refused whole, leaving the record alone', (() => {
  const held = Db.byId('Students', target.studentId);
  let threw = false;
  try {
    apiSaveApplication({
      details: details({ homePincode: '12' }),
      needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
    });
  } catch (e) { threw = true; }
  return threw && String(Db.byId('Students', target.studentId).homePincode) === String(held.homePincode);
})(), 'half an application saved is worse than none');

check('saving a draft cannot un-submit a submitted application', (() => {
  apiSaveApplication({ preferences: goodPrefs, lifestyle: goodLifestyle, submit: false });
  return Db.byId('Applications', myApp.appId).status === 'SUBMITTED';
})(), 'it would have withdrawn them from the allocation they were already in');

section('A correction reopens whatever was checked against it');

// Both checks passed, and THEN the address changed.
const doc = Db.where('Documents', { appId: myApp.appId })[0];
Db.update('Documents', doc.docId, {
  driveFileId: 'file-x', status: 'VERIFIED', scanVerdict: 'MATCH',
  verifiedBy: 'warden@ipu.ac.in', verifiedAt: new Date()
});
Db.append('Identity', {
  studentId: target.studentId, aadhaarRef: 'ref', aadhaarLast4: '4321',
  enrolmentNorm: '', status: 'VERIFIED', riskScore: 0, findingsJson: null,
  submittedAt: new Date(), verifiedBy: 'warden@ipu.ac.in', verifiedAt: new Date(), note: ''
});
Db.invalidate('Documents'); Db.invalidate('Identity');
Db.update('Applications', myApp.appId, { docStatus: 'PENDING' });
Db.invalidate('Applications');

apiSaveApplication({
  details: details({ homePincode: newPin === '110078' ? '560001' : '110078' }),
  needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
});
Db.invalidate('Documents');

check('the document that was checked against the old address goes back in the queue',
  Db.byId('Documents', doc.docId).status === 'UPLOADED' &&
  Db.byId('Documents', doc.docId).scanVerdict === 'UNSCANNED',
  'otherwise "get it verified, then change it" is the whole hole');
check('and the reopening is on the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'DOCUMENT_CHECK_REOPENED'));

check('changing the name sends the identity check back too', (() => {
  Db.update('Identity', target.studentId, { status: 'VERIFIED' });
  Db.invalidate('Identity');
  apiSaveApplication({
    details: details({ name: 'Corrected Name' }),
    needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
  });
  Db.invalidate('Identity');
  return Identity.statusFor(target.studentId).status === 'SUBMITTED';
})(), 'the identity check matches a name to a card, so a new name is a new check');

check('a correction that touches nothing checkable leaves the checks alone', (() => {
  Db.update('Documents', doc.docId, { status: 'VERIFIED', scanVerdict: 'MATCH' });
  Db.invalidate('Documents');
  apiSaveApplication({
    details: details({ medicalNotes: 'Asthma inhaler kept in the room' }),
    needsAccessible: false, preferences: goodPrefs, lifestyle: goodLifestyle, submit: true
  });
  Db.invalidate('Documents');
  return Db.byId('Documents', doc.docId).status === 'VERIFIED';
})(), 'reopening a check nothing invalidated would just punish people for typing');

section('Once the office has accepted it, it is fixed');

Db.readAll('Documents').filter(d => d.appId === myApp.appId).forEach(d =>
  Db.update('Documents', d.docId, { status: 'VERIFIED', driveFileId: 'f', scanVerdict: 'MATCH' }));
Db.update('Identity', target.studentId, { status: 'VERIFIED' });
Db.update('Applications', myApp.appId, { docStatus: 'VERIFIED' });
Db.invalidate('Documents'); Db.invalidate('Identity'); Db.invalidate('Applications');

check('the form says so rather than rendering fields', apiGetApplyForm().editable === false);
check('and the reason says what happened',
  /checked and accepted/.test(apiGetApplyForm().lockReason),
  apiGetApplyForm().lockReason);
check('a save is refused', (() => {
  try {
    apiSaveApplication({ preferences: goodPrefs, lifestyle: goodLifestyle, submit: true });
    return false;
  } catch (e) { return true; }
})());
check('and so is a details correction', (() => {
  try {
    apiSaveApplication({
      details: details({ homePincode: '110001' }),
      preferences: goodPrefs, lifestyle: goodLifestyle, submit: true });
    return false;
  } catch (e) { return true; }
})(), 'the declaration IS what was verified once both have passed');

check('an undecided application is still theirs to correct', (() => {
  Db.update('Applications', myApp.appId, { docStatus: 'SUBMITTED', verifyStatus: '' });
  Db.invalidate('Applications');
  return apiGetApplyForm().editable === true;
})(), 'while the office has not finished, somebody is still going to read this record');

Db.update('Applications', myApp.appId, { docStatus: 'PENDING' });
Db.update('Identity', target.studentId, { status: 'SUBMITTED' });
Db.invalidate('Applications'); Db.invalidate('Identity');

section('Reporting a problem is a residents desk');

(function () {
  let refused = false, msg = '';
  try { apiRaiseGrievance('The geyser in the bathroom has not worked for three days'); }
  catch (e) { refused = true; msg = e.message; }
  check('an applicant with no room cannot open one', refused,
    'before allotment the application screens already say what is outstanding');
  if (refused) console.log('        -> "' + msg + '"');
  check('and it points them somewhere real',
    /hostel office/.test(msg), msg);
})();

section('Allotted applications lock');
Db.update('Applications', myApp.appId, { status: 'ALLOTTED' });
let locked = false, lockMsg = '';
try {
  apiSaveApplication({ preferences: goodPrefs,
                       lifestyle: goodLifestyle, submit: true });
} catch (e) { locked = true; lockMsg = e.message; }
check('an allotted application cannot be edited', locked,
  'a student could rewrite the basis of their own allocation');
if (locked) console.log('        -> "' + lockMsg + '"');

section('Student view after allocation');
Db.readAll('Applications').forEach(a => Db.update('Applications', a.appId, { status: 'SUBMITTED' }));
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-P3' });

const allocatedApp = run.allocations[0];
const allocatedStu = stuById[Db.byId('Applications', allocatedApp.appId).studentId];
global.Session = { getActiveUser: () => ({ getEmail: () => allocatedStu.email }) };

const view = apiGetStudentView();
check('view loads', view.signedIn && !!view.application);
check('allotment is present', !!view.allocation);
check('allotment names a real room', !!view.allocation.roomNo && !!view.allocation.hostelName);
check('explanation is present', !!view.explanation, 'this is the headline novelty feature');
check('explanation has grouped sections', view.explanation.groups.length >= 3,
  view.explanation.groups.map(g => g.title).join(', '));
check('every explanation item has readable text',
  view.explanation.groups.every(g => g.items.every(i => i.text && i.text.length > 15)));
check('the explanation names the priority group the applicant was placed in', (() => {
  const items = view.explanation.groups.reduce((a, g) => a.concat(g.items), []);
  return items.some(i => i.code === 'PRIORITY_GROUP');
})(), 'which group you are in is the single most decisive fact about the outcome');
check('and the position within that group', (() => {
  const items = view.explanation.groups.reduce((a, g) => a.concat(g.items), []);
  const m = items.find(i => i.code === 'MERIT_POSITION');
  return m && /in your priority group/.test(m.text);
})());
check('preferences are returned with hostel names',
  view.preferences.length > 0 && !!view.preferences[0].hostelName);
check('documents are returned', view.documents.length > 0);

console.log('\n        --- explanation as the student sees it ---');
console.log('        ' + view.explanation.headline);
view.explanation.groups.forEach(g => {
  console.log('        [' + g.title + ']');
  g.items.forEach(i => console.log('          ' + (i.ok ? '✓' : '✗') + ' ' + i.text));
});

section('Roommates in the view');
const withMates = run.allocations
  .map(a => a.appId)
  .find(id => {
    const alloc = Db.findOne('Allocations', { appId: id });
    const bed = Db.byId('Beds', alloc.bedId);
    return Db.where('Beds', { roomId: bed.roomId }).filter(b => b.occupantAppId).length > 1;
  });
const mateStu = stuById[Db.byId('Applications', withMates).studentId];
global.Session = { getActiveUser: () => ({ getEmail: () => mateStu.email }) };
const mateView = apiGetStudentView();
check('roommates are listed', mateView.allocation.roommates.length > 0);
check('each roommate has a compatibility percentage',
  mateView.allocation.roommates.every(m => m.compatPercent >= 0 && m.compatPercent <= 100));
check('roommate names are real students',
  mateView.allocation.roommates.every(m => m.name && m.name !== 'Not yet allotted'));
console.log('        ' + mateView.allocation.roommates.map(m =>
  m.name + ' (' + m.compatPercent + '%' +
  (m.strengths.length ? ', matched on ' + m.strengths.join(' and ') : '') + ')').join('\n        '));

section('Waitlisted student view');
const wlApp = run.waitlist[0];
const wlStu = stuById[Db.byId('Applications', wlApp.appId).studentId];
global.Session = { getActiveUser: () => ({ getEmail: () => wlStu.email }) };
const wlView = apiGetStudentView();
check('waitlist block is present', !!wlView.waitlist);
check('no allotment is shown', !wlView.allocation);
check('position and ETA are shown',
  wlView.waitlist.position >= 1 && wlView.waitlist.etaPercent >= 0);
check('a waitlisted student still gets an explanation', !!wlView.explanation);
console.log('        position ' + wlView.waitlist.position + ', ' +
  wlView.waitlist.etaPercent + '% estimated chance');
wlView.explanation.groups.forEach(g =>
  g.items.filter(i => !i.ok).forEach(i => console.log('        ✗ ' + i.text)));

section('Unknown visitor is handled gracefully');
global.Session = { getActiveUser: () => ({ getEmail: () => 'nobody@example.com' }) };
const stranger = apiGetStudentView();
check('signed in but unregistered is reported, not crashed',
  stranger.signedIn && stranger.unregistered === true);
check('no student data leaks to a stranger', stranger.student === null);

global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
check('signed-out visitor is reported', apiGetStudentView().signedIn === false);

process.exit(summarise());
