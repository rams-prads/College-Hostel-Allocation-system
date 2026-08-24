/**
 * Reading a GGSIPU admission confirmation page.
 *
 *   node tests/admissionform.test.js
 *
 * This document replaced Aadhaar as the evidence the whole system rests on, so
 * what it can and cannot be trusted to read is worth stating precisely.
 *
 * The text below is OCR of a real confirmation page, kept verbatim - including
 * the fact that the "Region" label is not a label but a fifty-word sentence,
 * which is exactly the sort of thing that breaks a reader written against a
 * tidied-up example.
 */
const { check, section, summarise } = require('./stubs');

// The address check needs the PIN-code reference table to say how far apart two
// PIN codes are, and policy for the tolerance. Everything else here is pure.
seedConfig_();
seedPolicy_();
seedAll();

const PAGE = [
  'Guru Gobind Singh Indraprastha University, Delhi',
  'GGSIPU B.Tech 2024 [CODE-131]',
  'Confirmation Page',
  'Personal Details',
  'Application Number 131241025461 Candidate Name Nikhil Chavan',
  'Father Name Sanjay Chavan Mother Name Sunita Chavan',
  'Gender Male Date of Birth (DOB) 29-11-2004',
  'Region from where Qualifying Exam has passed or appeared as per the Eligibility ' +
    'Criteria mentioned in the admission brochure Delhi (NCT) Religion HINDUISM',
  'Category General',
  'Sub Category List',
  'Physically handicapped No',
  'Defence Personnel No',
  'Wards of J&K Migrants No',
  'Sikh Minority No',
  'Other Details',
  'Anti-Ragging Undertaking Reference No {# Enter NA, In case of non availability} NA',
  'Qualification Details',
  'Class 10th or Equivalent Details',
  'Passing Status Passed',
  'Passing Year 2021',
  'Qualifying Board CBSE (CENTRAL BOARD OF SECONDARY EDUCATION)',
  'Roll Number 26104942',
  'Maximum Marks 500',
  'Obtained Marks 454',
  'Percentage Marks 90.8',
  '(Qualifying Exam Details as per Eligibility Criteria) Details',
  'Passing Status Passed',
  'Passing Year 2023',
  'Board /University CBSE I (CBSE INTERNATIONAL)',
  'Roll Number 26603575',
  'Maximum Marks 500',
  'Obtained Marks 402',
  'Percentage Marks 80.4',
  'Contact Details',
  'Correspondence Address',
  'Premises No./Village Name Gali No-4 , A-block,',
  'Sub Locality/Colony/Police Station(Optional) --',
  'Locality/City/Town/Village/Post Office shastri park extension burari',
  'Country India',
  'State Delhi (NCT)',
  'District NORTH DELHI',
  'Pin Code 110084',
  'Mobile Number 966****066'
].join('\n');

const f = DocScan.readAdmissionForm(PAGE);

section('Every field the allocation turns on, off one page');

check('the application number', f.applicationNo === '131241025461',
  f.applicationNo + ' - the university can check this against its own counselling list, ' +
  'which is a stronger control than anything available for an Aadhaar number');

check('the candidate name, and not the next column with it',
  f.candidateName === 'Nikhil Chavan', JSON.stringify(f.candidateName));
check('the father name likewise', f.fatherName === 'Sanjay Chavan',
  JSON.stringify(f.fatherName));

check('the region the qualifying exam was passed in', f.region === 'Delhi (NCT)',
  JSON.stringify(f.region));
check('and what it means for the priority order', f.regionIsDelhi === true,
  'this decides which group the applicant is in, and the brochure exhausts one ' +
  'group before it looks at the next - nothing else on the page matters as much');

check('the reservation category, normalised', f.category === 'GEN', f.category);
check('the disability sub-category', f.isPwD === false && f.pwdRead === true,
  'the FIRST priority group; it was self-declared and checked by nobody');

check('the QUALIFYING percentage, not the class 10 one',
  f.qualifyingPercent === 80.4,
  f.qualifyingPercent + ' of ' + JSON.stringify(f.percentages) +
  ' - the page carries both, and the brochure ranks a first-year on the qualifying one');

check('the correspondence PIN code', f.pincodes.indexOf('110084') >= 0,
  JSON.stringify(f.pincodes));
check('and no other number is mistaken for one', f.pincodes.length === 1,
  JSON.stringify(f.pincodes) + ' - roll numbers, marks and an application number ' +
  'are all on this page and none of them is a PIN code');

check('the state and district', f.state === 'Delhi (NCT)' && /NORTH/.test(f.district),
  f.state + ' / ' + f.district);

section('The label that is a sentence');

check('the region is not confused with the question that asks for it',
  !/Qualifying Exam has passed/i.test(f.region),
  'anchoring on the first two words of that label captures the rest of the ' +
  'question instead of the answer');

check('a page whose boilerplate OCR mangled still yields the region', (() => {
  const mangled = PAGE.replace(
    /Region from where Qualifying Exam has passed[\s\S]*?brochure/,
    'Reg1on fr0m where Qua1ifying Exarn ... brochure');
  return DocScan.readAdmissionForm(mangled).regionIsDelhi === true;
})(), 'the answer still sits between the end of that sentence and "Religion"');

section('An outside-Delhi page reads as one');

const outside = DocScan.readAdmissionForm(
  PAGE.replace('admission brochure Delhi (NCT) Religion', 'admission brochure Maharashtra Religion'));
