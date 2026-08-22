/**
 * Registration.gs - self-registration for students not already in the registry.
 *
 * A real deployment would import the registry from the university's records. A
 * student who is not in it still has to be able to apply, so this creates the
 * record from what they declare.
 *
 * Everything captured here is SELF-DECLARED and flagged as such on the record.
 * It is a claim, not evidence: the documents step is what turns it into
 * evidence, and nothing here bypasses that.
 */

// Programmes, branches, durations and the school each belongs to all come from
// Catalogue.gs, which holds the real EDC course table. Nothing about a course
// is described twice.

/**
 * A student is admitted to one campus and stays there. It is declared once,
 * here, and is never offered again as a choice on the application form.
 */
/** The schools on each campus. Hostel eligibility follows the school. */
var SCHOOLS_BY_CAMPUS = {
  EDC:    ['USAR', 'USDI', 'USAP', 'USMC'],
  DWARKA: ['USICT', 'USMS', 'USLLS', 'USBAS']
};

var CAMPUS_OPTIONS = [
  { code: 'DWARKA', label: 'Dwarka Campus',
    note: 'Sector 16C, Dwarka - the main university campus.' },
  { code: 'EDC', label: 'East Delhi Campus',
    note: 'Surajmal Vihar, East Delhi.' }
];

var BRANCHES_BY_PROGRAMME = {
  BTech: ['Computer Science & Engineering', 'Information Technology',
          'Electronics & Communication', 'Electrical & Electronics',
          'Mechanical Engineering', 'Civil Engineering'],
  MTech: ['Computer Science & Engineering', 'VLSI Design',
          'Structural Engineering', 'Power Systems'],
  MBA:   ['Finance', 'Marketing', 'Human Resources', 'Operations'],
  MCA:   ['Computer Applications'],
  LLB:   ['Law'],
  BBA:   ['General', 'Banking & Insurance'],
  BCA:   ['Computer Applications']
};

/** Reference data the registration step needs. */
function apiGetRegistrationOptions() {
  return {
    // One entry per programme, carrying everything the form needs to render it
    // and everything it needs to validate against.
    programmes: Catalogue.programmes().map(function (p) {
      return {
        code: p.code,
        label: p.name + (p.cet ? ' (CET ' + p.cet + ')' : ''),
        name: p.name,
        school: p.school,
        schoolName: Catalogue.schoolName(p.school),
        entryYear: p.entryYear || 1,
        lastYear: (p.entryYear || 1) + p.years - 1,
        isPg: p.level === 'PG' || p.level === 'PHD' || p.level === 'PG_DIPLOMA',
        note: p.note || '',
        branches: p.branches.map(function (b) { return b.name; })
      };
    }),
    categories: [
      { code: 'GEN', label: 'General' },
      { code: 'OBC', label: 'Other Backward Classes (non-creamy layer)' },
      { code: 'SC',  label: 'Scheduled Caste' },
      { code: 'ST',  label: 'Scheduled Tribe' },
      { code: 'EWS', label: 'Economically Weaker Section' }
    ],
    campuses: CAMPUS_OPTIONS,
    // Kept for display only. Which school a student belongs to is decided by
    // the programme they name, never asked for separately.
    schools: Catalogue.schools().map(function (c) {
      return { code: c, label: Catalogue.schoolName(c) };
    }),
    residenceCategories: [
      { code: 'OUTSIDE_DELHI', label: 'Outside Delhi',
        note: 'You were admitted against the outside-Delhi quota. Second priority for a ' +
              'hostel seat, ranked among yourselves on marks.' },
      { code: 'DELHI', label: 'Delhi',
        note: 'You were admitted against the Delhi quota. Considered after the outside-Delhi ' +
              'applicants, and ordered by how far your home is from campus.' }
    ],
    pwdTypes: ['Locomotor', 'Visual', 'Hearing', 'Speech', 'Other'],
    bloodGroups: ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-', 'Not known'],
    minDistanceKm: Policy.value('eligibility', 'MIN_DISTANCE_KM', 30),
    minCgpa: Policy.value('eligibility', 'MIN_CGPA', 5.0)
  };
}

/**
 * Resolve a PIN code so an applicant sees the distance the engine will use
 * while they are still filling the form, rather than discovering it in a
 * rejection weeks later.
 */
