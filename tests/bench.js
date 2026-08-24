/**
 * Where the time goes.
 *
 *   node tests/bench.js
 *
 * Not a test - a measurement. It runs the calls a page actually makes against a
 * full cohort and prints how long each takes, because "it feels slow" is not
 * something you can fix and "apiAdminVerificationQueue: 4.8s" is.
 *
 * The in-memory Db here is faster than a real spreadsheet, so these numbers are
 * a FLOOR. What they measure accurately is the shape: an O(n^2) call stays
 * O(n^2) whatever the storage underneath it.
 */
const { section } = require('./stubs');

seedConfig_();
seedPolicy_();
seedAll();

const ADMIN = 'admin@ipu.ac.in';
Db.append('Admins', { email: ADMIN, name: 'Hostel Admin', role: 'SUPER_ADMIN',
                      campus: 'ALL', active: true });
Db.invalidate('Admins');
global.Session = { getActiveUser: () => ({ getEmail: () => ADMIN }) };
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://x/exec' }) };

// A cohort with documents on it, which is what makes the scans expensive.
const apps = Db.readAll('Applications');
apps.slice(0, 120).forEach((a, i) => {
  const st = Db.byId('Students', a.studentId);
  Documents.provision(a.appId, st);
  Db.invalidate('Documents');
  Db.where('Documents', { appId: a.appId }).forEach((d, n) => {
    Db.update('Documents', d.docId, {
      status: 'UPLOADED', driveFileId: 'f' + i + '-' + n, fileName: 'scan.jpg',
      contentHash: 'h' + i + '-' + n, scanVerdict: 'MATCH',
      scanJson: { findings: [], detail: { nameScore: 1 } }
    });
  });
});
Db.invalidate('Documents');
Db.invalidate('Applications');

console.log('cohort: ' + apps.length + ' applications, ' +
            Db.readAll('Students').length + ' students, ' +
            Db.readAll('Documents').length + ' documents\n');

function time(label, fn, runs) {
  runs = runs || 1;
  const t0 = Date.now();
  let out;
  for (let i = 0; i < runs; i++) out = fn();
  const ms = (Date.now() - t0) / runs;
  console.log('  ' + String(Math.round(ms)).padStart(6) + ' ms   ' + label);
  return out;
}

section('What the verification tab does when it opens');
time('apiAdminVerificationStats()', () => apiAdminVerificationStats());
const q = time('apiAdminVerificationQueue()  [the filter buttons]',
  () => apiAdminVerificationQueue({ filter: 'NEEDS_DECISION', limit: 200 }));
time('apiAdminVerificationQueue({filter:ALL})',
  () => apiAdminVerificationQueue({ filter: 'ALL', limit: 200 }));
if (q.rows.length) {
  time('apiAdminVerificationCase()   [opening one]',
    () => apiAdminVerificationCase(q.rows[0].appId));
}

section('The pieces underneath');
time('Identity.screen() x1', () => Identity.screen(apps[0].appId));
time('Identity.screen() x200', () => {
  for (let i = 0; i < 200; i++) Identity.screen(apps[i].appId);
});
time('Documents.outstanding() x200', () => {
  for (let i = 0; i < 200; i++) {
    Documents.outstanding(apps[i].appId, Db.byId('Students', apps[i].studentId));
  }
});

// These two will look identical here and are not identical on Google. The
// in-memory Db has no per-call read cost; a real Apps Script call re-opens the
// spreadsheet and re-reads every tab it touches, because the per-execution
// cache dies with the execution. This section is a reminder of a cost this
// harness cannot show, not a measurement of one.
section('Round trips - a cost this harness cannot measure');
time('opening the tab: queue + stats separately', () => {
  apiAdminVerificationStats();
  return apiAdminVerificationQueue({ filter: 'NEEDS_DECISION', limit: 200 });
});
time('opening the tab: one call carrying both', () =>
  apiAdminVerificationQueue({ filter: 'NEEDS_DECISION', limit: 200, withStats: true }));

section('The other screens');
time('apiAdminOverview()', () => apiAdminOverview());
time('apiAdminWaitlist()', () => apiAdminWaitlist({ page: 1, pageSize: 25 }));
time('apiAdminDocQueue()', () => apiAdminDocQueue(200));
time('apiGetStudentView()  [one student]', () => {
  const st = Db.byId('Students', apps[0].studentId);
  global.Session = { getActiveUser: () => ({ getEmail: () => st.email }) };
  const v = apiGetStudentView(null, '');
  global.Session = { getActiveUser: () => ({ getEmail: () => ADMIN }) };
  return v;
});

section('The pieces underneath, batched and not');
time('Identity.screen() x200, each building its own index', () => {
  for (let i = 0; i < 200; i++) Identity.screen(apps[i].appId);
});
time('Identity.screen() x200 sharing one index', () => {
  const ctx = Identity.buildContext();
  for (let i = 0; i < 200; i++) Identity.screen(apps[i].appId, ctx);
});
time('Documents.outstanding() x200, re-reading each time', () => {
  for (let i = 0; i < 200; i++) {
    Documents.outstanding(apps[i].appId, Db.byId('Students', apps[i].studentId));
  }
});
time('Documents.outstanding() x200 with the rows in hand', () => {
  const byApp = Db.groupBy('Documents', 'appId');
  const stu = Db.indexBy('Students', 'studentId');
  for (let i = 0; i < 200; i++) {
    Documents.outstanding(apps[i].appId, stu[apps[i].studentId],
      { app: apps[i], docs: byApp[apps[i].appId] || [] });
  }
});

section('The heavy end');
time('Allocator.run()  [the whole cohort]',
  () => Allocator.run({ seed: 'BENCH', mode: 'DRAFT' }));
time('Grievance.inbox(50)', () => Grievance.inbox(null, 50));
time('Verification.stats()', () => Verification.stats());
time('Eligibility.evaluateAll()', () => Eligibility.evaluateAll());

console.log('');
