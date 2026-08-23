/**
 * Api.gs - server functions the browser calls via google.script.run.
 *
 * Everything the student portal needs, in as few round trips as possible: one
 * call to render a page, one call to submit. Apps Script round trips are slow,
 * so chatty APIs feel broken on a phone over campus wifi.
 *
 * EVERY function that touches an application goes through Auth.requireOwner(),
 * so passing someone else's appId from the browser gets you an error, not their
 * data.
 */

// ============================================================ student portal

/**
 * Single entry point for a client that signed in with an email code.
 *
 * Every api* function reads its caller from Auth.session(). Rather than adding a
 * token parameter to twenty of them - twenty chances to forget one, and the one
 * you forget is the hole - the token is attached to the request here, once, and
 * cleared in a finally so it cannot leak into the next execution.
 *
 * Only names beginning "api" are dispatchable. That is not a new restriction:
 * every api* function is already callable directly over google.script.run, so
 * this exposes nothing that was not exposed before. It does keep the dispatcher
 * from being turned into a way to call anything else in the project.
 */
function apiCall(sessionToken, fnName, args) {
  if (!/^api[A-Z][A-Za-z0-9]*$/.test(String(fnName || ''))) {
    throw new Error('Unknown operation.');
  }
  if (fnName === 'apiCall') throw new Error('Unknown operation.');

  // globalThis, not `this`. Apps Script does not guarantee what `this` is bound
  // to inside a function the google.script.run bridge invoked, and a dispatcher
  // that resolves nothing would break every call on the site at once.
  var scope = (typeof globalThis !== 'undefined') ? globalThis : this;
  var fn = scope[fnName];
  if (typeof fn !== 'function') throw new Error('Unknown operation.');

  Auth.useToken(sessionToken);
  try {
    return fn.apply(null, args || []);
  } finally {
    Auth.useToken(null);
  }
}

/**
 * Everything needed to render the student dashboard in one round trip.
 */
