/**
 * walkthrough.js - the whole system, offline, in one run.
 *
 *   node tests/walkthrough.js
 *
 * The test suites assert that the engine is correct. This one SHOWS it working:
 * it seeds a cohort, allocates it, reads back the explanation a real student
 * would see, runs a what-if simulation, and breaks the ledger on purpose to
 * watch the chain detect it.
 *
 * Nothing here touches Google. tests/stubs.js shims the Apps Script APIs and
 * swaps Db for an in-memory store; the engine source is loaded unmodified, so
 * this is the same code that runs on a real deployment.
 */
const { store } = require('./stubs');

// ANSI, matching the test suites so the output reads as one family.
const B = s => '\x1b[1m' + s + '\x1b[0m';
const G = s => '\x1b[32m' + s + '\x1b[0m';
const R = s => '\x1b[31m' + s + '\x1b[0m';
const D = s => '\x1b[90m' + s + '\x1b[0m';

function step(n, title) {
  console.log('\n' + B('=== ' + n + '. ' + title + ' ==='));
}

/** Print a reason trace the way the student portal renders it. */
function trace(reasons) {
  (reasons || []).forEach(r => {
    console.log('  ' + (r.ok ? G('+') : R('-')) + ' ' + r.text);
  });
}

// ---------------------------------------------------------------- 1. the data

step(1, 'Seed a synthetic GGSIPU cohort');

seedConfig_();
seedPolicy_();
seedAll();

console.log('  students     ' + Db.readAll('Students').length);
console.log('  applications ' + Db.readAll('Applications').length);
console.log('  hostels      ' + Db.readAll('Hostels').length +
            '   rooms ' + Db.readAll('Rooms').length +
            '   beds ' + Db.readAll('Beds').length);
console.log(D('  Generated from a fixed seed, so this cohort is identical on every machine.'));

// -------------------------------------------------------- 2. who may apply

step(2, 'Eligibility - rules that produce reasons, not a boolean');

const elig = Eligibility.evaluateAll();
console.log('  eligible ' + elig.eligible.length + '   rejected ' + elig.rejected.length);
console.log(D('  A rejection, as the applicant sees it:'));
trace(elig.byAppId[elig.rejected[0]].reasons.filter(r => !r.ok));

// ------------------------------------------------------------ 3. the run

step(3, 'Run the allocator - stages A to H');

const t0 = Date.now();
const run = Allocator.run({ seed: 'GGSIPU-2026' });
const secs = ((Date.now() - t0) / 1000).toFixed(2);

console.log('  seed        ' + run.seed);
console.log('  policyHash  ' + run.policyHash + D('   (pins the exact rules that produced this)'));
console.log('  elapsed     ' + secs + 's');
console.log('');
const m = run.metrics.summary;
console.log('  allocated ' + m.allocated + '   waitlisted ' + m.waitlisted + '   rejected ' + m.rejected);
console.log('  utilisation ' + m.utilisationPct + '%    first preference met ' + m.pref1Pct + '%');
console.log('  mean preference granted ' + m.meanPrefRank +
            '    mean roommate compatibility ' + m.meanCompatPct + '%');
console.log('  accessibility honoured ' + m.accessibilityHonouredPct + '%    Gini ' + m.giniSatisfaction);
console.log('  Pareto swaps found ' + m.paretoSwaps +
            D('   <- 0 means nobody can be made better off without hurting someone'));

// ------------------------------------------------------------ 4. the quota

step(4, 'Quota apportionment - largest remainder');

const q = run.quota;
console.log('  total beds ' + q.totalBeds + '   held back as buffer ' + q.buffer +
            '   allocatable ' + q.allocatable);
console.log('  open ' + q.open + '   reserved ' + q.reservedTotal +
            '   PwD (horizontal) ' + q.pwdHorizontal);
console.log('  by category: ' + JSON.stringify(q.reserved));
const seatSum = q.open + q.reservedTotal + q.pwdHorizontal;
console.log('  ' + (seatSum === q.allocatable ? G('open + reserved + PwD == allocatable')
                                              : R('SEAT COUNT MISMATCH')) +
            D('   (the engine cannot hand out more seats than there are beds)'));

// ----------------------------------------- 5 and 6. what a student is told

const appsIdx = Db.indexBy('Applications', 'appId');
const studIdx = Db.indexBy('Students', 'studentId');

function who(appId) {
  const a = appsIdx[appId];
  const s = a ? studIdx[a.studentId] : null;
  return s ? s.name + '  (' + s.category + ', year ' + s.year + ', ' + s.campus + ')' : appId;
}

step(5, 'An allotted student - why did I get this room?');
const got = run.allocations[40];
console.log('  ' + who(got.appId));
trace(run.traces[got.appId]);

step(6, 'A waitlisted student - the screen that decides whether they complain');
const wait = run.waitlist[0];
console.log('  ' + who(wait.appId) + '  position ' + wait.position);
trace(run.traces[wait.appId]);

