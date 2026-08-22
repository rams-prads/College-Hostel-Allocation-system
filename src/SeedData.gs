/**
 * SeedData.gs - synthetic GGSIPU-shaped demo data.
 *
 * Everything here is generated from a fixed seed, so the demo cohort is
 * identical on every machine and every run. Change DEFAULT_SEED and you get a
 * different but equally valid university.
 *
 * DELIBERATE DEMO PROPERTIES (these are features, not accidents):
 *   - Beds are scarcer than applicants, so the waitlist is non-empty.
 *   - ~8% of applicants live inside the minimum-distance radius, so the
 *     eligibility engine visibly rejects somebody during the demo.
 *   - Boys are more oversubscribed than girls, so the fairness dashboard has
 *     something interesting to show.
 *
 * All names, hostels and rooms are FICTIONAL placeholders. See
 * PROJECT_CONTEXT.md section 15 for swapping in real GGSIPU inventory.
 */

var DEFAULT_SEED = 'GGSIPU-2026';
// More applicants than beds, which is the situation the whole system exists
// for. The four hostels hold 1,110; a cohort that fitted would make every
// allocation trivially correct and prove nothing about the priority order.
var DEFAULT_COHORT = 1400;

/**
 * Hostel inventory.
 *
 * EDC Boys is the real thing, taken from the 2025-26 admission brochure: 38
 * single rooms, 54 triple and 16 four-seaters, 264 seats in total. The single
 * rooms are the ones the brochure reserves for PG and PhD students.
 *
 * The other three are shaped the same way at plausible sizes, because the
 * brochure covers one hostel and the system covers four. Swapping in real
 * counts is an edit to this table and nothing else.
 */
var HOSTEL_SPECS = [
  { hostelId: 'ED-BH-1', name: 'EDC Boys Hostel',       campus: 'EDC',    gender: 'M',
    warden: 'Dr. Ravi Butola',
    rooms: { SINGLE: 38, TRIPLE: 54, QUAD: 16 } },
  { hostelId: 'ED-GH-1', name: 'EDC Girls Hostel',      campus: 'EDC',    gender: 'F',
    warden: 'Dr. K. Gupta',
    rooms: { SINGLE: 30, TRIPLE: 48, QUAD: 14 } },
  { hostelId: 'DW-BH-A', name: 'Dwarka Boys Hostel A',  campus: 'DWARKA', gender: 'M',
    warden: 'Dr. A. Sharma',
    rooms: { SINGLE: 40, TRIPLE: 70, QUAD: 20 } },
  { hostelId: 'DW-GH-A', name: 'Dwarka Girls Hostel A', campus: 'DWARKA', gender: 'F',
    warden: 'Dr. M. Iyer',
    rooms: { SINGLE: 34, TRIPLE: 60, QUAD: 18 } }
];

var CAPACITY = { SINGLE: 1, TRIPLE: 3, QUAD: 4 };

/** Which schools sit on which campus. Hostel eligibility follows the school. */
var SCHOOLS = {
  EDC:    ['USAR', 'USDI', 'USAP', 'USMC'],
  DWARKA: ['USICT', 'USMS', 'USLLS', 'USBAS']
};

/** Programmes the brochure treats as PG or PhD, for the single-room rule. */
var PG_PROGRAMMES = { MTech: 1, MBA: 1, MCA: 1, PhD: 1 };

var PROGRAMMES = [
  ['BTech', 45], ['MBA', 15], ['MCA', 10], ['LLB', 12], ['MTech', 8], ['BBA', 5], ['BCA', 5]
];
var BRANCHES = {
  BTech: ['CSE', 'IT', 'ECE', 'EEE', 'Mechanical', 'Civil'],
  MTech: ['CSE', 'VLSI', 'Structural', 'Power Systems'],
  MBA:   ['Finance', 'Marketing', 'HR', 'Operations'],
  LLB:   ['Law'],
  MCA:   ['Computer Applications'],
  BBA:   ['General', 'Banking'],
  BCA:   ['Computer Applications']
};
var YEARS_BY_PROGRAMME = { BTech: 4, MTech: 2, MBA: 2, MCA: 2, LLB: 5, BBA: 3, BCA: 3 };