function apiGetStudentView(asAppId, demoToken) {
  var s = Auth.session();

  // A demo link stands in for a session the platform will not give us. It grants
  // exactly one thing: reading this one portal. Everything that writes goes
  // through Auth.session() independently and still sees an anonymous visitor.
  var demoAppId = demoToken ? Auth.checkDemoToken(demoToken) : null;
  if (!s.email && !demoAppId) return { signedIn: false };

  if (demoAppId && !s.email) {
    var demoApp = Db.byId('Applications', demoAppId);
    if (!demoApp) return { signedIn: false };
    s = {
      email: '', name: '', isAdmin: false, role: 'DEMO', campus: null,
      student: Db.byId('Students', demoApp.studentId),
      application: demoApp,
      demoMode: true
    };
  }

  // An admin may inspect any applicant's portal exactly as that student sees
  // it. A warden already has this information; what they have never had is the
  // student's own view of it, which is what a grievance is usually about.
  // Students may only ever see themselves - the guard is on the server.
  if (asAppId) {
    if (!s.isAdmin) throw new Error('Access denied: you may only view your own application.');
    var target = Db.byId('Applications', asAppId);
    if (!target) throw new Error('No such application.');
    s = {
      email: s.email, name: s.name, isAdmin: true, role: s.role, campus: s.campus,
      student: Db.byId('Students', target.studentId),
      application: target,
      viewingAs: true
    };
  }

  var view = {
    signedIn: true,
    email: s.email,
    name: s.name,
    isAdmin: s.isAdmin,
    viewingAs: !!s.viewingAs,
    demoMode: !!s.demoMode,
    applicationsOpen: String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() === 'TRUE',
    institution: Db.cfg('INSTITUTION_SHORT', 'GGSIPU'),
    supportEmail: Db.cfg('SUPPORT_EMAIL', ''),
    student: null,
    application: null,
    documents: [],
    allocation: null,
    waitlist: null,
    explanation: null
  };

  if (!s.student) {
    view.unregistered = true;
    return view;
  }

  var st = s.student;
  view.student = {
    studentId: st.studentId, name: st.name, enrollmentNo: st.enrollmentNo,
    programme: st.programme, branch: st.branch, year: st.year, cgpa: st.cgpa,
    campus: st.campus, category: st.category, isPwD: st.isPwD, gender: st.gender,
    homePincode: st.homePincode, homeState: st.homeState
  };

  var app = s.application;
  if (!app) return view;

  view.application = {
    appId: app.appId, status: app.status, campus: app.campus,
    submittedAt: fmtDate_(app.submittedAt), distanceKm: app.distanceKm,
    eligible: app.eligible, docStatus: app.docStatus,
    needsAccessible: app.needsAccessible, meritScore: app.meritScore
  };
  // Asked here so the portal and the form give the same answer. A page that
  // offers an edit link the server will refuse is worse than one that does not.
  var lock = editability_(app, st);
  view.editable = lock.editable;
  view.lockReason = lock.reason;
  // Targeted reads. Auth.session() has already pulled Students and Applications,
  // so those cost nothing more; Preferences, Allocations and Waitlist had not
  // been touched and were being read in full for a handful of rows each.
  view.preferences = Db.rowsWhere('Preferences', 'appId', app.appId)
    .sort(function (a, b) { return a.rank - b.rank; })
    .map(function (p) {
      var h = Db.byId('Hostels', p.hostelId);
      return { rank: p.rank, hostelId: p.hostelId,
               hostelName: h ? h.name : p.hostelId,
               campus: h ? h.campus : '', roomType: p.roomType };
    });
  view.documents = Documents.statusFor(app.appId, st);
  // A sheet created before the Identity tab existed has no Identity tab. That is
  // a setup step outstanding, not a reason to fail the whole dashboard - the
  // student would see a spinner and have no idea why.
  try {
    view.identity = Identity.statusFor(st.studentId);
  } catch (e) {
    view.identity = null;
    view.setupWarning = 'Identity verification is not available yet: ' + e.message;
  }

  var alloc = Db.rowsWhere('Allocations', 'appId', app.appId)[0] || null;
  if (alloc && alloc.status === 'ACTIVE') {
    var bed = Db.byId('Beds', alloc.bedId);
    var room = bed ? Db.byId('Rooms', bed.roomId) : null;
    var hostel = room ? Db.byId('Hostels', room.hostelId) : null;
    view.allocation = {
      allocId: alloc.allocId,
      hostelName: hostel ? hostel.name : '',
      campus: hostel ? hostel.campus : '',
      warden: hostel ? hostel.warden : '',
      block: room ? room.block : '',
      floor: room ? room.floor : '',
      roomNo: room ? room.roomNo : '',
      roomType: room ? room.roomType : '',
      bedNo: bed ? bed.bedNo : '',
      isAccessible: room ? room.isAccessible : false,
      prefRankMet: alloc.prefRankMet,
      compatScore: alloc.compatScore,
      allocatedAt: fmtDate_(alloc.allocatedAt),
      roommates: roommatesFor_(alloc, bed)
    };
    view.explanation = buildExplanation_(alloc.reasonCodes, alloc);
  }

  var wl = Db.rowsWhere('Waitlist', 'appId', app.appId)[0] || null;
  if (wl && !view.allocation) {
    view.waitlist = {
      position: wl.position,
      etaProbability: wl.etaProbability,
      etaPercent: Math.round(Number(wl.etaProbability) * 100),
      hostelName: (Db.byId('Hostels', wl.hostelId) || {}).name || ''
    };
    view.explanation = buildExplanation_(wl.reasonCodes, null);
  }

  if (!view.explanation && app.eligibilityNotes && app.eligibilityNotes.length) {
    view.explanation = {
      headline: 'Your application was not eligible for allocation',
      groups: [{ title: 'Eligibility', items: (app.eligibilityNotes || []).map(function (t) {
        return { ok: false, text: t };
      }) }]
    };
  }

  return view;
}

/** Who else is in the room, and how well matched. */
function roommatesFor_(alloc, bed) {
  if (!bed) return [];
  var siblings = Db.where('Beds', { roomId: bed.roomId })
    .filter(function (b) { return b.bedId !== bed.bedId && b.occupantAppId; });
  return siblings.map(function (b) {
    var otherApp = Db.byId('Applications', b.occupantAppId);
    var other = otherApp ? Db.byId('Students', otherApp.studentId) : null;
    var mine = Db.byId('Lifestyle', alloc.appId);
    var theirs = Db.byId('Lifestyle', b.occupantAppId);
    var sc = (mine && theirs) ? Roommate.score(mine, theirs) : null;
    return {
      name: other ? other.name : 'Not yet allotted',
      programme: other ? other.programme : '',
      year: other ? other.year : '',
      bedNo: b.bedNo,
      compatPercent: sc ? Math.round(sc.score * 100) : null,
      strengths: sc ? topStrengths_(sc.parts) : []
    };
  });
}

/** The two dimensions a pair matched best on - more useful than a bare score. */
function topStrengths_(parts) {
  var labels = {
    sleep: 'sleep schedule', study: 'study style', clean: 'cleanliness',
    social: 'sociability', food: 'food preference', lang: 'language'
  };
  return Object.keys(labels)
    .map(function (k) { return { k: k, v: parts[k] }; })
    .filter(function (x) { return x.v >= 0.75; })
    .sort(function (a, b) { return b.v - a.v; })
    .slice(0, 2)
    .map(function (x) { return labels[x.k]; });
}

/**
 * Turn the raw reason trace into grouped, display-ready sections.
 * This is the "why did I get this room?" panel - novelty feature 1.
 */
