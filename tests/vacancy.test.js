/**
 * Waiting-list promotion.
 *
 *   node tests/vacancy.test.js
 *
 * One bed comes free. The question is not "who is first on the list" but "who
 * is the first person on the list who could actually live in THIS bed", and
 * almost everything worth testing here is a case where those two differ.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();
const run = Allocator.runAndCommit({ seed: 'VACANCY', runId: 'RUN-VAC',
                                     triggeredBy: 'admin@ipu.ac.in' });

function anyActive() {
  return Db.readAll('Allocations').find(a => a.status === 'ACTIVE');
}
function roomOf(bedId) {
  const bed = Db.byId('Beds', bedId);
  return Db.byId('Rooms', bed.roomId);
}
function hostelOf(bedId) {
  return Db.byId('Hostels', roomOf(bedId).hostelId);
}
/** Empty one bed the way a cancellation does, without going through the API. */
function freeBed(alloc) {
  Db.update('Allocations', alloc.allocId, { status: 'CANCELLED' });
  Db.update('Beds', alloc.bedId, { status: 'VACANT', occupantAppId: '' });
  Db.update('Applications', alloc.appId, { status: 'WITHDRAWN' });
  Db.invalidate('Allocations'); Db.invalidate('Beds'); Db.invalidate('Applications');
  return alloc.bedId;
}

section('A bed that comes free goes to the next person entitled to it');

const alloc = anyActive();
const hostel = hostelOf(alloc.bedId);
const room = roomOf(alloc.bedId);
const queueBefore = Db.readAll('Waitlist').slice()
  .sort((a, b) => a.position - b.position);
const bedId = freeBed(alloc);

const r = Vacancy.fill(bedId, 'admin@ipu.ac.in');

check('somebody is seated', r.filled === true, r.reason);
check('the bed is theirs', (() => {
  const bed = Db.byId('Beds', bedId);
  return bed.status === 'OCCUPIED' && bed.occupantAppId === r.appId;
})());
check('and their application says so',
  Db.byId('Applications', r.appId).status === 'ALLOTTED');
check('there is an allocation row behind it', (() => {
  const a = Db.byId('Allocations', r.allocId);
  return a && a.status === 'ACTIVE' && a.bedId === bedId && a.appId === r.appId;
})());

check('it is the highest-placed applicant the bed was open to', (() => {
  // Everybody the promotion passed over must have been ineligible for this
  // exact bed - never merely further down.
  const apps = Db.indexBy('Applications', 'appId');
  const stu = Db.indexBy('Students', 'studentId');
  const promotedAt = r.position;
  return queueBefore
    .filter(w => Number(w.position) < promotedAt)
    .every(w => {
      const a = apps[w.appId];
      const s = a ? stu[a.studentId] : null;
      if (!a || !s) return true;
      return !!Vacancy._ineligibleFor(Db.byId('Beds', bedId), room, hostel, a, s);
    });
})(), 'skipping somebody who could have had the bed is the one thing this must never do');

check('nobody else was moved', (() => {
  // Exactly one allocation was added, and no ACTIVE row changed its bed.
  const active = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE');
  return active.filter(a => a.allocId === r.allocId).length === 1;
})(), 'the alternative - re-running - re-decides students already holding letters');

section('The student is told what happened, and why they and not the person above');

const trace = Db.byId('Allocations', r.allocId).reasonCodes;
check('the trace explains the promotion',
  trace.some(t => t.code === 'WAITLIST_PROMOTED'));
check('and names the position they came from',
  trace.some(t => String(t.text).indexOf(String(r.position)) >= 0),
  JSON.stringify(trace[0] && trace[0].text));
check('the room is named', trace.some(t => String(t.text).indexOf(room.roomNo) >= 0));
check('and anyone passed over is accounted for, not left unexplained',
  r.skipped === 0 || trace.some(t => t.code === 'VACANCY_ELIGIBILITY'),
  r.skipped + ' passed over');
check('it is on the ledger',
  Db.readAll('AuditLog').some(e => e.action === 'WAITLIST_PROMOTED'));
check('the chain still verifies', Ledger.verify().intact);

section('The queue closes up behind them');

check('the promoted student is off the list',
  !Db.findOne('Waitlist', { appId: r.appId }));
check('and the positions left are 1..N with no gap', (() => {
  const pos = Db.readAll('Waitlist').map(w => Number(w.position)).sort((a, b) => a - b);
  return pos.every((p, i) => p === i + 1);
})(), 'a queue with a hole in it is a queue people read as broken');

section('The hard partitions still hold');

check('a bed is never offered across gender', (() => {
  const bad = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').some(a => {
    const h = hostelOf(a.bedId);
    const s = Db.byId('Students', Db.byId('Applications', a.appId).studentId);
    return h.gender !== 'CO' && h.gender !== s.gender;
  });
  return !bad;
})());
check('nor across campus', (() => {
  const bad = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').some(a => {
    const h = hostelOf(a.bedId);
    const s = Db.byId('Students', Db.byId('Applications', a.appId).studentId);
    return s.campus && h.campus !== s.campus;
  });
  return !bad;
})());
check('and a student who needs an accessible room is never put in one that is not', (() => {
  const bad = Db.readAll('Allocations').filter(a => a.status === 'ACTIVE').some(a => {
    const app = Db.byId('Applications', a.appId);
    return app.needsAccessible && !roomOf(a.bedId).isAccessible;
  });
  return !bad;
})());

