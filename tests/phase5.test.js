/**
 * Phase 5 tests - simulator, swap marketplace, grievance auto-triage.
 *
 *   node tests/phase5.test.js
 *
 * The claims that matter here:
 *   - a simulation cannot touch live state, even when it throws
 *   - a swap cannot break either hard partition, or the accessibility guarantee
 *   - an allocation dispute is AUDITED, not just answered, and a planted
 *     irregularity escalates instead of being papered over
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });

const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-P5',
                                     triggeredBy: 'admin@ipu.ac.in' });
const stuById = Db.indexBy('Students', 'studentId');
const appById = Db.indexBy('Applications', 'appId');
const roomById = Db.indexBy('Rooms', 'roomId');
const hostelById = Db.indexBy('Hostels', 'hostelId');

section('Policy override is memory-only');
const sheetBefore = JSON.stringify(Db.readAll('Policy'));
Policy.setOverride([{ category: 'reservation', key: 'PwD', value: 12 }]);
check('override changes what the engine reads', Policy.value('reservation', 'PwD', 0) === 12);
check('override does NOT change the sheet', JSON.stringify(Db.readAll('Policy')) === sheetBefore,
  'a what-if must be incapable of leaving a mark');
check('override changes the policy hash', (() => {
  const withOv = Policy.snapshotHash();
  Policy.clearOverride();
  return withOv !== Policy.snapshotHash();
})(), 'a run must never report a hash that is not the policy that produced it');
check('clearing restores the sheet value',
  Policy.value('reservation', 'PwD', 0) === 5);

section('Simulator');
const sim = Simulator.simulate({
  changes: [{ category: 'reservation', key: 'PwD', value: 12 }],
  seed: 'GGSIPU-2026'
});
check('simulation completes', !!sim.after, sim.elapsedSec + 's');
check('reports the from/to of each change',
  sim.changes[0].from === 5 && sim.changes[0].to === 12,
  JSON.stringify(sim.changes[0]));
check('before and after metrics are both present', !!sim.before && !!sim.after);
check('policy hash differs between the two runs',
  sim.policyHashBefore !== sim.policyHashAfter);
check('movement is reported', sim.movement.totalAffected >= 0);
check('a who-moved sample is returned', Array.isArray(sim.sample));
check('sample rows name a student and a change kind',
  sim.sample.every(s => !!s.name && ['GAINED', 'LOST', 'MOVED'].includes(s.change)));
console.log('        PwD 5% -> 12%:  allocated ' + sim.before.allocated + ' -> ' + sim.after.allocated +
            ',  waitlisted ' + sim.before.waitlisted + ' -> ' + sim.after.waitlisted);
console.log('        movement: ' + sim.movement.gained + ' gained, ' + sim.movement.lost +
            ' lost, ' + sim.movement.moved + ' moved, ' + sim.movement.unchanged + ' unchanged');
if (sim.sample.length) {
  const s0 = sim.sample[0];
  console.log('        e.g. ' + s0.name + ' (' + s0.category + '): ' + s0.change +
    (s0.from ? ' from ' + s0.from.hostelName + ' ' + s0.from.roomNo : '') +
    (s0.to ? ' to ' + s0.to.hostelName + ' ' + s0.to.roomNo : ''));
}

section('Simulation is non-destructive');
const bedsBefore = JSON.stringify(Db.readAll('Beds'));
const appsBefore = JSON.stringify(Db.readAll('Applications'));
const allocBefore = JSON.stringify(Db.readAll('Allocations'));
const runsBefore = Db.readAll('Runs').length;
Simulator.simulate({ changes: [{ category: 'weight', key: 'W_DISTANCE', value: 0.9 }] });
check('beds untouched', JSON.stringify(Db.readAll('Beds')) === bedsBefore);
check('applications untouched', JSON.stringify(Db.readAll('Applications')) === appsBefore);
check('allocations untouched', JSON.stringify(Db.readAll('Allocations')) === allocBefore);
check('no run record written', Db.readAll('Runs').length === runsBefore);
check('policy sheet untouched', JSON.stringify(Db.readAll('Policy')) === sheetBefore);
check('no override left behind', Policy.hasOverride() === false);

check('a throwing simulation still clears the override', (() => {
  const orig = Allocator.run;
  Allocator.run = function () { throw new Error('boom'); };
  try { Simulator.simulate({ changes: [{ category: 'weight', key: 'W_MERIT', value: 0.5 }] }); }
  catch (e) { /* expected */ }
  Allocator.run = orig;
  return Policy.hasOverride() === false;
})(), 'a stuck overlay would silently poison every later run');