function apiLookupPincode(pincode, campus) {
  var geo = Geo.distanceFromHome(pincode, campus);
  var minDist = Policy.value('eligibility', 'MIN_DISTANCE_KM', 30);
  var where = campus ? ' from ' + Geo.campusName(campus) : ' from campus';

  if (!geo.resolved) {
    return {
      resolved: false,
      message: 'This PIN code is not in our reference table. You can still apply — the ' +
               'hostel office will confirm your distance from your address proof.'
    };
  }
  return {
    resolved: true,
    km: geo.km,
    district: geo.district,
    state: geo.state,
    eligible: geo.km >= minDist,
    minDistanceKm: minDist,
    message: geo.km >= minDist
      ? 'About ' + geo.km + ' km' + where + ' (' + geo.district + ', ' + geo.state +
        '). That is beyond the ' + minDist + ' km minimum, so distance will not block you.'
      : 'About ' + geo.km + ' km' + where + ' (' + geo.district + ', ' + geo.state +
        '). Hostel places are kept for students living more than ' + minDist +
        ' km away, so an application from this address is unlikely to succeed.'
  };
}

/** Create a student record for the signed-in account. */
function apiRegisterStudent(payload) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in with your Google account first.');
  if (s.student) throw new Error('A student record already exists for ' + s.email + '.');

  var errors = validateRegistration_(payload);
  if (errors.length) throw new Error(errors.join(' '));

  // An enrolment number identifies a person. Two records sharing one would let
  // the same student hold two applications.
  var wanted = String(payload.enrollmentNo).trim().toLowerCase();
  var clash = Db.readAll('Students').filter(function (x) {
    return String(x.enrollmentNo).trim().toLowerCase() === wanted;
  })[0];
  if (clash) {
    throw new Error('Enrolment number ' + payload.enrollmentNo + ' is already registered. ' +
                    'If that is yours, contact the hostel office rather than registering again.');
  }

  var geo = Geo.distanceFromHome(payload.homePincode, payload.campus);
  var studentId = Db.nextId('STU');

  Db.append('Students', {
    studentId: studentId,
    name: String(payload.name).trim(),
    enrollmentNo: String(payload.enrollmentNo).trim(),
    email: s.email,
    phone: digits_(payload.phone),
    dob: String(payload.dob || '').trim(),
    gender: payload.gender,
    programme: payload.programme,
    branch: String(payload.branch || '').trim(),
    campus: payload.campus,
    // Derived from the programme. A student who names a course has already
    // named their school; asking again only creates a second answer that can
    // contradict the first.
    school: Catalogue.schoolOf(payload.programme),
    year: Number(payload.year),

    // What the allotment order actually turns on.
    residenceCategory: payload.residenceCategory,
    parentTransferred: payload.residenceCategory === 'DELHI' && !!payload.parentTransferred,
    isForeign: !!payload.isForeign,
    meritPercent: Number(payload.meritPercent) || 0,
    // First year OF THE PROGRAMME, which for a lateral entrant is year 2. Their
    // qualifying result is a diploma or a B.Sc rather than class 12, which the
    // brochure covers with "12th [best five subjects] /equivalent".
    meritBasis: Number(payload.year) <= Catalogue.entryYear(payload.programme)
      ? 'CLASS_12' : 'SEMESTER',
    meritRank: 0,

    // A self-registering applicant is by definition not a returning resident;
    // re-admission runs from the office's own list of last session's residents.
    exResident: false,
    promoted: true,
    detained: false,
    disciplinaryFlag: false,
    attendancePct: 0,
    firstAdmittedSession: String(Db.cfg('ACADEMIC_YEAR', '2026')),
    category: payload.category,
    isPwD: !!payload.isPwD,
    pwdType: payload.isPwD ? String(payload.pwdType || '') : '',
    homeAddress: String(payload.homeAddress || '').trim(),
    homeCity: String(payload.homeCity || '').trim(),
    homePincode: String(payload.homePincode).trim(),
    homeState: geo.resolved ? geo.state : String(payload.homeState || '').trim(),
    guardianName: String(payload.guardianName || '').trim(),
    guardianPhone: digits_(payload.guardianPhone),
    guardianEmail: String(payload.guardianEmail || '').trim(),
    bloodGroup: String(payload.bloodGroup || '').trim(),
    medicalNotes: String(payload.medicalNotes || '').trim(),
    selfDeclared: true,
    registeredAt: new Date()
  });

  Ledger.append('STUDENT_REGISTERED', {
    studentId: studentId, email: s.email, enrollmentNo: payload.enrollmentNo,
    programme: payload.programme, campus: payload.campus, year: payload.year,
    selfDeclared: true
  }, s.email);

  return { ok: true, studentId: studentId, distanceKm: geo.resolved ? geo.km : null };
}

