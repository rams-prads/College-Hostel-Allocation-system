/**
 * Phase 2 tests - the allocation engine.
 *
 *   node tests/phase2.test.js
 *
 * These are the correctness claims we make to judges, so they are asserted
 * rather than asserted-about: no double-booked beds, no gender violation, every
 * accessibility need honoured, quotas within tolerance, and byte-for-byte
 * reproducibility from the seed.
 */
const { check, section, summarise } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();

section('Eligibility');
const elig = Eligibility.evaluateAll();
check('every application is evaluated',
  Object.keys(elig.byAppId).length === Db.readAll('Applications').length);
check('some pass, some fail', elig.eligible.length > 0 && elig.rejected.length > 0,
  elig.eligible.length + ' eligible, ' + elig.rejected.length + ' rejected');
check('every result carries reasons',
  Object.keys(elig.byAppId).every(k => elig.byAppId[k].reasons.length > 0));
check('every rejection has at least one failing reason',
  elig.rejected.every(id => elig.byAppId[id].reasons.some(r => !r.ok)));
check('every acceptance has no failing reason',
  elig.eligible.every(id => elig.byAppId[id].reasons.every(r => r.ok)));
check('reason text is human-readable, not a bare code',
  Object.keys(elig.byAppId).every(k =>
    elig.byAppId[k].reasons.every(r => typeof r.text === 'string' && r.text.length > 20)));

const distFail = elig.rejected.filter(id =>
  elig.byAppId[id].reasons.some(r => r.code === 'ELIG_FAIL_DISTANCE'));
check('the min-distance rule rejects people', distFail.length > 0, distFail.length + ' rejected on distance');
console.log('        sample: "' + elig.byAppId[distFail[0]].reasons.find(r => !r.ok).text + '"');

section('Policy snapshot');
const h1 = Policy.snapshotHash();
Policy.invalidate();
check('hash is stable across reloads', Policy.snapshotHash() === h1, h1);
check('hash is short enough to display', h1.length === 16);

section('Roommate compatibility');
const A = { sleepTime:'EARLY', wakeTime:'EARLY', studyStyle:'QUIET', cleanliness:5,
            sociability:2, foodPref:'VEG', language:'Hindi', smokingTolerance:false };
const clone = JSON.parse(JSON.stringify(A));
const opposite = { sleepTime:'LATE', wakeTime:'LATE', studyStyle:'GROUP', cleanliness:1,
                   sociability:5, foodPref:'NONVEG', language:'Tamil', smokingTolerance:true };
check('identical profiles score ~1', Roommate.score(A, clone).score > 0.99,
  Roommate.score(A, clone).score.toFixed(3));
check('opposite profiles score low', Roommate.score(A, opposite).score < 0.35,
  Roommate.score(A, opposite).score.toFixed(3));
check('scoring is symmetric',
  Math.abs(Roommate.score(A, opposite).score - Roommate.score(opposite, A).score) < 1e-9);
check('score stays in [0,1]', (() => {
  const life = Db.readAll('Lifestyle');
  for (let i = 0; i < 200; i++) {
    const s = Roommate.score(life[i % life.length], life[(i * 7 + 3) % life.length]).score;
    if (s < 0 || s > 1) return false;
  }
  return true;
})());
const smokeA = Object.assign({}, A, { smokingTolerance: true });
check('smoking mismatch penalises the score',
  Roommate.score(A, smokeA).score < Roommate.score(A, clone).score);
check('breakdown is returned for the student-facing panel',
  Object.keys(Roommate.score(A, opposite).parts).length >= 6);

const life = Db.readAll('Lifestyle');
const lifeIdx = Db.indexBy('Lifestyle', 'appId');
const sample = life.slice(0, 30).map(l => l.appId);
const grouped = Roommate.formGroups(sample, 3, lifeIdx);
check('grouping partitions everyone exactly once', (() => {
  const flat = grouped.flat();
  return flat.length === sample.length && new Set(flat).size === sample.length;
})());
check('groups respect the capacity', grouped.every(g => g.length <= 3));
const groupedMean = grouped.reduce((s, g) => s + Roommate.groupScore(g, lifeIdx), 0) / grouped.length;
const randomGroups = [];
for (let i = 0; i < sample.length; i += 3) randomGroups.push(sample.slice(i, i + 3));
const randomMean = randomGroups.reduce((s, g) => s + Roommate.groupScore(g, lifeIdx), 0) / randomGroups.length;
check('grouping beats arbitrary pairing', groupedMean > randomMean,
  'optimised ' + groupedMean.toFixed(3) + ' vs arbitrary ' + randomMean.toFixed(3));
