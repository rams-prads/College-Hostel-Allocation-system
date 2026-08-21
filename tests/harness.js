/**
 * Offline test harness: stubs the Apps Script globals so engine logic can be
 * exercised in Node before it ever touches a real spreadsheet.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src');

// ---- Apps Script stubs -----------------------------------------------------
const store = {};            // tab -> array of row arrays (excluding header)

global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest(alg, str) {
    const buf = crypto.createHash('sha256').update(str, 'utf8').digest();
    return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); // mimic signed bytes
  },
  formatDate(d, tz, fmt) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
};

global.LockService = {
  getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
};

const scriptProps = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; },
    deleteAllProperties: () => { for (const k in scriptProps) delete scriptProps[k]; }
  })
};

global.Session = { getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) };
global.Logger = { log: (...a) => console.log(...a) };
global.SpreadsheetApp = { getActiveSpreadsheet: () => null };

// ---- minimal in-memory Db replacement --------------------------------------
// We load Schema.gs for real, then substitute a memory-backed Db.
eval(fs.readFileSync(path.join(SRC, 'Schema.gs'), 'utf8'));

global.Db = {
  _t: store,
  readAll(tab) {
    const cols = schemaCols(tab);
    return (store[tab] || []).map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((c, j) => { o[c] = r[j]; });
      return o;
    });
  },
  append(tab, obj) {
    const cols = schemaCols(tab);
    (store[tab] = store[tab] || []).push(cols.map(c => {
      const v = obj[c];
      return v === undefined || v === null ? '' : v;
    }));
    return 1;
  },
  appendMany(tab, objs) { objs.forEach(o => this.append(tab, o)); return objs.length; },
  invalidate() {}
};

eval(fs.readFileSync(path.join(SRC, 'Ledger.gs'), 'utf8'));

// ---- tests -----------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); fail++; }
}

console.log('\n=== Schema contract ===');
check('19 tabs defined', SHEET_ORDER.length === 19, SHEET_ORDER.length + ' found');
check('every ordered tab exists in SCHEMA', SHEET_ORDER.every(t => !!SCHEMA[t]));
check('every SCHEMA tab is in SHEET_ORDER',
  Object.keys(SCHEMA).every(t => SHEET_ORDER.indexOf(t) >= 0));
check('no duplicate columns in any tab',
  Object.keys(SCHEMA).every(t => {
    const c = schemaCols(t);
    return new Set(c).size === c.length;
  }));
check('every declared pk is a real column',
  Object.keys(SCHEMA).every(t => !SCHEMA[t].pk || schemaCols(t).indexOf(SCHEMA[t].pk) >= 0));
check('schemaColIndex is 1-based', schemaColIndex('Students', 'studentId') === 1);
check('schemaColIndex throws on typo', (() => {
  try { schemaColIndex('Students', 'nope'); return false; } catch (e) { return true; }
})());
check('every ENUM column declares values',
  Object.keys(SCHEMA).every(t => SCHEMA[t].cols.every(c => c.type !== 'enum' || Array.isArray(c.values))));

console.log('\n=== Ledger hash chain ===');
Ledger.genesis();
check('genesis row written', Db.readAll('AuditLog').length === 1);
check('genesis links to zero-hash', Db.readAll('AuditLog')[0].prevHash === '0'.repeat(64));

Ledger.append('ALLOCATION_COMMITTED', { runId: 'RUN-1', allocated: 871 });
Ledger.append('SWAP_APPROVED', { reqId: 'REQ-9' });
Ledger.append('POLICY_CHANGED', { key: 'PwD', from: 3, to: 5 });

const chain = Db.readAll('AuditLog');
check('4 entries in chain', chain.length === 4, chain.length + '');
check('sequence numbers are contiguous', chain.every((r, i) => Number(r.seq) === i));
check('each row links to its predecessor',
  chain.every((r, i) => i === 0 || r.prevHash === chain[i - 1].hash));

let v = Ledger.verify();
check('verify() reports intact', v.intact === true, v.reason);
check('verify() counts all entries', v.length === 4);

console.log('\n=== Tamper detection ===');
// Simulate an admin quietly editing a historical payload in the sheet.
const original = store.AuditLog[1][4];
store.AuditLog[1][4] = JSON.stringify({ runId: 'RUN-1', allocated: 999 });
v = Ledger.verify();
check('modified payload detected', v.intact === false, v.reason);
check('points at the right row', v.brokenAt === 1, 'brokenAt=' + v.brokenAt);
console.log('        reason: ' + v.reason);

store.AuditLog[1][4] = original;
check('restoring the value re-validates the chain', Ledger.verify().intact === true);

// Simulate someone rewriting a hash to cover their tracks.
store.AuditLog[2][6] = 'f'.repeat(64);
v = Ledger.verify();
check('forged hash detected', v.intact === false, v.reason);
console.log('        reason: ' + v.reason);

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
