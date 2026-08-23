/**
 * Document reading tests.
 *
 *   node tests/phase10.test.js
 *
 * Distance decides eligibility and moves the merit score, so the home address is
 * the field worth misstating. Checking it by hand means opening several hundred
 * scans before a run, which does not happen, so the declaration stands unchecked.
 *
 * What is read is the PIN CODE, not the address - it is the only part that
 * reaches the allocator, and six digits survive OCR when prose does not. What is
 * RAISED is only a difference that changes the outcome; the whole point is an
 * officer looking at eight applications instead of five hundred.
 *
 * The OCR call is stubbed here. Everything downstream of it - extraction,
 * matching, materiality, the queue - is the part that can be wrong in an
 * interesting way, and that is what these exercise.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };

/** Swap in a fixed OCR result so the rest of the pipeline can be driven. */
let OCR = { ok: true, text: '', reason: '' };
const reader = () => OCR;

// Documents.scanIfNeeded goes through the real reader, so point that at the
// stub too rather than reaching into DocScan.
const realCheck = DocScan.checkDocument;
DocScan.checkDocument = (doc, student, r) => realCheck(doc, student, r || reader);

function asAdmin() {
  global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
}
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
Db.invalidate('Admins');

// ====================================================== extracting a PIN code
section('Reading a PIN code out of OCR noise');

const CASES = [
  ['plain',            'Address: 4 Shivaji Nagar, Kothrud, Pune - 411038', ['411038']],
  ['split by OCR',     'Kothrud, Pune - 411 038', ['411038']],
  ['hyphenated',       'Pune 411-038', ['411038']],
  ['inside a block',   'S/O Ramesh,\n4 Shivaji Nagar\nKothrud\nPune, Maharashtra\n411038\n',
                       ['411038']],
  ['two addresses',    'Present: 110078  Permanent: 781028', ['110078', '781028']]
];
CASES.forEach(([label, text, expect]) => {
  check('PIN read from ' + label,
    JSON.stringify(DocScan.pincodes(text)) === JSON.stringify(expect),
    JSON.stringify(DocScan.pincodes(text)));
});

section('And not reading things that are not PIN codes');
check('an Aadhaar number is not mistaken for one',
  DocScan.pincodes('Aadhaar 4567 8901 2345').length === 0,
  JSON.stringify(DocScan.pincodes('Aadhaar 4567 8901 2345')));
check('an 11-digit enrolment number is not either',
  DocScan.pincodes('Enrolment 04101000126').length === 0);
check('a phone number is not either',
  DocScan.pincodes('Mobile 9876543210').length === 0);
check('a PIN starting with 0 is rejected',
  DocScan.pincodes('Code 011038').length === 0,
  'no Indian PIN code begins with 0');
check('a PIN starting with 9 is rejected',
  DocScan.pincodes('Code 911038').length === 0);
check('a year is not a PIN', DocScan.pincodes('Issued 2019').length === 0);

section('Aadhaar last four, however it is spaced');
check('spaced', JSON.stringify(DocScan.aadhaarLast4('4567 8901 2345')) === '["2345"]');
check('unspaced', JSON.stringify(DocScan.aadhaarLast4('456789012345')) === '["2345"]');
check('a longer run is not matched', DocScan.aadhaarLast4('1234567890123456').length === 0);

// ============================================================ name matching
section('Matching a name through OCR damage');

check('an exact name matches', DocScan.nameScore('Riya Sharma', 'Name: Riya Sharma') === 1);
check('case and punctuation do not matter',
  DocScan.nameScore('Riya Sharma', 'NAME:  RIYA  SHARMA.') === 1);
check('one OCR error in a long token is tolerated',
  DocScan.nameScore('Ananya Deshpande', 'Ananya Deshpands') === 1,
  'OCR confuses adjacent glyphs far more often than it drops a whole word');
check('a different person does not match',
  DocScan.nameScore('Riya Sharma', 'Name: Vikram Patel') === 0);
check('a half match scores a half',
  DocScan.nameScore('Riya Sharma', 'Name: Riya Verma') === 0.5);
check('short tokens are ignored',
  DocScan.nameScore('A B Kumar', 'Kumar') === 1,
  'initials match everything and prove nothing');

// ============================================================ the verdict
section('An Aadhaar that agrees is not sent to anybody');

const student = Db.readAll('Students').find(s => Number(s.homePincode) > 700000);
const app = Db.findOne('Applications', { studentId: student.studentId });
Documents.provision(app.appId, student);

const addrDoc = Db.findOne('Applications', { appId: app.appId }) &&
  Db.where('Documents', { appId: app.appId }).find(d => d.docType === 'AADHAAR');
