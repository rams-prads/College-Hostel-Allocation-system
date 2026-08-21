/**
 * Setup.gs - one-click database creation.
 *
 * Run createDatabase() once from the Apps Script editor (or the custom menu).
 * It builds all 18 tabs from SCHEMA, applies validation and formatting, seeds
 * Config and Policy with sane GGSIPU defaults, and writes the genesis ledger row.
 *
 * Safe to re-run: existing tabs are left alone unless you pass {force: true}.
 */

/** Entry point. */
function createDatabase(opts) {
  opts = opts || {};
  var ss = Db.ss();
  var created = [], skipped = [];

  SHEET_ORDER.forEach(function (tab, i) {
    var existing = ss.getSheetByName(tab);
    if (existing && !opts.force) { skipped.push(tab); return; }
    if (existing && opts.force) ss.deleteSheet(existing);
    buildSheet_(ss, tab, i);
    created.push(tab);
  });

  // Remove the default "Sheet1" if it is still empty.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  Db.invalidate();
  seedConfig_();
  seedPolicy_();
  seedAdmins_();
  Ledger.genesis();

  var msg = 'Created: ' + (created.length ? created.join(', ') : 'none') +
            '\nSkipped (already existed): ' + (skipped.length ? skipped.join(', ') : 'none');
  Logger.log(msg);
  return { created: created, skipped: skipped, message: msg };
}

/** Nuke and rebuild. Destructive - confirm before calling. */
function resetDatabase() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  return createDatabase({ force: true });
}

// -------------------------------------------------------------------- builders

function buildSheet_(ss, tab, position) {
  var spec = SCHEMA[tab];
  var cols = spec.cols;
  var sh = ss.insertSheet(tab, position);

  // Header row.
  var headers = cols.map(function (c) { return c.name; });
  var hdr = sh.getRange(1, 1, 1, headers.length);
  hdr.setValues([headers]);
  hdr.setFontWeight('bold')
     .setBackground('#1f3864')
     .setFontColor('#ffffff')
     .setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);

  // Header note carries the schema description - self-documenting for the admin team.
  sh.getRange(1, 1).setNote(spec.desc + '\n\nPrimary key: ' + (spec.pk || '(none)'));

  // Per-column validation and formatting.
  cols.forEach(function (col, i) {
    var c = i + 1;
    var body = sh.getRange(2, c, Math.max(sh.getMaxRows() - 1, 1), 1);

    if (col.type === T.ENUM && col.values) {
      body.setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(col.values, true)
          .setAllowInvalid(false)
          .setHelpText(col.name + ' must be one of: ' + col.values.join(', '))
          .build()
      );
    } else if (col.type === T.BOOL) {
      body.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    } else if (col.type === T.DATE) {
      body.setNumberFormat('yyyy-mm-dd hh:mm');
    } else if (col.type === T.NUM) {
      body.setNumberFormat('0.00##');
    } else if (col.type === T.INT) {
      body.setNumberFormat('0');
    }

    sh.setColumnWidth(c, columnWidth_(col));
  });

  // The ledger is machine-written only - make that visually obvious.
  if (tab === 'AuditLog') {
    sh.getRange(1, 1, 1, cols.length).setBackground('#7f1d1d');
    sh.getRange(1, 1).setNote(spec.desc + '\n\nDO NOT EDIT BY HAND. Any manual change breaks the hash chain and will be detected by Ledger.verify().');
  }

  return sh;
}

function columnWidth_(col) {
  if (col.type === T.JSON) return 260;
  if (col.type === T.DATE) return 140;
  if (col.type === T.BOOL) return 80;
  if (col.name === 'text' || col.name === 'notes' || col.name === 'resolution') return 300;
  if (col.name === 'hash' || col.name === 'prevHash') return 200;
  if (col.name === 'email' || col.name === 'toEmail' || col.name === 'name') return 180;
  return 120;
}

// ----------------------------------------------------------------------- seeds

function seedConfig_() {
  if (Db.readAll('Config', { fresh: true }).length) return;
  Db.appendMany('Config', [
    { key: 'ACADEMIC_YEAR',        value: '2026',  notes: 'Used in generated IDs and letters' },
    { key: 'INSTITUTION_NAME',     value: 'Guru Gobind Singh Indraprastha University', notes: '' },
    { key: 'INSTITUTION_SHORT',    value: 'GGSIPU', notes: '' },
    { key: 'APPLICATIONS_OPEN',    value: 'TRUE',  notes: 'Set FALSE to close the intake form' },
    { key: 'MAX_PREFERENCES',      value: '5',     notes: 'How many ranked choices a student may give' },
    { key: 'EMAIL_ENABLED',        value: 'FALSE', notes: 'Keep FALSE while testing so no real mail goes out' },
    { key: 'EMAIL_DAILY_CAP',      value: '90',    notes: 'Stay under the free-tier Gmail quota of 100/day' },
    { key: 'LETTER_FOLDER_ID',     value: '',      notes: 'Drive folder for generated allotment letters' },
    { key: 'SUPPORT_EMAIL',        value: 'hostel@ipu.ac.in', notes: 'Shown on letters and notifications' },
    { key: 'GRIEVANCE_SLA_DAYS',   value: '7',     notes: 'Working days to resolve a grievance' },
    { key: 'ALLOC_LOCAL_SEARCH',   value: 'TRUE',  notes: 'Stage F of the allocator. Set FALSE to disable.' },
    { key: 'ALLOC_MAX_ITERATIONS', value: '2000',  notes: 'Cap on local-search iterations (execution-time guard)' }
  ]);
}

