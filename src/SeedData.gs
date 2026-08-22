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
var DEFAULT_COHORT = 900;

/**
 * Hostel inventory. Room counts are chosen to yield ~756 beds against ~900
 * applicants. Every hostel gets accessible ground-floor rooms.
 */
var HOSTEL_SPECS = [
  { hostelId: 'DW-BH-A', name: 'Dwarka Boys Hostel A',   campus: 'DWARKA', gender: 'M',
    warden: 'Dr. A. Sharma',  blocks: ['A', 'B'], floors: 4, roomsPerFloor: 8 },
  { hostelId: 'DW-BH-B', name: 'Dwarka Boys Hostel B',   campus: 'DWARKA', gender: 'M',
    warden: 'Dr. R. Verma',   blocks: ['A', 'B'], floors: 4, roomsPerFloor: 8 },
  { hostelId: 'ED-BH-1', name: 'East Delhi Boys Block 1', campus: 'EDC',   gender: 'M',
    warden: 'Dr. S. Khan',    blocks: ['A', 'B'], floors: 3, roomsPerFloor: 8 },
  { hostelId: 'DW-GH-A', name: 'Dwarka Girls Hostel A',  campus: 'DWARKA', gender: 'F',
    warden: 'Dr. M. Iyer',    blocks: ['A', 'B'], floors: 4, roomsPerFloor: 8 },
  { hostelId: 'DW-GH-B', name: 'Dwarka Girls Hostel B',  campus: 'DWARKA', gender: 'F',
    warden: 'Dr. P. Nair',    blocks: ['A', 'B'], floors: 3, roomsPerFloor: 8 },
  { hostelId: 'ED-GH-1', name: 'East Delhi Girls Block 1', campus: 'EDC',  gender: 'F',
    warden: 'Dr. K. Gupta',   blocks: ['A', 'B'], floors: 3, roomsPerFloor: 8 }
];

/** Room-type pattern repeated across each block-floor of 8 rooms: 18 beds. */
var FLOOR_PATTERN = ['SINGLE', 'DOUBLE', 'DOUBLE', 'DOUBLE', 'DOUBLE', 'TRIPLE', 'TRIPLE', 'TRIPLE'];
var CAPACITY = { SINGLE: 1, DOUBLE: 2, TRIPLE: 3 };

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

    h.blocks.forEach(function (block) {
      for (var floor = 1; floor <= h.floors; floor++) {
        for (var i = 0; i < h.roomsPerFloor; i++) {
          var roomType = FLOOR_PATTERN[i % FLOOR_PATTERN.length];
          var cap = CAPACITY[roomType];
          var roomNo = block + floor + Util.pad(i + 1, 2);
          var roomId = h.hostelId + '-' + roomNo;

          // Ground-floor rooms are the accessible stock: step-free access and
          // adapted washrooms. PwD applicants are pinned here by the allocator.
          var isAccessible = (floor === 1 && i < 4);

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
  var minDistance = policyValue_('eligibility', 'MIN_DISTANCE_KM', 30);
  var minCgpa = policyValue_('eligibility', 'MIN_CGPA', 5.0);

  var students = [], applications = [], preferences = [], lifestyles = [];
  var byGender = { M: 0, F: 0 };
  var ineligible = 0, needsAccessible = 0;

  // Pre-compute the merit-rank ordering by drawing CGPAs first.
  var draft = [];
  for (var i = 0; i < cohort; i++) {
    var gender = Util.weighted(rand, [['M', 58], ['F', 42]]);
    var programme = Util.weighted(rand, PROGRAMMES);
    var maxYear = YEARS_BY_PROGRAMME[programme];
    var year = Util.weighted(rand, yearWeights_(maxYear));
    var cgpa = Util.round(Util.normal(rand, 7.2, 1.1, 4.0, 10.0), 2);
    draft.push({ gender: gender, programme: programme, year: year, cgpa: cgpa, r: rand() });
  }

  // Merit rank: CGPA descending, ties broken by the seeded draw.
  var ranked = draft.slice().sort(function (a, b) {
    return b.cgpa - a.cgpa || a.r - b.r;
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
    var dist = distanceForSeed_(pin, geoIdx);

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
      enrollmentNo: enrollmentNo_(d.programme, n),
      email: emailName + '@example.edu',
      phone: '9' + Util.pad(Util.intBetween(rand, 100000000, 999999999), 9).substring(0, 9),
      gender: d.gender,
      programme: d.programme,
      branch: Util.pick(rand, BRANCHES[d.programme]),
      year: d.year,
      cgpa: d.cgpa,
      meritRank: d.meritRank,
      category: category,
      isPwD: isPwD,
      pwdType: pwdType,
      homePincode: pin,
      homeState: geoIdx[pin.substring(0, 3)].state,
      guardianEmail: 'guardian.' + emailName + '@example.com'
    });

    byGender[d.gender]++;

    // Eligibility is evaluated properly by Eligibility.gs in Phase 2. Here we
    // only pre-compute the obvious flags so the seed data is self-consistent.
    var eligible = dist >= minDistance && d.cgpa >= minCgpa;
    if (!eligible) ineligible++;

    var notes = [];
    if (dist < minDistance) notes.push('Home is ' + dist + ' km from campus, under the ' + minDistance + ' km minimum');
    if (d.cgpa < minCgpa) notes.push('CGPA ' + d.cgpa + ' is below the ' + minCgpa + ' minimum');

    applications.push({
      appId: appId,
      studentId: studentId,
      campusPref: Util.weighted(rand, [['ANY', 50], ['DWARKA', 35], ['EDC', 15]]),
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

    // Ranked preferences, drawn from hostels matching the student's gender.
    var eligibleHostels = hostels.filter(function (h) { return h.gender === d.gender; });
    var options = [];
    eligibleHostels.forEach(function (h) {
      ['SINGLE', 'DOUBLE', 'TRIPLE'].forEach(function (rt) {
        options.push({ hostelId: h.hostelId, roomType: rt, campus: h.campus });
      });
    });

    // Bias preferences toward the student's stated campus and away from TRIPLE,
    // which is how real preference sheets actually look.
    var appCampus = applications[applications.length - 1].campusPref;
    var scored = options.map(function (o) {
      var w = rand();
      if (appCampus !== 'ANY' && o.campus === appCampus) w += 0.55;
      if (o.roomType === 'SINGLE') w += 0.30;
      if (o.roomType === 'DOUBLE') w += 0.15;
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
    smokingTolerance: rand() < 0.18,
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

function distanceForSeed_(pin, geoIdx) {
  var loc = geoIdx[pin.substring(0, 3)];
  if (!loc) return -1;
  var best = null;
  Object.keys(CAMPUSES).forEach(function (k) {
    var c = CAMPUSES[k];
    var km = Geo.haversine(loc.lat, loc.lng, c.lat, c.lng);
    if (best === null || km < best) best = km;
  });
  return Util.round(best, 1);
}

function yearWeights_(maxYear) {
  var base = [45, 25, 18, 8, 4];
  var out = [];
  for (var y = 1; y <= maxYear; y++) out.push([y, base[y - 1] || 3]);
  return out;
}

function enrollmentNo_(programme, n) {
  var codes = { BTech: '01', MTech: '02', MBA: '03', MCA: '04', LLB: '05', BBA: '06', BCA: '07' };
  return Util.pad(n, 5) + codes[programme] + '26';
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
