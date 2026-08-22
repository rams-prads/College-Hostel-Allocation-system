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
  // A template that throws while evaluating produces an EMPTY frame, not an
  // error message - the exception dies inside the sandboxed iframe and the user
  // sees a blank page with nothing to act on. Catching it here turns every
  // server-side failure into something readable.
  try {
    return route_(e);
  } catch (err) {
    return errorPage_(err, e);
  }
}

function route_(e) {
  var page = (e && e.parameter && e.parameter.page) || 'home';

  // Self-diagnosis, deliberately free of includes, templates and client script,
  // so it renders even when everything else is broken.
  if (page === 'diag') return diagnosticPage_(e);

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

  // A signed read-only link stands in for a session the platform will not give
  // us for a visitor outside the owner's domain. Checked BEFORE the sign-in
  // wall, since the whole point is that this visitor cannot pass it.
  if (params.demo && !session.email) {
    if (Auth.checkDemoToken(params.demo)) {
      return render_('ui/student', 'My Hostel Application',
        { session: session, demoToken: params.demo });
    }
    return render_('ui/index', 'Hostel Portal', {
      session: session, needsLogin: true,
      authError: 'That demo link is not valid, has expired, or demo links are switched off.'
    });
  }

  // No server-side sign-in gate any more.
  //
  // A visitor signed in with an email code holds their session in the browser,
  // and doGet cannot see it - the token arrives on the API call, not the page
  // request. Gating here would have bounced every first-year applicant to a
  // sign-in page they had already passed.
  //
  // Nothing is weakened by this: the page is only chrome. Every function behind
  // it resolves the caller through Auth.session() and enforces its own access,
  // which is where enforcement belonged all along.

  if (page === 'admin') {
    // Only refuse outright when Google DID identify the visitor and they are
    // definitely not an administrator. Otherwise render, and let the dashboard's
    // first call - which is guarded server-side - decide.
    if (session.email && !session.isAdmin) return accessDenied_(session);
    return render_('ui/admin', 'Admin Dashboard', { session: session });
  }
  if (page === 'apply')  return render_('ui/apply',   'Hostel Application', { session: session });
  if (params.demo)       return render_('ui/student', 'My Hostel Application',
                                        { session: session, demoToken: params.demo });

  return render_('ui/student', 'My Hostel Application', { session: session });
}

/** A server-side failure, rendered so it can be read and reported. */
function errorPage_(err, e) {
  var page = (e && e.parameter && e.parameter.page) || 'home';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;' +
    'margin:44px auto;padding:0 20px;color:#121c2e;line-height:1.55">' +
    '<h2 style="margin:0 0 6px;color:#a52222">This page could not be built</h2>' +
    '<p style="color:#6b7a90;margin:0 0 18px">The server hit an error while preparing the ' +
    '<strong>' + page + '</strong> page.</p>' +
    '<pre style="background:#f6f8fb;border:1px solid #dde4ed;border-radius:8px;padding:14px;' +
    'font-size:12.5px;overflow-x:auto;white-space:pre-wrap">' +
    String(err && err.message ? err.message : err) +
    (err && err.stack ? '\n\n' + err.stack : '') + '</pre>' +
    '<p style="font-size:13.5px">Open <strong>?page=diag</strong> on this same address for a ' +
    'full check of the deployment.</p></div>'
  ).setTitle('Error');
}

/**
 * Deployment self-check. No includes, no templates, no client script - so it
 * still renders when the thing that breaks the other pages is one of those.
 */
