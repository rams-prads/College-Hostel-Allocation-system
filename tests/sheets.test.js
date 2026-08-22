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