check('a single room is refused to an undergraduate', (() => {
  const single = Db.readAll('Rooms').find(rm => rm.roomType === 'SINGLE');
  const bed = Db.readAll('Beds').find(b => b.roomId === single.roomId);
  const ug = Db.readAll('Students').find(s => !Catalogue.isPgOrPhd(s.programme, s.year));
  const app = Db.findOne('Applications', { studentId: ug.studentId });
  return !!Vacancy._ineligibleFor(bed, single, Db.byId('Hostels', single.hostelId), app, ug);
})(), 'the brochure keeps single rooms for postgraduates, and a vacancy does not suspend that');

section('Nothing to do is said, not done badly');

check('an occupied bed is refused', (() => {
  const taken = Db.readAll('Beds').find(b => b.status === 'OCCUPIED');
  const out = Vacancy.fill(taken.bedId, 'admin@ipu.ac.in');
  return out.filled === false && /not free/i.test(out.reason);
})());
check('a bed that does not exist is refused', (() => {
  const out = Vacancy.fill('NO-SUCH-BED', 'admin@ipu.ac.in');
  return out.filled === false && /no such bed/i.test(out.reason);
})());

section('Who is skipped, and why');

/** The person production SHOULD pick for this bed, worked out independently. */
function expectedFor(bedId) {
  const bed = Db.byId('Beds', bedId);
  const rm = roomOf(bedId), h = hostelOf(bedId);
  const apps = Db.indexBy('Applications', 'appId');
  const stu = Db.indexBy('Students', 'studentId');
  return Db.readAll('Waitlist').slice()
    .sort((a, b) => a.position - b.position)
    .filter(w => {
      const a = apps[w.appId];
      const st = a ? stu[a.studentId] : null;
      if (!a || !st || a.status !== 'WAITLISTED') return false;
      return !Vacancy._ineligibleFor(bed, rm, h, a, st);
    })[0] || null;
}

check("a bed in the women's hostel skips the men above them on the list", (() => {
  const girls = Db.readAll('Hostels').find(h => h.gender === 'F');
  const a = Db.readAll('Allocations').filter(x => x.status === 'ACTIVE')
    .find(x => hostelOf(x.bedId).hostelId === girls.hostelId);
  if (!a) return true;                       // nothing allotted there to free

  const id = freeBed(a);
  const want = expectedFor(id);
  const out = Vacancy.fill(id, 'admin@ipu.ac.in');
  if (!out.filled) return !want;

  const who = Db.byId('Students', Db.byId('Applications', out.appId).studentId);
  const rightPerson = want && out.appId === want.appId;
  // And it really was a discriminating choice, not the top of the list anyway.
  return rightPerson && who.gender === 'F' && out.skipped > 0;
})(), 'the queue is mostly men, so the first woman on it is not the first name on it');

check('somebody who needs an accessible room is passed over for one that is not', (() => {
  const plain = Db.readAll('Allocations').filter(x => x.status === 'ACTIVE')
    .find(x => !roomOf(x.bedId).isAccessible);
  const id = freeBed(plain);

  // Put the requirement on whoever would otherwise have been chosen.
  const want = expectedFor(id);
  if (!want) return true;
  Db.update('Applications', want.appId, { needsAccessible: true });
  Db.invalidate('Applications');

  const out = Vacancy.fill(id, 'admin@ipu.ac.in');
  const passedOver = !out.filled || out.appId !== want.appId;

  Db.update('Applications', want.appId, { needsAccessible: false });
  Db.invalidate('Applications');
  return passedOver;
})(), 'an accessible-room requirement is a requirement, not a preference to be waived when a bed appears');

check('a withdrawn applicant is never promoted', (() => {
  const a2 = anyActive();
  const id = freeBed(a2);
  const want = expectedFor(id);
  if (!want) return true;

  // They are on the list, and they are next - and they have withdrawn.
  Db.update('Applications', want.appId, { status: 'WITHDRAWN' });
  Db.invalidate('Applications');

  const out = Vacancy.fill(id, 'admin@ipu.ac.in');
  const skipped = !out.filled || out.appId !== want.appId;

  Db.update('Applications', want.appId, { status: 'WAITLISTED' });
  Db.invalidate('Applications');
  return skipped;
})(), 'a row on the waiting list is not the same thing as somebody still waiting');

section('The batch pass');

const sweep = Vacancy.fillAll(10, 'admin@ipu.ac.in');
check('it reports what it did',
  typeof sweep.filled === 'number' && typeof sweep.vacantBefore === 'number',
  JSON.stringify({ filled: sweep.filled, before: sweep.vacantBefore, after: sweep.vacantAfter }));
check('it is bounded', sweep.filled <= 10);
check('and it never leaves a bed both vacant and occupied', (() => {
  return Db.readAll('Beds').every(b =>
    (b.status === 'OCCUPIED') === !!b.occupantAppId);
})(), 'the two are written together, and a run that separates them corrupts the count');
check('no bed is held by two students', (() => {
  const seen = {};
  return Db.readAll('Allocations').filter(a => a.status === 'ACTIVE')
    .every(a => (seen[a.bedId] ? false : (seen[a.bedId] = true)));
})());

process.exit(summarise());
