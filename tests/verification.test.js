/**
 * The verification console.
 *
 *   node tests/verification.test.js
 *
 * The behaviour worth pinning down is not "does a document get marked". It is
 * that one decision leaves ONE consistent state behind, that asking a student
 * for a clearer photograph does not throw their application away, and that the
 * student is told what to do rather than that something was rejected.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();

const ADMIN = 'admin@ipu.ac.in';
Db.append('Admins', { email: ADMIN, name: 'Hostel Admin', role: 'SUPER_ADMIN',
                      campus: 'ALL', active: true });
Db.invalidate('Admins');
function asAdmin() {
  global.Session = { getActiveUser: () => ({ getEmail: () => ADMIN }) };
}
asAdmin();

/**
 * An applicant with everything uploaded and read, waiting on a person.
 *
 * Each call takes a FRESH application. Passing indices by hand meant two
 * sections quietly picked the same one, and the second reset a case the first
 * had already decided - which showed up as an unrelated test failing three
 * sections later.
 */
const used = {};
function readyCase(over, wantContinuing) {
  const apps = Db.readAll('Applications');
  let app = null;
  for (let i = 0; i < apps.length; i++) {
    if (used[apps[i].appId]) continue;
    const s = Db.byId('Students', apps[i].studentId);
    // A continuing student is one who has an ALTERNATIVE - two slots, so
    // "send back the one that is wrong" and "send back everything" differ.
    if (wantContinuing && Documents.slotsFor(s, apps[i]).length < 2) continue;
    app = apps[i];
    break;
  }
  if (!app) throw new Error('no free application left in the fixture');
  used[app.appId] = true;
  const st = Db.byId('Students', app.studentId);
  Documents.provision(app.appId, st);
  Db.invalidate('Documents');
  Db.where('Documents', { appId: app.appId }).forEach((d, n) => {
    Db.update('Documents', d.docId, Object.assign({
      status: 'UPLOADED', driveFileId: 'f-' + app.appId + '-' + n,
      fileName: 'scan.jpg', mimeType: 'image/jpeg', sizeBytes: 80000,
      uploadedAt: new Date(), scanVerdict: 'MATCH',
      scanJson: { findings: [], detail: {
        nameScore: 1,
        declaredPincode: String(st.homePincode),
        pincodesFound: [String(st.homePincode)],
        pincodeConfirmed: true
      } }
    }, over || {}));
  });
  Db.update('Applications', app.appId, { verifyStatus: 'PENDING', status: 'SUBMITTED' });
  Db.invalidate('Documents'); Db.invalidate('Applications');
  return app;
}

// ============================================================== the case
section('One applicant, one object, everything needed to decide');

const a1 = readyCase();
const k = Verification.caseFor(a1.appId);

check('the declaration is in it', !!k.declared.name && !!k.declared.enrollmentNo);
check('the evidence is in it', k.documents.length > 0 && !!k.documents[0].driveFileId);
check('the automatic checks are in it', !!k.risk && Array.isArray(k.risk.findings));
check('and the comparison between the two', k.comparisons.length > 0,
  'the officer\'s task is comparing what was typed with what the document says; ' +
  'the old screen did the comparison and showed only its opinion');
check('a comparison names the field, both sides, and the verdict', (() => {
  const c = k.comparisons[0];
  return c.field && c.declared !== undefined && c.found !== undefined &&
         typeof c.ok === 'boolean';
})(), JSON.stringify(k.comparisons[0]));

check('the document can be shown, not just linked', (() => {
  const d = k.documents[0];
  return /drive\.google\.com/.test(d.previewUrl) && /drive\.google\.com/.test(d.thumbUrl);
})(), 'comparing two things that are never on screen together is the slow way to do this');

check('it says whether the case can be decided at all', typeof k.ready.canDecide === 'boolean');
check('and how long the applicant has been waiting', typeof k.waitingDays === 'number');