function buildExplanation_(reasonCodes, alloc) {
  var trace = reasonCodes;
  if (typeof trace === 'string') {
    try { trace = JSON.parse(trace); } catch (e) { trace = []; }
  }
  if (!trace || !trace.length) return null;

  var groups = [
    { title: 'Eligibility',            prefixes: ['ELIG_'],                    items: [] },
    // The priority group comes before the position within it, because which
    // group you are in decides the outcome and the position only orders you
    // inside it. A reason with no group here is silently dropped, which is how
    // the most decisive fact about an allotment went missing from its own
    // explanation the moment the policy changed.
    { title: 'Your priority group',    prefixes: ['PRIORITY_GROUP'],           items: [] },
    { title: 'Your position',          prefixes: ['MERIT_POSITION'],           items: [] },
    { title: 'How your seat was awarded', prefixes: ['SEAT_', 'WAITLIST_'],    items: [] },
    { title: 'Your room preferences',  prefixes: ['PREF_', 'FALLBACK_', 'PARETO_'], items: [] },
    { title: 'Accessibility',          prefixes: ['ACCESSIBLE_'],              items: [] },
    { title: 'Roommate matching',      prefixes: ['ROOMMATE_'],                items: [] },
    { title: 'Changes since allotment', prefixes: ['SWAP_', 'TRANSFER_'],      items: [] }
  ];

  // Anything with no group of its own still gets shown. Dropping it silently is
  // how a reason the engine took the trouble to record disappears from the
  // explanation it was recorded for.
  var other = { title: 'Other factors', prefixes: [], items: [] };
  groups.push(other);

  trace.forEach(function (r) {
    for (var i = 0; i < groups.length; i++) {
      var hit = groups[i].prefixes.some(function (p) { return String(r.code).indexOf(p) === 0; });
      if (hit) {
        groups[i].items.push({ ok: r.ok, text: r.text, code: r.code, detail: r.detail });
        return;
      }
    }
    other.items.push({ ok: r.ok, text: r.text, code: r.code, detail: r.detail });
  });

  var merit = trace.filter(function (r) { return r.code === 'MERIT_POSITION'; })[0];
  var headline = alloc
    ? (alloc.prefRankMet >= 1
        ? 'You were allotted your preference ' + alloc.prefRankMet + ' room'
        : 'You were allotted a room outside your stated preferences')
    : 'You are on the waiting list';

  return {
    headline: headline,
    meritDetail: merit ? merit.detail : null,
    groups: groups.filter(function (g) { return g.items.length; })
  };
}

// ============================================================ apply form

/** Reference data for the application form, plus any saved draft. */
function apiGetApplyForm() {
  var s = Auth.session();
  if (!s.email) return { signedIn: false };

  // Not in the registry. The form opens on registration rather than refusing.
  if (!s.student) {
    return {
      signedIn: true,
      needsRegistration: true,
      email: s.email,
      isAdmin: !!s.isAdmin,
      applicationsOpen: String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() === 'TRUE',
      registration: apiGetRegistrationOptions(),
      maxPreferences: Number(Db.cfg('MAX_PREFERENCES', 5))
    };
  }

  var options = hostelOptions_(s.student.gender, s.student.campus, s.student);

  var existing = s.application;
  var draft = null;
  if (existing) {
    draft = {
      appId: existing.appId,
      status: existing.status,
      needsAccessible: existing.needsAccessible,
      preferences: Db.where('Preferences', { appId: existing.appId })
        .sort(function (a, b) { return a.rank - b.rank; })
        .map(function (p) { return p.hostelId + '|' + p.roomType; }),
      lifestyle: Db.byId('Lifestyle', existing.appId)
    };
  }

  var lock = editability_(existing, s.student);

  return {
    signedIn: true,
    email: s.email,
    // So the form can send an administrator where they belong rather than
    // offering them an application they will never submit.
    isAdmin: !!s.isAdmin,
    applicationsOpen: String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() === 'TRUE',
    student: s.student,
    maxPreferences: Number(Db.cfg('MAX_PREFERENCES', 5)),
    options: options,
    documents: existing ? Documents.statusFor(existing.appId, s.student)
                        : Documents.requiredFor(s.student),
    draft: draft,
    // Sent to everybody, not only to a registering student. A student who typed
    // their own details is the person best placed to correct them, and until
    // the office has finished checking, correcting them is exactly what we want
    // to happen - so the form that captured them has to be able to render again.
    registration: apiGetRegistrationOptions(),
    editable: lock.editable,
    lockReason: lock.reason,
    minDistanceKm: Policy.value('eligibility', 'MIN_DISTANCE_KM', 30)
  };
}

function roomTypeLabel_(rt) {
  return { SINGLE: 'Single room', TRIPLE: '3-seater', QUAD: '4-seater' }[rt] || rt;
}

/**
 * The (hostel, room type) options open to one gender at one campus.
 *
 * Both filters are hard partitions, not rankings: a student cannot be housed in
 * another campus's hostel any more than in another gender's. Offering an option
 * that can never be granted is worse than offering none.
 */
