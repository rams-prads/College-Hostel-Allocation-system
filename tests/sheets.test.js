/**
 * Spreadsheet round-trip tests.
 *
 *   node tests/sheets.test.js
 *
 * The offline store keeps JavaScript values exactly as they were written. A real
 * Google Sheet does not: it reads a numeric-looking string and stores a number.
 * Every other suite is blind to that by construction, which is how a chain that
 * failed to verify at row 0 on every live deployment passed 875 checks.
 *
 * This suite models the coercion instead of the storage, and asserts the two
 * things that stop it: every text column is formatted as text, and the ledger
 * repair restores only what it can prove it is restoring.
 */
const { check, section, summarise } = require('./stubs');

// ---------------------------------------------------------------- the fake
/** What Sheets does to a value written into a cell with a given format. */
function asStoredBySheets(value, numberFormat) {
  if (numberFormat === '@') return value;                 // plain text: untouched
  if (typeof value !== 'string' || value === '') return value;
  if (!/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(value.trim())) return value;
  return Number(value);                                    // "Automatic" wins
}

/** Just enough SpreadsheetApp for buildSheet_ to run and be observed. */
function fakeSpreadsheet() {
  const formats = {};       // tab -> { columnIndex: format }
  const sheets = {};

  function range(tab, col) {
    return {
      setValues() { return this; },
      setValue() { return this; },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setFontColor() { return this; },
      setVerticalAlignment() { return this; },
      setNote() { return this; },
      setDataValidation() { return this; },
      setNumberFormat(f) { formats[tab][col] = f; return this; }
    };
  }

  const ss = {
    insertSheet(name) {
      formats[name] = {};
      sheets[name] = {
        getRange: (r, c) => range(name, c),
        setFrozenRows() {}, setRowHeight() {}, setColumnWidth() {},
        getMaxRows: () => 1000, getLastRow: () => 1, getLastColumn: () => 0
      };
      return sheets[name];
    },
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => Object.keys(sheets).map(k => sheets[k]),
    deleteSheet() {}
  };
  return { ss, formats };
}

global.SpreadsheetApp = Object.assign(global.SpreadsheetApp || {}, {
  newDataValidation() {
    const b = {
      requireValueInList: () => b, requireCheckbox: () => b,
      setAllowInvalid: () => b, setHelpText: () => b, build: () => ({})
    };
    return b;
  }
});

// ============================================================ formatting
section('Every text column is stored as text');

const { ss, formats } = fakeSpreadsheet();
SHEET_ORDER.forEach((tab, i) => buildSheet_(ss, tab, i));

check('every tab was built', Object.keys(formats).length === SHEET_ORDER.length);

const unformatted = [];
SHEET_ORDER.forEach(tab => {
  SCHEMA[tab].cols.forEach((col, i) => {
    if (col.type !== T.STR && col.type !== T.JSON) return;
    if (formats[tab][i + 1] !== '@') unformatted.push(tab + '.' + col.name);
  });
});
check('no text column is left on the default format', unformatted.length === 0,
  unformatted.slice(0, 6).join(', ') + (unformatted.length > 6 ? ' …' : ''));

check('numeric columns keep a numeric format', (() => {
  return SHEET_ORDER.every(tab => SCHEMA[tab].cols.every((col, i) => {
    if (col.type !== T.NUM && col.type !== T.INT) return true;
    return formats[tab][i + 1] && formats[tab][i + 1] !== '@';
  }));
})(), 'formatting a number as text would break sorting and arithmetic in the sheet');

section('Reading one row without reading the tab');
// rowsWhere is a second way to read the same data, taken whenever the tab is
// not already loaded. Two paths to one answer is a place for them to drift, so
// the contract is that they cannot.
check('rowsWhere returns exactly what where returns', (() => {
  seedConfig_(); seedPolicy_(); Ledger.genesis();
  return ['Applications', 'Preferences', 'Students'].every(tab => {
    const col = tab === 'Students' ? 'studentId' : 'appId';
    const sample = Db.readAll(tab)[3];
    if (!sample) return true;
    const filter = {}; filter[col] = sample[col];
    return JSON.stringify(Db.where(tab, filter)) ===
           JSON.stringify(Db.rowsWhere(tab, col, sample[col]));
  });
})(), 'the targeted read must be indistinguishable from the full one');

