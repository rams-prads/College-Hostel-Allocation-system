/**
 * Phase 6 tests - demo scenario and the admin view-as guard.
 *
 *   node tests/phase6.test.js
 *
 * The cast must be REAL applicants whose outcomes genuinely demonstrate what the
 * script claims. If a judge clicks into any character, the story has to hold up.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-P6',
                                     triggeredBy: 'admin@ipu.ac.in' });

section('Demo cast');
const demo = DemoScenario.prepare({ email: 'operator@example.com' });
check('a cast is produced', demo.cast.length >= 5, demo.cast.length + ' characters');
check('every character has a role and a talking point',
  demo.cast.every(c => !!c.role && c.note.length > 60));
check('every character is a real applicant',
  demo.cast.every(c => !!Db.byId('Applications', c.appId)));
check('names were actually written to the sheet',
  demo.cast.every(c => Db.byId('Students', c.studentId).name === c.name));
check('the operator email is attached to the lead',
  demo.signInAs && Db.byId('Students', demo.cast[0].studentId).email === 'operator@example.com');

const byCode = {};
demo.cast.forEach(c => { byCode[c.code] = c; });
console.log('        cast: ' + demo.cast.map(c => c.code).join(', '));

section('Each character genuinely demonstrates its feature');

if (byCode.ARJUN) {
  const a = Db.findOne('Allocations', { appId: byCode.ARJUN.appId });
  check('ARJUN really got his first preference', a && a.prefRankMet === 1);
  check('ARJUN really is far from home', byCode.ARJUN.distanceKm > 1000,
    byCode.ARJUN.distanceKm + ' km');
  check('ARJUN has a full explanation trace', (() => {
    const v = apiGetStudentViewAs(byCode.ARJUN.appId);
    return v.explanation && v.explanation.groups.length >= 3 && !!v.explanation.meritDetail;
  })());
} else { check('ARJUN exists', false); }

if (byCode.PRIYA) {
  const a = Db.findOne('Allocations', { appId: byCode.PRIYA.appId });
  const room = Db.byId('Rooms', Db.byId('Beds', a.bedId).roomId);
  check('PRIYA really is in an accessible room', room.isAccessible === true);
  check('PRIYA really is on the ground floor', Number(room.floor) === 1);
  check('PRIYA really needed one',
    Db.byId('Applications', byCode.PRIYA.appId).needsAccessible === true);
  check('the room number in the script matches reality',
    byCode.PRIYA.room === room.roomNo);
} else { check('PRIYA exists', false); }

if (byCode.ROHAN) {
  const w = Db.findOne('Waitlist', { appId: byCode.ROHAN.appId });
  check('ROHAN really is on the waiting list', !!w);
  check('ROHAN really is at the position claimed',
    w.position === byCode.ROHAN.waitlistPosition, w.position + ' vs ' + byCode.ROHAN.waitlistPosition);
  check('ROHAN has no allotment', !Db.findOne('Allocations', { appId: byCode.ROHAN.appId }));
  check('ROHAN gets a real explanation, not a shrug', (() => {
    const v = apiGetStudentViewAs(byCode.ROHAN.appId);
    const items = v.explanation.groups.reduce((n, g) => n + g.items.length, 0);
    return items >= 4;
  })());
  const v = apiGetStudentViewAs(byCode.ROHAN.appId);
  console.log('\n        --- what ROHAN is shown ---');
  v.explanation.groups.forEach(g => g.items.filter(i => !i.ok).forEach(i =>
    console.log('        ✗ ' + i.text.slice(0, 100) + (i.text.length > 100 ? '…' : ''))));
} else { check('ROHAN exists', false); }

if (byCode.KAVYA && byCode.MEERA) {
  const v = Swap.validate(byCode.KAVYA.appId, byCode.MEERA.appId);
  check('the demo swap pair actually passes validation', v.ok,
    v.checks.filter(c => !c.ok).map(c => c.name).join(', '));
  check('the pair share a gender', (() => {
    const g = id => Db.byId('Students', Db.byId('Applications', id).studentId).gender;
    return g(byCode.KAVYA.appId) === g(byCode.MEERA.appId);
  })());
  check('the pair are in different rooms', byCode.KAVYA.room !== byCode.MEERA.room);
} else { check('a swap pair exists', false); }

if (byCode.SANJAY) {
  const app = Db.byId('Applications', byCode.SANJAY.appId);
  check('SANJAY really is ineligible', app.eligible === false);
  check('SANJAY really lives inside the radius', Number(app.distanceKm) < 30,
    app.distanceKm + ' km');
  check('SANJAY is told why', (app.eligibilityNotes || []).length > 0);
} else { check('SANJAY exists', false); }

section('The demo swap really works end to end');
if (byCode.KAVYA && byCode.MEERA) {
  const roomK = byCode.KAVYA.room, roomM = byCode.MEERA.room;
  const req = Swap.post(byCode.KAVYA.appId, { reason: 'Closer to my department' });
  const matches = Swap.findMatches(byCode.MEERA.appId);
  check('KAVYA\'s request is visible to MEERA',
    matches.some(m => m.appId === byCode.KAVYA.appId));
  const res = Swap.accept(req.reqId, byCode.MEERA.appId);
  check('the swap executes', res.ok === true);
  const now = id => Db.byId('Rooms',
    Db.byId('Beds', Db.findOne('Allocations', { appId: id }).bedId).roomId).roomNo;
  check('they actually exchanged rooms',
    now(byCode.KAVYA.appId) === roomM && now(byCode.MEERA.appId) === roomK,
    roomK + '/' + roomM + ' -> ' + now(byCode.KAVYA.appId) + '/' + now(byCode.MEERA.appId));
  check('the swap shows in the explanation panel', (() => {
    const v = apiGetStudentViewAs(byCode.KAVYA.appId);
    return JSON.stringify(v.explanation).indexOf('swap') > 0;
  })());
}

section('The demo grievance really works');
if (byCode.ROHAN) {
  const g = Grievance.raise(byCode.ROHAN.appId,
    'My rank was decent but I did not get a room. Please explain why.', 'student');
  check('the grievance is auto-answered', g.status === 'AUTO_ANSWERED', g.status);
  check('the audit ran', g.findings.length >= 3);
  check('a ledger entry is cited', !!g.ledgerRef);
}

section('Grievances reach the wardens on Slack');
if (byCode.ARJUN) {
  const complaint = 'There has been no hot water in the washroom for three days.';
  const lastLog = () => {
    const rows = Db.readAll('AuditLog').filter(e => e.action === 'GRIEVANCE_SLACK_NOTIFIED');
    const e = rows[rows.length - 1];
    if (!e) return {};
    return typeof e.payloadJson === 'string' ? JSON.parse(e.payloadJson) : e.payloadJson;
  };

  UrlFetchApp._reset();
  Grievance.raise(byCode.ARJUN.appId, complaint, 'student');
  check('nothing leaves the machine while SLACK_ENABLED is FALSE',
    global.__fetches.length === 0, global.__fetches.length + ' calls');
  check('the skipped send is still on the record', lastLog().status === 'SKIPPED');

  // Switched on, but nobody has pasted a webhook URL in yet - the likeliest
  // half-finished setup there is, and the one that must not lose a ticket.
  Db.setCfg('SLACK_ENABLED', 'TRUE');
  UrlFetchApp._reset();
  const noUrl = Grievance.raise(byCode.ARJUN.appId, complaint, 'student');
  check('a ticket is raised anyway with no webhook configured', !!noUrl.ticketId);
  const missing = lastLog();
  check('the ledger names the property that is missing',
    (missing.error || '').indexOf('SLACK_WEBHOOK_URL') >= 0, missing.error);

  PropertiesService.getScriptProperties()
    .setProperty('SLACK_WEBHOOK_URL', 'https://hooks.slack.example/T0/B0/secret');

  UrlFetchApp._reset();
  global.__fetchQueue = [global.__fetchResponse(200, 'ok')];
  const sent = Grievance.raise(byCode.ARJUN.appId, complaint, 'student');
  check('exactly one call is made', global.__fetches.length === 1,
    global.__fetches.length + ' calls');
  check('it is a POST to the webhook',
    global.__fetches[0].params.method === 'post' &&
    global.__fetches[0].url.indexOf('hooks.slack.example') > 0);

  const posted = JSON.parse(global.__fetches[0].params.payload).text;
  check('the warden is told which student', posted.indexOf(byCode.ARJUN.name) > 0);
  check('the warden is told which room', posted.indexOf(String(byCode.ARJUN.room)) > 0);
  check('the warden is told what is actually wrong', posted.indexOf('hot water') > 0);
  check('the ticket id is quotable back', posted.indexOf(sent.ticketId) > 0);
  check('the triage verdict rides along', posted.indexOf(sent.status) > 0, sent.status);
  check('the send is recorded', lastLog().status === 'SENT');
  console.log('        -> ' + posted.split('\n').join(' | '));

  UrlFetchApp._reset();
  global.__fetchQueue = [global.__fetchResponse(500, 'channel_not_found')];
  const survived = Grievance.raise(byCode.ARJUN.appId, complaint, 'student');
  check('a Slack outage does not stop a student reporting a fault',
    !!Db.byId('Grievances', survived.ticketId));
  const failed = lastLog();
  check('the failure is recorded with its cause',
    failed.status === 'FAILED' && failed.error.indexOf('500') > 0, failed.error);

  Db.setCfg('SLACK_ENABLED', 'FALSE');
  UrlFetchApp._reset();
}

section('View-as is admin-only');
global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
check('an admin may open another student\'s portal',
  !!apiGetStudentView(byCode.ARJUN.appId).student);
check('the view is flagged as an admin view',
  apiGetStudentView(byCode.ARJUN.appId).viewingAs === true);

const someStudent = Db.readAll('Students').find(s => s.email.indexOf('@example.edu') > 0);
global.Session = { getActiveUser: () => ({ getEmail: () => someStudent.email }) };
let blocked = false, msg = '';
try { apiGetStudentView(byCode.ARJUN.appId); } catch (e) { blocked = true; msg = e.message; }
check('a student may NOT open someone else\'s portal', blocked,
  'this is the obvious attack: pass any appId from the browser console');
if (blocked) console.log('        -> "' + msg + '"');
check('a student can still see their own portal',
  !!apiGetStudentView().student);
check('their own view is not flagged as an admin view',
  apiGetStudentView().viewingAs === false);

section('Student search is admin-only');
let searchBlocked = false;
try { apiAdminFindStudent('a'); } catch (e) { searchBlocked = true; }
check('a student cannot search the register', searchBlocked);

global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
// The full name, not the first: search caps its results, and a common first
// name in a thousand-student cohort pushes the intended match off the end.
const found = apiAdminFindStudent(byCode.ARJUN.name);
check('search finds a character by name', found.some(r => r.appId === byCode.ARJUN.appId),
  found.length + ' results');
check('search works by application id',
  apiAdminFindStudent(byCode.ARJUN.appId).some(r => r.appId === byCode.ARJUN.appId));
check('search is bounded', apiAdminFindStudent('a').length <= 12);
check('a too-short query returns nothing', apiAdminFindStudent('a'.slice(0, 1)).length === 0);

section('Demo brief reads cleanly');
const brief = DemoScenario.brief();
check('a brief is produced', brief.length > 400);
check('it names every character',
  demo.cast.every(c => brief.indexOf(c.code) >= 0));
check('it carries application ids for the operator',
  demo.cast.every(c => brief.indexOf(c.appId) >= 0));

section('Final integrity');
check('ledger intact', Ledger.verify().intact, Ledger.verify().reason);
check('no bed double-booked', (() => {
  const used = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').map(a => a.bedId);
  return new Set(used).size === used.length;
})());
check('gender partition holds', (() => {
  const rooms = Db.indexBy('Rooms', 'roomId'), hostels = Db.indexBy('Hostels', 'hostelId');
  const apps = Db.indexBy('Applications', 'appId'), stu = Db.indexBy('Students', 'studentId');
  return Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').every(a => {
    const s = stu[apps[a.appId].studentId];
    const h = hostels[rooms[Db.byId('Beds', a.bedId).roomId].hostelId];
    return h.gender === 'CO' || h.gender === s.gender;
  });
})());

/** Helper: read a student view as the admin, without disturbing the session. */
function apiGetStudentViewAs(appId) {
  const prev = global.Session;
  global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
  try { return apiGetStudentView(appId); } finally { global.Session = prev; }
}

process.exit(summarise());
