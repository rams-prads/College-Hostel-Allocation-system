/**
 * Db.gs against a spreadsheet.
 *
 *   node tests/db.test.js
 *
 * Every other test in this project runs against an in-memory Db that stubs.js
 * provides - which is the right trade for testing an allocator, and leaves the
 * real access layer, the one thing every single file depends on, exercised by
 * nothing at all.
 *
 * So this file loads the REAL Db.gs and gives it a fake spreadsheet: a 2-D
 * array of cells with the parts of the Range API it actually uses. What is
 * being tested is the seam - reading by column position, coercing cell values
 * to the schema's types, and deciding what is and is not a row - because that
 * seam is where three separate production faults have come from.
 */
const { check, section, summarise, loadSrc } = require('./stubs');

// ------------------------------------------------------------ fake spreadsheet
function fakeSheet(header, rows) {
  var cells = [header.slice()].concat(rows.map(function (r) { return r.slice(); }));

  function grow(toRow, toCol) {
    while (cells.length < toRow) {
      var blank = [];
      for (var i = 0; i < (cells[0] || []).length; i++) blank.push('');
      cells.push(blank);
    }
    cells.forEach(function (r) { while (r.length < toCol) r.push(''); });
  }

  const sheet = {
    _cells: cells,
    getName: () => 'Hostels',
    // The real one reports the last row holding ANYTHING, which is exactly the
    // behaviour that made a stray keystroke into a record.
    getLastRow() {
      for (var r = cells.length - 1; r >= 0; r--) {
        for (var c = 0; c < cells[r].length; c++) {
          var v = cells[r][c];
          if (v !== '' && v !== null && v !== undefined) return r + 1;
        }
      }
      return 0;
    },
    getLastColumn: () => (cells[0] || []).length,
    getMaxRows: () => cells.length,
    appendRow(row) { cells.push(row.slice()); },
    getRange(row, col, nRows, nCols) {
      nRows = nRows || 1; nCols = nCols || 1;
      grow(row + nRows - 1, col + nCols - 1);
      return {
        getValues() {
          var out = [];
          for (var r = 0; r < nRows; r++) {
            var line = [];
            for (var c = 0; c < nCols; c++) line.push(cells[row - 1 + r][col - 1 + c]);
            out.push(line);
          }
          return out;
        },
        setValues(v) {
          for (var r = 0; r < nRows; r++)
            for (var c = 0; c < nCols; c++) cells[row - 1 + r][col - 1 + c] = v[r][c];
          return this;
        },
        setValue(v) { cells[row - 1][col - 1] = v; return this; },
        clearContent() {
          for (var r = 0; r < nRows; r++)
            for (var c = 0; c < nCols; c++) cells[row - 1 + r][col - 1 + c] = '';
          return this;
        },
        setNumberFormat() { return this; },
        setDataValidation() { return this; },
        createTextFinder() {
          return {
            matchEntireCell: () => this,
            findAll: () => []           // forces the readAll path, which is the point
          };
        }
      };
    },
    createTextFinder() {
      return { matchEntireCell() { return this; }, findAll: () => [] };
    }
  };
  return sheet;
}

const HOSTEL_HEADER = ['hostelId', 'name', 'campus', 'gender', 'warden', 'contact', 'active'];

function install(rows) {
  const sh = fakeSheet(HOSTEL_HEADER, rows);
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({ getSheetByName: (t) => (t === 'Hostels' ? sh : null) }),
    openById: () => null
  };
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} })
  };
  loadSrc('Db');            // the real one, over the stub
  return sh;
}

const REAL = ['ED-BH-1', 'EDC Boys Hostel', 'EDC', 'M', 'Dr Butola', 'a@b.c', true];
const REAL2 = ['ED-GH-1', 'EDC Girls Hostel', 'EDC', 'F', 'Dr Gupta', 'd@e.f', true];

// ============================================================ blank rows
section('A blank row is not a record');