function hostelOptions_(gender, campus, student) {
  // The brochure reserves single rooms for PG and PhD students. An
  // undergraduate ranking one would be ranking something that can never be
  // granted, and would then be told a preference was "unavailable" when in
  // truth it was never theirs to ask for.
  var singlesAllowed = !Number(Policy.value('capacity', 'SINGLE_ROOM_PG_ONLY', 1)) ||
    (student && Catalogue.isPgOrPhd(student.programme, student.year));

  var rooms = Db.readAll('Rooms');
  var hostels = Db.readAll('Hostels').filter(function (h) {
    return h.active && (h.gender === gender || h.gender === 'CO') &&
           (!campus || h.campus === campus);
  });

  var options = [];
  hostels.forEach(function (h) {
    ['SINGLE', 'TRIPLE', 'QUAD'].forEach(function (rt) {
      if (rt === 'SINGLE' && !singlesAllowed) return;
      var capacity = rooms.filter(function (r) {
        return r.hostelId === h.hostelId && r.roomType === rt && r.status === 'ACTIVE';
      }).length;
      if (!capacity) return;
      options.push({
        key: h.hostelId + '|' + rt,
        hostelId: h.hostelId, hostelName: h.name, campus: h.campus,
        roomType: rt, roomTypeLabel: roomTypeLabel_(rt), rooms: capacity
      });
    });
  });
  return options;
}

/**
 * Options for a student who is still registering and therefore has no record to
 * read a gender or campus from. Called from the form as soon as they have
 * declared both, so the preference step can be filled in the same sitting.
 */
function apiGetHostelOptions(gender, campus, programme, year) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in first.');
  // An existing record is authoritative - what the browser sends is not.
  if (s.student) return hostelOptions_(s.student.gender, s.student.campus, s.student);
  if (['M', 'F', 'O'].indexOf(gender) < 0) throw new Error('Select your gender first.');
  if (['DWARKA', 'EDC'].indexOf(campus) < 0) throw new Error('Select your campus first.');
  // A registrant has no record yet, so the programme they have just declared is
  // what decides whether a single room is theirs to ask for.
  return hostelOptions_(gender, campus, { programme: programme, year: year });
}

/**
 * Whether an application can still be changed, and if not, why not.
 *
 * ONE rule, in ONE place, because the question is asked from four: the form
 * that decides which fields to render, the portal that decides whether to offer
 * the link, and the two endpoints that write. A rule copied into four places is
 * a rule that will eventually disagree with itself, and the version that says
 * "yes" is the one that will be found by whoever wants it to.
 *
 * The rule: everything a student declared is theirs to correct until the office
 * has finished checking it. "Finished" means BOTH checks - the identity and the
 * documents - because while either is still open somebody is still going to
 * read this record, and a correction now costs the office a great deal less
 * than a grievance after allotment. Once both have passed, the declaration IS
 * what was verified, and it stops being theirs to change.
 *
 * Editing while a check is open does not weaken the check: reopenChecks_()
 * sends back anything that was verified against a field that has since moved.
 */
function editability_(app, student) {
  if (!app) return { editable: true, reason: '' };

  var settled = { ALLOTTED: 'allotted', WAITLISTED: 'on the waiting list',
                  CANCELLED: 'cancelled', WITHDRAWN: 'withdrawn' };
  if (settled[app.status]) {
    return { editable: false,
      reason: 'Your application is ' + settled[app.status] + ', so it can no longer be ' +
              'changed. Contact the hostel office if something is wrong.' };
  }

  var idStatus = 'REQUIRED';
  try {
    if (student) idStatus = Identity.statusFor(student.studentId).status;
  } catch (e) { /* no Identity tab yet - treat as not verified */ }

  if (idStatus === 'VERIFIED' && String(app.docStatus) === 'VERIFIED') {
    return { editable: false,
      reason: 'Your identity and your documents have both been verified, so your ' +
              'application is now fixed as the office checked it. Contact the hostel ' +
              'office if something still needs to change.' };
  }
  return { editable: true, reason: '' };
}

/**
 * The fields a student may correct about themselves, and nothing else.
 *
 * A whitelist rather than "everything except": a column added to Students later
 * would silently become student-writable under a blacklist, and the columns
 * most worth protecting - the re-admission and disciplinary flags - are exactly
 * the ones somebody would add later.
 */
var EDITABLE_DETAIL_FIELDS = [
  'name', 'enrollmentNo', 'phone', 'dob', 'gender', 'programme', 'branch',
  'campus', 'year', 'meritPercent', 'residenceCategory', 'parentTransferred',
  'category', 'isPwD', 'pwdType', 'homeAddress', 'homeCity', 'homePincode',
  'homeState', 'guardianName', 'guardianPhone', 'guardianEmail', 'bloodGroup',
  'medicalNotes'
];