var FIRST_M = ['Aarav','Vivaan','Aditya','Arjun','Rohan','Kabir','Ishaan','Rahul','Ankit','Siddharth',
               'Karan','Nikhil','Manish','Rajat','Sameer','Varun','Yash','Harsh','Devansh','Tanmay',
               'Prateek','Abhishek','Gaurav','Shivam','Aman','Ritesh','Sourav','Nitin','Vikas','Deepak'];
var FIRST_F = ['Aanya','Diya','Ananya','Ishita','Kavya','Meera','Neha','Priya','Riya','Sanya',
               'Shreya','Tanvi','Aditi','Pooja','Sneha','Nikita','Swati','Anjali','Divya','Kritika',
               'Megha','Payal','Ritika','Simran','Vaishnavi','Bhavna','Charu','Garima','Isha','Juhi'];
var LAST = ['Sharma','Verma','Gupta','Singh','Kumar','Yadav','Mishra','Patel','Reddy','Nair',
            'Iyer','Das','Bose','Chatterjee','Mukherjee','Joshi','Desai','Malhotra','Chauhan','Rathore',
            'Pillai','Menon','Bhat','Shetty','Kulkarni','Deshmukh','Sinha','Jha','Tiwari','Pandey'];

var LANGUAGES = ['Hindi','English','Bengali','Marathi','Telugu','Tamil','Gujarati','Kannada',
                 'Malayalam','Punjabi','Odia','Assamese','Bhojpuri','Maithili'];

// ============================================================== orchestration

/**
 * Generate the full demo dataset. Safe to re-run - it clears the tabs it owns.
 * @param {{seed?: string, cohort?: number}} opts
 */
function seedAll(opts) {
  opts = opts || {};
  var seed = opts.seed || DEFAULT_SEED;
  var cohort = opts.cohort || DEFAULT_COHORT;
  var t0 = new Date().getTime();

  var geo   = seedPincodeGeo_();
  var inv   = seedInventory_();
  var people = seedStudentsAndApplications_(seed, cohort);

  Db.invalidate();
  Geo.invalidate();

  // The generator writes its own ids rather than calling Db.nextId, so the
  // sequence counters have to be moved past them. Otherwise the first student
  // to register afterwards is issued an id that is already taken.
  PropertiesService.getScriptProperties().setProperty('SEQ_STU', String(cohort));
  PropertiesService.getScriptProperties().setProperty('SEQ_APP', String(cohort));

  var summary = {
    seed: seed,
    pincodePrefixes: geo,
    hostels: inv.hostels,
    rooms: inv.rooms,
    beds: inv.beds,
    students: people.students,
    applications: people.applications,
    preferences: people.preferences,
    ineligible: people.ineligible,
    needsAccessible: people.needsAccessible,
    bedsByGender: inv.bedsByGender,
    applicantsByGender: people.byGender,
    elapsedSec: Util.round((new Date().getTime() - t0) / 1000, 1)
  };

  Ledger.append('DEMO_DATA_SEEDED', summary, 'system');
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Menu wrapper with a confirmation prompt. */
function seedDemoDataFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Seed demo data',
    'This replaces all Students, Applications, Preferences, Lifestyle, Hostels, Rooms and Beds data.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var s = seedAll();
  ui.alert('Demo data seeded',
    s.students + ' students, ' + s.applications + ' applications\n' +
    s.beds + ' beds across ' + s.rooms + ' rooms in ' + s.hostels + ' hostels\n' +
    s.ineligible + ' applicants fail eligibility rules\n\n' +
    'Took ' + s.elapsedSec + 's', ui.ButtonSet.OK);
}

// =================================================================== pincodes

function seedPincodeGeo_() {
  var rows = PINCODE_GEO.map(function (r) {
    return { pinPrefix: r[0], lat: r[1], lng: r[2], district: r[3], state: r[4] };
  });
  Db.replaceAll('PincodeGeo', rows);
  return rows.length;
}

// ================================================================== inventory