check('an Aadhaar number never appears in the case', (() => {
  const s = JSON.stringify(k);
  return !/\b\d{12}\b/.test(s);
})(), 'the console is the screen most likely to be shared or photographed');

check('a blocking finding on a document is not left off the risk panel', (() => {
  // The two used to live on different cards, which put a BLOCK finding about a
  // document below an INFO finding about the applicant. Wrong way round, and
  // the officer had to know to look in two places to find the serious one.
  const a = readyCase({
    scanVerdict: 'CONFLICT',
    scanJson: { findings: [{ code: 'ADDRESS_CONFLICT', severity: 'BLOCK',
                             text: 'The PIN code on the document is not the one declared.' }],
                detail: { nameScore: 1, declaredPincode: '110078',
                          pincodesFound: ['560001'], pincodeConfirmed: false,
                          material: true, declaredKm: 12, documentKm: 1800 } }
  });
  const c = Verification.caseFor(a.appId);
  return c.risk.level === 'HIGH' &&
         c.risk.findings.some(f => /PIN code on the document/.test(f.text));
})(), 'a blocking document finding must make the case blocking');

check('the case compares every field the allocation turns on', (() => {
  // The point of the swap. Aadhaar let one field be checked - the PIN code.
  // The admission page lets six be, four of which were previously typed by the
  // applicant and read by nobody.
  const a = readyCase({
    scanVerdict: 'MATCH',
    scanJson: { findings: [], detail: {
      nameScore: 1, declaredPincode: '110084', pincodesFound: ['110084'],
      pincodeConfirmed: true,
      applicationNo: '131241025461',
      regionRead: 'Delhi (NCT)', regionIsDelhi: true, regionAgrees: true,
      categoryOnForm: 'GEN', pwdOnForm: false,
      percentOnForm: 80.4, percentGap: 0
    } }
  });
  const fields = Verification.caseFor(a.appId).comparisons.map(c => c.field);
  return ['Name', 'Admission region', 'Category', 'Disability',
          'Qualifying marks', 'Application number', 'PIN code']
    .every(f => fields.indexOf(f) >= 0);
})(), 'one field checked became six');

check('and it explains why the region matters', (() => {
  const a = readyCase({
    scanVerdict: 'MATCH',
    scanJson: { findings: [], detail: { regionRead: 'Maharashtra', regionIsDelhi: false,
                                        regionAgrees: false } }
  });
  const r = Verification.caseFor(a.appId).comparisons.find(c => c.field === 'Admission region');
  return r && r.ok === false && /exhausted before the next/.test(r.note || '');
})(), 'an officer who does not know what a field decides cannot weigh a discrepancy in it');

// ========================================================== the decision
section('Verifying closes the whole case, not part of it');

const out = Verification.decide(a1.appId, 'VERIFY', {}, ADMIN);
Db.invalidate('Documents'); Db.invalidate('Applications');

check('it reports what it did', out.ok === true && out.verdict === 'VERIFY');
check('every uploaded document is verified',
  Db.where('Documents', { appId: a1.appId })
    .filter(d => d.driveFileId).every(d => d.status === 'VERIFIED'));
check('the application carries the office decision',
  Db.byId('Applications', a1.appId).verifyStatus === 'VERIFIED');
check('and who made it', !!Db.byId('Applications', a1.appId).verifiedBy);
check('one ledger entry covers the whole decision', (() => {
  const e = Db.readAll('AuditLog').filter(x => x.action === 'VERIFICATION_DECIDED');
  return e.length === 1;
})(), 'three decisions on three screens left nothing tying them together');
check('the chain still verifies', Ledger.verify().intact);

// ======================================================= asking for a copy
section('Asking for a better copy does not throw the application away');

// A CONTINUING student deliberately: they hold two documents, so "send back the
// one that is blurred" and "send back everything" are different outcomes. With a
// first-year, who holds only an Aadhaar, the two are the same and the test
// proves nothing.
const a2 = readyCase(null, true);
const r2 = Verification.decide(a2.appId, 'RESUBMIT',
  { reason: 'UNREADABLE', docTypes: ['ADMISSION_FORM'] }, ADMIN);