check('the region is read, not assumed', outside.region === 'Maharashtra', outside.region);
check('and it is not Delhi', outside.regionIsDelhi === false);
check('while the correspondence address is untouched',
  outside.pincodes.indexOf('110084') >= 0,
  'a student can live in Delhi and have sat their board exam elsewhere - that is ' +
  'precisely the distinction the brochure draws, and conflating the two is wrong');

section('Each category spelling');

[['General', 'GEN'], ['Other Backward Classes', 'OBC'], ['Scheduled Caste', 'SC'],
 ['Scheduled Tribe', 'ST'], ['Economically Weaker Section', 'EWS'],
 ['OBC (Non Creamy Layer)', 'OBC'], ['SC', 'SC']].forEach(pair => {
  const read = DocScan.readAdmissionForm(PAGE.replace('Category General', 'Category ' + pair[0]));
  check('"' + pair[0] + '" reads as ' + pair[1], read.category === pair[1], read.category);
});

section('A page that contradicts the declaration is caught');

// Straight through checkDocument, not through the reader alone: what matters is
// that a contradiction becomes a finding an officer sees, with the right
// severity, not merely that a field was parsed.
const DOC = { docId: 'D1', appId: 'A1', docType: 'ADMISSION_FORM', driveFileId: 'x' };
function scanAs(student, page) {
  return DocScan.checkDocument(DOC, student, function () {
    return { ok: true, text: page || PAGE, reason: '' };
  });
}
const HONEST = {
  name: 'Nikhil Chavan', enrollmentNo: '', residenceCategory: 'DELHI',
  category: 'GEN', isPwD: false, meritPercent: 80.4,
  homePincode: '110084', campus: 'EDC'
};

check('an honest page produces nothing to act on',
  scanAs(HONEST).findings.length === 0,
  JSON.stringify(scanAs(HONEST).findings.map(f => f.code)));

check('claiming the Delhi category on an outside-Delhi page is BLOCKING', (() => {
  const r = scanAs(HONEST,
    PAGE.replace('admission brochure Delhi (NCT) Religion', 'admission brochure Bihar Religion'));
  const f = r.findings.find(x => x.code === 'REGION_CONFLICT');
  return f && f.severity === 'BLOCK' && r.verdict === 'CONFLICT';
})(), 'the priority groups are exhausted in order, so this is not a detail - it is ' +
      'the difference between being considered second and being considered fourth');

check('and the finding says what it costs',
  /priority group/.test((scanAs(HONEST,
    PAGE.replace('admission brochure Delhi (NCT) Religion', 'admission brochure Bihar Religion'))
    .findings.find(x => x.code === 'REGION_CONFLICT') || {}).text || ''));

check('a disability claimed but not on the form is BLOCKING', (() => {
  const r = scanAs(Object.assign({}, HONEST, { isPwD: true }));
  const f = r.findings.find(x => x.code === 'PWD_CONFLICT');
  return f && f.severity === 'BLOCK';
})(), 'the disabled group is considered before every other');

check('a disability ON the form but not claimed is also raised', (() => {
  const r = scanAs(HONEST, PAGE.replace('Physically handicapped No', 'Physically handicapped Yes'));
  const f = r.findings.find(x => x.code === 'PWD_CONFLICT');
  return f && /would place this applicant in the first priority group/.test(f.text);
})(), 'a student who under-claims loses a place they were entitled to, which is a ' +
      'failure of the system and not of the student');

check('a category that disagrees is BLOCKING', (() => {
  const r = scanAs(Object.assign({}, HONEST, { category: 'SC' }));
  const f = r.findings.find(x => x.code === 'CATEGORY_CONFLICT');
  return f && f.severity === 'BLOCK';
})(), 'reserved seats are apportioned on it');

check('marks that differ are raised but do NOT block', (() => {
  const r = scanAs(Object.assign({}, HONEST, { meritPercent: 92 }));
  const f = r.findings.find(x => x.code === 'MERIT_DIFFERS');
  return f && f.severity === 'REVIEW';
})(), 'the page carries two percentages and a continuing student is ranked on a ' +
      'semester result that is not on it at all - so this is for a person, not a rule');

check('an address that changes the outcome still blocks', (() => {
  const r = scanAs(Object.assign({}, HONEST, { homePincode: '560001' }),
                   PAGE);           // page says 110084, declaration says Bengaluru
  return r.verdict === 'CONFLICT' &&
         r.findings.some(x => x.code === 'ADDRESS_CONFLICT' && x.severity === 'BLOCK');
})(), 'the check that survived from the Aadhaar version, unchanged');

check('a page with no application number asks for a person', (() => {
  const r = scanAs(HONEST, PAGE.replace('Application Number 131241025461', 'Application Number'));
  return r.findings.some(x => x.code === 'NO_APPLICATION_NUMBER' && x.severity === 'REVIEW');
})(), 'without it the university cannot cross-check the page against its own list');

section('What it does NOT prove');

check('it is not read as proof of identity', (() => {
  // Nothing here asserts the person uploading it is the person named. Neither
  // did an Aadhaar photocopy - we never had UIDAI authentication - so nothing
  // was lost, but the claim must not be made either.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'Documents.gs'), 'utf8');
  return /It is not proof of identity/.test(src);
})(), 'a system that overstates what its evidence proves is worse than one that ' +
      'collects less and says so');

process.exit(summarise());