// ============================================================ the damage
section('What the default format would have done');

const casualties = [
  ["the ledger's genesis link", '0'.repeat(64)],
  ['an enrolment number', '04101000126'],
  ["an Aadhaar's last four digits", '0124'],
  // A phone number has no leading zero, so its VALUE survives even though its
  // type does not. Listing it as a casualty would have been wrong.
];
casualties.forEach(([what, value]) => {
  check(what + ' survives a text column',
    asStoredBySheets(value, '@') === value);
  check(what + ' would NOT survive the default', (() => {
    const back = asStoredBySheets(value, null);
    return String(back) !== value;
  })(), 'if this ever passes, the coercion model is wrong, not the code');
});

check('a hash with a letter in it was never at risk',
  asStoredBySheets('a3f9c2', null) === 'a3f9c2',
  'which is why only the genesis row ever broke, and only on real sheets');

// ============================================ what the sheet itself refuses
section('Nothing is written that the sheet would reject');

// An ENUM column becomes a dropdown set to refuse anything outside its list.
// Adding a category in code and not in the schema does not fail a unit test -
// it fails on a real spreadsheet, at the next read, with a stack pointing
// somewhere else entirely, because Apps Script defers the write.
seedConfig_();
seedPolicy_();
seedAll();

const enumBreaches = [];
SHEET_ORDER.forEach(tab => {
  const cols = SCHEMA[tab].cols.filter(c => c.type === T.ENUM && c.values);
  if (!cols.length) return;
  let rows;
  try { rows = Db.readAll(tab); } catch (e) { return; }
  rows.forEach(r => {
    cols.forEach(c => {
      const v = r[c.name];
      if (v === '' || v === null || v === undefined) return;
      if (c.values.indexOf(v) < 0) {
        enumBreaches.push(tab + '.' + c.name + ' = ' + JSON.stringify(v));
      }
    });
  });
});
check('every seeded value is inside its column\'s allowed list',
  enumBreaches.length === 0,
  enumBreaches.slice(0, 5).join(' | '));

check('every policy category the seeder uses is declared',
  Db.readAll('Policy').every(r =>
    SCHEMA.Policy.cols.filter(c => c.name === 'category')[0].values.indexOf(r.category) >= 0),
  'the identity rules were written into a sheet whose dropdown had never heard of them');

// ============================================= values that are not numbers
section('A rule that is not a number survives the round trip');

/** What Db.decode does, which the in-memory store does not model. */
function decodeAs(type, value) {
  if (value === '' || value === null || value === undefined) {
    return type === T.BOOL ? false : (type === T.JSON ? null : '');
  }
  switch (type) {
    case T.NUM:  return Number(value);
    case T.INT:  return parseInt(value, 10);
    case T.BOOL: return value === true || value === 'TRUE' || value === 'true' || value === 1;
    default:     return value;
  }
}

const PATTERN = '^\\d{11}$';
check('a numeric column would have destroyed the enrolment pattern',
  isNaN(decodeAs(T.NUM, PATTERN)),
  'this is why Policy.value is text: Number() runs before Policy ever sees the row');
check('the text column returns it intact',
  decodeAs(T.STR, PATTERN) === PATTERN);
check('and a numeric rule still reads as a number',
  Policy.value('reservation', 'SC', null) === 15,
  typeof Policy.value('reservation', 'SC', null));
check('the pattern reaches Identity as a pattern',
  typeof Policy.value('identity', 'ENROLMENT_PATTERN', '') === 'string' &&
  Policy.value('identity', 'ENROLMENT_PATTERN', '').indexOf('\\d') >= 0,
  String(Policy.value('identity', 'ENROLMENT_PATTERN', '')));

// ================================================= settings on an old sheet
section('A setting added later still reaches an existing sheet');

seedConfig_();
seedPolicy_();

// An installation from before LOGO_URL and the identity rules existed.
Db.replaceAll('Config', Db.readAll('Config')
  .filter(r => r.key !== 'LOGO_URL' && r.key !== 'ALLOW_DEMO_LINKS'));
