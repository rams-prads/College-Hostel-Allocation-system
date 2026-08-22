/**
 * Setup.gs - one-click database creation.
 *
 * Run createDatabase() once from the Apps Script editor (or the custom menu).
 * It builds all 18 tabs from SCHEMA, applies validation and formatting, seeds
 * Config and Policy with sane GGSIPU defaults, and writes the genesis ledger row.
 *
 * Safe to re-run: existing tabs are left alone unless you pass {force: true}.
 */

/**
 * RUN THIS ONE. Builds the database, seeds it, makes you an administrator, and
 * prints the address of the finished portal.
 *
 * Everything it does was already available as four separate functions that had
 * to be run in the right order. That ordering is not interesting and getting it
 * wrong is easy, so it lives here instead of in a person's head.
 *
 * Safe to run twice: existing sheets are migrated rather than rebuilt, and
 * seeding is skipped if there are already students.
 */
function setupEverything() {
  var out = [];

  var me = '';
  try { me = Session.getEffectiveUser().getEmail() || ''; } catch (e) { me = ''; }

  out.push('Running as: ' + (me || '(unknown)'));

  // BEFORE anything writes. A sheet built against an older schema still carries
  // the dropdown it was created with, and the first write of a newly allowed
  // value is rejected by the sheet itself.
  try {
    var val = repairValidation();
    out.push(val.message);
  } catch (e) {
    out.push('Could not refresh dropdowns: ' + e.message);
  }

  // Build anything missing, migrate anything out of date, destroy nothing.
  var built = createDatabase();
  out.push(built.created.length ? 'Created tabs: ' + built.created.join(', ')
                                : 'All tabs already existed');
  var migrated = migrateSchema();
  if (migrated.added.length) out.push('Brought up to date: ' + migrated.added.join(' | '));

  // Settings and rules introduced since this sheet was first built. Additive:
  // anything already there keeps the value it has.
  var newCfg = seedConfig_();
  var newPol = seedPolicy_();
  out.push(newCfg && newCfg.length ? 'Settings added: ' + newCfg.join(', ')
                                   : 'No new settings needed.');
  out.push(newPol && newPol.length ? 'Policy rules added: ' + newPol.join(', ')
                                   : 'No new policy rules needed.');

  // repairValidation above already set every column's format and rule from the
  // schema; there is no separate formatting pass to run.

  var led = repairLedger();
  if (led.repaired) out.push('Audit ledger: ' + led.message);
  else if (!Ledger.verify().intact) out.push('AUDIT LEDGER: ' + led.message);
  if (migrated.unsafe.length) {
    out.push('COULD NOT MIGRATE: ' + migrated.unsafe.join(', ') +
             ' - run resetDatabase() if you do not need the data in them.');
  }

  if (Db.readAll('Students', { fresh: true }).length) {
    out.push('Cohort already present, not reseeding.');
  } else {
    var seeded = seedAll();
    out.push('Seeded ' + seeded.students + ' students and ' + seeded.beds + ' beds.');
  }

  // Whoever runs this owns the deployment, so they are the administrator.
  if (me) {
    var existing = Db.readAll('Admins', { fresh: true }).filter(function (a) {
      return String(a.email).trim().toLowerCase() === me.trim().toLowerCase();
    })[0];
    if (existing) {
      Db.update('Admins', existing.email, { active: true, role: 'SUPER_ADMIN', campus: 'ALL' });
      out.push('You were already an administrator.');
    } else {
      Db.append('Admins', { email: me, name: 'Project Owner', role: 'SUPER_ADMIN',
                            campus: 'ALL', active: true });
      out.push('Added ' + me + ' as SUPER_ADMIN.');
    }
  } else {
    out.push('Could not read your address, so no administrator was added. ' +
             'Run Auth.selfEnrolAdmin() once from the editor.');
  }

  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }

  out.push('');
  if (url) {
    out.push('PORTAL:      ' + url);
    out.push('ADMIN:       ' + url + '?page=admin');
    out.push('DIAGNOSTICS: ' + url + '?page=diag');
  } else {
    out.push('No web app URL yet. Deploy > New deployment > Web app,');
    out.push('  Execute as: Me,  Who has access: Anyone with a Google account.');
  }

  // The single thing most likely to be wrong, said before it goes wrong.
  var domain = me.indexOf('@') > 0 ? me.split('@')[1] : '';
  out.push('');
  if (domain && domain !== 'gmail.com' && domain !== 'googlemail.com') {
    out.push('Sign-in: this project is owned by an account on ' + domain + ', so anyone');
    out.push('  with an address on that domain can sign in and be recognised.');
    out.push('  Addresses on OTHER domains will not be - that is a Google restriction,');
    out.push('  not a setting in this project.');
  } else {
    out.push('Sign-in: this project is owned by a personal Google account, so ONLY YOU');
    out.push('  can be recognised by the portal. Other people reach the sign-in page and');
    out.push('  are sent straight back to it, however many times they sign in.');
    out.push('  To let students in, the project must be owned by an account on THEIR');
    out.push('  domain - see DEPLOYMENT.md, "Letting other people sign in".');
  }

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/** Entry point. */
function createDatabase(opts) {
  opts = opts || {};
  var ss = Db.ss();
  var created = [], skipped = [];

  var drifted = [];

  SHEET_ORDER.forEach(function (tab, i) {
    var existing = ss.getSheetByName(tab);
    if (existing && !opts.force) {
      // Skipping silently is the dangerous case. Db reads columns BY POSITION
      // from the schema, so a sheet built against an older column list is not
      // merely out of date - every row read from it is shifted and wrong. Say so.
      if (headersDrifted_(existing, tab)) drifted.push(tab);
      skipped.push(tab);
      return;
    }
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
  if (drifted.length) {
    msg += '\n\n*** SCHEMA MISMATCH: ' + drifted.join(', ') + ' ***\n' +
           'These sheets were built against an older column list. Data is read by ' +
           'column position, so every row in them will be read incorrectly until they ' +
           'are rebuilt. Run resetDatabase() and then seedAll().';
  }
  Logger.log(msg);
  return { created: created, skipped: skipped, drifted: drifted, message: msg };
}

/**
 * Bring existing sheets up to the current schema WITHOUT destroying data.
 *
 * Only ever appends columns. If a sheet's headers are a prefix of the schema's,
 * the missing ones are written and every existing row keeps its meaning, because
 * nothing shifted. Anything else - a rename, a reorder, a deletion - cannot be
 * repaired safely by a script and is reported for a human to decide.
 *
 * This exists because the alternative is resetDatabase(), and a student who has
 * already submitted a form should not lose it because a column was added.
 */
function migrateSchema() {
  var ss = Db.ss();
  var added = [], created = [], unsafe = [];

  SHEET_ORDER.forEach(function (tab, i) {
    var sh = ss.getSheetByName(tab);
    if (!sh) { buildSheet_(ss, tab, i); created.push(tab); return; }

    var expected = SCHEMA[tab].cols.map(function (c) { return c.name; });
    var width = Math.max(sh.getLastColumn(), 1);
    var actual = sh.getRange(1, 1, 1, width).getValues()[0]
      .map(function (v) { return String(v || ''); });
    while (actual.length && actual[actual.length - 1] === '') actual.pop();

    if (actual.length > expected.length) { unsafe.push(tab + ' (extra columns)'); return; }

    var diverges = actual.some(function (name, c) { return name !== expected[c]; });
    if (diverges) { unsafe.push(tab + ' (columns renamed or reordered)'); return; }
    if (actual.length === expected.length) return;

    var missing = expected.slice(actual.length);
    var hdr = sh.getRange(1, actual.length + 1, 1, missing.length);
    hdr.setValues([missing]);
    hdr.setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff')
       .setVerticalAlignment('middle');
    added.push(tab + ': +' + missing.join(', '));
  });

  Db.invalidate();
  var msg = [
    'Created: ' + (created.length ? created.join(', ') : 'none'),
    'Columns added: ' + (added.length ? added.join(' | ') : 'none'),
    'Needs a manual decision: ' + (unsafe.length ? unsafe.join(', ') : 'none')
  ].join('\n');
  if (unsafe.length) {
    msg += '\n\nThese sheets cannot be migrated automatically without risking data. ' +
           'Rebuild them with resetDatabase() (destroys all data) or fix the headers by hand.';
  }
  Logger.log(msg);
  return { created: created, added: added, unsafe: unsafe, message: msg };
}

/**
 * Bring an existing sheet's per-column rules back in line with the schema.
 *
 * A sheet carries the rules it was BUILT with, and there are two ways for those
 * to fall out of step - both of which have now happened:
 *
 *   1. A value is added to an ENUM. The old dropdown still refuses it, and the
 *      write fails with "category must be one of: ..." naming the old list.
 *   2. A column STOPS being an ENUM. Nothing adds a rule, so nothing thinks to
 *      remove the old one either, and a column that is now free text still
 *      rejects everything outside a list that no longer exists. That is what
 *      "programme must be one of: BTech, MTech, MBA, LLB, MCA, BBA, BCA" was,
 *      months after those programmes stopped being the ones offered.
 *
 * So this sets the rule a column should have AND clears the rule it should not,
 * from the schema, every time. Applying only the first half is what let the
 * second fault survive the fix for the first.
 */
function refreshColumnRules_(sh, tab) {
  var rows;
  try {
    rows = Math.max(sh.getMaxRows() - 1, 1);
  } catch (e) {
    // Not a real sheet (the offline harness). There are no rules to refresh.
    return 0;
  }
  var touched = 0;

  SCHEMA[tab].cols.forEach(function (col, i) {
    var range = sh.getRange(2, i + 1, rows, 1);
    try {
      if (col.type === T.ENUM && col.values) {
        range.setDataValidation(
          SpreadsheetApp.newDataValidation()
            .requireValueInList(col.values, true)
            .setAllowInvalid(false)
            .setHelpText(col.name + ' must be one of: ' + col.values.join(', '))
            .build()
        );
      } else if (col.type === T.BOOL) {
        range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      } else {
        // No rule belongs here. Clearing is the half that was missing.
        range.setDataValidation(null);
      }

      if (col.type === T.DATE)      range.setNumberFormat('yyyy-mm-dd hh:mm');
      else if (col.type === T.NUM)  range.setNumberFormat('0.00##');
      else if (col.type === T.INT)  range.setNumberFormat('0');
      else if (col.type === T.STR || col.type === T.JSON) range.setNumberFormat('@');

      touched++;
    } catch (e) { /* one column must not stop the rest */ }
  });

  return touched;
}

/**
 * Re-apply the schema's validation and formatting to every sheet that exists.
 *
 * Run before anything writes: a sheet that still refuses a value the schema now
 * allows will reject the write, and the error it produces names the column
 * rather than the cause.
 */
function repairValidation() {
  var ss = Db.ss();
  var refreshed = [];

  SHEET_ORDER.forEach(function (tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) return;
    var n = refreshColumnRules_(sh, tab);
    if (n) refreshed.push(tab + '(' + n + ')');
  });

  Db.invalidate();
  return { refreshed: refreshed,
           message: 'Column rules refreshed: ' + (refreshed.join(', ') || 'none') };
}

/**
 * Restore the ledger's genesis link if the spreadsheet mangled it.
 *
 * This is a RESTORATION, not a rewrite, and the difference matters for a record
 * whose whole purpose is to be tamper-evident. The genesis row's previous-hash
 * is a known constant - 64 zeros - which a sheet on the default number format
 * stored as the number 0. Its own hash was computed over the correct value
 * before the write, so putting the constant back must reproduce the hash that
 * is already on the row.
 *
 * That check is the safety: if the recomputed hash does not match, the row was
 * altered by something other than this formatting fault and the repair is
 * refused. Nothing else in the chain is touched, ever.
 */
function repairLedger() {
  var v = Ledger.verify();
  if (v.intact) return { repaired: false, message: 'Chain already verifies. Nothing to do.' };

  var rows = Db.readAll('AuditLog', { fresh: true });
  if (!rows.length) return { repaired: false, message: 'The audit log is empty.' };

  var first = rows[0];
  var zeros = '';
  while (zeros.length < 64) zeros += '0';

  if (String(first.prevHash) === zeros) {
    return {
      repaired: false,
      message: 'The break is not the genesis link, so this is not the formatting fault. ' +
               v.reason + ' Investigate before doing anything else - this is what ' +
               'tamper detection is for.'
    };
  }

  var expected = Ledger.hashOf(first, zeros);
  if (expected !== String(first.hash)) {
    return {
      repaired: false,
      message: 'Refusing to touch the ledger: restoring the genesis link does not reproduce ' +
               'the hash stored on row ' + first.seq + ', so that row was changed by ' +
               'something other than the spreadsheet reformatting it. ' + v.reason
    };
  }

  repairValidation();
  Db.update('AuditLog', first.seq, { prevHash: zeros });
  Db.invalidate('AuditLog');

  var after = Ledger.verify();
  return {
    repaired: after.intact,
    message: after.intact
      ? 'Genesis link restored and verified. ' + after.reason
      : 'Genesis link restored but the chain still does not verify: ' + after.reason
  };
}

/**
 * Delete a sheet and build it again from the current schema.
 *
 * Only safe for a tab whose contents are disposable, which is why the only
 * caller is the seeder - every tab it touches it was going to overwrite in full
 * anyway. Nothing else in the project may call this.
 */
function rebuildTab_(tab) {
  var ss = Db.ss();
  var existing = ss.getSheetByName(tab);
  var pos = SHEET_ORDER.indexOf(tab);
  if (existing) ss.deleteSheet(existing);
  buildSheet_(ss, tab, pos < 0 ? ss.getSheets().length : pos);
  Db.invalidate(tab);
}

/**
 * Make sure the tabs the seeder is about to fill have the columns the seeder
 * thinks they have.
 *
 * Db writes BY COLUMN POSITION. A schema change that inserts a column leaves an
 * existing sheet one place out of step, and the seeder then writes each value
 * into its neighbour's column - so an admission category lands in the column
 * holding SC/ST/OBC and the spreadsheet rejects it. The error that surfaces
 * ("category must be one of: GEN, OBC, SC, ST, EWS") describes the symptom and
 * says nothing about the cause, which is a whole sheet shifted sideways.
 *
 * These tabs hold generated data and the seeder replaces all of it, so the
 * honest fix is to rebuild any that have drifted rather than to write into them
 * and hope.
 */
function ensureSeedTabs_(tabs) {
  var rebuilt = [];
  try {
    var ss = Db.ss();
    tabs.forEach(function (tab) {
      var sh = ss.getSheetByName(tab);
      if (!sh) { rebuildTab_(tab); rebuilt.push(tab); return; }
      if (headersDrifted_(sh, tab)) { rebuildTab_(tab); rebuilt.push(tab); return; }

      // Headers can match while the per-column rules do not: changing a column
      // from a dropdown to free text leaves the old dropdown in place, and it
      // goes on refusing values the schema now allows.
      refreshColumnRules_(sh, tab);
    });
  } catch (e) {
    // No real spreadsheet (the offline harness). Nothing to align.
    return [];
  }
  if (rebuilt.length) Logger.log('Rebuilt for the current schema: ' + rebuilt.join(', '));
  return rebuilt;
}

/** Does an existing sheet's header row still match the schema? */
function headersDrifted_(sh, tab) {
  var expected = SCHEMA[tab].cols.map(function (c) { return c.name; });
  if (sh.getLastColumn() < 1) return true;
  var actual = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), expected.length)).getValues()[0];
  return expected.some(function (name, i) { return actual[i] !== name; });
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
  // Validation and number format come from one place, shared with the repair
  // path. Two implementations of "what rule does this column have" is how a
  // sheet ends up carrying a rule the schema stopped asking for.
  refreshColumnRules_(sh, tab);
  cols.forEach(function (col, i) { sh.setColumnWidth(i + 1, columnWidth_(col)); });

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