function seedInventory_() {
  var hostels = [], rooms = [], beds = [];
  var bedsByGender = { M: 0, F: 0 };

  HOSTEL_SPECS.forEach(function (h) {
    hostels.push({
      hostelId: h.hostelId, name: h.name, campus: h.campus, gender: h.gender,
      warden: h.warden, contact: h.hostelId.toLowerCase() + '@ipu.ac.in', active: true
    });

    // Rooms are laid out from the counts the brochure gives, four to a floor
    // block, singles first so the PG floor is contiguous the way a real hostel
    // allocates it.
    var order = ['SINGLE', 'TRIPLE', 'QUAD'];
    var n = 0;
    order.forEach(function (roomType) {
      var count = (h.rooms || {})[roomType] || 0;
      var cap = CAPACITY[roomType];

      for (var i = 0; i < count; i++) {
        n++;
        // The first three rooms of EVERY type sit on the ground floor and are
        // the accessible stock: step-free access and an adapted washroom. Doing
        // it per type rather than per corridor matters - if only the singles
        // were accessible, a PwD applicant who is not PG could not be housed at
        // all, which is the opposite of a first-priority group.
        var isAccessible = (i < 3);
        var floor = isAccessible ? 1 : Math.floor((n - 1) / 12) + 1;
        var block = String.fromCharCode(65 + Math.floor((n - 1) / 60));
        // Numbered from a hostel-wide running count, not from position on a
        // floor: pulling the accessible rooms down to the ground floor made two
        // rooms share a number and, through that, two beds share an id.
        var roomNo = block + Util.pad(n, 3);
        var roomId = h.hostelId + '-' + roomNo;

        rooms.push({
          roomId: roomId, hostelId: h.hostelId, block: block, floor: floor,
          roomNo: roomNo, capacity: cap, roomType: roomType,
          isAccessible: isAccessible, status: 'ACTIVE'
        });

        for (var b = 1; b <= cap; b++) {
          beds.push({
            bedId: roomId + '-' + b, roomId: roomId, bedNo: b,
            status: 'VACANT', occupantAppId: ''
          });
          bedsByGender[h.gender]++;
        }
      }
    });
  });

  Db.replaceAll('Hostels', hostels);
  Db.replaceAll('Rooms', rooms);
  Db.replaceAll('Beds', beds);

  return {
    hostels: hostels.length, rooms: rooms.length, beds: beds.length,
    bedsByGender: bedsByGender
  };
}

// =================================================================== students