Db.update('Documents', addrDoc.docId, { driveFileId: 'file-1', status: 'UPLOADED' });
Db.invalidate('Documents');

function scan(text, doc) {
  OCR = { ok: true, text: text, reason: '' };
  return DocScan.checkDocument(doc || Db.byId('Documents', addrDoc.docId), student, reader);
}

const agree = scan('Government of India\n' + student.name +
  '\nS/O Someone\nHouse 12, Main Road\n' + student.homeCity + '\n' + student.homePincode);
check('it reads as a match', agree.verdict === 'MATCH', JSON.stringify(agree.findings));
check('with nothing for a person to do', agree.findings.length === 0);
check('and it recorded which PIN it confirmed',
  agree.detail.declaredPincode === String(student.homePincode));

section('A conflict that changes the outcome IS raised');

// Declared: far from campus and eligible. Document: a Delhi PIN, inside the
// exclusion radius. This is the fraud the check exists for.
const gamed = scan('Government of India\n' + student.name + '\nDwarka, New Delhi\n110078');
check('it reads as a conflict', gamed.verdict === 'CONFLICT', JSON.stringify(gamed.findings));
check('and is blocking', gamed.findings.some(f => f.severity === 'BLOCK'));
check('the reason names both distances and the rule crossed',
  /eligibility line/.test(gamed.findings[0].text), gamed.findings[0].text);
console.log('        ' + gamed.findings[0].text);

section('A difference that changes nothing is NOT raised');

// A neighbouring PIN in the same town: both a similar distance from campus.
const near = String(Number(student.homePincode) + 1);
const clerical = scan('Government of India\n' + student.name + '\n' +
  student.homeCity + '\n' + near);
check('it is not a conflict', clerical.verdict !== 'CONFLICT', clerical.verdict);
check('nothing blocking is produced',
  !clerical.findings.some(f => f.severity === 'BLOCK'));
check('it is recorded, not raised',
  clerical.findings.every(f => f.severity === 'INFO'),
  'this is the case that rebuilds a queue of five hundred if it is got wrong');
console.log('        ' + (clerical.findings[0] || {}).text);

section('Somebody else\'s document is caught');
const wrongPerson = scan('Government of India\nVikram Patel\nSomewhere\n' + student.homePincode);
check('the name mismatch blocks it',
  wrongPerson.findings.some(f => f.code === 'NAME_NOT_ON_DOCUMENT'));
check('and the verdict is a conflict', wrongPerson.verdict === 'CONFLICT');

section('An unreadable scan goes to a person, not through');
OCR = { ok: false, text: '', reason: 'blurred' };
const blur = DocScan.checkDocument(Db.byId('Documents', addrDoc.docId), student, reader);
check('it is marked unreadable', blur.verdict === 'UNREADABLE');
check('and asks for a person', blur.findings.some(f => f.severity === 'REVIEW'));

OCR = { ok: true, text: 'Government of India\n' + student.name + '\nno numbers here', reason: '' };
const noPin = DocScan.checkDocument(Db.byId('Documents', addrDoc.docId), student, reader);
check('a document with no PIN code is unreadable, not a pass',
  noPin.verdict === 'UNREADABLE',
  'silently passing something it could not read would be the worst outcome');

section('A college ID proves enrolment, not address');
// Only a continuing student is asked for one, so this must be a continuing
// student - taking whichever student came first would make the whole section
// skip itself the day the seed order changed.
const senior = Db.readAll('Students').find(s => Number(s.year) > 1);
const seniorApp = Db.findOne('Applications', { studentId: senior.studentId });
Documents.provision(seniorApp.appId, senior);
Db.invalidate('Documents');
const idDoc = Db.where('Documents', { appId: seniorApp.appId })
  .find(d => d.docType === 'ID_CARD');
check('a continuing student was asked for an ID card at all', !!idDoc,
  'without one there is nothing here to test');
if (idDoc) {
  Db.update('Documents', idDoc.docId, { driveFileId: 'file-2', status: 'UPLOADED' });
  Db.invalidate('Documents');
  OCR = { ok: true, text: 'GGSIPU IDENTITY CARD\n' + senior.name +
                          '\nEnrolment No ' + senior.enrollmentNo, reason: '' };
  const idScan = DocScan.checkDocument(Db.byId('Documents', idDoc.docId), senior, reader);
  check('a matching ID card passes', idScan.verdict === 'MATCH', JSON.stringify(idScan.findings));
  check('and no PIN code was demanded of it',
    idScan.detail.declaredPincode === undefined);

  OCR = { ok: true, text: 'GGSIPU IDENTITY CARD\n' + senior.name +
                          '\nEnrolment No 09999999999', reason: '' };
  const wrongId = DocScan.checkDocument(Db.byId('Documents', idDoc.docId), senior, reader);
  check('a wrong enrolment number is raised',
    wrongId.findings.some(f => f.code === 'ENROLMENT_NOT_ON_DOCUMENT'));
}