/**
 * Config defaults, added but never overwritten.
 *
 * This used to return early whenever the sheet had any rows at all, which meant
 * a setting introduced after the first setup never reached an existing
 * installation - LOGO_URL and ALLOW_DEMO_LINKS simply were not there to edit.
 * The code fell back to a default and behaved correctly, which made it worse:
 * nothing was broken, so nothing was noticed, and the settings the office is
 * supposed to control were invisible.
 *
 * Missing keys are inserted. An existing value is left exactly as it is, whether
 * or not it matches the default - it was set by somebody, and that is the point.
 */
function seedConfig_() {
  var existing = {};
  Db.readAll('Config', { fresh: true }).forEach(function (r) { existing[r.key] = true; });

  var defaults = [
    { key: 'ACADEMIC_YEAR',        value: '2026',  notes: 'Used in generated IDs and letters' },
    { key: 'INSTITUTION_NAME',     value: 'Guru Gobind Singh Indraprastha University', notes: '' },
    { key: 'INSTITUTION_SHORT',    value: 'GGSIPU', notes: '' },
    { key: 'APPLICATIONS_OPEN',    value: 'TRUE',  notes: 'Set FALSE to close the intake form' },
    { key: 'MAX_PREFERENCES',      value: '3',     notes: 'How many ranked choices a student may give. A campus has one hostel per gender and three room types, so three is the whole menu.' },
    { key: 'EMAIL_ENABLED',        value: 'FALSE', notes: 'Keep FALSE while testing so no real mail goes out' },
    { key: 'EMAIL_DAILY_CAP',      value: '90',    notes: 'Stay under the free-tier Gmail quota of 100/day' },
    { key: 'LETTER_FOLDER_ID',     value: '',      notes: 'Drive folder for generated allotment letters' },
    { key: 'SUPPORT_EMAIL',        value: 'hostel@ipu.ac.in', notes: 'Shown on letters and notifications' },
    { key: 'GRIEVANCE_SLA_DAYS',   value: '7',     notes: 'Working days to resolve a grievance' },

    // Fees, from the EDC brochure. Held as settings rather than in code so the
    // office can update them each session without a developer.
    { key: 'FEE_HOSTEL_SINGLE',    value: '35000', notes: 'Annual hostel fee, single seater (non-refundable)' },
    { key: 'FEE_HOSTEL_TRIPLE',    value: '30000', notes: 'Annual hostel fee, triple seater (non-refundable)' },
    { key: 'FEE_HOSTEL_QUAD',      value: '25000', notes: 'Annual hostel fee, four seater (non-refundable)' },
    { key: 'FEE_HOSTEL_SECURITY',  value: '5000',  notes: 'Hostel security (refundable)' },
    { key: 'FEE_ADMISSION_FRESH',  value: '1000',  notes: 'Admission charge, fresh admission' },
    { key: 'FEE_ADMISSION_READM',  value: '500',   notes: 'Admission charge, re-admission' },
    { key: 'FEE_MESS_SECURITY',    value: '5000',  notes: 'Mess security (refundable), fresh admission only' },
    { key: 'FEE_MESS_MAINTENANCE', value: '1000',  notes: 'Mess maintenance (non-refundable)' },
    { key: 'FEE_MESS_ADVANCE',     value: '54000', notes: 'Advance mess charge, adjusted against actual use' },
    { key: 'FEE_WELFARE',          value: '4000',  notes: 'Annual welfare charge (non-refundable)' },
    { key: 'ALLOW_DEMO_LINKS',     value: 'FALSE', notes: 'Read-only student links that work without sign-in. For demos only - switch back off afterwards.' },
    { key: 'LOGO_URL',             value: 'https://www.ipu.ac.in/images/logo.png',
      notes: 'University crest shown in the masthead. Any public image URL, or a Drive file shared "anyone with the link". Blank falls back to the IPU monogram.' },
    { key: 'ALLOC_LOCAL_SEARCH',   value: 'TRUE',  notes: 'Stage F of the allocator. Set FALSE to disable.' },
    { key: 'ALLOC_MAX_ITERATIONS', value: '2000',  notes: 'Cap on local-search iterations (execution-time guard)' }
  ];

  var missing = defaults.filter(function (row) { return !existing[row.key]; });
  if (missing.length) Db.appendMany('Config', missing);
  return missing.map(function (r) { return r.key; });
}

