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

section('Document requirements are computed, not a fixed checklist');
const firstYearGen = { year: 1, category: 'GEN', isPwD: false };
const seniorGen    = { year: 3, category: 'GEN', isPwD: false };
const firstYearSC  = { year: 1, category: 'SC',  isPwD: false };
const seniorPwdOBC = { year: 2, category: 'OBC', isPwD: true };

const types = s => Documents.requiredFor(s).map(d => d.docType).sort();

check('first-year student is asked for an admission letter',
  types(firstYearGen).includes('ADMISSION_LETTER'));
check('first-year student is NOT asked for an ID card',
  !types(firstYearGen).includes('ID_CARD'),
  'ID cards are not issued yet in year 1');
check('continuing student is asked for an ID card',
  types(seniorGen).includes('ID_CARD'));
check('continuing student is NOT asked for an admission letter',
  !types(seniorGen).includes('ADMISSION_LETTER'));
check('General category is NOT asked for a category certificate',
  !types(firstYearGen).includes('CATEGORY_CERT'),
  'GEN claims no reserved seat, so there is nothing to verify');
check('reserved category IS asked for a category certificate',
  types(firstYearSC).includes('CATEGORY_CERT'));
check('PwD student is asked for a disability certificate',
  types(seniorPwdOBC).includes('PWD_CERT'));
check('non-PwD student is not asked for a disability certificate',
  !types(seniorGen).includes('PWD_CERT'));
check('everyone is asked for address proof',
  [firstYearGen, seniorGen, firstYearSC, seniorPwdOBC].every(s =>
    types(s).includes('ADDRESS_PROOF')),
  'distance gates eligibility and carries score weight');
check('a PwD OBC senior is asked for both certificates they are claiming on',
  types(seniorPwdOBC).indexOf('PWD_CERT') >= 0 &&
  types(seniorPwdOBC).indexOf('CATEGORY_CERT') >= 0,
  types(seniorPwdOBC).join(', '));
check('a General first-year is asked for neither, because they claim neither',
  types(firstYearGen).indexOf('PWD_CERT') < 0 &&
  types(firstYearGen).indexOf('CATEGORY_CERT') < 0,
  types(firstYearGen).join(', '));
check('a General first-year is asked for less than a claiming senior',
  types(firstYearGen).length < types(seniorPwdOBC).length,
  types(firstYearGen).length + ' vs ' + types(seniorPwdOBC).length);
check('the marksheet is asked of everyone',
  types(firstYearGen).indexOf('MARKSHEET') >= 0 &&
  types(seniorPwdOBC).indexOf('MARKSHEET') >= 0,
  'the priority list is built from those marks');
check('a first-year gives the admission slip, a continuing student the ID card',
  types(firstYearGen).indexOf('ADMISSION_LETTER') >= 0 &&
  types(seniorPwdOBC).indexOf('ID_CARD') >= 0);
check('a transfer order is asked for only where that priority is claimed', (() => {
  const claimer = Object.assign({}, firstYearGen,
    { residenceCategory: 'DELHI', parentTransferred: true });
  return Documents.requiredFor(claimer).some(d => d.docType === 'TRANSFER_CERT') &&
         types(firstYearGen).indexOf('TRANSFER_CERT') < 0;
})());
check('the category certificate names the actual category', (() => {
  const d = Documents.requiredFor(firstYearSC).find(x => x.docType === 'CATEGORY_CERT');
  return d.label.indexOf('SC') === 0;
})());
check('every requirement explains why it is being asked for',
  Documents.requiredFor(seniorPwdOBC).every(d => d.why && d.why.length > 25));

section('Document provisioning and roll-up');
const students = Db.readAll('Students');
const apps = Db.readAll('Applications');
const stuById = Db.indexBy('Students', 'studentId');
const sampleApp = apps[0];
const sampleStu = stuById[sampleApp.studentId];