Db.invalidate('Documents'); Db.invalidate('Applications');
const app2 = Db.byId('Applications', a2.appId);

check('the case is marked as waiting on the student',
  app2.verifyStatus === 'ACTION_REQUIRED');
check('and is NOT rejected', app2.verifyStatus !== 'REJECTED',
  'this used to kill an application over a blurred photograph');

check('the applicant stays eligible for a room', (() => {
  const e = Eligibility.evaluate(app2, Db.byId('Students', app2.studentId),
    Db.where('Preferences', { appId: app2.appId }).length);
  return e.eligible;
})(), 'the office is waiting on them, which is a reason to chase them and not to refuse them');

check('only the document named is sent back', (() => {
  const docs = Db.where('Documents', { appId: a2.appId });
  const form = docs.find(d => d.docType === 'ADMISSION_FORM');
  const others = docs.filter(d => d.docType !== 'ADMISSION_FORM' && d.driveFileId);
  return form.status === 'REJECTED' && others.every(d => d.status !== 'REJECTED');
})(), '"the ID card is blurred" must not discard an Aadhaar that was perfectly readable');

check('the student is given an instruction, not a verdict', (() => {
  return /clearer photo or scan/.test(r2.message);
})(), r2.message);
check('and the instruction is on the document they have to replace', (() => {
  const d = Db.where('Documents', { appId: a2.appId }).find(x => x.docType === 'ADMISSION_FORM');
  return /clearer/.test(String(d.note));
})());

// ================================================================ reject
section('Rejecting is a different thing and says so');

const a3 = readyCase();
Verification.decide(a3.appId, 'REJECT', { reason: 'DUPLICATE' }, ADMIN);
Db.invalidate('Applications');
const app3 = Db.byId('Applications', a3.appId);

check('the case is rejected', app3.verifyStatus === 'REJECTED');
check('and the applicant is not eligible', (() => {
  const e = Eligibility.evaluate(app3, Db.byId('Students', app3.studentId),
    Db.where('Preferences', { appId: app3.appId }).length);
  return !e.eligible;
})());

// ============================================================ the guards
section('A decision nobody can act on is refused');

check('a reason is required for anything but Verify', (() => {
  const a = readyCase();
  try { Verification.decide(a.appId, 'RESUBMIT', {}, ADMIN); return false; }
  catch (e) { return /reason/i.test(e.message); }
})(), '"rejected" on its own is not an instruction a student can act on');

check('"something else" needs the something else written down', (() => {
  const a = readyCase();
  try { Verification.decide(a.appId, 'OTHER' && 'REJECT', { reason: 'OTHER' }, ADMIN); return false; }
  catch (e) { return /what needs to change/i.test(e.message); }
})());

check('an unknown verdict is refused', (() => {
  const a = readyCase();
  try { Verification.decide(a.appId, 'MAYBE', { reason: 'OTHER', note: 'x' }, ADMIN); return false; }
  catch (e) { return true; }
})());

check('every reason carries the sentence the student reads', (() => {
  return Verification.reasons().every(r => r.student && r.student.length > 40 && r.label);
})(), 'a code in a database is not something anybody can act on');

// ============================= the alternative nobody used
section('An unused alternative is not an outstanding task');