function seedStudentsAndApplications_(seed, cohort) {
  var rand = Util.rng(seed);
  var geoIdx = buildSeedGeoIndex_();
  var hostels = HOSTEL_SPECS;
  var maxPrefs = Number(Db.cfg('MAX_PREFERENCES', 5));

  var students = [], applications = [], preferences = [], lifestyles = [];
  var byGender = { M: 0, F: 0 };
  var ineligible = 0, needsAccessible = 0;

  // Pre-compute the merit-rank ordering by drawing CGPAs first.
  // Campus is drawn in proportion to the beds that exist for that gender, so the
  // two campuses come out under comparable pressure. Skewing demand away from
  // supply would flatter the allocator: it would look efficient simply because
  // one campus had spare beds and nobody who could use them.
  var campusWeights = campusWeightsByGender_();

  var draft = [];
  for (var i = 0; i < cohort; i++) {
    var gender = Util.weighted(rand, [['M', 58], ['F', 42]]);
    var programme = Util.weighted(rand, PROGRAMMES);
    var maxYear = YEARS_BY_PROGRAMME[programme];
    var year = Util.weighted(rand, yearWeights_(maxYear));
    var campus = Util.weighted(rand, campusWeights[gender] || campusWeights.M);

    // The figure the policy ranks on: a percentage either way, so a first-year
    // and a final-year sit on one scale without any normalising.
    var meritPercent = Util.round(Util.normal(rand, 72, 11, 40, 99), 2);
    var meritBasis = year <= 1 ? 'CLASS_12' : 'SEMESTER';

    // Roughly two in three hostel applicants are admitted outside Delhi, which
    // is what makes the priority order bite: the second group is large enough
    // to consume most of the seats before the Delhi groups are reached at all.
    var residenceCategory = Util.weighted(rand, [['OUTSIDE_DELHI', 66], ['DELHI', 34]]);
    // Of the Delhi-category applicants, a minority have a parent posted out of
    // Delhi and can claim the third group instead of the fourth.
    var parentTransferred = residenceCategory === 'DELHI' && rand() < 0.18;

    draft.push({
      gender: gender, campus: campus, programme: programme, year: year,
      meritPercent: meritPercent, meritBasis: meritBasis,
      residenceCategory: residenceCategory, parentTransferred: parentTransferred,
      isForeign: rand() < 0.03,
      // A returning resident, with the conditions re-admission actually tests.
      exResident: year > 1 && rand() < 0.55,
      promoted: rand() > 0.04,
      detained: rand() < 0.02,
      disciplinaryFlag: rand() < 0.015,
      attendancePct: Util.round(Util.normal(rand, 84, 9, 45, 100), 1),
      r: rand()
    });
  }

  // Merit rank: percentage descending, ties broken by the seeded draw.
  var ranked = draft.slice().sort(function (a, b) {
    return b.meritPercent - a.meritPercent || a.r - b.r;
  });
  ranked.forEach(function (d, idx) { d.meritRank = idx + 1; });

  draft.forEach(function (d, i) {
    var n = i + 1;
    var studentId = 'STU-2026-' + Util.pad(n, 4);
    var appId     = 'APP-2026-' + Util.pad(n, 4);

    var first = Util.pick(rand, d.gender === 'M' ? FIRST_M : FIRST_F);
    var last  = Util.pick(rand, LAST);
    var name  = first + ' ' + last;

    var pin = pickPincode_(rand, geoIdx);
    var dist = distanceForSeed_(pin, geoIdx, d.campus);

    var category = Util.weighted(rand, [['GEN', 40], ['OBC', 27], ['SC', 15], ['ST', 7], ['EWS', 11]]);
    var isPwD = rand() < 0.03;
    var pwdType = isPwD ? Util.pick(rand, ['Locomotor', 'Visual', 'Hearing', 'Other']) : '';
    // Not every PwD student needs an accessible room; locomotor and visual do.
    var accessible = isPwD && (pwdType === 'Locomotor' || pwdType === 'Visual');
    if (accessible) needsAccessible++;

    var emailName = (first + '.' + last).toLowerCase() + n;

    students.push({
      studentId: studentId,
      name: name,
      enrollmentNo: enrollmentNo_(d.programme, d.campus, n, d.year),
      email: emailName + '@example.edu',
      phone: '9' + Util.pad(Util.intBetween(rand, 100000000, 999999999), 9).substring(0, 9),
      gender: d.gender,
      programme: d.programme,
      branch: Util.pick(rand, BRANCHES[d.programme]),
      campus: d.campus,
      school: Util.pick(rand, SCHOOLS[d.campus] || SCHOOLS.EDC),
      year: d.year,

      residenceCategory: d.residenceCategory,
      parentTransferred: d.parentTransferred,
      isForeign: d.isForeign,
      meritPercent: d.meritPercent,
      meritBasis: d.meritBasis,
      meritRank: d.meritRank,

      exResident: d.exResident,
      promoted: d.promoted,
      detained: d.detained,
      disciplinaryFlag: d.disciplinaryFlag,
      attendancePct: d.attendancePct,
      firstAdmittedSession: d.exResident ? '2024-25' : '2025-26',

      category: category,
      isPwD: isPwD,
      pwdType: pwdType,
      homePincode: pin,
      homeState: geoIdx[pin.substring(0, 3)].state,
      guardianEmail: 'guardian.' + emailName + '@example.com'
    });

    byGender[d.gender]++;

    // Eligibility is evaluated properly by Eligibility.gs. Here we only
    // pre-compute the obvious flags so the seed data is self-consistent.
    //
    // Note what is NOT here: no distance floor and no marks floor. The brochure
    // imposes neither on a fresh applicant. What can make somebody ineligible
    // is failing a RE-ADMISSION condition.
    var notes = [];
    var eligible = true;
    if (d.exResident) {
      if (d.detained) { eligible = false; notes.push('Detained from university examinations'); }
      if (!d.promoted) { eligible = false; notes.push('Not promoted to the next session'); }
      if (d.disciplinaryFlag) { eligible = false; notes.push('Disciplinary notice in the preceding session'); }
      if (d.attendancePct < 75) {
        eligible = false;
        notes.push('Attendance ' + d.attendancePct + '% is below the 75% required');
      }
    }
    if (!eligible) ineligible++;

    applications.push({
      appId: appId,
      studentId: studentId,
      campus: d.campus,
      // An ex-resident returns through re-admission, which the brochure runs as
      // a separate window that closes before fresh allotment opens.
      admissionType: d.exResident ? 'READMISSION' : 'FRESH',
      priorityTier: '',
      status: 'SUBMITTED',
      submittedAt: submittedAt_(rand),
      meritScore: 0,                       // computed by the allocator in Phase 2
      distanceKm: dist,
      eligible: eligible,
      eligibilityNotes: notes,
      docStatus: Util.weighted(rand, [['VERIFIED', 70], ['SUBMITTED', 25], ['PENDING', 5]]),
      docFolderUrl: '',
      needsAccessible: accessible,
      updatedAt: new Date()
    });

    // Ranked preferences, drawn only from hostels the student could actually be
    // allotted: their own gender AND their own campus. Both are hard partitions,
    // so a preference outside either could never be granted.
    var eligibleHostels = hostels.filter(function (h) {
      return h.gender === d.gender && h.campus === d.campus;
    });
    // A single room is for PG and PhD students, so it is not offered to anyone
    // else - a preference that could never be granted is not a preference.
    var isPg = !!PG_PROGRAMMES[d.programme];
    var options = [];
    eligibleHostels.forEach(function (h) {
      ['SINGLE', 'TRIPLE', 'QUAD'].forEach(function (rt) {
        if (rt === 'SINGLE' && !isPg) return;
        options.push({ hostelId: h.hostelId, roomType: rt, campus: h.campus });
      });
    });

    // Bias toward the smaller room, which is how real preference sheets look.
    var scored = options.map(function (o) {
      var w = rand();
      if (o.roomType === 'SINGLE') w += 0.35;
      if (o.roomType === 'TRIPLE') w += 0.15;
      return { o: o, w: w };
    }).sort(function (a, b) { return b.w - a.w; });

    var nPrefs = Math.min(maxPrefs, scored.length);
    for (var p = 0; p < nPrefs; p++) {
      preferences.push({
        appId: appId, rank: p + 1,
        hostelId: scored[p].o.hostelId, roomType: scored[p].o.roomType
      });
    }

    lifestyles.push(makeLifestyle_(rand, appId));
  });

  Db.replaceAll('Students', students);
  Db.replaceAll('Applications', applications);
  Db.replaceAll('Preferences', preferences);
  Db.replaceAll('Lifestyle', lifestyles);

  return {
    students: students.length,
    applications: applications.length,
    preferences: preferences.length,
    ineligible: ineligible,
    needsAccessible: needsAccessible,
    byGender: byGender
  };
}