/** The record as it would be if this correction were accepted. Not written. */
function mergedStudent_(student, details) {
  var out = {};
  Object.keys(student).forEach(function (k) { out[k] = student[k]; });
  details = details || {};
  EDITABLE_DETAIL_FIELDS.forEach(function (f) {
    if (details[f] === undefined) return;
    var v = details[f];
    if (f === 'parentTransferred' || f === 'isPwD') v = !!v;
    else if (f === 'year' || f === 'meritPercent') v = Number(v) || 0;
    else if (f === 'phone' || f === 'guardianPhone') v = String(v).replace(/\D/g, '');
    else v = String(v == null ? '' : v).trim();
    out[f] = v;
  });
  if (out.residenceCategory !== 'DELHI') out.parentTransferred = false;
  if (!out.isPwD) out.pwdType = '';
  return out;
}

/**
 * Write a correction, record exactly what moved, and reopen anything that was
 * checked against a field that moved.
 */
function applyDetailChanges_(before, after, actor) {
  var changed = {};
  EDITABLE_DETAIL_FIELDS.forEach(function (f) {
    var a = before[f] == null ? '' : before[f];
    var b = after[f] == null ? '' : after[f];
    if (String(a) !== String(b)) changed[f] = { from: a, to: b };
  });
  var fields = Object.keys(changed);
  if (!fields.length) return { changed: [] };

  var write = {};
  EDITABLE_DETAIL_FIELDS.forEach(function (f) { write[f] = after[f]; });
  // Derived, never declared: naming a course has already named the school, and
  // the year decides which result the merit percentage is.
  write.school = Catalogue.schoolOf(after.programme);
  write.meritBasis = Number(after.year) <= Catalogue.entryYear(after.programme)
    ? 'CLASS_12' : 'SEMESTER';
  var geo = Geo.distanceFromHome(after.homePincode, after.campus);
  if (geo.resolved) write.homeState = geo.state;

  Db.update('Students', before.studentId, write);

  // WHAT changed, not merely that something did. An officer who verified an
  // address has to be able to see that the address moved after they looked.
  Ledger.append('STUDENT_DETAILS_UPDATED', {
    studentId: before.studentId, fields: fields, changes: changed
  }, actor);

  reopenChecks_(before.studentId, changed, actor);
  return { changed: fields };
}

/**
 * A check is worth something only if it was made against what the record says
 * NOW. Corrections before verification are allowed on purpose, so any field a
 * check actually asserts must reopen that check when it moves - otherwise
 * "get it verified, then quietly change it" is a hole wide enough to drive an
 * address through, and the address is the field the priority order turns on.
 */
function reopenChecks_(studentId, changed, actor) {
  function touched(list) {
    return list.some(function (f) { return !!changed[f]; });
  }

  // The identity check matches a name and an enrolment number to a card.
  if (touched(['name', 'enrollmentNo'])) {
    try { Identity.reopen(studentId, 'the declared details were changed', actor); }
    catch (e) { /* no Identity tab yet */ }
  }

  // A document check asserts the name on it, the enrolment number on it, and
  // the PIN code read off it.
  if (!touched(['name', 'enrollmentNo', 'homePincode'])) return;

  var app = Db.findOne('Applications', { studentId: studentId });
  if (!app) return;

  var reopened = 0;
  Db.where('Documents', { appId: app.appId }).forEach(function (d) {
    if (!d.driveFileId) return;
    var wasChecked = d.status === 'VERIFIED' || d.status === 'REJECTED' ||
                     (d.scanVerdict && d.scanVerdict !== 'UNSCANNED');
    if (!wasChecked) return;
    Db.update('Documents', d.docId, {
      status: 'UPLOADED', verifiedBy: '', verifiedAt: '',
      scanVerdict: 'UNSCANNED', scanJson: null, scannedAt: '',
      note: 'Checked again because the details it was compared against were changed.'
    });
    reopened++;
  });

  if (!reopened) return;
  Db.invalidate('Documents');
  var student = Db.byId('Students', studentId);
  Db.update('Applications', app.appId, { docStatus: Documents.rollUp(app.appId, student) });
  Ledger.append('DOCUMENT_CHECK_REOPENED', {
    appId: app.appId, count: reopened, fields: Object.keys(changed)
  }, actor);
}

/**
 * Save or submit an application, and optionally a correction to the details it
 * is judged on.
 *
 * The two arrive TOGETHER rather than on separate calls, because preferences
 * are validated against gender and campus. Saving one without the other would
 * check the new choices against the old record - or the old choices against the
 * new one - and leave the two disagreeing in a way nothing downstream expects.
 *
 * Details are accepted only from `payload.details`, only through the whitelist
 * above, and only while editability_() says the record is still the student's
 * to correct. Everything in it is self-declared and always was; verification is
 * what turns it into evidence, and a change reopens the verification.
 *
 * @param {Object} payload {details{}?, needsAccessible, preferences[],
 *                          lifestyle{}, submit:boolean}
 */