// The reported fault. A continuing student sent the admission page and left the
// ID-card slot empty - which is the whole point of there being two. The slot
// stayed REQUIRED for ever, so the console filed them under "waiting on the
// student" and showed them to nobody, while their own page said "under review".
(() => {
  const app = (function () {
    const apps = Db.readAll('Applications');
    for (let i = 0; i < apps.length; i++) {
      if (used[apps[i].appId]) continue;
      const s = Db.byId('Students', apps[i].studentId);
      if (Documents.slotsFor(s, apps[i]).length < 2) continue;
      used[apps[i].appId] = true;
      return apps[i];
    }
    throw new Error('no continuing applicant left');
  })();
  const st = Db.byId('Students', app.studentId);

  Documents.provision(app.appId, st);
  Db.invalidate('Documents');
  const form = Db.where('Documents', { appId: app.appId })
    .find(d => d.docType === 'ADMISSION_FORM');
  Db.update('Documents', form.docId, {
    status: 'UPLOADED', driveFileId: 'only-the-form', fileName: 'form.jpg',
    scanVerdict: 'MATCH', scanJson: { findings: [], detail: { nameScore: 1 } }
  });
  Db.update('Applications', app.appId,
    { status: 'SUBMITTED', verifyStatus: '', docStatus: 'SUBMITTED' });
  Db.invalidate('Documents'); Db.invalidate('Applications');

  check('the unused slot is still marked REQUIRED', (() => {
    const card = Db.where('Documents', { appId: app.appId }).find(d => d.docType === 'ID_CARD');
    return card && card.status === 'REQUIRED';
  })(), 'which is correct - nobody uploaded to it');

  check('but nothing is outstanding, because the requirement is met',
    Documents.outstanding(app.appId, st).length === 0,
    'an alternative they declined is not a task they owe');

  check('so the case is waiting on the OFFICER, not on the student',
    Verification._stateOf(Db.byId('Applications', app.appId),
      Db.where('Documents', { appId: app.appId }), st) === 'NEEDS_DECISION',
    'it sat in "with student" for ever, invisible to everybody, while the ' +
    'their own page meanwhile said "under review"');

  check('it is in the to-do list',
    Verification.queue({ filter: 'NEEDS_DECISION', limit: 500 })
      .rows.some(r => r.appId === app.appId));

  check('and it can actually be verified',
    Verification.caseFor(app.appId).ready.canDecide === true,
    'the Verify button was disabled on every continuing student who sent the page');

  check('a case with nothing uploaded at all is still waiting on the student', (() => {
    const other = Db.readAll('Applications').find(a =>
      !used[a.appId] && a.status !== 'DRAFT' && a.status !== 'WITHDRAWN');
    used[other.appId] = true;
    const os = Db.byId('Students', other.studentId);
    Documents.provision(other.appId, os);
    Db.update('Applications', other.appId, { verifyStatus: '' });
    Db.invalidate('Documents'); Db.invalidate('Applications');
    return Verification._stateOf(Db.byId('Applications', other.appId),
      Db.where('Documents', { appId: other.appId }), os) === 'WAITING_ON_STUDENT';
  })(), 'the fix must not make everybody look ready');
})();

// =========================================== batching changes nothing
section('Screening a thousand gives the same answers as screening one');

check('a shared cohort index produces the identical verdict', (() => {
  // The queue screens every applicant against one index built once, instead of
  // rebuilding the comparison for each. Faster is worthless if it is also
  // different, so: same applicants, both ways, compared field by field.
  const ctx = Identity.buildContext();
  const sample = Db.readAll('Applications').slice(0, 40);
  return sample.every(a => {
    const alone = Identity.screen(a.appId);
    const batched = Identity.screen(a.appId, ctx);
    return alone.level === batched.level &&
           alone.score === batched.score &&
           JSON.stringify(alone.findings.map(f => f.code).sort()) ===
           JSON.stringify(batched.findings.map(f => f.code).sort());
  });
})(), 'an optimisation that changes an answer is not an optimisation');