function makeLifestyle_(rand, appId) {
  var sleep = Util.weighted(rand, [['EARLY', 25], ['MODERATE', 45], ['LATE', 30]]);
  // Wake time correlates with sleep time - random pairing would produce
  // nonsense profiles and make the compatibility scores meaningless.
  var wake = sleep === 'LATE'
    ? Util.weighted(rand, [['LATE', 60], ['MODERATE', 35], ['EARLY', 5]])
    : sleep === 'EARLY'
      ? Util.weighted(rand, [['EARLY', 65], ['MODERATE', 30], ['LATE', 5]])
      : Util.weighted(rand, [['MODERATE', 60], ['EARLY', 20], ['LATE', 20]]);

  return {
    appId: appId,
    sleepTime: sleep,
    wakeTime: wake,
    studyStyle: Util.weighted(rand, [['QUIET', 45], ['MUSIC', 35], ['GROUP', 20]]),
    cleanliness: Util.intBetween(rand, 1, 5),
    sociability: Util.intBetween(rand, 1, 5),
    foodPref: Util.weighted(rand, [['VEG', 45], ['NONVEG', 40], ['EGG', 15]]),
    language: Util.pick(rand, LANGUAGES),
    guestsFrequency: Util.weighted(rand, [['NEVER', 30], ['SOMETIMES', 55], ['OFTEN', 15]])
  };
}

// ==================================================================== helpers

/** Local geo index built from the constant, so seeding does not depend on sheet state. */
function buildSeedGeoIndex_() {
  var idx = {};
  PINCODE_GEO.forEach(function (r) {
    idx[r[0]] = { pinPrefix: r[0], lat: r[1], lng: r[2], district: r[3], state: r[4] };
  });
  return idx;
}

/**
 * Draw a home PIN code. Weighted so ~8% of applicants fall inside the
 * minimum-distance radius, which makes the eligibility engine visibly do
 * something during the demo.
 */
function pickPincode_(rand, geoIdx) {
  var NCR = ['110', '111', '121', '122', '201', '203', '245', '131'];
  var all = Object.keys(geoIdx);
  var far = all.filter(function (p) { return NCR.indexOf(p) < 0; });

  var prefix = rand() < 0.08 ? Util.pick(rand, NCR) : Util.pick(rand, far);
  return prefix + Util.pad(Util.intBetween(rand, 1, 99), 3);
}