function apiSaveApplication(payload) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in first.');
  if (!s.student) throw new Error('No student record is linked to ' + s.email + '.');

  if (String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() !== 'TRUE') {
    throw new Error('Applications are closed.');
  }

  var app = s.application;
  var isNew = !app;
  var appId = app ? app.appId : Db.nextId('APP');

  var lock = editability_(app, s.student);
  if (!lock.editable) throw new Error(lock.reason);

  // Validate EVERYTHING before writing anything. A correction that passes while
  // the preferences it invalidates do not must leave the record untouched,
  // rather than saving half of an application that no longer holds together.
  var student = s.student;
  if (payload.details) {
    student = mergedStudent_(s.student, payload.details);
    var dErrors = validateRegistration_(student);
    if (dErrors.length) throw new Error(dErrors.join(' '));

    var wanted = String(student.enrollmentNo).trim().toLowerCase();
    var clash = Db.readAll('Students').filter(function (x) {
      return x.studentId !== s.student.studentId &&
             String(x.enrollmentNo).trim().toLowerCase() === wanted;
    })[0];
    if (clash) {
      throw new Error('Enrolment number ' + student.enrollmentNo + ' is already registered ' +
                      'to another student. Contact the hostel office.');
    }
  }

  var errors = validateApplication_(payload, student);
  if (errors.length) throw new Error(errors.join(' '));

  if (payload.details) applyDetailChanges_(s.student, student, s.email);

  var geo = Geo.distanceFromHome(student.homePincode, student.campus);
  // Saving a draft must never UNDO a submission. Before details could be
  // corrected there was nothing to save on a submitted application, so nobody
  // hit this; now "Save as draft" on an edit would have quietly withdrawn a
  // student from the allocation they were already in.
  var status = payload.submit ? 'SUBMITTED'
             : (app && app.status !== 'DRAFT' ? app.status : 'DRAFT');
  var now = new Date();

  var record = {
    appId: appId,
    studentId: student.studentId,
    campus: student.campus,
    status: status,
    submittedAt: payload.submit ? now : (app ? app.submittedAt : ''),
    meritScore: app ? app.meritScore : 0,
    distanceKm: geo.resolved ? geo.km : -1,
    eligible: app ? app.eligible : false,
    eligibilityNotes: app ? app.eligibilityNotes : [],
    docStatus: app ? app.docStatus : 'PENDING',
    docFolderUrl: app ? app.docFolderUrl : '',
    needsAccessible: !!payload.needsAccessible,
    updatedAt: now
  };

  if (isNew) {
    Db.append('Applications', record);
  } else {
    Db.update('Applications', appId, record);
  }

  // Preferences are replaced wholesale - simpler and safer than diffing ranks.
  var others = Db.readAll('Preferences').filter(function (p) { return p.appId !== appId; });
  var mine = (payload.preferences || []).map(function (key, i) {
    var parts = String(key).split('|');
    return { appId: appId, rank: i + 1, hostelId: parts[0], roomType: parts[1] };
  });
  Db.replaceAll('Preferences', others.concat(mine));

  if (payload.lifestyle) {
    var life = Object.assign({ appId: appId }, payload.lifestyle);
    if (Db.byId('Lifestyle', appId)) Db.update('Lifestyle', appId, life);
    else Db.append('Lifestyle', life);
  }

  Documents.provision(appId, student);
  Db.update('Applications', appId, { docStatus: Documents.rollUp(appId, student) });

  if (payload.submit) {
    Ledger.append('APPLICATION_SUBMITTED', {
      appId: appId, studentId: s.student.studentId,
      preferences: mine.length, campus: record.campus
    }, s.email);
  }

  return { ok: true, appId: appId, status: status };
}

/** Field-level validation. Returns human-readable messages, not codes. */
function validateApplication_(payload, student) {
  var errors = [];
  var maxPrefs = Number(Db.cfg('MAX_PREFERENCES', 5));
  var prefs = payload.preferences || [];

  if (payload.submit && !prefs.length) {
    errors.push('Please rank at least one room preference.');
  }
  if (prefs.length > maxPrefs) {
    errors.push('You may rank at most ' + maxPrefs + ' preferences.');
  }
  if (new Set(prefs).size !== prefs.length) {
    errors.push('The same choice appears more than once in your preference list.');
  }

  // A preference outside either hard partition would be impossible to grant, so
  // it is rejected at the door rather than silently dropped later - a student
  // whose choices vanish without explanation has a legitimate grievance.
  var hostels = Db.indexBy('Hostels', 'hostelId');
  prefs.forEach(function (key) {
    var hostelId = String(key).split('|')[0];
    var h = hostels[hostelId];
    if (!h) { errors.push('Unknown hostel in your preferences.'); return; }
    if (h.gender !== 'CO' && h.gender !== student.gender) {
      errors.push(h.name + ' does not accept applications from your gender.');
    }
    if (student.campus && h.campus !== student.campus) {
      errors.push(h.name + ' is at ' + Geo.campusName(h.campus) + '. You are admitted to ' +
                  Geo.campusName(student.campus) + ' and can only be allotted a hostel there.');
    }
  });

  if (payload.submit) {
    var life = payload.lifestyle || {};
    ['sleepTime', 'wakeTime', 'studyStyle', 'foodPref'].forEach(function (f) {
      if (!life[f]) errors.push('Please complete the roommate questionnaire.');
    });
  }
  return errors.filter(function (v, i, a) { return a.indexOf(v) === i; });
}

