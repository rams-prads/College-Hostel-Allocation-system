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

var PROGRAMME_YEARS = { BTech: 4, MTech: 2, MBA: 2, MCA: 2, LLB: 5, BBA: 3, BCA: 3 };

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
    programmes: Object.keys(PROGRAMME_YEARS).map(function (p) {
      return { code: p, years: PROGRAMME_YEARS[p], branches: BRANCHES_BY_PROGRAMME[p] };
    }),
    categories: [
      { code: 'GEN', label: 'General' },
      { code: 'OBC', label: 'Other Backward Classes (non-creamy layer)' },
      { code: 'SC',  label: 'Scheduled Caste' },
      { code: 'ST',  label: 'Scheduled Tribe' },
      { code: 'EWS', label: 'Economically Weaker Section' }
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
function apiLookupPincode(pincode) {
  var geo = Geo.distanceFromHome(pincode);
  var minDist = Policy.value('eligibility', 'MIN_DISTANCE_KM', 30);

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
      ? 'About ' + geo.km + ' km from campus (' + geo.district + ', ' + geo.state +
        '). That is beyond the ' + minDist + ' km minimum, so distance will not block you.'
      : 'About ' + geo.km + ' km from campus (' + geo.district + ', ' + geo.state +
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

  var geo = Geo.distanceFromHome(payload.homePincode);
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
    year: Number(payload.year),
    cgpa: Number(payload.cgpa) || 0,
    entranceRank: Number(payload.entranceRank) || 0,
    meritRank: 0,
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
    programme: payload.programme, year: payload.year, selfDeclared: true
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
  if (!PROGRAMME_YEARS[p.programme]) e.push('Select your programme.');
  if (!p.branch) e.push('Select your branch or specialisation.');

  var maxYear = PROGRAMME_YEARS[p.programme] || 5;
  var year = Number(p.year);
  if (!(year >= 1 && year <= maxYear)) {
    e.push('Year of study must be between 1 and ' + maxYear + ' for ' +
           (p.programme || 'this programme') + '.');
  }

  // A first-year has no CGPA to be ranked on; everyone else must have one.
  if (year === 1) {
    if (!(Number(p.entranceRank) > 0)) {
      e.push('First-year applicants must give their entrance or admission rank, because ' +
             'there is no CGPA to rank them on yet.');
    }
  } else if (!(Number(p.cgpa) > 0 && Number(p.cgpa) <= 10)) {
    e.push('Enter your current CGPA on a scale of 0 to 10.');
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