Db.replaceAll('Policy', Db.readAll('Policy')
  .filter(r => String(r.ruleId).indexOf('POL-ID-') !== 0));
Db.invalidate();

// And somebody has tuned a value since.
Db.update('Config', 'ACADEMIC_YEAR', { value: '2031' });
Db.update('Policy', 'POL-RES-SC', { value: 22 });
Db.invalidate();

const beforeCfg = Db.readAll('Config').length;
const addedCfg = seedConfig_();
const addedPol = seedPolicy_();
Db.invalidate();

check('the missing settings are added', addedCfg.indexOf('LOGO_URL') >= 0,
  'seeding used to stop dead if the sheet had any rows at all, so a setting ' +
  'introduced later was never visible to edit');
check('the missing policy rules are added', addedPol.indexOf('POL-ID-PATTERN') >= 0);
check('LOGO_URL can now be edited in the sheet',
  !!Db.readAll('Config').filter(r => r.key === 'LOGO_URL')[0]);

check('a tuned setting is not reset to the default',
  Db.cfg('ACADEMIC_YEAR') === '2031',
  'it was set by somebody, which is the entire point of it being in the sheet');
check('a tuned policy value is not reset either',
  Number(Db.byId('Policy', 'POL-RES-SC').value) === 22);

check('nothing is duplicated', (() => {
  const keys = Db.readAll('Config').map(r => r.key);
  return new Set(keys).size === keys.length;
})());
check('running it again adds nothing', (() => {
  const n = Db.readAll('Config').length;
  seedConfig_(); seedPolicy_(); Db.invalidate();
  return Db.readAll('Config').length === n;
})());
check('the count grew by exactly what was missing',
  Db.readAll('Config').length === beforeCfg + addedCfg.length);

// ============================================================ ledger repair
section('The ledger repair restores; it does not rewrite');

seedConfig_();
seedPolicy_();
Ledger.genesis();
Ledger.append('SOMETHING_HAPPENED', { a: 1 }, 'system');
Ledger.append('SOMETHING_ELSE', { b: 2 }, 'system');

check('a fresh chain verifies', Ledger.verify().intact);
check('repair on a healthy chain does nothing',
  repairLedger().repaired === false);

// Reproduce exactly what the spreadsheet did: genesis prevHash read back as 0.
const genesisRow = Db.readAll('AuditLog')[0];
Db.update('AuditLog', genesisRow.seq, { prevHash: 0 });
Db.invalidate('AuditLog');

const broken = Ledger.verify();
check('the mangled genesis link breaks the chain', !broken.intact);
check('and it is reported at row 0', broken.brokenAt === 0, broken.reason);
console.log('        ' + broken.reason);

const repair = repairLedger();
check('the repair succeeds', repair.repaired === true, repair.message);
check('the chain verifies afterwards', Ledger.verify().intact);
check('the genesis link is the constant again',
  String(Db.readAll('AuditLog')[0].prevHash) === '0'.repeat(64));

section('It refuses when the row was genuinely altered');

// Change something the hash covers. Restoring the link cannot reproduce the
// stored hash, so the repair must not touch it.
Db.update('AuditLog', 0, { prevHash: 0, actor: 'somebody-else' });
Db.invalidate('AuditLog');

const refused = repairLedger();
check('the repair is refused', refused.repaired === false);
check('and says why in terms of the evidence',
  /does not reproduce the hash/.test(refused.message), refused.message);
console.log('        ' + refused.message);
check('the altered row is left exactly as found',
  Db.readAll('AuditLog')[0].actor === 'somebody-else',
  'a repair that quietly fixed real tampering would defeat the whole ledger');

section('It refuses a break anywhere other than genesis');
Db.update('AuditLog', 0, { prevHash: '0'.repeat(64), actor: 'system' });
Db.invalidate('AuditLog');
check('the chain is healthy again', Ledger.verify().intact);

Db.update('AuditLog', 2, { actor: 'tampered' });
Db.invalidate('AuditLog');
const mid = repairLedger();
check('a mid-chain break is not treated as the formatting fault',
  mid.repaired === false && /tamper detection/.test(mid.message), mid.message);

process.exit(summarise());