console.log('        compatibility lift: +' + (100 * (groupedMean - randomMean)).toFixed(1) + ' points');

section('Run the allocation');
const t0 = Date.now();
const r = Allocator.run({ seed: 'GGSIPU-2026', runId: 'RUN-TEST-1' });
const ms = Date.now() - t0;
console.log('        completed in ' + ms + ' ms');
check('runs well inside the Apps Script 6-minute limit', ms < 60000, ms + ' ms');
check('produced allocations', r.allocations.length > 0, r.allocations.length + '');
check('produced a waitlist', r.waitlist.length > 0, r.waitlist.length + '');
console.log('');
console.log(Metrics.format(r.metrics).split('\n').map(l => '        ' + l).join('\n'));

section('Hard constraints - these must NEVER fail');
const roomById = Db.indexBy('Rooms', 'roomId');
const bedById = Db.indexBy('Beds', 'bedId');
const hostelById = Db.indexBy('Hostels', 'hostelId');
const appById = Db.indexBy('Applications', 'appId');
const stuById = Db.indexBy('Students', 'studentId');

const bedsUsed = r.allocations.map(a => a.bedId);
check('no bed is double-booked', new Set(bedsUsed).size === bedsUsed.length,
  (bedsUsed.length - new Set(bedsUsed).size) + ' duplicates');
check('every allocated bed exists', bedsUsed.every(b => !!bedById[b]));
check('no student is allocated twice',
  new Set(r.allocations.map(a => a.appId)).size === r.allocations.length);

const genderViolations = r.allocations.filter(a => {
  const student = stuById[appById[a.appId].studentId];
  const hostel = hostelById[roomById[a.roomId].hostelId];
  return hostel.gender !== 'CO' && hostel.gender !== student.gender;
});
check('no gender partition violation', genderViolations.length === 0,
  genderViolations.length + ' violations');

const accessViolations = r.allocations.filter(a =>
  a.candidate.needsAccessible && !roomById[a.roomId].isAccessible);
check('every accessibility requirement is honoured', accessViolations.length === 0,
  accessViolations.length + ' violations');
check('no student needing an accessible room was waitlisted',
  r.waitlist.filter(w => w.candidate.needsAccessible).length === 0);

check('allocated + waitlisted = eligible pool',
  r.allocations.length + r.waitlist.length ===
  Db.readAll('Applications').length - r.rejected.length,
  r.allocations.length + ' + ' + r.waitlist.length + ' vs ' +
  (Db.readAll('Applications').length - r.rejected.length));

check('never allocates more than allocatable capacity',
  r.allocations.length <= r.quota.allocatable,
  r.allocations.length + ' <= ' + r.quota.allocatable);

const roomOccupancy = {};
r.allocations.forEach(a => { roomOccupancy[a.roomId] = (roomOccupancy[a.roomId] || 0) + 1; });
check('no room exceeds its capacity',
  Object.keys(roomOccupancy).every(rid => roomOccupancy[rid] <= Number(roomById[rid].capacity)));

const mixedRooms = Object.keys(roomOccupancy).filter(rid => {
  const occupants = r.allocations.filter(a => a.roomId === rid);
  const genders = new Set(occupants.map(a => stuById[appById[a.appId].studentId].gender));
  return genders.size > 1;
});
check('no room mixes genders', mixedRooms.length === 0, mixedRooms.length + ' mixed rooms');

section('Quota correctness');
console.log('        plan: ' + JSON.stringify(r.quota.reserved) +
            ' reserved + ' + r.quota.open + ' open = ' + r.quota.allocatable);
const filled = {};
r.allocations.forEach(a => { filled[a.quotaUsed] = (filled[a.quotaUsed] || 0) + 1; });
console.log('        filled: ' + JSON.stringify(filled));

check('open seats are not oversubscribed', (filled.OPEN || 0) <= r.quota.open,
  (filled.OPEN || 0) + ' <= ' + r.quota.open);