check('and duplicates are still caught through the index', (() => {
  // The whole point of the cross-application checks. If the index missed them,
  // everything above would agree and both would be wrong.
  const docs = Db.readAll('Documents').filter(d => d.driveFileId);
  if (docs.length < 2) return true;
  const a = docs[0], b = docs.find(d => d.appId !== a.appId);
  if (!b) return true;
  Db.update('Documents', a.docId, { contentHash: 'TWINNED' });
  Db.update('Documents', b.docId, { contentHash: 'TWINNED' });
  Db.invalidate('Documents');

  const ctx = Identity.buildContext();
  const found = Identity.screen(a.appId, ctx).findings.some(f => f.code === 'DOCUMENT_REUSED');

  Db.update('Documents', a.docId, { contentHash: '' });
  Db.update('Documents', b.docId, { contentHash: '' });
  Db.invalidate('Documents');
  return found;
})(), 'two applications cannot legitimately hold byte-identical documents');

check('a shared enrolment number is caught too', (() => {
  const students = Db.readAll('Students');
  const a = students[0], b = students[1];
  const was = b.enrollmentNo;
  Db.update('Students', b.studentId, { enrollmentNo: a.enrollmentNo });
  Db.invalidate('Students');

  const app = Db.findOne('Applications', { studentId: a.studentId });
  const found = Identity.screen(app.appId, Identity.buildContext())
    .findings.some(f => f.code === 'ENROLMENT_REUSED');

  Db.update('Students', b.studentId, { enrollmentNo: was });
  Db.invalidate('Students');
  return found;
})());

// ============================================================== the queue
section('The queue is ordered by what should be done first');

const q = Verification.queue({ filter: 'ALL', limit: 300 });
check('it returns rows and counts', q.rows.length > 0 && !!q.counts);
check('risk comes before age', (() => {
  for (let i = 1; i < q.rows.length; i++) {
    if (q.rows[i].riskScore > q.rows[i - 1].riskScore) return false;
  }
  return true;
})(), 'a fraudulent application must not sit behind two hundred clean ones');
check('and age breaks the tie', (() => {
  for (let i = 1; i < q.rows.length; i++) {
    if (q.rows[i].riskScore !== q.rows[i - 1].riskScore) continue;
    if (q.rows[i].waitingDays > q.rows[i - 1].waitingDays) return false;
  }
  return true;
})(), 'nor a clean applicant wait a month because nothing is wrong with them');

check('a decided case leaves the to-do list', (() => {
  return !Verification.queue({ filter: 'NEEDS_DECISION', limit: 300 })
    .rows.some(r => r.appId === a1.appId);
})());
check('and appears in the done list', (() => {
  // Searched rather than scanned: an installation with history has thousands of
  // decided cases, and "is it in the first page" is not the question.
  const who = Db.byId('Students', Db.byId('Applications', a1.appId).studentId);
  return Verification.queue({ filter: 'DONE', q: who.enrollmentNo, limit: 50 })
    .rows.some(r => r.appId === a1.appId);
})());
check('a case waiting on the student is in its own list',
  Verification.queue({ filter: 'WAITING_ON_STUDENT', limit: 300 })
    .rows.some(r => r.appId === a2.appId),
  '"who do I chase" is the question a queue is for');

check('the queue can be searched by name or enrolment number', (() => {
  const who = Db.byId('Students', Db.byId('Applications', a2.appId).studentId);
  const found = Verification.queue({ filter: 'ALL', q: who.enrollmentNo, limit: 300 });
  return found.rows.length === 1 && found.rows[0].appId === a2.appId;
})());

check('nobody appears in the queue twice', (() => {
  const seen = {};
  return Verification.queue({ filter: 'ALL', limit: 300 }).rows
    .every(r => (seen[r.appId] ? false : (seen[r.appId] = true)));
})());

// ============================================================== the gate
section('Whether any of this gates anything is a visible, recorded choice');

check('the gate starts off, and says so', (() => {
  const s = apiAdminVerificationStats();
  return s.gate.documents === false;
})(), 'advisory early in a session, required once verification has caught up');

check('turning it on changes the rule', (() => {
  apiAdminSetVerificationGate(true);
  return !!Number(Policy.value('eligibility', 'REQUIRE_DOC_VERIFIED', 0));
})());