/** Withdraw an application. */
function apiWithdrawApplication() {
  var s = Auth.session();
  if (!s.application) throw new Error('You have no application to withdraw.');
  Db.update('Applications', s.application.appId, { status: 'WITHDRAWN', updatedAt: new Date() });
  Ledger.append('APPLICATION_WITHDRAWN', { appId: s.application.appId }, s.email);
  return { ok: true };
}

// ============================================================ documents

/**
 * File types a document may be. An allow-list, never a block-list.
 *
 * The previous version created a Drive file with whatever MIME type the browser
 * claimed. An uploaded text/html file served from Drive executes in the
 * uploader's origin, so a student could have stored a script and handed the link
 * to a verifier. Only formats a scanned certificate can legitimately be are
 * accepted, and the type is taken from this table rather than from the client.
 */
var ALLOWED_UPLOAD_TYPES = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/webp': '.webp'
};

/**
 * Upload one document to Drive and attach it to the application.
 * @param {{docType, fileName, mimeType, bytes}} payload  bytes = base64
 */
function apiUploadDocument(payload) {
  var s = Auth.session();
  if (!s.application) throw new Error('Submit your application before uploading documents.');
  Auth.requireOwner(s.application.appId);

  payload = payload || {};

  // Uploads cost Drive quota and cannot be undone cheaply, so they are capped
  // per applicant per hour before any work is done.
  var perHour = Number(Policy.value('identity', 'MAX_UPLOADS_PER_HOUR', 20));
  Auth.rateLimit('upload', s.email, perHour, 3600);

  // The slot must be one this applicant was actually asked for. Without this a
  // student could create document rows for types that do not apply to them.
  var slot = Db.findOne('Documents', { appId: s.application.appId, docType: payload.docType });
  if (!slot) throw new Error('That document is not required for your application.');

  var mime = String(payload.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_UPLOAD_TYPES[mime]) {
    throw new Error('Upload a PDF or a photo (JPG, PNG, HEIC or WEBP). ' +
                    'Other file types are not accepted.');
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(payload.bytes || '');
  } catch (e) {
    throw new Error('That file could not be read. Please try uploading it again.');
  }
  if (!bytes || !bytes.length) throw new Error('That file appears to be empty.');

  var maxMb = Number(Policy.value('identity', 'MAX_UPLOAD_MB', 8));
  if (bytes.length > maxMb * 1024 * 1024) {
    throw new Error('That file is larger than ' + maxMb + ' MB. Please upload a smaller ' +
                    'scan or photo.');
  }

  // The stored name is generated, not accepted. A client-supplied filename can
  // carry path separators, control characters or a second extension, none of
  // which belong in a Drive folder a verifier will open.
  var safeName = payload.docType + '-' + s.application.appId + ALLOWED_UPLOAD_TYPES[mime];

  var folder = documentsFolder_(s.application.appId);
  var blob = Utilities.newBlob(bytes, mime, safeName);
  var file = folder.createFile(blob);

  // Hash the CONTENT, so the same scan submitted by two applicants is detectable
  // however it was renamed.
  var hash = Util.sha256Hex(bytes);

  Documents.recordUpload(s.application.appId, payload.docType, file.getId(), safeName, {
    mimeType: mime, sizeBytes: bytes.length, contentHash: hash
  });
  Db.update('Applications', s.application.appId, {
    docStatus: Documents.rollUp(s.application.appId, s.student),
    docFolderUrl: folder.getUrl()
  });

  // Read it straight away. A few seconds here saves the applicant discovering a
  // mismatch weeks later, and saves an officer opening the file at all when it
  // agrees with what was declared.
  var verdict = null;
  try {
    var slotRow = Db.findOne('Documents', { appId: s.application.appId, docType: payload.docType });
    verdict = Documents.scanIfNeeded(slotRow, s.student, true);
  } catch (e) { /* reading is advisory; the upload itself succeeded */ }

  try { Identity.rescreen(s.application.appId); } catch (e) { /* screening is advisory */ }

  return { ok: true, fileName: safeName, scanVerdict: verdict };
}

// ============================================================ identity