function distanceForSeed_(pin, geoIdx, campus) {
  var loc = geoIdx[pin.substring(0, 3)];
  if (!loc) return -1;
  var keys = CAMPUSES[campus] ? [campus] : Object.keys(CAMPUSES);
  var best = null;
  keys.forEach(function (k) {
    var c = CAMPUSES[k];
    var km = Geo.haversine(loc.lat, loc.lng, c.lat, c.lng);
    if (best === null || km < best) best = km;
  });
  return Util.round(best, 1);
}

/**
 * Per-gender campus split, derived from the inventory rather than hard-coded, so
 * changing a hostel's size in HOSTEL_SPECS moves the demand with it.
 * @return {{M: Array, F: Array}} weight pairs for Util.weighted
 */
function campusWeightsByGender_() {
  var tally = {};
  HOSTEL_SPECS.forEach(function (h) {
    var beds = 0;
    Object.keys(h.rooms).forEach(function (rt) { beds += h.rooms[rt] * CAPACITY[rt]; });
    tally[h.gender] = tally[h.gender] || {};
    tally[h.gender][h.campus] = (tally[h.gender][h.campus] || 0) + beds;
  });
  var out = {};
  Object.keys(tally).forEach(function (g) {
    out[g] = Object.keys(tally[g]).map(function (c) { return [c, tally[g][c]]; });
  });
  return out;
}

function yearWeights_(maxYear) {
  var base = [45, 25, 18, 8, 4];
  var out = [];
  for (var y = 1; y <= maxYear; y++) out.push([y, base[y - 1] || 3]);
  return out;
}

/**
 * An 11-digit enrolment number in the shape GGSIPU actually uses:
 *
 *     III PPP RRR YY
 *      |   |   |   +-- last two digits of the year of ADMISSION
 *      |   |   +------ roll number within the intake
 *      |   +---------- programme code
 *      +-------------- institute code (differs by campus)
 *
 * The admission year is derived from the year of study rather than stamped as a
 * constant, so the number agrees with the rest of the record - a third-year
 * student carries a number three intakes old. Identity.gs cross-checks exactly
 * that, and seed data that could not pass its own consistency check would make
 * the check untestable.
 *
 * Roll is n mod 1000, which is unique while the cohort stays under 1000.
 */
function enrollmentNo_(programme, campus, n, yearOfStudy) {
  var institute = campus === 'EDC' ? '164' : '041';
  var codes = { BTech: '010', MTech: '020', MBA: '030',
                MCA: '040', LLB: '050', BBA: '060', BCA: '070' };
  var academicYear = Number(Db.cfg('ACADEMIC_YEAR', '2026'));
  var admitted = academicYear - Number(yearOfStudy) + 1;
  return institute + (codes[programme] || '000') +
         Util.pad(n % 1000, 3) + Util.pad(admitted % 100, 2);
}

/** Applications trickle in over a four-week window. */
function submittedAt_(rand) {
  var start = new Date(2026, 5, 1).getTime();   // 1 June 2026
  var span = 28 * 24 * 3600 * 1000;
  return new Date(start + Math.floor(rand() * span));
}

/** Read one Policy value, with a fallback if the row is absent or inactive. */
function policyValue_(category, key, fallback) {
  var rows = Db.readAll('Policy');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].category === category && rows[i].key === key && rows[i].active) {
      return Number(rows[i].value);
    }
  }
  return fallback;
}

// ================================================================== verify P1

/**
 * Phase 1 exit check. See PROJECT_CONTEXT.md section 12.
 */