check('an empty change set is rejected', (() => {
  try { Simulator.simulate({ changes: [] }); return false; } catch (e) { return true; }
})());

section('Simulator knobs');
const knobs = Simulator.knobs();
check('knobs are offered', knobs.length > 5, knobs.length + ' knobs');
check('each knob carries its current value', knobs.every(k => k.value !== undefined));
check('each knob has bounds and help',
  knobs.every(k => k.min !== undefined && k.max !== undefined && !!k.help));
check('the knobs are the levers the policy actually has',
  knobs.some(k => k.category === 'reservation') && knobs.some(k => k.category === 'priority'),
  'the brochure orders priority groups; it does not weight them against each other');
check('every priority group is adjustable',
  ['PWD', 'OUTSIDE_DELHI', 'PARENT_TRANSFERRED', 'DELHI']
    .every(k => knobs.some(x => x.category === 'priority' && x.key === k)));
check('no weight knobs are offered any more',
  !knobs.some(k => k.category === 'weight'),
  'offering a control that no longer affects anything is worse than offering none');

section('Committing a simulation');
const pwdBefore = Policy.value('reservation', 'PwD', 0);
const committed = Simulator.commit(
  [{ category: 'reservation', key: 'PwD', value: 7 }], 'admin@ipu.ac.in', 'GGSIPU-2026');
check('the policy sheet is now updated', Policy.value('reservation', 'PwD', 0) === 7,
  pwdBefore + ' -> ' + Policy.value('reservation', 'PwD', 0));
check('the change is reported with from/to',
  committed.applied[0].from === 5 && committed.applied[0].to === 7);
