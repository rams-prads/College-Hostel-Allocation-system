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
    .addItem('2. Seed demo data', 'seedAll')
    .addSeparator()
    .addItem('Run allocation', 'runAllocationFromMenu')
    .addItem('Verify ledger integrity', 'showLedgerStatus')
    .addSeparator()
    .addItem('Verify Phase 0 setup', 'showPhase0Report')
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
  if (page === 'verify') return render_('ui/verify', 'Verify Allotment', { params: e.parameter });

  if (!session.email) return render_('ui/index', 'Hostel Portal', { session: session, needsLogin: true });

  if (page === 'admin') {
    if (!session.isAdmin) return htmlMessage_('Access denied', 'This page is for hostel administrators only.');
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

function showLedgerStatus() {
  var v = Ledger.verify();
  SpreadsheetApp.getUi().alert(
    v.intact ? 'Ledger intact' : 'LEDGER TAMPERED',
    v.reason + '\n\nEntries: ' + v.length,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