// ============================================================ at scale
section('The queue an officer actually sees');

// Give every applicant an address proof, most of them honest.
const students = Db.indexBy('Students', 'studentId');
const allApps = Db.readAll('Applications').slice(0, 60);
allApps.forEach(a => Documents.provision(a.appId, students[a.studentId]));
Db.invalidate('Documents');

/** What an OCR pass over a real address proof looks like. */
function aadhaarText(st, pin) {
  return 'GOVERNMENT OF INDIA\n' +
         'Unique Identification Authority of India\n' +
         st.name + '\nDOB: 14/03/2006\n' +
         'S/O Ramesh Kumar, House 12, Main Road,\n' +
         (st.homeCity || 'Town') + ', ' + (st.homeState || 'State') + '\n' + pin + '\n' +
         'XXXX XXXX 4321';
}

let liars = 0;
Db.readAll('Documents')
  .filter(d => d.docType === 'AADHAAR' &&
               allApps.some(a => a.appId === d.appId))
  .forEach((d, i) => {
    const st = students[Db.byId('Applications', d.appId).studentId];
    Db.update('Documents', d.docId, { driveFileId: 'f-' + i, status: 'UPLOADED' });

    // Plant the misdeclaration only where it would actually gain something: a
    // student who declared a far address but whose document says Delhi. Doing it
    // to somebody already living in Delhi plants nothing - the swap changes no
    // outcome, so the check is right to stay quiet, and counting it as a
    // detection the code missed would be measuring the test, not the system.
    const far = Geo.distanceFromHome(st.homePincode, st.campus);
    const cheat = i % 12 === 0 && far.resolved && far.km > 400;
    if (cheat) liars++;

    OCR = { ok: true, text: aadhaarText(st, cheat ? '110078' : st.homePincode) };
    Documents.scanIfNeeded(Db.byId('Documents', d.docId), st, true);
  });
Db.invalidate('Documents');

// An officer would read everything before triaging, so read the rest too.
asAdmin();
let guard = 0;
while (apiAdminScanDocuments(60).remaining > 0 && guard++ < 20) { /* keep going */ }

asAdmin();
const summary = apiAdminVerificationSummary();
console.log('        ' + JSON.stringify(summary.byVerdict));
check('most documents settled themselves',
  summary.byVerdict.MATCH > summary.byVerdict.CONFLICT * 3,
  summary.byVerdict.MATCH + ' matched, ' + summary.byVerdict.CONFLICT + ' conflicted');
check('the officer queue is a small fraction of the whole',
  summary.needsPerson < summary.total / 3,
  summary.needsPerson + ' of ' + summary.total + ' need a person');
console.log('        an officer opens ' + summary.needsPerson + ' documents instead of ' +
            summary.total);

const conflictsOnly = apiAdminDocQueue(100);
check('the queue defaults to only what needs a person',
  conflictsOnly.every(r => r.scanVerdict === 'CONFLICT' || r.scanVerdict === 'UNREADABLE' ||
                           r.scanVerdict === 'UNSCANNED'),
  conflictsOnly.map(r => r.scanVerdict).join(','));
const addressConflicts = conflictsOnly.filter(
  r => r.scanVerdict === 'CONFLICT' && r.docType === 'AADHAAR');
check('every planted misdeclaration is in it, and nothing else is',
  addressConflicts.length === liars,
  addressConflicts.length + ' raised vs ' + liars + ' planted');
check('the full queue is still reachable',
  apiAdminDocQueue(200, false).length > conflictsOnly.length);
check('each one carries the explanation, not just a flag',
  addressConflicts.every(r => r.findings.some(f => f.code === 'ADDRESS_CONFLICT')));
check('every conflict of any kind is blocking',
  conflictsOnly.filter(r => r.scanVerdict === 'CONFLICT')
    .every(r => r.findings.some(f => f.severity === 'BLOCK')),
  'a conflict that is not blocking would be cleared automatically');

section('Auto-clearing takes only what agreed');
const before = Db.readAll('Documents').filter(d => d.status === 'VERIFIED').length;
const cleared = apiAdminAutoClear();
const after = Db.readAll('Documents').filter(d => d.status === 'VERIFIED').length;