function verifyPhase1() {
  var out = [];
  function check(ok, label) { out.push((ok ? 'PASS  ' : 'FAIL  ') + label); return ok; }

  var students = Db.readAll('Students', { fresh: true });
  var apps     = Db.readAll('Applications', { fresh: true });
  var prefs    = Db.readAll('Preferences', { fresh: true });
  var life     = Db.readAll('Lifestyle', { fresh: true });
  var rooms    = Db.readAll('Rooms', { fresh: true });
  var beds     = Db.readAll('Beds', { fresh: true });
  var hostels  = Db.readAll('Hostels', { fresh: true });

  check(students.length > 0, 'Students seeded (' + students.length + ')');
  check(apps.length === students.length, 'One application per student (' + apps.length + ')');
  check(life.length === apps.length, 'One lifestyle profile per application (' + life.length + ')');

  var capacitySum = rooms.reduce(function (s, r) { return s + Number(r.capacity); }, 0);
  check(beds.length === capacitySum, 'Bed count equals sum of room capacity (' + beds.length + ' = ' + capacitySum + ')');

  var bedIds = {}, dupBeds = 0;
  beds.forEach(function (b) { if (bedIds[b.bedId]) dupBeds++; bedIds[b.bedId] = 1; });
  check(dupBeds === 0, 'No duplicate bed IDs');

  var roomIds = {};
  rooms.forEach(function (r) { roomIds[r.roomId] = 1; });
  var orphanBeds = beds.filter(function (b) { return !roomIds[b.roomId]; }).length;
  check(orphanBeds === 0, 'Every bed belongs to a real room');

  var hostelIds = {};
  hostels.forEach(function (h) { hostelIds[h.hostelId] = h; });
  var orphanRooms = rooms.filter(function (r) { return !hostelIds[r.hostelId]; }).length;
  check(orphanRooms === 0, 'Every room belongs to a real hostel');

  // Preferences must never cross the gender line, or the allocator's only hard
  // partition is already violated in the input data.
  var appById = {}, stuById = {};
  students.forEach(function (s) { stuById[s.studentId] = s; });
  apps.forEach(function (a) { appById[a.appId] = a; });
  var crossGender = prefs.filter(function (p) {
    var a = appById[p.appId]; if (!a) return true;
    var s = stuById[a.studentId]; if (!s) return true;
    var h = hostelIds[p.hostelId];
    return !h || h.gender !== s.gender;
  }).length;
  check(crossGender === 0, 'No preference crosses the gender partition');

  var accessibleBeds = beds.filter(function (b) {
    var r = rooms.filter(function (x) { return x.roomId === b.roomId; })[0];
    return r && r.isAccessible;
  }).length;
  var needAcc = apps.filter(function (a) { return a.needsAccessible; }).length;
  check(accessibleBeds >= needAcc,
    'Accessible beds cover accessible demand (' + accessibleBeds + ' beds >= ' + needAcc + ' applicants)');

  var unresolved = apps.filter(function (a) { return Number(a.distanceKm) < 0; }).length;
  check(unresolved === 0, 'Every home PIN resolved to a distance');

  var ineligible = apps.filter(function (a) { return !a.eligible; }).length;
  check(ineligible > 0, 'Some applicants fail eligibility, so the engine has work to do (' + ineligible + ')');

  var scarcity = beds.length < apps.length;
  check(scarcity, 'Beds are scarcer than applicants, so the waitlist is non-empty (' +
    beds.length + ' beds, ' + apps.length + ' applicants)');

  var text = out.join('\n');
  Logger.log(text);
  return text;
}

/** Distribution report - sanity-check the cohort looks like a real university. */
function describeCohort() {
  var students = Db.readAll('Students', { fresh: true });
  var apps = Db.readAll('Applications', { fresh: true });
  var beds = Db.readAll('Beds', { fresh: true });
  var hostels = Db.indexBy('Hostels', 'hostelId');
  var rooms = Db.indexBy('Rooms', 'roomId');

  function tally(arr, fn) {
    var t = {};
    arr.forEach(function (x) { var k = fn(x); t[k] = (t[k] || 0) + 1; });
    return t;
  }

  var bedsByGender = {};
  Db.readAll('Beds').forEach(function (b) {
    var r = rooms[b.roomId]; if (!r) return;
    var h = hostels[r.hostelId]; if (!h) return;
    bedsByGender[h.gender] = (bedsByGender[h.gender] || 0) + 1;
  });

  var report = {
    students: students.length,
    beds: beds.length,
    byGender: tally(students, function (s) { return s.gender; }),
    bedsByGender: bedsByGender,
    byProgramme: tally(students, function (s) { return s.programme; }),
    byCategory: tally(students, function (s) { return s.category; }),
    pwd: students.filter(function (s) { return s.isPwD; }).length,
    needsAccessible: apps.filter(function (a) { return a.needsAccessible; }).length,
    ineligible: apps.filter(function (a) { return !a.eligible; }).length,
    topStates: Object.keys(tally(students, function (s) { return s.homeState; }))
      .map(function (k) { return [k, tally(students, function (s) { return s.homeState; })[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8)
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
