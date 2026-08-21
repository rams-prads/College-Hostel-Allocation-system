/**
 * stubs.js - Apps Script environment shim for Node.
 *
 * Lets the engine run offline so Track A can iterate in seconds instead of
 * pushing to Apps Script and waiting. Loaded by every test file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const store = {};                 // tab -> array of row arrays (no header)
const scriptProps = {};

// ---------------------------------------------------------- Apps Script stubs
global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest(alg, str) {
    return Array.from(crypto.createHash('sha256').update(str, 'utf8').digest())
      .map(b => (b > 127 ? b - 256 : b));            // mimic Apps Script signed bytes
  },
  formatDate(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
};

global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; },
    deleteAllProperties: () => { for (const k in scriptProps) delete scriptProps[k]; }
  })
};

global.Session = { getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) };
global.Logger = { log: () => {} };                    // silent; tests print their own
global.SpreadsheetApp = { getActiveSpreadsheet: () => null };
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };

// ------------------------------------------------------- in-memory Db (batch)
function loadSrc(name) {
  const code = fs.readFileSync(path.join(SRC, name + '.gs'), 'utf8');
  (0, eval)(code);                                    // indirect eval -> global scope
}

loadSrc('Schema');

global.Db = {
  _store: store,
  readAll(tab) {
    const cols = schemaCols(tab);
    return (store[tab] || []).map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((c, j) => { o[c] = r[j]; });
      return o;
    });
  },
  where(tab, filter) {
    const keys = Object.keys(filter);
    return this.readAll(tab).filter(r => keys.every(k => r[k] === filter[k]));
  },
  findOne(tab, filter) { const h = this.where(tab, filter); return h.length ? h[0] : null; },
  byId(tab, id) {
    const pk = SCHEMA[tab].pk;
    return this.findOne(tab, { [pk]: id });
  },
  indexBy(tab, col) {
    const idx = {};
    this.readAll(tab).forEach(r => { idx[r[col]] = r; });
    return idx;
  },
  groupBy(tab, col) {
    const g = {};
    this.readAll(tab).forEach(r => { (g[r[col]] = g[r[col]] || []).push(r); });
    return g;
  },
  append(tab, obj) {
    const cols = schemaCols(tab);
    (store[tab] = store[tab] || []).push(
      cols.map(c => (obj[c] === undefined || obj[c] === null ? '' : obj[c]))
    );
    return 1;
  },
  appendMany(tab, objs) { (objs || []).forEach(o => this.append(tab, o)); return (objs || []).length; },
  update(tab, id, patch) {
    const pk = SCHEMA[tab].pk;
    const cols = schemaCols(tab);
    const rows = store[tab] || [];
    const pkIdx = cols.indexOf(pk);
    for (const r of rows) {
      if (r[pkIdx] === id) {
        Object.keys(patch).forEach(k => { r[cols.indexOf(k)] = patch[k]; });
        return true;
      }
    }
    throw new Error('Db stub: no row ' + id + ' in ' + tab);
  },
  replaceAll(tab, objs) {
    const cols = schemaCols(tab);
    store[tab] = (objs || []).map(o =>
      cols.map(c => (o[c] === undefined || o[c] === null ? '' : o[c])));
    return (objs || []).length;
  },
  invalidate() {},
  nextId(prefix) {
    scriptProps['SEQ_' + prefix] = String(Number(scriptProps['SEQ_' + prefix] || 0) + 1);
    return prefix + '-2026-' + String(scriptProps['SEQ_' + prefix]).padStart(4, '0');
  },
  cfg(key, fallback) {
    const r = this.readAll('Config').find(x => x.key === key);
    return r ? r.value : fallback;
  },
  setCfg(key, value) {
    const existing = this.readAll('Config').find(x => x.key === key);
    if (existing) return this.update('Config', key, { value });
    return this.append('Config', { key, value, notes: '' });
  }
};

// ----------------------------------------------------------- load engine code
['Util', 'Ledger', 'Geo', 'SeedData', 'Policy', 'Eligibility', 'Roommate', 'Metrics', 'Allocator'].forEach(loadSrc);

// Setup.gs seeds Config/Policy; we call only its seed functions, not the
// sheet-building parts, which need a real SpreadsheetApp.
const setupSrc = fs.readFileSync(path.join(SRC, 'Setup.gs'), 'utf8');
(0, eval)(setupSrc);

// ---------------------------------------------------------------- assertions
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('  \x1b[32mPASS\x1b[0m  ' + name); pass++; }
  else {
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (detail ? '  -> ' + detail : ''));
    failures.push(name);
    fail++;
  }
  return !!cond;
}

function section(title) { console.log('\n\x1b[1m=== ' + title + ' ===\x1b[0m'); }

function summarise() {
  console.log('');
  if (fail === 0) console.log('\x1b[32mALL ' + pass + ' CHECKS PASSED\x1b[0m');
  else console.log('\x1b[31m' + pass + ' passed, ' + fail + ' FAILED\x1b[0m -> ' + failures.join('; '));
  return fail === 0 ? 0 : 1;
}

module.exports = { store, check, section, summarise, loadSrc, SRC };