// ----------------------------------------------------- 7. reproducibility

step(7, 'Reproducibility - same seed, same allocation');

function key(r) { return r.allocations.map(a => a.appId + ':' + a.bedId).join('|'); }

const again = Allocator.run({ seed: 'GGSIPU-2026' });
console.log('  ' + (key(run) === key(again) ? G('byte-identical across two independent runs')
                                            : R('RUNS DIVERGED')) +
            D('   (what makes a result defensible in an appeal months later)'));

const different = Allocator.run({ seed: 'A-DIFFERENT-SEED' });
console.log('  ' + (key(different) !== key(run) ? G('a different seed gives a different tie-break order')
                                                : R('seed had no effect')));

// -------------------------------------------------------- 8. the simulator

step(8, 'What-if simulator - change a quota, see who moves');

const sim = Simulator.simulate({
  changes: [{ category: 'reservation', key: 'PwD', value: 12 }],
  seed: 'GGSIPU-2026'
});

const chg = sim.changes[0];
console.log('  ' + chg.category + '.' + chg.key + ':  ' + chg.from + ' -> ' + chg.to);
console.log('  policy hash  ' + sim.policyHashBefore + ' -> ' + sim.policyHashAfter);
console.log('');
console.log('                    before    after');
['allocated', 'waitlisted', 'pref1Pct', 'utilisationPct'].forEach(k => {
  console.log('  ' + k.padEnd(16) + String(sim.before[k]).padStart(7) +
              String(sim.after[k]).padStart(9));
});
console.log('');
console.log('  students affected: ' + sim.movement.totalAffected +
            '   (gained ' + sim.movement.gained +
            ', lost ' + sim.movement.lost +
            ', moved ' + sim.movement.moved + ')');
sim.sample.slice(0, 5).forEach(s => {
  const from = s.from ? s.from.hostelName + ' ' + s.from.roomNo : 'waitlist';
  const to = s.to ? s.to.hostelName + ' ' + s.to.roomNo : 'waitlist';
  console.log('    ' + s.change.padEnd(7) + s.name.padEnd(22) + from + '  ->  ' + to);
});
console.log(D('  Names, not a percentage. And nothing was written - the modified policy'));
console.log(D('  existed only in memory, so a simulation cannot mark the sheet.'));

// ---------------------------------------------------------- 9. the ledger

step(9, 'Tamper-evident ledger');

Ledger.genesis();
Ledger.append('ALLOCATION_COMMITTED', { runId: run.runId, allocated: m.allocated }, 'demo@example.com');
Ledger.append('DOCUMENT_VERIFIED', { docId: 'DOC-0001' }, 'verifier@example.com');

let v = Ledger.verify();
console.log('  ' + (v.intact ? G('chain intact') : R('chain broken')) + '   ' + v.reason);

// Reach past Db and edit history the way a person with the sheet open would.
const payloadCol = schemaCols('AuditLog').indexOf('payloadJson');
const victim = 1;
const original = store.AuditLog[victim][payloadCol];
store.AuditLog[victim][payloadCol] = '{"runId":"RUN-FAKE","allocated":9999}';

v = Ledger.verify();
console.log('  ' + (v.intact ? R('TAMPER NOT DETECTED') : G('tamper detected')) + '   ' + v.reason);

store.AuditLog[victim][payloadCol] = original;
v = Ledger.verify();
console.log('  ' + (v.intact ? G('restored, chain intact again') : R('still broken')) + '   ' + v.reason);

// ------------------------------------------------------- 10. letter and QR

step(10, 'Allotment letter signature - forgery is rejected');

const allocId = 'ALC-RUN-DEMO-0001';
const sig = Letters.signature(allocId);
console.log('  allotment ' + allocId);
console.log('  signature ' + sig + D('   (HMAC-SHA256 under a key held in Script Properties)'));
console.log('  ' + (Letters.verifies(allocId, sig) ? G('genuine letter verifies')
                                                   : R('genuine letter REJECTED')));

const forged = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
console.log('  ' + (!Letters.verifies(allocId, forged) ? G('one changed character fails verification')
                                                       : R('FORGERY ACCEPTED')));
console.log('  ' + (!Letters.verifies('ALC-RUN-DEMO-0002', sig) ? G('another allotment id fails')
                                                                : R('SIGNATURE REUSED ACROSS IDS')));

const qr = QrCode.encode(Letters.verifyUrl(allocId) || ('?v=' + allocId + '~' + sig));
console.log('  QR encoded offline: version ' + qr.version + ', ' + qr.size + 'x' + qr.size +
            ' modules' + D('   (no network call, no image service)'));

// ------------------------------------------------------------------ done

console.log('\n' + B('--- end of walkthrough ---'));
console.log(D('The portal, the admin dashboard, the PDF and email need a real deployment.'));
console.log(D('See DEPLOYMENT.md. Everything above is the same code that runs there.'));