check('a real run was committed', Db.readAll('Runs').length === runsBefore + 1);
check('the policy change is in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'POLICY_CHANGED'));
check('ledger chain still intact', Ledger.verify().intact);
// Put it back so later sections run against the documented policy.
Simulator.commit([{ category: 'reservation', key: 'PwD', value: 5 }], 'admin@ipu.ac.in', 'GGSIPU-2026');

section('Swap validation - the constraints that must hold');
const allocs = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE');
function genderOf(appId) { return stuById[appById[appId].studentId].gender; }
function roomOf(appId) {
  const a = Db.findOne('Allocations', { appId });
  return roomById[Db.byId('Beds', a.bedId).roomId];
}

function campusOf(appId) { return stuById[appById[appId].studentId].campus; }

// Pick a pair that SHOULD be swappable: same gender, same campus, neither
// needing an accessible room, neither currently holding accessible stock.
// Grabbing the first two allotments would sometimes catch a PwD student and fail
// the accessibility check correctly, which tests nothing about the happy path.
function plainAllocsFor(gender, campus) {
  return allocs.filter(a =>
    genderOf(a.appId) === gender &&
    (!campus || campusOf(a.appId) === campus) &&
    !appById[a.appId].needsAccessible &&
    !roomById[Db.byId('Beds', a.bedId).roomId].isAccessible);
}
// One campus now, so a cross-campus refusal cannot be demonstrated from seeded
// data. The rule is still tested - directly, against Swap.validate - further
// down, which is a better test of it than an incidental pair anyway.
const boys = plainAllocsFor('M', 'EDC');
const girls = plainAllocsFor('F', 'EDC');
const boyA = boys[0].appId, boyB = boys[1].appId, girlA = girls[0].appId;
console.log('        pair: ' + boyA + ' and ' + boyB +
            ' (both plain rooms, same gender, same campus)');

const vSame = Swap.validate(boyA, boyB);
check('two same-gender students may swap', vSame.ok, JSON.stringify(
  vSame.checks.filter(c => !c.ok).map(c => c.name)));
check('validation returns every check, passed or failed', vSame.checks.length >= 4);
check('quota neutrality is stated explicitly',
  vSame.checks.some(c => c.name === 'QUOTA_NEUTRAL' && c.ok));

const vCross = Swap.validate(boyA, girlA);
check('a cross-gender swap is refused', !vCross.ok);
check('the refusal names the gender check',
  vCross.checks.some(c => c.name === 'GENDER' && !c.ok));
console.log('        cross-gender -> "' +
  vCross.checks.find(c => !c.ok).text + '"');

// Two consenting students cannot agree their way past a partition. A swap is
// the only route by which an allocation changes after the run, so it is the
// only route by which either partition could be broken after the fact.
check('a cross-campus swap is refused', (() => {
  // Move one student to the other campus on paper and re-validate. Seeded data
  // is one campus, so the pair has to be constructed rather than found.
  const st = stuById[appById[boyB].studentId];
  const wasCampus = st.campus;
  Db.update('Students', st.studentId, { campus: 'DWARKA' });
  Db.invalidate('Students');
  const v = Swap.validate(boyA, boyB);
  Db.update('Students', st.studentId, { campus: wasCampus });
  Db.invalidate('Students');
  return !v.ok && v.checks.some(c => c.name === 'CAMPUS' && !c.ok);
})(), 'a student cannot be moved to a campus they do not attend, by consent or otherwise');

check('a student cannot swap with themselves', !Swap.validate(boyA, boyA).ok);
check('swapping with an unallotted student is refused', (() => {
  const wl = Db.readAll('Waitlist')[0];
  return !Swap.validate(boyA, wl.appId).ok;
})());

// Accessibility: a student who needs an accessible room must not lose it.
const accApp = allocs.find(a => appById[a.appId].needsAccessible);
if (accApp) {
  const plainSameGender = allocs.find(a =>
    genderOf(a.appId) === genderOf(accApp.appId) &&
    !roomById[Db.byId('Beds', a.bedId).roomId].isAccessible &&
    !appById[a.appId].needsAccessible);
  const vAcc = Swap.validate(accApp.appId, plainSameGender.appId);
  check('a student needing an accessible room cannot swap into a plain one', !vAcc.ok);
  check('the refusal names accessibility',
    vAcc.checks.some(c => (c.name === 'ACCESSIBILITY' || c.name === 'ACCESSIBLE_STOCK') && !c.ok));
  console.log('        accessibility -> "' + vAcc.checks.find(c => !c.ok).text + '"');
} else {
  check('an accessible-room student exists to test with', false, 'no PwD allotment in this run');
}

section('Swap marketplace flow');
const posted = Swap.post(boyA, { reason: 'Closer to my department' });
check('a request can be posted', posted.status === 'OPEN');
check('posting is recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'SWAP_POSTED'));
check('a second open request is refused', (() => {
  try { Swap.post(boyA, {}); return false; } catch (e) { return true; }
})());

const matches = Swap.findMatches(boyB);
check('the request appears as a match for a compatible student',
  matches.some(m => m.appId === boyA), matches.length + ' matches');
check('matches carry room details',
  matches.every(m => !!m.hostelName && !!m.roomNo));
check('only legal matches are offered', (() => {
  return matches.every(m => Swap.validate(boyB, m.appId).ok);
})(), 'a student must never be offered a match that will then be refused');
check('a girl is never offered a boy\'s request',
  !Swap.findMatches(girlA).some(m => m.appId === boyA));

const roomA_before = roomOf(boyA).roomNo;
const roomB_before = roomOf(boyB).roomNo;
const accepted = Swap.accept(posted.reqId, boyB);
check('accepting a valid swap executes it', accepted.ok === true);
check('the two students actually exchanged rooms',
  roomOf(boyA).roomNo === roomB_before && roomOf(boyB).roomNo === roomA_before,
  roomA_before + '/' + roomB_before + ' -> ' + roomOf(boyA).roomNo + '/' + roomOf(boyB).roomNo);
check('bed occupancy was updated on both sides', (() => {
  const aA = Db.findOne('Allocations', { appId: boyA });
  const aB = Db.findOne('Allocations', { appId: boyB });
  return Db.byId('Beds', aA.bedId).occupantAppId === boyA &&
         Db.byId('Beds', aB.bedId).occupantAppId === boyB;
})());
check('no bed is double-booked after the swap', (() => {
  const used = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').map(a => a.bedId);
  return new Set(used).size === used.length;
})());
check('the campus partition still holds after the swap', (() => {
  return Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').every(a => {
    const st = stuById[appById[a.appId].studentId];
    const h = Db.byId('Hostels', roomById[Db.byId('Beds', a.bedId).roomId].hostelId);
    return !st.campus || h.campus === st.campus;
  });
})());
check('the gender partition still holds after the swap', (() => {
  return Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').every(a => {
    const st = stuById[appById[a.appId].studentId];
    const h = hostelById[roomById[Db.byId('Beds', a.bedId).roomId].hostelId];
    return h.gender === 'CO' || h.gender === st.gender;
  });
})());
check('every accessibility requirement still holds after the swap', (() => {
  return Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').every(a => {
    if (!appById[a.appId].needsAccessible) return true;
    return roomById[Db.byId('Beds', a.bedId).roomId].isAccessible;
  });
})());
check('the request is marked approved',
  Db.byId('Transfers', posted.reqId).status === 'APPROVED');