check('and an unverified applicant is then held out of the allocation', (() => {
  const a = readyCase();
  const app = Db.byId('Applications', a.appId);
  const e = Eligibility.evaluate(app, Db.byId('Students', app.studentId),
    Db.where('Preferences', { appId: a.appId }).length);
  return !e.eligible;
})());

check('a verified one is not', (() => {
  const app = Db.byId('Applications', a1.appId);
  const e = Eligibility.evaluate(app, Db.byId('Students', app.studentId),
    Db.where('Preferences', { appId: a1.appId }).length);
  return e.eligible;
})());

check('and somebody merely waiting on a copy is not refused for that alone', (() => {
  // With the gate ON they are held, but for the honest reason - verification is
  // unfinished - not because a blurred photograph was recorded as a rejection.
  const app = Db.byId('Applications', a2.appId);
  const e = Eligibility.evaluate(app, Db.byId('Students', app.studentId),
    Db.where('Preferences', { appId: a2.appId }).length);
  return (e.reasons || []).some(x => /waiting for it|has asked you/.test(x.text || ''));
})(), JSON.stringify((Eligibility.evaluate(Db.byId('Applications', a2.appId),
  Db.byId('Students', Db.byId('Applications', a2.appId).studentId), 3).reasons || [])
  .map(x => x.code)));

check('the change is on the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'POLICY_CHANGED'));

apiAdminSetVerificationGate(false);

// ============================================================== the numbers
section('The numbers an officer is measured on');

const st = Verification.stats();
check('what is waiting on a person', typeof st.byState.NEEDS_DECISION === 'number');
check('what is waiting on a student', typeof st.byState.WAITING_ON_STUDENT === 'number');
check('the age of the oldest still waiting', typeof st.oldestWaitingDays === 'number');
check('and how much the machine took off the pile',
  st.settledByMachinePct >= 0 && st.settledByMachinePct <= 100,
  st.settledByMachinePct + '%');
check('the clearable count obeys the same rule the button does', (() => {
  // Counting "agrees with its declaration" and then clearing rather fewer is
  // how a button comes to be labelled with a number it cannot deliver.
  return st.clearable === apiAdminVerificationSummary().clearable;
})(), st.clearable + ' vs ' + apiAdminVerificationSummary().clearable);

section('One trip, not two');

check('the queue can bring the numbers with it', (() => {
  // On Google a second call is a second trip that re-opens the spreadsheet and
  // re-reads every tab the first one just read. Opening this tab asked for the
  // queue and the summary separately; so did every decision.
  const both = apiAdminVerificationQueue({ filter: 'ALL', limit: 10, withStats: true });
  return !!both.rows && !!both.stats && !!both.reasons && !!both.gate;
})());

check('and gives exactly the same numbers as asking separately', (() => {
  const both = apiAdminVerificationQueue({ filter: 'ALL', limit: 10, withStats: true });
  const apart = apiAdminVerificationStats();
  return JSON.stringify(both.stats) === JSON.stringify(apart.stats) &&
         JSON.stringify(both.gate) === JSON.stringify(apart.gate);
})(), 'a shortcut that answers differently is not a shortcut');

check('it does not carry them when nobody asked', (() => {
  const plain = apiAdminVerificationQueue({ filter: 'ALL', limit: 10 });
  return plain.stats === undefined && plain.rows !== undefined;
})(), 'switching a filter does not need the counts recomputed');

section('Only administrators');

global.Session = { getActiveUser: () => ({ getEmail: () => Db.readAll('Students')[0].email }) };
['apiAdminVerificationQueue', 'apiAdminVerificationCase', 'apiAdminVerificationStats',
 'apiAdminVerificationDecide', 'apiAdminSetVerificationGate'].forEach(fn => {
  let denied = false;
  try { global[fn](a1.appId); } catch (e) { denied = /administrator/i.test(e.message); }
  check(fn + ' is closed to students', denied);
});

process.exit(summarise());