Object.keys(r.quota.reserved).forEach(cat => {
  check('  ' + cat + ' quota not oversubscribed',
    (filled[cat] || 0) <= r.quota.reserved[cat],
    (filled[cat] || 0) + ' <= ' + r.quota.reserved[cat]);
});
check('reserved-category students who make open merit consume OPEN, not their quota', (() => {
  const openHolders = r.allocations.filter(a => a.quotaUsed === 'OPEN');
  return openHolders.some(a => a.candidate.category !== 'GEN');
})());
check('quota seats only go to their own category',
  r.allocations.every(a =>
    a.quotaUsed === 'OPEN' || a.quotaUsed === 'PWD_HORIZONTAL' || a.quotaUsed === 'CONVERTED' ||
    a.quotaUsed === a.candidate.category));
check('PwD horizontal seats only go to PwD students',
  r.allocations.filter(a => a.quotaUsed === 'PWD_HORIZONTAL').every(a => a.candidate.isPwD));
check('open + reserved + PwD equals allocatable (horizontal is carved, not added)',
  r.quota.open + r.quota.reservedTotal + r.quota.pwdHorizontal === r.quota.allocatable,
  r.quota.open + ' + ' + r.quota.reservedTotal + ' + ' + r.quota.pwdHorizontal +
  ' vs ' + r.quota.allocatable);

section('Dereservation - unfilled reserved seats are converted');
console.log('        converted ' + r.converted + ' unfilled reserved seats to the waiting list');
check('conversion happened', r.converted > 0, r.converted + '');
check('converted students are told so',
  r.allocations.filter(a => a.quotaUsed === 'CONVERTED')
    .every(a => (r.traces[a.appId] || []).some(t => t.code === 'SEAT_CONVERTED')));
// Merit order holds WITHIN each gender. Across genders it cannot: once the
// boys' hostels are full, a lower-ranked girl is correctly seated ahead of a
// higher-ranked boy, because no bed he could legally occupy exists.
check('conversion respects merit order within each gender', ['M', 'F'].every(g => {
  const conv = r.allocations
    .filter(a => a.quotaUsed === 'CONVERTED' && a.candidate.gender === g)
    .map(a => a.candidate.meritPosition);
  const waiting = r.waitlist
    .filter(w => w.candidate.gender === g)
    .map(w => w.candidate.meritPosition);
  if (!conv.length || !waiting.length) return true;
  return Math.max(...conv) < Math.min(...waiting);
}));
check('the waiting list is only the oversubscribed gender', (() => {
  const genders = new Set(r.waitlist.map(w => w.candidate.gender));
  return genders.size === 1;
})(), 'both genders still waiting means beds were stranded');
check('utilisation is now near-total', r.metrics.summary.utilisationPct > 97,
  r.metrics.summary.utilisationPct + '%');
// The real claim is not "zero vacant beds" - beds in the under-subscribed
// gender's hostels are unavoidable once every eligible student there is housed.
// The claim is that NOBODY WAITS while a bed they could legally occupy is free.
check('no student waits while a bed they could occupy sits empty', (() => {
  const heldPerHostel = {};
  Db.readAll('Hostels').forEach(h => {
    const n = Db.readAll('Beds').filter(b => roomById[b.roomId].hostelId === h.hostelId).length;
    heldPerHostel[h.hostelId] = Math.floor(n * 2 / 100);   // VACANCY_BUFFER_PCT
  });
  const surplus = { M: 0, F: 0 };
  Db.readAll('Hostels').forEach(h => {
    const total = Db.readAll('Beds').filter(b => roomById[b.roomId].hostelId === h.hostelId).length;
    const used = r.allocations.filter(a => roomById[a.roomId].hostelId === h.hostelId).length;
    surplus[h.gender] += total - used - heldPerHostel[h.hostelId];
  });
  const waitingGenders = new Set(r.waitlist.map(w => w.candidate.gender));
  return [...waitingGenders].every(g => surplus[g] === 0);
})(), 'a waitlisted student had an occupiable bed available');
check('the waiting list is confined to the oversubscribed gender',
  new Set(r.waitlist.map(w => w.candidate.gender)).size === 1);
check('the vacancy buffer is spread across hostels, not borne by one gender',
  r.quota.buffer > 0 && r.quota.buffer < r.quota.totalBeds * 0.05,
  r.quota.buffer + ' beds held back');

section('Merit ordering is respected');
// Nobody with a strictly lower score should be allocated while a higher-scoring
// applicant in the SAME entitlement position is waitlisted without cause.
const allocScores = r.allocations.map(a => a.candidate.score);
const waitScores = r.waitlist.map(w => w.candidate.score);
const minAlloc = Math.min(...allocScores);
const maxWait = Math.max(...waitScores);
check('waitlisted students are explained, not arbitrary',
  r.waitlist.every(w => (r.traces[w.appId] || []).some(t => t.code.indexOf('WAITLIST') === 0)));