check('documents were cleared', cleared.cleared > 0, cleared.cleared + ' cleared');
check('the count is real', after - before === cleared.cleared);
check('no conflicting document was cleared',
  !Db.readAll('Documents').some(d => d.scanVerdict === 'CONFLICT' && d.status === 'VERIFIED'),
  'the entire safety of this rests on that being true');
check('no unread document was cleared',
  !Db.readAll('Documents').some(d =>
    (!d.scanVerdict || d.scanVerdict === 'UNSCANNED') && d.status === 'VERIFIED'));
check('a machine decision is recorded as one',
  Db.readAll('Documents').filter(d => d.status === 'VERIFIED')
    .some(d => /AUTOMATIC/.test(String(d.verifiedBy))),
  'nobody should later mistake this for a person having looked');
check('it is in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'DOCUMENTS_AUTO_CLEARED'));
check('the ledger is intact', Ledger.verify().intact);

section('A document that agrees but is flagged is not left in limbo');

// The reported fault, in full. A document whose reading AGREED was left out of
// the decision queue - correctly, the machine had settled it - and then refused
// by auto-clear because screening had flagged the applicant. Refusing was a
// bare `return`, so the button reported clearing nothing and gave no reason.
// The document was on no admin screen, could not be cleared, and the student's
// portal said "under review" for ever.
(() => {
  asAdmin();

  // Two applications holding a byte-identical document: DOCUMENT_REUSED, which
  // is a BLOCK finding, which makes the applicant screen HIGH.
  const a1 = allApps[0], a2 = allApps[1];
  [a1, a2].forEach(a => {
    Documents.provision(a.appId, students[a.studentId]);
  });
  Db.invalidate('Documents');
  const d1 = Db.where('Documents', { appId: a1.appId })[0];
  const d2 = Db.where('Documents', { appId: a2.appId })[0];
  Db.update('Documents', d1.docId, { status: 'UPLOADED', scanVerdict: 'MATCH',
                                     driveFileId: 'twin-1', contentHash: 'IDENTICAL' });
  Db.update('Documents', d2.docId, { status: 'UPLOADED', scanVerdict: 'MATCH',
                                     driveFileId: 'twin-2', contentHash: 'IDENTICAL' });
  Db.invalidate('Documents');

  check('screening does flag it', Identity.screen(a1.appId).level === 'HIGH',
    Identity.screen(a1.appId).findings.map(f => f.code).join(','));

  const sum = apiAdminVerificationSummary();
  check('the button is not offered a count it cannot deliver',
    sum.clearable === 0 && sum.blocked >= 2,
    'clearable ' + sum.clearable + ', blocked ' + sum.blocked);
  check('and the summary says why they are held',
    /byte-identical|already registered|flagged/i.test(sum.blockedReason || ''),
    sum.blockedReason);
  check('they count as waiting on a person, because they are',
    sum.needsPerson >= 2, sum.needsPerson + ' need a person');

  const queue = apiAdminDocQueue(200);
  check('and they appear in the queue a person actually works through',
    queue.some(r => r.docId === d1.docId) && queue.some(r => r.docId === d2.docId),
    'left out of the queue AND refused by the button is how a document becomes invisible');

  const out = apiAdminAutoClear();
  check('pressing the button clears none of them', (() => {
    Db.invalidate('Documents');
    return Db.byId('Documents', d1.docId).status === 'UPLOADED';
  })(), 'a tidy scan does not make a reused document acceptable');
  check('but it says so, and names who and why',
    (out.skipped || []).length >= 2 &&
    out.skipped.some(x => x.docId === d1.docId && x.reason && x.studentName),
    JSON.stringify((out.skipped || [])[0] || null));

  // And the ordinary path still works: unflag one, and it clears.
  Db.update('Documents', d2.docId, { contentHash: 'DIFFERENT-NOW' });
  Db.invalidate('Documents');
  const out2 = apiAdminAutoClear();
  Db.invalidate('Documents');
  check('a document nothing is wrong with still clears',
    Db.byId('Documents', d1.docId).status === 'VERIFIED',
    'the guard must block the flagged case, not the feature');
  check('and the button reports the work it did', out2.cleared > 0, out2.cleared + ' cleared');
})();

section('Only admins can do any of it');
global.Session = { getActiveUser: () => ({ getEmail: () => students[allApps[0].studentId].email }) };
['apiAdminScanDocuments', 'apiAdminVerificationSummary', 'apiAdminAutoClear']
  .forEach(fn => {
    let denied = false;
    try { global[fn](5); } catch (e) { denied = true; }
    check(fn + ' is closed to students', denied);
  });

process.exit(summarise());
