/**
 * Main.gs - web app router and spreadsheet menu.
 *
 * Phase 0 ships the skeleton only. Track B fleshes out the page handlers in
 * Phase 3; the routing table below is the contract they build against.
 */

/** Custom menu so the admin team never has to open the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Hostel System')
    .addItem('1. Create database', 'createDatabase')
    .addItem('2. Seed demo data', 'seedDemoDataFromMenu')
    .addSeparator()
    .addItem('Run allocation', 'runAllocationFromMenu')
    .addItem('Prepare demo scenario', 'prepareDemoFromMenu')
    .addItem('Generate demo letters only', 'generateCastLettersFromMenu')
    .addItem('Verify ledger integrity', 'showLedgerStatus')
    .addSeparator()
    .addItem('Run pre-demo dry run', 'runDryRun')
    .addSeparator()
    .addItem('Add me as administrator', 'addMeAsAdmin')
    .addItem('Who am I?', 'showWhoAmI')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Diagnostics')
      .addItem('Verify Phase 0 (foundation)', 'showPhase0Report')
      .addItem('Verify Phase 1 (demo data)', 'showPhase1Report')
      .addItem('Describe cohort', 'showCohortReport')
      .addItem('Show demo cast', 'showDemoCast')
      .addItem('QR diagnostics', 'showQrDiagnostics'))
    .addToUi();
}

/**
 * Web app entry point.
 * Routes: (default) student portal | apply | admin | verify
 */
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'home';
  var session = Auth.session();

  // The QR verification page is deliberately public - a warden at the gate
  // must be able to scan a letter without logging in.
  //
  // ?v=<allocId>~<sig> is the compact form the QR carries. The older
  // ?page=verify&id=&sig= form still works, so letters printed before the
  // change keep verifying.
  var params = (e && e.parameter) || {};
  if (params.v) {
    var parsed = Letters.parseToken(params.v);
    if (parsed) { params.id = parsed.allocId; params.sig = parsed.sig; }
    page = 'verify';
  }
  if (page === 'verify') return render_('ui/verify', 'Verify Allotment', { params: params });

  if (!session.email) return render_('ui/index', 'Hostel Portal', { session: session, needsLogin: true });

  if (page === 'admin') {
    if (!session.isAdmin) return accessDenied_(session);
    return render_('ui/admin', 'Admin Dashboard', { session: session });
  }
  if (page === 'apply')  return render_('ui/apply',   'Hostel Application', { session: session });

  return render_('ui/student', 'My Hostel Application', { session: session });
}

/** Render a template with data bound to it. */
function render_(file, title, data) {
  var t = HtmlService.createTemplateFromFile(file);
  Object.keys(data || {}).forEach(function (k) { t[k] = data[k]; });
  return t.evaluate()
    .setTitle(title + ' | GGSIPU Hostels')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Include partials from templates: <?!= include('ui/styles'); ?> */
function include(file) {
  return HtmlService.createHtmlOutputFromFile(file).getContent();
}

/**
 * A refusal that explains itself. The usual cause is a mismatch between the
 * account the browser is signed into and the address in the Admins tab -
 * telling the reader which address was actually seen turns a dead end into a
 * one-line fix.
 */
function accessDenied_(session) {
  var known = Db.readAll('Admins')
    .filter(function (a) { return a.active; })
    .map(function (a) { return a.email; });

  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;' +
    'margin:48px auto;padding:0 20px;color:#16191d;line-height:1.55">' +
    '<h2 style="margin:0 0 8px">Access denied</h2>' +
    '<p style="color:#5b636e">This page is for hostel administrators.</p>' +
    '<div style="background:#f1f3f6;border-radius:8px;padding:14px 16px;margin:18px 0;font-size:14px">' +
      '<div>You are signed in as <strong>' + (session.email || '(not detected)') + '</strong></div>' +
      '<div style="margin-top:6px;color:#5b636e">Administrators on record: ' +
        (known.length ? known.join(', ') : 'none') + '</div>' +
    '</div>' +
    '<p style="font-size:14px">If that address should be an administrator, open the spreadsheet and ' +
    'choose <strong>Hostel System &rsaquo; Add me as administrator</strong>, then reload this page.</p>' +
    '<p style="font-size:14px;color:#5b636e">If you are signed into more than one Google account, ' +
    'this page may be using a different one than you expect. Try it in a private window.</p>' +
    '<p style="margin-top:22px"><a href="?" style="color:#1f3864">Go to the student portal</a></p>' +
    '</div>'
  ).setTitle('Access denied');
}

function htmlMessage_(title, body) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,sans-serif;padding:48px;text-align:center">' +
    '<h2>' + title + '</h2><p>' + body + '</p></div>'
  ).setTitle(title);
}

/** Absolute URL of this web app - used in emails and QR codes. */
function webAppUrl() {
  return ScriptApp.getService().getUrl();
}

// ------------------------------------------------------------- menu callbacks

function showPhase0Report() {
  SpreadsheetApp.getUi().alert('Phase 0 verification', verifyPhase0(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function showPhase1Report() {
  SpreadsheetApp.getUi().alert('Phase 1 verification', verifyPhase1(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function showCohortReport() {
  var r = describeCohort();
  var lines = [
    'Students: ' + r.students + '    Beds: ' + r.beds,
    'By gender: ' + JSON.stringify(r.byGender),
    'Beds by gender: ' + JSON.stringify(r.bedsByGender),
    'By programme: ' + JSON.stringify(r.byProgramme),
    'By category: ' + JSON.stringify(r.byCategory),
    'PwD: ' + r.pwd + '  (needing accessible rooms: ' + r.needsAccessible + ')',
    'Failing eligibility: ' + r.ineligible,
    '',
    'Top home states:',
    r.topStates.map(function (s) { return '  ' + s[0] + ': ' + s[1]; }).join('\n')
  ].join('\n');
  SpreadsheetApp.getUi().alert('Cohort profile', lines, SpreadsheetApp.getUi().ButtonSet.OK);
}

function addMeAsAdmin() {
  var res = Auth.selfEnrolAdmin();
  SpreadsheetApp.getUi().alert('Administrator ' + res.action,
    res.email + ' is now a SUPER_ADMIN for all campuses.\n\n' +
    'Reload the web app and open ?page=admin.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Diagnostic: exactly what the system thinks you are. */
function showWhoAmI() {
  var s = Auth.session();
  var lines = [
    'Google account: ' + (s.email || '(not detected)'),
    'Administrator:  ' + (s.isAdmin ? 'yes (' + s.role + ', ' + s.campus + ')' : 'no'),
    'Student record: ' + (s.student ? s.student.name + ' (' + s.student.studentId + ')' : 'none'),
    'Application:    ' + (s.application ? s.application.appId + ' - ' + s.application.status : 'none'),
    '',
    'Web app URL:',
    webAppUrl() || '(not deployed yet)',
    '',
    'Administrators on record:',
    Db.readAll('Admins').map(function (a) {
      return '  ' + a.email + '  ' + a.role + (a.active ? '' : '  [INACTIVE]');
    }).join('\n') || '  none'
  ];
  SpreadsheetApp.getUi().alert('Who am I?', lines.join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function showDemoCast() {
  SpreadsheetApp.getUi().alert('Demo cast', DemoScenario.brief(),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function showLedgerStatus() {
  var v = Ledger.verify();
  SpreadsheetApp.getUi().alert(
    v.intact ? 'Ledger intact' : 'LEDGER TAMPERED',
    v.reason + '\n\nEntries: ' + v.length,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