check('the swap is in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'SWAP_APPROVED'));
check('letters were reissued for both students', accepted.swap.lettersReissued === 2,
  'a stale letter would verify as genuine and send a warden to the wrong door');
check('the trace now explains the swap', (() => {
  const a = Db.findOne('Allocations', { appId: boyA });
  const t = typeof a.reasonCodes === 'string' ? JSON.parse(a.reasonCodes) : a.reasonCodes;
  return t.some(r => r.code === 'SWAP_EXECUTED');
})());
console.log('        ' + (() => {
  const a = Db.findOne('Allocations', { appId: boyA });
  const t = typeof a.reasonCodes === 'string' ? JSON.parse(a.reasonCodes) : a.reasonCodes;
  return t.find(r => r.code === 'SWAP_EXECUTED').text;
})());

check('accepting an already-approved request is refused', (() => {
  try { Swap.accept(posted.reqId, boys[2].appId); return false; } catch (e) { return true; }
})());
check('ledger intact after all swap activity', Ledger.verify().intact);

section('Grievance classification');
const cases = [
  ['I did not get any room even though my rank was good', 'ALLOCATION'],
  ['My roommate keeps the lights on all night', 'ROOMMATE'],
  ['There is no water in the washroom on my floor', 'FACILITY'],
  ['I paid the hostel fee twice and need a refund', 'FEE'],
  ['My category certificate was rejected during verification', 'DOCUMENT']
];
cases.forEach(([text, expected]) => {
  check('"' + text.slice(0, 38) + '..." -> ' + expected,
    Grievance.classify(text) === expected, 'got ' + Grievance.classify(text));
});

section('Allocation grievance is audited, not parroted');
const wlApp = Db.readAll('Waitlist')[0].appId;
const g1 = Grievance.raise(wlApp,
  'I have a good merit rank but did not get a room. This seems unfair to me.', 'student');
check('ticket is created', !!g1.ticketId);
check('classified as an allocation dispute', g1.category === 'ALLOCATION');
check('auto-answered when everything checks out', g1.status === 'AUTO_ANSWERED', g1.status);
check('the audit ran real checks', g1.findings.length >= 3,
  g1.findings.map(f => f.check).join(', '));
check('the ledger was verified as part of triage',
  g1.findings.some(f => f.check === 'LEDGER_INTACT' && f.ok));
check('merit order was independently re-checked',
  g1.findings.some(f => f.check === 'MERIT_ORDER_HELD'));
check('the reply cites a ledger entry', !!g1.ledgerRef && !!g1.ledgerRef.hash);
check('the reply is substantive', g1.body.length > 120);
console.log('\n        --- automatic reply ---');
console.log('        ' + g1.headline);
console.log('        ' + g1.body.replace(/(.{92}\s)/g, '$1\n        '));
console.log('        checks: ' + g1.findings.map(f => (f.ok ? '+' : '!') + f.check).join(' '));

section('A planted irregularity escalates instead of being papered over');
// Give a low-merit student of the same gender a seat this waitlisted student
// was entitled to. The audit must notice, even though the stored trace still
// says everything was fine.
const victim = Db.byId('Applications', wlApp);
const victimStu = stuById[victim.studentId];
// It has to be somebody in the SAME priority group. A student from a group
// ahead of theirs was always going to be considered first whatever their marks,
// so that is the policy working rather than an irregularity - and the audit is
// right to say nothing about it.
const plantTarget = Db.readAll('Allocations').find(a => {
  const app = appById[a.appId];
  const st = stuById[app.studentId];
  return a.status === 'ACTIVE' && st.gender === victimStu.gender &&
         st.campus === victimStu.campus &&
         (app.priorityTier || '') === (victim.priorityTier || '') &&
         a.quotaUsed === 'OPEN';
});
check('a same-group comparison exists to plant into', !!plantTarget,
  'group ' + victim.priorityTier);
const originalScore = Db.byId('Applications', plantTarget.appId).meritScore;
Db.update('Applications', plantTarget.appId,
  { meritScore: Number(victim.meritScore) - 0.05 });

const g2 = Grievance.raise(wlApp,
  'Someone with a lower rank than me got a room. Why was I not allotted a seat?', 'student');
check('the planted irregularity is caught', g2.status === 'ESCALATED', g2.status);
check('the failing check is named',
  g2.findings.some(f => f.check === 'MERIT_ORDER_HELD' && !f.ok));
check('the anomaly is described in words', g2.anomalies && g2.anomalies.length > 0);
console.log('        -> ' + (g2.anomalies || []).join(' '));
check('escalation is recorded in the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'GRIEVANCE_ESCALATED'));
Db.update('Applications', plantTarget.appId, { meritScore: originalScore });

section('A tampered ledger is caught during triage');
const rows = Db._store.AuditLog;
const idx = Math.floor(rows.length / 2);
const keep = rows[idx][4];
rows[idx][4] = JSON.stringify({ tampered: true });
const g3 = Grievance.raise(wlApp,
  'I want to know why my hostel seat allocation went the way it did.', 'student');
check('triage refuses to vouch for a broken chain', g3.status === 'ESCALATED');
check('the ledger check is the one that failed',
  g3.findings.some(f => f.check === 'LEDGER_INTACT' && !f.ok));
console.log('        -> ' + g3.findings.find(f => f.check === 'LEDGER_INTACT').text);
rows[idx][4] = keep;
check('chain restored', Ledger.verify().intact);

section('Other grievance categories');
const allottedApp = Db.readAll('Allocations').find(a => a.status === 'ACTIVE').appId;
const gRoom = Grievance.raise(allottedApp,
  'My roommate is very noisy and I cannot study in the room at all.', 'student');
check('a roommate complaint is auto-answered', gRoom.status === 'AUTO_ANSWERED');
check('it points the student at the swap marketplace',
  gRoom.body.toLowerCase().indexOf('swap') > 0,
  'self-service beats an administrative transfer queue');

const gDoc = Grievance.raise(allottedApp,
  'I uploaded my category certificate but it still shows as not verified.', 'student');
check('a document query is auto-answered', gDoc.status === 'AUTO_ANSWERED');
check('it names the actual document state', gDoc.body.length > 60);

const gOther = Grievance.raise(allottedApp,
  'I would like to request a change in my mess timings please.', 'student');
check('an unrecognised request escalates to a human', gOther.status === 'ESCALATED');

section('Grievance inbox and stats');
const st = Grievance.stats();
check('stats are computed', st.total > 0, st.total + ' tickets');
check('auto-resolution rate is reported',
  st.autoResolvedPct >= 0 && st.autoResolvedPct <= 100, st.autoResolvedPct + '%');
console.log('        ' + st.total + ' tickets, ' + st.autoResolvedPct +
            '% answered automatically, by category: ' + JSON.stringify(st.byCategory));

const inbox = Grievance.inbox(null, 50);
check('inbox lists tickets', inbox.length > 0);
check('inbox rows name the student', inbox.every(t => t.name !== undefined));
check('escalated tickets surface their anomalies',
  inbox.filter(t => t.status === 'ESCALATED').every(t => Array.isArray(t.anomalies)));

section('Admin API surface');
global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
check('simulator knobs are exposed', apiAdminSimulatorKnobs().length > 5);
check('simulate runs through the API',
  !!apiAdminSimulate([{ category: 'eligibility', key: 'MIN_CGPA', value: 6.5 }]).after);
check('grievance inbox is exposed', !!apiAdminGrievanceInbox().stats);
check('swap board is exposed', !!apiAdminSwapBoard().counts);
check('the tamper demo is disabled by default', (() => {
  try { apiAdminTamperDemo(); return false; } catch (e) { return e.message.indexOf('disabled') > 0; }
})(), 'it must never be reachable on a real deployment');

global.Session = { getActiveUser: () => ({ getEmail: () => 'someone@example.edu' }) };
['apiAdminSimulate', 'apiAdminCommitSimulation', 'apiAdminGrievanceInbox', 'apiAdminSwapBoard']
  .forEach(fn => {
    let denied = false;
    try { global[fn]([]); } catch (e) { denied = /administrator|Access denied/i.test(e.message); }
    check(fn + ' refuses a non-admin', denied);
  });

section('Final integrity sweep');
global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
check('ledger intact after everything', Ledger.verify().intact, Ledger.verify().reason);
check('no bed double-booked', (() => {
  const used = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').map(a => a.bedId);
  return new Set(used).size === used.length;
})());
check('policy sheet is back to documented values',
  Policy.value('reservation', 'PwD', 0) === 5);
check('no simulation override is left active', Policy.hasOverride() === false);

process.exit(summarise());
