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
  view.preferences = Db.where('Preferences', { appId: app.appId })
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

  var alloc = Db.findOne('Allocations', { appId: app.appId });
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

  var wl = Db.findOne('Waitlist', { appId: app.appId });
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
    { title: 'Your position',          prefixes: ['MERIT_POSITION'],           items: [] },
    { title: 'How your seat was awarded', prefixes: ['SEAT_', 'WAITLIST_'],    items: [] },
    { title: 'Your room preferences',  prefixes: ['PREF_', 'FALLBACK_', 'PARETO_'], items: [] },
    { title: 'Accessibility',          prefixes: ['ACCESSIBLE_'],              items: [] },
    { title: 'Roommate matching',      prefixes: ['ROOMMATE_'],                items: [] },
    { title: 'Changes since allotment', prefixes: ['SWAP_', 'TRANSFER_'],      items: [] }
  ];

  trace.forEach(function (r) {
    for (var i = 0; i < groups.length; i++) {
      var hit = groups[i].prefixes.some(function (p) { return String(r.code).indexOf(p) === 0; });
      if (hit) {
        groups[i].items.push({ ok: r.ok, text: r.text, code: r.code, detail: r.detail });
        return;
      }
    }
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
      applicationsOpen: String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() === 'TRUE',
      registration: apiGetRegistrationOptions(),
      maxPreferences: Number(Db.cfg('MAX_PREFERENCES', 5))
    };
  }

  var options = hostelOptions_(s.student.gender, s.student.campus);

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

  return {
    signedIn: true,
    applicationsOpen: String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() === 'TRUE',
    student: s.student,
    maxPreferences: Number(Db.cfg('MAX_PREFERENCES', 5)),
    options: options,
    documents: existing ? Documents.statusFor(existing.appId, s.student)
                        : Documents.requiredFor(s.student),
    draft: draft,
    minDistanceKm: Policy.value('eligibility', 'MIN_DISTANCE_KM', 30)
  };
}

function roomTypeLabel_(rt) {
  return { SINGLE: 'Single room', DOUBLE: '2-seater', TRIPLE: '3-seater' }[rt] || rt;
}

/**
 * The (hostel, room type) options open to one gender at one campus.
 *
 * Both filters are hard partitions, not rankings: a student cannot be housed in
 * another campus's hostel any more than in another gender's. Offering an option
 * that can never be granted is worse than offering none.
 */
function hostelOptions_(gender, campus) {
  var rooms = Db.readAll('Rooms');
  var hostels = Db.readAll('Hostels').filter(function (h) {
    return h.active && (h.gender === gender || h.gender === 'CO') &&
           (!campus || h.campus === campus);
  });

  var options = [];
  hostels.forEach(function (h) {
    ['SINGLE', 'DOUBLE', 'TRIPLE'].forEach(function (rt) {
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
function apiGetHostelOptions(gender, campus) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in first.');
  // An existing record is authoritative - what the browser sends is not.
  if (s.student) return hostelOptions_(s.student.gender, s.student.campus);
  if (['M', 'F', 'O'].indexOf(gender) < 0) throw new Error('Select your gender first.');
  if (['DWARKA', 'EDC'].indexOf(campus) < 0) throw new Error('Select your campus first.');
  return hostelOptions_(gender, campus);
}

/**
 * Save or submit an application.
 *
 * Campus is deliberately absent from the payload. It is a property of the
 * student's admission, read from their record, and is never accepted from the
 * browser - a student who could choose it could apply to a campus they do not
 * belong to.
 *
 * @param {Object} payload {needsAccessible, preferences[], lifestyle{}, submit:boolean}
 */
function apiSaveApplication(payload) {
  var s = Auth.session();
  if (!s.email) throw new Error('Please sign in first.');
  if (!s.student) throw new Error('No student record is linked to ' + s.email + '.');

  if (String(Db.cfg('APPLICATIONS_OPEN', 'TRUE')).toUpperCase() !== 'TRUE') {
    throw new Error('Applications are closed.');
  }

  var errors = validateApplication_(payload, s.student);
  if (errors.length) throw new Error(errors.join(' '));

  var app = s.application;
  var isNew = !app;
  var appId = app ? app.appId : Db.nextId('APP');

  // Locking an allotted application prevents a student editing preferences
  // after results are out and quietly rewriting the basis of their allocation.
  if (app && ['ALLOTTED', 'WAITLISTED', 'CANCELLED', 'WITHDRAWN'].indexOf(app.status) >= 0) {
    throw new Error('Your application is ' + String(app.status).toLowerCase() +
                    ' and can no longer be edited. Raise a grievance if something is wrong.');
  }

  var geo = Geo.distanceFromHome(s.student.homePincode, s.student.campus);
  var status = payload.submit ? 'SUBMITTED' : 'DRAFT';
  var now = new Date();

  var record = {
    appId: appId,
    studentId: s.student.studentId,
    campus: s.student.campus,
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

  Documents.provision(appId, s.student);
  Db.update('Applications', appId, { docStatus: Documents.rollUp(appId, s.student) });

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

  // Re-screen now, so the verifier sees the consequences of this upload rather
  // than a stale assessment made before it arrived.
  try { Identity.rescreen(s.application.appId); } catch (e) { /* screening is advisory */ }

  return { ok: true, fileName: safeName };
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

function apiRaiseGrievance(text) {
  var s = Auth.session();
  if (!s.application) throw new Error('You need an application before raising a grievance.');
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
