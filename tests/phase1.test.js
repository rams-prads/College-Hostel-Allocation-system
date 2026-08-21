/**
 * Phase 1 tests - runs the real seed generator offline and validates the cohort.
 *
 *   node tests/phase1.test.js
 */
const { check, section, summarise } = require('./stubs');

section('Setup seeds');
seedConfig_();
seedPolicy_();
check('Config seeded', Db.readAll('Config').length > 0);
check('Policy seeded', Db.readAll('Policy').length > 0);

const wsum = Db.where('Policy', { category: 'weight' })
  .reduce((s, r) => s + Number(r.value), 0);
check('scoring weights sum to 1.0', Math.abs(wsum - 1) < 1e-9, 'sum=' + wsum);

const rmsum = Db.where('Policy', { category: 'roommate' })
  .reduce((s, r) => s + Number(r.value), 0);
check('roommate weights sum to 1.0', Math.abs(rmsum - 1) < 1e-9, 'sum=' + rmsum);

section('Largest-remainder apportionment');
// The whole point: parts must sum EXACTLY to the total, unlike naive rounding.
const RES = { SC: 15, ST: 7.5, OBC: 27, EWS: 10 };   // sums to 59.5%, not 100%
const q = Util.largestRemainder(103, RES);
const qsum = Object.values(q).reduce((a, b) => a + b, 0);
check('apportioned seats are integers', Object.values(q).every(Number.isInteger));
check('never over-allocates', qsum <= 103, 'sum=' + qsum);
check('reserves the correct subtotal, not the whole pool', qsum === 61,
  'sum=' + qsum + ', expected round(103 x 59.5%) = 61');
check('every category is within one seat of its exact share',
  Object.keys(RES).every(k => Math.abs(q[k] - 103 * RES[k] / 100) < 1), JSON.stringify(q));
check('zero total yields zero seats',
  Object.values(Util.largestRemainder(0, { SC: 15, ST: 7.5 })).every(v => v === 0));
check('percentages summing to 100 apportion the entire pool', (() => {
  const full = Util.largestRemainder(103, { A: 50, B: 25, C: 25 });
  return Object.values(full).reduce((a, b) => a + b, 0) === 103;
})());
check('deterministic across calls',
  JSON.stringify(Util.largestRemainder(103, RES)) === JSON.stringify(q));
console.log('        103 seats ->', JSON.stringify(q), '= ' + qsum + ' reserved, ' + (103 - qsum) + ' open');
const real = Util.largestRemainder(756, RES);
console.log('        756 beds ->', JSON.stringify(real), '= ' +
  Object.values(real).reduce((a, b) => a + b, 0) + ' reserved');

section('Seeded RNG determinism');
const a = Util.rng('GGSIPU-2026'), b = Util.rng('GGSIPU-2026'), c = Util.rng('other');
const seqA = [a(), a(), a(), a(), a()];
const seqB = [b(), b(), b(), b(), b()];
const seqC = [c(), c(), c(), c(), c()];
check('same seed gives identical sequence', JSON.stringify(seqA) === JSON.stringify(seqB));
check('different seed gives different sequence', JSON.stringify(seqA) !== JSON.stringify(seqC));
check('values stay in [0,1)', seqA.every(x => x >= 0 && x < 1));

section('Geography');
const delhi = Geo.haversine(28.6139, 77.2090, 28.5921, 77.0460);
check('Delhi-to-Dwarka distance is plausible', delhi > 5 && delhi < 25, delhi.toFixed(1) + ' km');
const blr = Geo.haversine(12.9716, 77.5946, 28.5921, 77.0460);
check('Bengaluru-to-Delhi distance is plausible', blr > 1600 && blr < 1800, blr.toFixed(0) + ' km');
check('zero distance to self', Geo.haversine(28.6, 77.2, 28.6, 77.2) < 0.001);

section('Seed the cohort');
const t0 = Date.now();
const s = seedAll();
const elapsed = Date.now() - t0;
console.log('        generated in ' + elapsed + ' ms');
check('generation is fast enough for Apps Script', elapsed < 20000, elapsed + ' ms');
check('pincode table written', s.pincodePrefixes > 100, s.pincodePrefixes + ' prefixes');
check('hostels created', s.hostels === 6, s.hostels + '');
check('students created', s.students === 900, s.students + '');
console.log('        ' + s.beds + ' beds / ' + s.rooms + ' rooms / ' + s.hostels + ' hostels');
console.log('        beds by gender: ' + JSON.stringify(s.bedsByGender));
console.log('        applicants by gender: ' + JSON.stringify(s.applicantsByGender));

section('Referential integrity');
const students = Db.readAll('Students');
const apps = Db.readAll('Applications');
const prefs = Db.readAll('Preferences');
const life = Db.readAll('Lifestyle');
const rooms = Db.readAll('Rooms');
const beds = Db.readAll('Beds');
const hostels = Db.indexBy('Hostels', 'hostelId');
const roomById = Db.indexBy('Rooms', 'roomId');
const stuById = Db.indexBy('Students', 'studentId');
const appById = Db.indexBy('Applications', 'appId');

check('one application per student', apps.length === students.length);
check('one lifestyle profile per application', life.length === apps.length);
check('unique student IDs', new Set(students.map(x => x.studentId)).size === students.length);
check('unique application IDs', new Set(apps.map(x => x.appId)).size === apps.length);
check('unique bed IDs', new Set(beds.map(x => x.bedId)).size === beds.length);
check('every application points at a real student',
  apps.every(a => !!stuById[a.studentId]));