const n = Documents.provision(sampleApp.appId, sampleStu);
check('provisioning creates a row per required document',
  n === Documents.requiredFor(sampleStu).length, n + ' rows');
check('provisioning is idempotent',
  Documents.provision(sampleApp.appId, sampleStu) === 0);
check('rolls up to PENDING when nothing is uploaded',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'PENDING');

Documents.requiredFor(sampleStu).forEach(d =>
  Documents.recordUpload(sampleApp.appId, d.docType, 'file-' + d.docType, d.docType + '.pdf'));
check('rolls up to SUBMITTED once everything is uploaded',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'SUBMITTED');

const docs = Db.where('Documents', { appId: sampleApp.appId });
docs.forEach(d => Documents.decide(d.docId, true, 'warden@ipu.ac.in', ''));
check('rolls up to VERIFIED once everything is approved',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'VERIFIED');

Documents.decide(docs[0].docId, false, 'warden@ipu.ac.in', 'Blurred scan');
check('one rejection rolls the whole application up to REJECTED',
  Documents.rollUp(sampleApp.appId, sampleStu) === 'REJECTED');
check('verification decisions are written to the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'DOCUMENT_REJECTED'));
check('ledger chain survives document activity', Ledger.verify().intact);

section('Apply form API');
// Impersonate a real seeded student by pointing the session at their email.
// Dwarka deliberately: it has two women's hostels, so this student is offered
// more options than MAX_PREFERENCES and the over-length case below is reachable.
// A single-hostel campus cannot produce one, which is itself worth knowing.
const target = students.find(s => s.gender === 'F' && s.year >= 2 && s.campus === 'DWARKA');
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
  Documents.requiredFor(target, Db.findOne('Applications', { studentId: target.studentId })).length);
check('an existing application is returned as a draft', !!form.draft);
check('the draft preserves the saved preference order', (() => {
  const saved = Db.where('Preferences', { appId: form.draft.appId })
    .sort((a, b) => a.rank - b.rank)
    .map(p => p.hostelId + '|' + p.roomType);
  return JSON.stringify(saved) === JSON.stringify(form.draft.preferences);
})());

section('Saving an application');
const myApp = Db.findOne('Applications', { studentId: target.studentId });
Db.update('Applications', myApp.appId, { status: 'DRAFT' });

const goodPrefs = form.options.slice(0, 3).map(o => o.key);
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
  const ranks = Db.where('Preferences', { appId: saved.appId }).map(p => p.rank).sort();
  return JSON.stringify(ranks) === JSON.stringify([1, 2, 3]);
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
// A campus has one hostel per gender and three room types, so the menu is
// three long and the limit is three. Testing the cap therefore means lowering
// it rather than inventing choices that do not exist.
check('the limit matches the menu, so nothing unreachable is offered',
  Number(Db.cfg('MAX_PREFERENCES', 0)) === form.options.length,
  form.options.length + ' options, limit ' + Db.cfg('MAX_PREFERENCES', 0));

Db.setCfg('MAX_PREFERENCES', '2');
Db.invalidate('Config');
expectReject('more preferences than the limit are rejected', {
  preferences: form.options.slice(0, 3).map(o => o.key),
  lifestyle: goodLifestyle, submit: true
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
// the other campus could apply for a hostel they can never be housed in.
const otherCampusHostel = Db.readAll('Hostels')
  .find(h => h.gender === target.gender && h.campus !== target.campus);
expectReject('a hostel at the other campus is rejected even if posted directly', {
  preferences: [otherCampusHostel.hostelId + '|DOUBLE'],
  lifestyle: goodLifestyle, submit: true
});
check('the application records the campus from the student record, not the browser',
  Db.byId('Applications', saved.appId).campus === target.campus);

section('Drafts are permitted to be incomplete');
Db.update('Applications', myApp.appId, { status: 'DRAFT' });
const draft = apiSaveApplication({
  preferences: [], lifestyle: {}, submit: false
});
check('an empty draft saves without error', draft.ok && draft.status === 'DRAFT');

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