check('every waitlisted GEN student was blocked by open-seat exhaustion',
  r.waitlist.filter(w => w.candidate.category === 'GEN')
    .every(w => (r.traces[w.appId] || []).some(t => t.code === 'WAITLIST_NO_SEAT')));
console.log('        lowest allocated score ' + minAlloc.toFixed(4) +
            ', highest waitlisted score ' + maxWait.toFixed(4));
console.log('        (overlap is expected and correct: reserved quotas admit lower scores ' +
            'once open seats run out)');
check('waitlist is ordered by merit',
  r.waitlist.every((w, i) => i === 0 || r.waitlist[i - 1].candidate.score >= w.candidate.score));
check('waitlist positions are 1..N contiguous',
  r.waitlist.every((w, i) => w.position === i + 1));
check('ETA probability decreases down the list',
  r.waitlist.every((w, i) => i === 0 || r.waitlist[i - 1].etaProbability >= w.etaProbability));
check('ETA never claims certainty', r.waitlist.every(w => w.etaProbability <= 0.98));

section('Explainability - every outcome has a reason');
check('every allocated student has a trace',
  r.allocations.every(a => (r.traces[a.appId] || []).length > 0));
check('every waitlisted student has a trace',
  r.waitlist.every(w => (r.traces[w.appId] || []).length > 0));
check('every rejected student has a trace',
  r.rejected.every(x => (r.traces[x.appId] || []).length > 0));
check('every allocated student has a merit position',
  r.allocations.every(a => (r.traces[a.appId] || []).some(t => t.code === 'MERIT_POSITION')));
check('every allocated student has a seat-entitlement reason',
  r.allocations.every(a => (r.traces[a.appId] || []).some(t => t.code.indexOf('SEAT_') === 0)));
check('students granted a ranked preference are told which',
  r.allocations.filter(a => a.prefRankMet >= 1)
    .every(a => (r.traces[a.appId] || []).some(t => t.code === 'PREF_MET')));
check('fallback assignments are disclosed as such',
  r.allocations.filter(a => a.prefRankMet === 0)
    .every(a => (r.traces[a.appId] || []).some(t => t.code === 'FALLBACK_ASSIGNED')));

const missedPref = r.allocations.find(a => a.prefRankMet > 1);
const missReason = (r.traces[missedPref.appId] || []).find(t => t.code === 'PREF_UNAVAILABLE');
check('a missed preference explains why it was missed', !!missReason);
console.log('\n        --- sample student trace ---');
(r.traces[missedPref.appId] || []).forEach(t => {
  console.log('        ' + (t.ok ? '[+]' : '[-]') + ' ' + t.text);
});

section('Efficiency claim');
check('serial dictatorship left no Pareto-improving swap', r.metrics.summary.paretoSwaps === 0,
  r.metrics.summary.paretoSwaps + ' swaps found');
console.log('        0 swaps = the allocation is Pareto-efficient over stated preferences');

section('Reproducibility - the defensibility claim');
const r2 = Allocator.run({ seed: 'GGSIPU-2026', runId: 'RUN-TEST-2' });
check('same seed reproduces the same allocation exactly',
  JSON.stringify(r.allocations.map(a => [a.appId, a.bedId, a.prefRankMet, a.quotaUsed])) ===
  JSON.stringify(r2.allocations.map(a => [a.appId, a.bedId, a.prefRankMet, a.quotaUsed])));
check('same seed reproduces the same waitlist',
  JSON.stringify(r.waitlist.map(w => [w.appId, w.position])) ===
  JSON.stringify(r2.waitlist.map(w => [w.appId, w.position])));
check('same seed reproduces the same metrics',
  JSON.stringify(r.metrics.summary) === JSON.stringify(r2.metrics.summary));

const r3 = Allocator.run({ seed: 'OTHER-SEED', runId: 'RUN-TEST-3' });
check('a different seed changes tie-breaks',
  JSON.stringify(r.allocations.map(a => a.bedId)) !==
  JSON.stringify(r3.allocations.map(a => a.bedId)));
check('but the outcome totals stay stable',
  Math.abs(r3.allocations.length - r.allocations.length) <= 2,
  r.allocations.length + ' vs ' + r3.allocations.length);