function diagnosticPage_(e) {
  var lines = [];
  function row(k, v, ok) {
    lines.push('<tr><td style="padding:6px 14px 6px 0;color:#6b7a90;white-space:nowrap">' + k +
      '</td><td style="padding:6px 0;font-weight:600' +
      (ok === false ? ';color:#a52222' : (ok === true ? ';color:#0f7a4d' : '')) + '">' + v +
      '</td></tr>');
  }

  var url = '';
  try { url = ScriptApp.getService().getUrl() || '(none)'; } catch (err) { url = 'ERROR: ' + err.message; }
  row('Web app URL from the server', url, url.indexOf('http') === 0);
  row('This request arrived as', JSON.stringify((e && e.parameter) || {}));

  var email = '';
  try { email = Session.getActiveUser().getEmail() || '(not detected)'; }
  catch (err) { email = 'ERROR: ' + err.message; }
  row('Signed in as (active user)', email, email.indexOf('@') > 0);

  // The decisive pair. Under "Execute as: me" the EFFECTIVE user is always the
  // owner. If that resolves but the ACTIVE user is blank, the script is running
  // fine and simply cannot see who the visitor is - which means the deployment
  // is set to "Anyone, even anonymous", or the visitor's Google account sits
  // outside the owner's domain. Neither is a code fault, and without this row
  // both look like a broken page.
  var effective = '';
  try { effective = Session.getEffectiveUser().getEmail() || '(not detected)'; }
  catch (err) { effective = 'ERROR: ' + err.message; }
  row('Running as (effective user)', effective, effective.indexOf('@') > 0);

  if (email.indexOf('@') < 0 && effective.indexOf('@') > 0) {
    var ownerDomain = effective.split('@')[1] || '';
    var personal = ownerDomain === 'gmail.com' || ownerDomain === 'googlemail.com';

    row('Diagnosis', personal
      ? 'This project is owned by a PERSONAL Google account (' + effective + '). ' +
        'Google will not reveal a visitor\'s address to a web app running as its ' +
        'owner unless the visitor is that owner, or is on the same Workspace domain. ' +
        'Everyone else lands back on the sign-in page no matter how often they sign ' +
        'in. Changing the deployment settings does NOT fix this. The project has to ' +
        'be owned by an account on the students\' own domain.'
      : 'Signed-out, or signing in from outside <strong>' + ownerDomain + '</strong>. ' +
        'Only addresses on that domain can be recognised. Also check the deployment\'s ' +
        '"Who has access" is <strong>Anyone with a Google account</strong> and that you ' +
        'deployed a NEW VERSION after the last change.', false);

    if (!personal) {
      row('Try', 'Sign in with an address ending @' + ownerDomain);
    }
  }

  var s = null;
  try { s = Auth.session(); row('Administrator', s.isAdmin ? 'yes (' + s.role + ')' : 'no', s.isAdmin); }
  catch (err) { row('Administrator', 'ERROR: ' + err.message, false); }
  try { row('Student record', s && s.student ? s.student.name : 'none linked to this address'); }
  catch (err) { row('Student record', 'ERROR: ' + err.message, false); }

  // Can each interface file actually be read?
  ['ui/styles', 'ui/chrome', 'ui/index', 'ui/student', 'ui/apply', 'ui/admin', 'ui/verify']
    .forEach(function (f) {
      try {
        var n = HtmlService.createHtmlOutputFromFile(f).getContent().length;
        row('File ' + f, n + ' bytes', n > 0);
      } catch (err) {
        row('File ' + f, 'MISSING or unreadable: ' + err.message, false);
      }
    });

  // Can each page template actually be evaluated?
  [['ui/student', 'Student portal'], ['ui/apply', 'Application form'],
   ['ui/admin', 'Admin dashboard'], ['ui/verify', 'Verification page']]
    .forEach(function (pair) {
      try {
        var t = HtmlService.createTemplateFromFile(pair[0]);
        t.session = s; t.params = {};
        var out = t.evaluate().getContent();
        row('Renders: ' + pair[1], out.length + ' bytes', out.length > 500);
      } catch (err) {
        row('Renders: ' + pair[1], 'FAILS: ' + err.message, false);
      }
    });

  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;' +
    'margin:40px auto;padding:0 20px;color:#121c2e;line-height:1.5">' +
    '<h2 style="margin:0 0 4px">Deployment check</h2>' +
    '<p style="color:#6b7a90;margin:0 0 20px;font-size:14px">Everything the portal needs in ' +
    'order to render a page. Anything in red is the problem.</p>' +
    '<table style="border-collapse:collapse;font-size:13.5px;width:100%">' + lines.join('') +
    '</table>' +
    '<p style="font-size:13px;color:#6b7a90;margin-top:22px">If the web app URL above does not ' +
    'match the address in your browser, your deployment is serving an older version of the ' +
    'code. In the Apps Script editor choose <strong>Deploy &rsaquo; Manage deployments</strong>, ' +
    'edit the deployment, set <strong>Version: New version</strong> and deploy again.</p></div>'
  ).setTitle('Deployment check');
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

/**
 * Absolute URL of this web app, used in emails, QR codes and every internal
 * link.
 *
 * NEVER allowed to throw. It is called from inside page templates, and a
 * template that throws renders an empty frame rather than an error - which is
 * indistinguishable, from the outside, from the page simply not working.
 */
function webAppUrl() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
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