/**
 * Submit an Aadhaar number for verification against the applicant's documents.
 *
 * The number is validated, hashed and discarded inside this call. Nothing that
 * could reconstruct it is stored or returned - the response carries only the
 * masked form the student already knows.
 */
function apiSubmitIdentity(aadhaar) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in first.');

  // Limit FIRST, before any lookup. A 12-digit space is small enough to walk if
  // the endpoint is unmetered, and this endpoint is a valid-number oracle: it
  // answers "is this a real Aadhaar number" for anyone who asks. Checking the
  // student record first would leave that oracle open to any signed-in account
  // that has not registered.
  Auth.rateLimit('identity', s.email, 8, 3600);

  if (!s.student) throw new Error('Register your student details before verifying your identity.');

  var result = Identity.submit(s.student.studentId, aadhaar);
  if (s.application) {
    try { Identity.rescreen(s.application.appId); } catch (e) { /* advisory */ }
  }
  return result;
}

function documentsFolder_(appId) {
  var rootId = Db.cfg('LETTER_FOLDER_ID', '');
  var root = rootId ? DriveApp.getFolderById(rootId) : DriveApp.getRootFolder();
  var name = 'HostelDocs-' + appId;
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

// ============================================================ helpers

function fmtDate_(d) {
  if (!d) return '';
  try {
    return Utilities.formatDate(new Date(d), 'Asia/Kolkata', 'd MMM yyyy');
  } catch (e) { return ''; }
}

// ============================================================ swaps

/** The swap marketplace as this student sees it. */
function apiGetSwapView() {
  var s = Auth.session();
  if (!s.application) throw new Error('You need an application before you can use swaps.');
  var appId = s.application.appId;

  var mine = Db.readAll('Transfers').filter(function (t) {
    return t.type === 'SWAP' && t.appId === appId &&
           ['OPEN', 'MATCHED', 'CONSENTED'].indexOf(t.status) >= 0;
  })[0] || null;

  var place = Swap.placement(appId);
  return {
    allotted: !!place,
    current: place ? {
      hostelName: place.hostel.name, campus: place.hostel.campus,
      roomNo: place.room.roomNo, roomType: place.room.roomType,
      isAccessible: place.room.isAccessible
    } : null,
    myRequest: mine ? { reqId: mine.reqId, status: mine.status, reason: mine.reason } : null,
    matches: mine ? Swap.findMatches(appId) : [],
    boardSize: Swap.board(100).length
  };
}

function apiPostSwap(payload) {
  var s = Auth.session();
  if (!s.application) throw new Error('You have no application.');
  return Swap.post(s.application.appId, payload || {});
}

function apiAcceptSwap(reqId) {
  var s = Auth.session();
  if (!s.application) throw new Error('You have no application.');
  return Swap.accept(reqId, s.application.appId);
}

function apiCancelSwap(reqId) {
  var s = Auth.session();
  if (!s.application) throw new Error('You have no application.');
  return Swap.cancel(reqId, s.application.appId);
}

// ============================================================ grievances

/**
 * Report a problem. Open to residents, which means students holding a room.
 *
 * Before allotment there is nothing to report yet: the application has its own
 * screens for documents and identity, each of which says what is outstanding
 * and what to do about it, and a free-text box beside them only invited
 * questions those screens had already answered. After allotment the student
 * lives somewhere, and the things that go wrong - water, power, the mess, a
 * roommate, the room itself - have nowhere else to go.
 */
function apiRaiseGrievance(text) {
  var s = Auth.session();
  if (!s.application) throw new Error('You need an application before reporting a problem.');

  var alloc = Db.rowsWhere('Allocations', 'appId', s.application.appId)
    .filter(function (a) { return a.status === 'ACTIVE'; })[0];
  if (!alloc) {
    throw new Error('Reporting is open once you have been allotted a room. Until then, ' +
                    'your application page shows what is outstanding, and anything else ' +
                    'should go to the hostel office at ' +
                    Db.cfg('SUPPORT_EMAIL', 'hostel@ipu.ac.in') + '.');
  }
  return Grievance.raise(s.application.appId, text, s.email);
}

/** This student's tickets, with the automatic reply attached. */
function apiGetGrievances() {
  var s = Auth.session();
  if (!s.application) return [];
  return Db.where('Grievances', { appId: s.application.appId }).map(function (g) {
    var t = typeof g.autoTriage === 'string'
      ? (function () { try { return JSON.parse(g.autoTriage); } catch (e) { return null; } })()
      : g.autoTriage;
    return {
      ticketId: g.ticketId, category: g.category, status: g.status,
      text: g.text,
      headline: t ? t.headline : '',
      body: t ? t.body : '',
      findings: t ? t.findings : [],
      ledgerRef: t ? t.ledgerRef : null,
      createdAt: fmtDate_(g.createdAt),
      slaDueAt: fmtDate_(g.slaDueAt)
    };
  });
}