section('run() is pure - the simulator depends on this');
const bedsBefore = JSON.stringify(Db.readAll('Beds'));
const appsBefore = JSON.stringify(Db.readAll('Applications'));
Allocator.run({ seed: 'PURITY-CHECK' });
check('run() does not touch Beds', JSON.stringify(Db.readAll('Beds')) === bedsBefore);
check('run() does not touch Applications', JSON.stringify(Db.readAll('Applications')) === appsBefore);
check('run() writes no Allocations rows', Db.readAll('Allocations').length === 0);

section('Metrics');
const m = r.metrics;
check('utilisation is plausible', m.summary.utilisationPct > 90 && m.summary.utilisationPct <= 100,
  m.summary.utilisationPct + '%');
check('first-preference rate is reported', m.summary.pref1Pct > 0, m.summary.pref1Pct + '%');
check('accessibility honoured at 100%', m.summary.accessibilityHonouredPct === 100);
check('gini is in range', m.summary.giniSatisfaction >= 0 && m.summary.giniSatisfaction <= 1);
check('quota table covers every reserved category plus open and PwD',
  m.quotaTable.length === Object.keys(r.quota.reserved).length + 3);
check('capacity accounting balances',
  m.capacity.occupied + m.capacity.vacant === m.capacity.totalBeds);
check('gini of a uniform distribution is 0', Metrics.gini([1, 1, 1, 1]) < 1e-9);
check('gini of a maximally skewed distribution is high', Metrics.gini([0, 0, 0, 10]) > 0.6);

section('Commit persists everything');
const committed = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-COMMIT-1',
                                           triggeredBy: 'tester@example.com' });
check('Allocations rows written',
  Db.readAll('Allocations').length === committed.allocations.length);
check('Waitlist rows written', Db.readAll('Waitlist').length === committed.waitlist.length);
check('Runs row written', Db.readAll('Runs').length === 1);
check('beds marked OCCUPIED',
  Db.readAll('Beds').filter(b => b.status === 'OCCUPIED').length === committed.allocations.length);
check('every occupied bed names its occupant',
  Db.readAll('Beds').filter(b => b.status === 'OCCUPIED').every(b => !!b.occupantAppId));
check('application statuses updated to ALLOTTED',
  Db.readAll('Applications').filter(a => a.status === 'ALLOTTED').length === committed.allocations.length);
check('application statuses updated to WAITLISTED',
  Db.readAll('Applications').filter(a => a.status === 'WAITLISTED').length === committed.waitlist.length);
check('reason codes persisted with each allocation',
  Db.readAll('Allocations').every(a => Array.isArray(a.reasonCodes) && a.reasonCodes.length > 0));
check('merit scores written back',
  Db.readAll('Applications').filter(a => a.status === 'ALLOTTED').every(a => Number(a.meritScore) > 0));

section('Ledger records the run');
check('commit appended a ledger entry',
  Db.readAll('AuditLog').some(e => e.action === 'ALLOCATION_COMMITTED'));
check('chain still intact', Ledger.verify().intact, Ledger.verify().reason);
const entry = Db.readAll('AuditLog').filter(e => e.action === 'ALLOCATION_COMMITTED').pop();
const payload = typeof entry.payloadJson === 'string' ? JSON.parse(entry.payloadJson) : entry.payloadJson;
check('ledger entry pins the seed and policy hash', !!payload.seed && !!payload.policyHash);
console.log('        ledger: seed=' + payload.seed + ' policyHash=' + payload.policyHash +
            ' allocated=' + payload.allocated);

section('Policy changes actually change the outcome');
// The what-if simulator in Phase 5 depends on this being true.
const before = Allocator.run({ seed: 'GGSIPU-2026', runId: 'POL-A' });
Db.readAll('Policy').forEach(p => {
  if (p.category === 'weight' && p.key === 'W_DISTANCE') Db.update('Policy', p.ruleId, { value: 0.9 });
  if (p.category === 'weight' && p.key === 'W_MERIT') Db.update('Policy', p.ruleId, { value: 0.05 });
});
Policy.invalidate();
const after = Allocator.run({ seed: 'GGSIPU-2026', runId: 'POL-B' });
check('changing weights changes who gets in',
  JSON.stringify(before.allocations.map(a => a.appId).sort()) !==
  JSON.stringify(after.allocations.map(a => a.appId).sort()));
check('changing weights changes the policy hash', before.policyHash !== after.policyHash);
const moved = after.allocations.filter(a =>
  !before.allocations.some(b => b.appId === a.appId)).length;
console.log('        distance-heavy weighting moved ' + moved + ' students into allocation');

process.exit(summarise());