/**
 * Default policy. THESE ARE PLACEHOLDER VALUES pending real GGSIPU norms -
 * see the open questions in PROJECT_CONTEXT.md section 15.
 * The admin team edits these in the sheet; no code change is needed.
 */
/**
 * Policy defaults, added but never overwritten. Same reasoning as seedConfig_:
 * a rule added later never appeared in an existing sheet, so the office could
 * not see or tune it even though the engine was reading it.
 *
 * A value someone has already tuned is never touched. Only absent rules are
 * written, matched on ruleId.
 */
function seedPolicy_() {
  var have = {};
  Db.readAll('Policy', { fresh: true }).forEach(function (r) { have[r.ruleId] = true; });
  var now = new Date();
  var rows = [
    // Reservation percentages.
    ['POL-RES-SC',  'reservation', 'SC',  15,   'Scheduled Caste'],
    ['POL-RES-ST',  'reservation', 'ST',  7.5,  'Scheduled Tribe'],
    ['POL-RES-OBC', 'reservation', 'OBC', 27,   'Other Backward Classes'],
    ['POL-RES-EWS', 'reservation', 'EWS', 10,   'Economically Weaker Section'],
    ['POL-RES-PWD', 'reservation', 'PwD', 5,    'Horizontal reservation - also forces accessible rooms'],

    // Eligibility. The brochure sets NO minimum distance and NO minimum CGPA
    // for a fresh applicant - a Delhi student is eligible, simply last in the
    // priority order. The conditions it does set apply to RE-ADMISSION.
    ['POL-ELG-ATTN',  'eligibility', 'MIN_ATTENDANCE_PCT', 75,
     'Brochure rule 33: below this, in USS and hostel aggregate, no residency next session'],
    ['POL-ELG-PROMO', 'eligibility', 'REQUIRE_PROMOTION', 1,
     'A year-back student is not eligible for re-admission'],

    // The priority order for a fresh allotment, exactly as the brochure states
    // it. These are RANKS, not weights: a lower number is considered first and
    // is exhausted before the next is looked at. There is no trade-off between
    // them, which is the whole point - an applicant cannot make up for being in
    // a later group by being stronger on something else.
    ['POL-PRI-PWD',      'priority', 'PWD',                1,
     'Disabled/handicapped students, ahead of everyone'],
    ['POL-PRI-OD',       'priority', 'OUTSIDE_DELHI',      2,
     'Outside Delhi category, ordered by merit'],
    ['POL-PRI-TRANSFER', 'priority', 'PARENT_TRANSFERRED', 3,
     'Delhi category whose parent was transferred out of Delhi (Govt/PSU only)'],
    ['POL-PRI-DELHI',    'priority', 'DELHI',              4,
     'Remaining Delhi category, ordered by distance from campus'],

    // Seats set aside, spread evenly across the schools.
    ['POL-CAP-FOREIGN', 'capacity', 'FOREIGN_QUOTA_PCT', 5,
     'Brochure: up to 5% of seats may be offered to foreign students, equally across schools'],

    // Capacity policy.
    ['POL-CAP-BUFFER',  'capacity', 'VACANCY_BUFFER_PCT', 2,  'Beds held back for emergencies and transfers'],
    ['POL-CAP-SINGLE',  'capacity', 'SINGLE_ROOM_PG_ONLY', 1,
     'Brochure: single rooms are for PG and PhD students. 0 opens them to everyone.'],
    ['POL-CAP-CHURN',   'capacity', 'HISTORIC_CHURN_PCT', 8,  'Historical withdrawal rate - drives waitlist ETA'],

    // Roommate compatibility weights - must sum to 1.0.
    ['POL-RM-SLEEP',  'roommate', 'W_SLEEP',       0.25, 'Sleep/wake schedule alignment'],
    ['POL-RM-STUDY',  'roommate', 'W_STUDY',       0.20, 'Study style'],
    ['POL-RM-CLEAN',  'roommate', 'W_CLEAN',       0.20, 'Cleanliness expectation'],
    ['POL-RM-SOCIAL', 'roommate', 'W_SOCIAL',      0.15, 'Sociability'],
    ['POL-RM-FOOD',   'roommate', 'W_FOOD',        0.10, 'Food preference'],
    ['POL-RM-LANG',   'roommate', 'W_LANG',        0.10, 'Shared language - a mild bonus, never a hard rule'],

    // Identity verification. The enrolment pattern is policy, not code: we have
    // no authoritative published spec for GGSIPU enrolment numbers, and a
    // hard-coded guess would reject real students - the worst way for a
    // verification step to fail. Tighten it here once the office confirms it.
    ['POL-ID-PATTERN', 'identity', 'ENROLMENT_PATTERN', '^\\d{11}$',
     'Regex an enrolment number must match. Edit here, no code change needed.'],
    ['POL-ID-YEARPOS', 'identity', 'ENROLMENT_YEAR_POS', 9,
     'Zero-based index of the 2-digit admission year inside the enrolment number. -1 disables the check.'],
    ['POL-ID-MAXMB',   'identity', 'MAX_UPLOAD_MB',     8,
     'Largest document a student may upload'],
    ['POL-ID-RATE',    'identity', 'MAX_UPLOADS_PER_HOUR', 20,
     'Upload attempts allowed per applicant per hour'],

    // How far the PIN code on a document may sit from the declared one before
    // the difference is treated as material rather than clerical. Raising it
    // means fewer things reach a person, and more misdeclarations go unseen.
    ['POL-ELG-ADDRTOL', 'eligibility', 'ADDRESS_TOLERANCE_KM', 50,
     'Distance difference between declared and documented PIN that is worth raising']
  ];

  var missing = rows.filter(function (r) { return !have[r[0]]; });
  if (missing.length) {
    Db.appendMany('Policy', missing.map(function (r) {
      return {
        ruleId: r[0], category: r[1], key: r[2], value: r[3],
        effectiveFrom: now, active: true, notes: r[4]
      };
    }));
    Policy.invalidate();
  }
  return missing.map(function (r) { return r[0]; });
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