/**
 * Default policy. THESE ARE PLACEHOLDER VALUES pending real GGSIPU norms -
 * see the open questions in PROJECT_CONTEXT.md section 15.
 * The admin team edits these in the sheet; no code change is needed.
 */
function seedPolicy_() {
  if (Db.readAll('Policy', { fresh: true }).length) return;
  var now = new Date();
  var rows = [
    // Reservation percentages.
    ['POL-RES-SC',  'reservation', 'SC',  15,   'Scheduled Caste'],
    ['POL-RES-ST',  'reservation', 'ST',  7.5,  'Scheduled Tribe'],
    ['POL-RES-OBC', 'reservation', 'OBC', 27,   'Other Backward Classes'],
    ['POL-RES-EWS', 'reservation', 'EWS', 10,   'Economically Weaker Section'],
    ['POL-RES-PWD', 'reservation', 'PwD', 5,    'Horizontal reservation - also forces accessible rooms'],

    // Eligibility thresholds.
    ['POL-ELG-DIST', 'eligibility', 'MIN_DISTANCE_KM', 30,  'Students living nearer than this are normally ineligible'],
    ['POL-ELG-CGPA', 'eligibility', 'MIN_CGPA',        5.0, 'Minimum CGPA to retain hostel eligibility'],
    ['POL-ELG-ATTN', 'eligibility', 'MIN_ATTENDANCE',  0,   'Set above 0 to enforce an attendance floor'],

    // Scoring weights - must sum to 1.0. TUNE THESE WITH THE HOSTEL OFFICE.
    ['POL-WGT-MERIT', 'weight', 'W_MERIT',    0.45, 'Academic merit / entrance rank'],
    ['POL-WGT-DIST',  'weight', 'W_DISTANCE', 0.30, 'Distance from hometown - farther scores higher'],
    ['POL-WGT-YEAR',  'weight', 'W_YEAR',     0.15, 'Seniority by academic year'],
    ['POL-WGT-SPEC',  'weight', 'W_SPECIAL',  0.10, 'Special / medical need'],

    // Capacity policy.
    ['POL-CAP-BUFFER',  'capacity', 'VACANCY_BUFFER_PCT', 2,  'Beds held back for emergencies and transfers'],
    ['POL-CAP-CHURN',   'capacity', 'HISTORIC_CHURN_PCT', 8,  'Historical withdrawal rate - drives waitlist ETA'],

    // Roommate compatibility weights - must sum to 1.0.
    ['POL-RM-SLEEP',  'roommate', 'W_SLEEP',       0.25, 'Sleep/wake schedule alignment'],
    ['POL-RM-STUDY',  'roommate', 'W_STUDY',       0.20, 'Study style'],
    ['POL-RM-CLEAN',  'roommate', 'W_CLEAN',       0.20, 'Cleanliness expectation'],
    ['POL-RM-SOCIAL', 'roommate', 'W_SOCIAL',      0.15, 'Sociability'],
    ['POL-RM-FOOD',   'roommate', 'W_FOOD',        0.10, 'Food preference'],
    ['POL-RM-LANG',   'roommate', 'W_LANG',        0.10, 'Shared language - a mild bonus, never a hard rule']
  ];

  Db.appendMany('Policy', rows.map(function (r) {
    return {
      ruleId: r[0], category: r[1], key: r[2], value: r[3],
      effectiveFrom: now, active: true, notes: r[4]
    };
  }));
}

function seedAdmins_() {
  if (Db.readAll('Admins', { fresh: true }).length) return;
  var me = Session.getActiveUser().getEmail();
  if (!me) return;
  Db.append('Admins', {
    email: me, name: 'Project Owner', role: 'SUPER_ADMIN', campus: 'ALL', active: true
  });
}

// ------------------------------------------------------------------ verify P0

/**
 * Phase 0 exit check - run this to confirm the foundation is sound.
 * See PROJECT_CONTEXT.md section 12.
 */
function verifyPhase0() {
  var results = [];
  var ss = Db.ss();

  SHEET_ORDER.forEach(function (tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) { results.push('FAIL  ' + tab + ': sheet missing'); return; }
    var expected = schemaCols(tab);
    var actual = sh.getRange(1, 1, 1, expected.length).getValues()[0];
    var ok = expected.every(function (c, i) { return actual[i] === c; });
    results.push((ok ? 'PASS  ' : 'FAIL  ') + tab + ': ' + expected.length + ' columns');
  });

  var cfgCount = Db.readAll('Config', { fresh: true }).length;
  var polCount = Db.readAll('Policy', { fresh: true }).length;
  results.push((cfgCount > 0 ? 'PASS  ' : 'FAIL  ') + 'Config seeded (' + cfgCount + ' rows)');
  results.push((polCount > 0 ? 'PASS  ' : 'FAIL  ') + 'Policy seeded (' + polCount + ' rows)');

  var chain = Ledger.verify();
  results.push((chain.intact && chain.length > 0 ? 'PASS  ' : 'FAIL  ') + 'Ledger: ' + chain.reason);

  // Weights must sum to 1.0 or the scoring stage is meaningless.
  var w = Db.where('Policy', { category: 'weight' })
            .reduce(function (s, r) { return s + Number(r.value); }, 0);
  results.push((Math.abs(w - 1) < 1e-6 ? 'PASS  ' : 'WARN  ') + 'Scoring weights sum to ' + w.toFixed(4));

  var out = results.join('\n');
  Logger.log(out);
  return out;
}