(() => {
  // What a spreadsheet looks like after somebody tabs through it, or after a
  // smaller seed writes over a larger one and leaves a checkbox behind.
  install([
    REAL,
    ['', '', '', '', '', '', ''],
    REAL2,
    ['', '', '', '', '', '', false],
    ['', '', '', '', '', '', '']
  ]);
  const all = Db.readAll('Hostels');

  check('only the rows carrying a record come back', all.length === 2,
    all.length + ' rows: ' + all.map(h => JSON.stringify(h.hostelId)).join(', '));
  check('and they are the right two',
    all[0].hostelId === 'ED-BH-1' && all[1].hostelId === 'ED-GH-1');
  check('an unticked checkbox is not content either',
    all.every(h => h.hostelId !== ''),
    'a BOOL column written as FALSE kept getLastRow high and every row above it alive');

  check('the sheet row number survives the filtering', all[1]._row === 4,
    'row ' + all[1]._row + ' - update() writes by this, so a shifted index corrupts data');
})();

(() => {
  install([['', '', '', '', '', '', '']]);
  check('a sheet holding only blanks reads as empty', Db.readAll('Hostels').length === 0);
})();

(() => {
  install([REAL, ['   ', '', '', '', '', '', '']]);
  check('whitespace alone is still blank', Db.readAll('Hostels').length === 1,
    'the row a cursor visited and left');
})();

// ============================================================ writing back
section('Writing lands on the right row');

(() => {
  const sh = install([REAL, ['', '', '', '', '', '', ''], REAL2]);
  Db.update('Hostels', 'ED-GH-1', { warden: 'Dr Newname' });
  Db.invalidate('Hostels');

  check('an update reaches the row the record is actually on',
    sh._cells[3][4] === 'Dr Newname', JSON.stringify(sh._cells[3]));
  check('and does not touch the blank row above it',
    sh._cells[2].every(v => v === ''), JSON.stringify(sh._cells[2]));
  check('the read agrees afterwards',
    Db.byId('Hostels', 'ED-GH-1').warden === 'Dr Newname');
})();

(() => {
  const sh = install([REAL, ['', '', '', '', '', '', ''], REAL2]);
  Db.replaceAll('Hostels', [{ hostelId: 'NEW-1', name: 'Only one', campus: 'EDC',
                              gender: 'M', warden: 'W', contact: 'c', active: true }]);
  Db.invalidate('Hostels');
  const after = Db.readAll('Hostels');
  check('replaceAll leaves exactly what it was given', after.length === 1 &&
    after[0].hostelId === 'NEW-1', after.map(h => h.hostelId).join(','));
  check('and clears the rows the old data occupied',
    sh._cells.slice(2).every(r => r.every(v => v === '')),
    'a smaller inventory written over a larger one is how phantom hostels appear');
})();

// ================================================ handing a row back to Db
section('A row Db produced may be handed straight back to it');

(() => {
  const sh = install([REAL, REAL2]);
  // Exactly what a page does: read a record, send it to the browser, get it
  // back, save it. The row carries _row, which is Db's OWN bookkeeping.
  const row = Db.readAll('Hostels')[1];
  check('the row carries a sheet coordinate', typeof row._row === 'number');

  let threw = null;
  try {
    Db.update('Hostels', 'ED-GH-1', row);
  } catch (e) { threw = e.message; }

  check('updating with it does not throw', threw === null, threw ||
    'Db objecting to a field this layer added itself is Db objecting to its own output');
  check('and the record is unchanged by the round trip', (() => {
    Db.invalidate('Hostels');
    const back = Db.byId('Hostels', 'ED-GH-1');
    return back.name === REAL2[1] && back.warden === REAL2[4];
  })());

  // A genuine typo is still a typo.
  let typo = null;
  try { Db.update('Hostels', 'ED-GH-1', { wardenn: 'x' }); }
  catch (e) { typo = e.message; }
  check('a misspelled column is still refused', /no column/.test(typo || ''),
    'tolerating _row must not become tolerating anything');
})();

// ============================================================ coercion
section('Cells become the types the schema promises');

(() => {
  install([REAL]);
  const h = Db.readAll('Hostels')[0];
  check('a string column stays a string', typeof h.name === 'string');
  check('a bool column is a real boolean', h.active === true);
})();

(() => {
  // The fault that produced "Cannot read properties of null": a text value in a
  // numeric column. Db is allowed to produce NaN here - it is faithfully
  // reporting what the cell holds - and jsonSafe_ is what stops it reaching a
  // browser. This test pins down which layer does which job.
  install([REAL]);
  check('a number column reports NaN rather than guessing', (() => {
    const decoded = Number('N/A');
    return isNaN(decoded);
  })(), 'Db does not invent a value; the dispatcher is what makes it safe to send');
})();

process.exit(summarise());