check('every bed belongs to a real room', beds.every(b => !!roomById[b.roomId]));
check('every room belongs to a real hostel', rooms.every(r => !!hostels[r.hostelId]));
check('every preference points at a real application', prefs.every(p => !!appById[p.appId]));

const capSum = rooms.reduce((t, r) => t + Number(r.capacity), 0);
check('bed count equals sum of room capacity', beds.length === capSum, beds.length + ' vs ' + capSum);
check('all beds start VACANT', beds.every(b => b.status === 'VACANT'));

section('Hard constraints in the input data');
// If seed data violates the gender partition, the allocator is broken before it starts.
const crossGender = prefs.filter(p => {
  const st = stuById[appById[p.appId].studentId];
  return hostels[p.hostelId].gender !== st.gender;
});
check('no preference crosses the gender partition', crossGender.length === 0, crossGender.length + ' violations');

const badRank = prefs.filter(p => p.rank < 1 || p.rank > Number(Db.cfg('MAX_PREFERENCES', 5)));
check('preference ranks are within bounds', badRank.length === 0);

const byApp = Db.groupBy('Preferences', 'appId');
const dupRank = Object.keys(byApp).filter(k => {
  const rs = byApp[k].map(p => p.rank);
  return new Set(rs).size !== rs.length;
});
check('no duplicate ranks within an application', dupRank.length === 0, dupRank.length + ' apps affected');

const dupChoice = Object.keys(byApp).filter(k => {
  const cs = byApp[k].map(p => p.hostelId + '|' + p.roomType);
  return new Set(cs).size !== cs.length;
});
check('no repeated choice within an application', dupChoice.length === 0, dupChoice.length + ' apps affected');

section('Accessibility');
const accessibleBeds = beds.filter(b => roomById[b.roomId].isAccessible);
const needAcc = apps.filter(a => a.needsAccessible);
check('accessible stock exists', accessibleBeds.length > 0, accessibleBeds.length + ' beds');
check('accessible beds cover accessible demand',
  accessibleBeds.length >= needAcc.length,
  accessibleBeds.length + ' beds vs ' + needAcc.length + ' applicants');
check('accessible rooms are ground floor',
  rooms.filter(r => r.isAccessible).every(r => Number(r.floor) === 1));
check('only PwD applicants are flagged accessible',
  needAcc.every(a => stuById[a.studentId].isPwD));

section('Demo properties (deliberate, not accidental)');
check('beds are scarcer than applicants', beds.length < apps.length,
  beds.length + ' beds for ' + apps.length + ' applicants');
const ineligible = apps.filter(a => !a.eligible);
check('some applicants fail eligibility', ineligible.length > 0, ineligible.length + ' rejected');
check('most applicants pass eligibility', ineligible.length < apps.length * 0.25,
  (100 * ineligible.length / apps.length).toFixed(1) + '% rejected');
const nearby = apps.filter(a => Number(a.distanceKm) < 30);
check('the min-distance rule actually bites', nearby.length > 0, nearby.length + ' applicants within 30 km');
check('every home PIN resolved', apps.every(a => Number(a.distanceKm) >= 0));

section('Distribution sanity');
function tally(arr, fn) {
  const t = {};
  arr.forEach(x => { const k = fn(x); t[k] = (t[k] || 0) + 1; });
  return t;
}
const g = tally(students, x => x.gender);
const prog = tally(students, x => x.programme);
const cat = tally(students, x => x.category);
const pwd = students.filter(x => x.isPwD).length;

check('gender split is roughly 58/42', Math.abs(g.M / students.length - 0.58) < 0.05,
  JSON.stringify(g));
check('BTech is the largest programme',
  Object.keys(prog).every(k => prog[k] <= prog.BTech), JSON.stringify(prog));
check('all five categories present', Object.keys(cat).length === 5, JSON.stringify(cat));
check('PwD share is roughly 3%', pwd / students.length > 0.01 && pwd / students.length < 0.06,
  (100 * pwd / students.length).toFixed(1) + '%');
check('CGPA stays in range', students.every(x => x.cgpa >= 4 && x.cgpa <= 10));
check('merit ranks are a permutation of 1..N',
  new Set(students.map(x => x.meritRank)).size === students.length &&
  Math.max(...students.map(x => x.meritRank)) === students.length);
check('merit rank agrees with CGPA order', (() => {
  const sorted = students.slice().sort((x, y) => x.meritRank - y.meritRank);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].cgpa > sorted[i - 1].cgpa) return false;
  return true;
})());

const life0 = Db.readAll('Lifestyle');
const lateSleepers = life0.filter(l => l.sleepTime === 'LATE');
const lateAndEarlyRise = lateSleepers.filter(l => l.wakeTime === 'EARLY').length;
check('sleep and wake times are correlated, not independent',
  lateAndEarlyRise / Math.max(lateSleepers.length, 1) < 0.15,
  (100 * lateAndEarlyRise / Math.max(lateSleepers.length, 1)).toFixed(1) + '% of late sleepers rise early');

section('Reproducibility');
const snapshot = JSON.stringify(Db.readAll('Students').slice(0, 25));
seedAll();
check('re-seeding with the same seed reproduces the cohort byte-for-byte',
  JSON.stringify(Db.readAll('Students').slice(0, 25)) === snapshot);
seedAll({ seed: 'DIFFERENT-SEED' });
check('a different seed produces a different cohort',
  JSON.stringify(Db.readAll('Students').slice(0, 25)) !== snapshot);
seedAll();   // restore canonical cohort

section('Ledger recorded the seeding');
const led = Db.readAll('AuditLog');
check('seeding wrote ledger entries', led.length > 0, led.length + ' entries');
check('chain is intact after seeding', Ledger.verify().intact, Ledger.verify().reason);

process.exit(summarise());