function digits_(v) { return String(v || '').replace(/\D/g, ''); }

/**
 * Field validation. Messages are written for the applicant, not the developer,
 * and every rule that exists here also exists on the server for a reason: the
 * browser can be bypassed, and this record feeds a merit calculation.
 */
function validateRegistration_(p) {
  var e = [];
  p = p || {};

  if (!p.name || String(p.name).trim().length < 3) e.push('Enter your full name.');
  if (!p.enrollmentNo || String(p.enrollmentNo).trim().length < 4) {
    e.push('Enter your university enrolment number.');
  }
  if (!isMobile_(p.phone)) e.push('Enter a valid 10-digit mobile number.');
  if (['M', 'F', 'O'].indexOf(p.gender) < 0) e.push('Select your gender.');
  var prog = Catalogue.byCode(p.programme);
  if (!prog) e.push('Select your programme.');
  if (!p.branch) e.push('Select your branch or specialisation.');
  else if (prog && Catalogue.branches(p.programme).indexOf(p.branch) < 0) {
    e.push('That specialisation is not offered on ' + prog.name + '.');
  }
  // Campus decides which hostels exist for this student at all, so a wrong or
  // missing value is not a cosmetic error - it would leave them unallocatable.
  if (['DWARKA', 'EDC'].indexOf(p.campus) < 0) {
    e.push('Select the campus you are admitted to.');
  }

  // Lateral entry starts in the second year, so a first year does not exist on
  // those programmes and offering one would produce a student who cannot be.
  var firstYear = prog ? Catalogue.entryYear(p.programme) : 1;
  var lastYear = prog ? firstYear + Catalogue.years(p.programme) - 1 : 5;
  var year = Number(p.year);
  if (prog && !(year >= firstYear && year <= lastYear)) {
    e.push('Year of study must be between ' + firstYear + ' and ' + lastYear +
           ' for ' + prog.name + (firstYear > 1
             ? ', which is a lateral-entry programme and has no first year.' : '.'));
  }

  // The one figure the priority order ranks on, and the brochure defines it
  // differently for a first-year: best five subjects of class 12, because there
  // is no university result yet. Both are percentages.
  var merit = Number(p.meritPercent);
  if (!(merit > 0 && merit <= 100)) {
    e.push(year <= firstYear
      ? 'Enter the percentage of your qualifying examination — best five subjects of ' +
        'class 12, or the diploma or B.Sc you entered on. It is what your application is ' +
        'ranked on until you have a university result.'
      : 'Enter your result up to the preceding semester, as a percentage.');
  }

  // The admission category, which decides which queue you are in at all. It is
  // not derived from the address: a student may live far away and still have
  // been admitted in the Delhi category.
  if (['DELHI', 'OUTSIDE_DELHI'].indexOf(p.residenceCategory) < 0) {
    e.push('Select whether you were admitted in the Delhi or the outside-Delhi category.');
  }
  if (p.residenceCategory === 'OUTSIDE_DELHI' && p.parentTransferred) {
    e.push('The parent-transfer priority applies only to Delhi-category applicants.');
  }


  if (['GEN', 'OBC', 'SC', 'ST', 'EWS'].indexOf(p.category) < 0) e.push('Select your category.');
  if (p.isPwD && !p.pwdType) {
    e.push('Select the type of disability, so the right kind of room can be reserved for you.');
  }

  if (!/^\d{6}$/.test(String(p.homePincode || '').trim())) e.push('Enter your 6-digit home PIN code.');
  if (!p.homeAddress || String(p.homeAddress).trim().length < 8) {
    e.push('Enter your permanent home address.');
  }
  if (!p.guardianName) e.push('Enter a parent or guardian name.');
  if (!isMobile_(p.guardianPhone)) {
    e.push('Enter a valid 10-digit mobile number for your parent or guardian.');
  }
  if (p.guardianEmail && !isEmail_(p.guardianEmail)) {
    e.push('The guardian email address does not look valid.');
  }
  return e;
}

function isMobile_(v) { return /^[6-9]\d{9}$/.test(digits_(v)); }
function isEmail_(v)  { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()); }
