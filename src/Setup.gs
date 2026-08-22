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

  // Text columns must be plain text or the spreadsheet silently rewrites their
  // contents. See repairFormatting().
  repairFormatting();
  out.push('Text columns set to plain text.');

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
 * Force every text column in every sheet to plain-text format.
 *
 * Formatting is not cosmetic here: it decides whether a string survives a round
 * trip. Safe to run at any time, and run as part of setupEverything() so a sheet
 * built before this was understood is corrected without anyone having to know.
 *
 * It cannot bring back a leading zero already lost - that digit is gone from the
 * cell - but it stops the next write from losing another.
 */
function repairFormatting() {
  var ss = Db.ss();
  var fixed = [];

  var skipped = [];

  SHEET_ORDER.forEach(function (tab) {
    // One sheet that cannot be reformatted must not abort the rest, and must not
    // abort a ledger repair that called this on its way through.
    try {
      var sh = ss.getSheetByName(tab);
      if (!sh) return;
      var cols = SCHEMA[tab].cols;
      var rows = Math.max(sh.getMaxRows() - 1, 1);
      var n = 0;
      cols.forEach(function (col, i) {
        if (col.type !== T.STR && col.type !== T.JSON) return;
        sh.getRange(2, i + 1, rows, 1).setNumberFormat('@');
        n++;
      });
      if (n) fixed.push(tab + '(' + n + ')');
    } catch (e) {
      skipped.push(tab);
    }
  });

  Db.invalidate();
  return {
    fixed: fixed, skipped: skipped,
    message: 'Text columns set to plain text: ' + (fixed.join(', ') || 'none') +
             (skipped.length ? '. Could not reformat: ' + skipped.join(', ') : '')
  };
}

/**
 * Restore the ledger's genesis link if the spreadsheet mangled it.
 *
 * This is a RESTORATION, not a rewrite, and the difference matters for a record
 * whose whole purpose is to be tamper-evident. The genesis row's previous-hash
 * is a known constant - 64 zeros - which Sheets stored as the number 0. Its own
 * hash was computed over the correct value before the write, so putting the
 * constant back must reproduce the hash that is already stored.
 *
 * That check is the safety: if the recomputed hash does not match what is on the
 * row, the row was altered by something other than this formatting fault and the
 * repair is refused. Nothing else in the chain is touched, ever.
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

  repairFormatting();
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
    } else {
      // Plain text, and NOT optional.
      //
      // With the default "Automatic" format, Sheets reads a numeric-looking
      // string as a number and the original is gone. The ledger's genesis row
      // stores 64 zeros as its previous hash; that became the number 0, so the
      // chain failed to verify at row 0 on every real deployment while every
      // offline test passed, because the test store keeps JavaScript values
      // verbatim. It also silently ate the leading zero from enrolment numbers
      // (04101000126) and from an Aadhaar's last four digits (0124).
      body.setNumberFormat('@');
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
    { key: 'MAX_PREFERENCES',      value: '5',     notes: 'How many ranked choices a student may give' },
    { key: 'EMAIL_ENABLED',        value: 'FALSE', notes: 'Keep FALSE while testing so no real mail goes out' },
    { key: 'EMAIL_DAILY_CAP',      value: '90',    notes: 'Stay under the free-tier Gmail quota of 100/day' },
    { key: 'LETTER_FOLDER_ID',     value: '',      notes: 'Drive folder for generated allotment letters' },
    { key: 'SUPPORT_EMAIL',        value: 'hostel@ipu.ac.in', notes: 'Shown on letters and notifications' },
    { key: 'GRIEVANCE_SLA_DAYS',   value: '7',     notes: 'Working days to resolve a grievance' },
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
