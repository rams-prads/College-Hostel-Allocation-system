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
  computeDigest(alg, input) {
    // Apps Script accepts a string or a byte array; so must the stub, or the
    // document-hashing path is never exercised offline.
    const buf = Array.isArray(input)
      ? Buffer.from(input.map(b => b & 0xff))
      : Buffer.from(String(input), 'utf8');
    return Array.from(crypto.createHash('sha256').update(buf).digest())
      .map(b => (b > 127 ? b - 256 : b));            // mimic Apps Script signed bytes
  },
  formatDate(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); },
  computeHmacSha256Signature(msg, key) {
    return Array.from(crypto.createHmac('sha256', key).update(msg, 'utf8').digest())
      .map(b => (b > 127 ? b - 256 : b));
  },
  getUuid() { return crypto.randomUUID(); },
  newBlob(content, type, name) {
    return {
      _c: content, _t: type, _n: name,
      getAs(mime) { return Object.assign({}, this, { _t: mime }); },
      setName(n) { this._n = n; return this; },
      getName() { return this._n; },
      getBytes() { return Buffer.from(String(this._c)); },
      getDataAsString() { return String(this._c); }
    };
  },
  base64Decode(s) { return Array.from(Buffer.from(s, 'base64')); },
  base64Encode(bytes) {
    const b = Array.isArray(bytes) ? Buffer.from(bytes.map(x => x & 0xFF)) : Buffer.from(String(bytes));
    return b.toString('base64');
  }
};

// Drive and Mail: recording stubs. Real behaviour needs a deployed script, so
// tests assert what we asked for rather than pretending files were written.
global.__drive = { files: [], folders: {} };
function makeFolder(name) {
  if (global.__drive.folders[name]) return global.__drive.folders[name];
  const f = {
    _name: name,
    getId: () => 'folder-' + name,
    getUrl: () => 'https://drive.example/' + name,
    createFile(blob) {
      const file = {
        _blob: blob,
        getId: () => 'file-' + global.__drive.files.length,
        getUrl: () => 'https://drive.example/file-' + global.__drive.files.length,
        setSharing() { return this; },
        setTrashed() { return this; },
        getName: () => blob.getName()
      };
      global.__drive.files.push(file);
      return file;
    },
    getFilesByName(n) {
      const hits = global.__drive.files.filter(f => f.getName() === n);
      let i = 0;
      return { hasNext: () => i < hits.length, next: () => hits[i++] };
    },
    getFoldersByName(n) {
      const f2 = global.__drive.folders[n];
      let used = false;
      return { hasNext: () => !!f2 && !used, next: () => { used = true; return f2; } };
    },
    createFolder(n) { return makeFolder(n); }
  };
  global.__drive.folders[name] = f;
  return f;
}
global.DriveApp = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' },
  getRootFolder: () => makeFolder('root'),
  getFolderById: (id) => makeFolder(String(id).replace('folder-', ''))
};

global.__mail = [];
global.MailApp = {
  sendEmail(opts) { global.__mail.push(opts); },
  getRemainingDailyQuota: () => 100
};

global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };

// CacheService backs the rate limiter. A real Map, so a test can actually drive
// a caller past the limit rather than only asserting the happy path.
const _cache = new Map();
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => (_cache.has(k) ? _cache.get(k) : null),
    put: (k, v) => { _cache.set(k, String(v)); },
    remove: (k) => { _cache.delete(k); }
  }),
  _reset() { _cache.clear(); }
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; },
    deleteAllProperties: () => { for (const k in scriptProps) delete scriptProps[k]; }
  })
};

// ------------------------------------------------------------- UrlFetchApp
//
// Gemini.gs is the only file in the project that leaves the machine, so this
// stub is the one place the network contract is checked at all.
//
// __fetches records every request made. Several tests assert on its LENGTH
// rather than its contents - "the rate limiter rejected the caller before we
// spent a request" is only provable by showing no request was made.
//
// __fetchQueue lets a test script the NEXT response, which is how quota
// exhaustion, a retired model, and a bare 400 are exercised without waiting
// for Google to produce one.
global.__fetches = [];
global.__fetchQueue = [];

function fetchResponse_(code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text, getAllHeaders: () => ({}) };
}
global.__fetchResponse = fetchResponse_;

/**
 * Deterministic stand-in for an embedding model: hash each token into one of
 * `dims` buckets, count, L2-normalise.
 *
 * Semantically meaningless, but LEXICALLY sensible - two texts sharing words
 * land near each other - which is what lets the retrieval tests assert real
 * ranking ("an attendance question ranks the attendance chunk first") offline.
 * A random vector would only prove the plumbing runs, not that ranking works.
 */
function fakeEmbed_(text, dims) {
  const v = new Array(dims).fill(0);
  String(text).toLowerCase().split(/[^a-z0-9]+/).forEach(tok => {
    if (!tok) return;
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims] += 1;
  });
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
global.__fakeEmbed = fakeEmbed_;

global.UrlFetchApp = {
  fetch(url, params) {
    global.__fetches.push({ url: String(url), params: params || {} });
    if (global.__fetchQueue.length) return global.__fetchQueue.shift();

    // Unscripted calls get a plausible default, so a test that cares about
    // neither embed nor generate does not have to script both.
    const payload = params && params.payload ? JSON.parse(params.payload) : {};

    if (/embedContent/i.test(url)) {
      const dims = payload.outputDimensionality ||
        (payload.requests && payload.requests[0] && payload.requests[0].outputDimensionality) || 768;
      const texts = payload.requests
        ? payload.requests.map(r => r.content.parts.map(p => p.text).join(' '))
        : [(payload.content.parts || []).map(p => p.text).join(' ')];
      // Deliberately NOT unit length: gemini-embedding-001 does not normalise
      // truncated output, and code that forgets to must fail here, not in
      // production. 1.7 is arbitrary and that is the point.
      const out = texts.map(t => ({ values: fakeEmbed_(t, dims).map(x => x * 1.7) }));
      return fetchResponse_(200, payload.requests ? { embeddings: out } : { embedding: out[0] });
    }

    if (/generateContent/i.test(url)) {
      return fetchResponse_(200, {
        candidates: [{ content: { parts: [{ text: 'Stubbed answer. [1]' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 42 }
      });
    }

    return fetchResponse_(404, { error: { message: 'stub: unrouted ' + url } });
  },
  _reset() { global.__fetches = []; global.__fetchQueue = []; }
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
  // Enough of a spreadsheet for DryRun's structural check. A tab "exists" once
  // the schema knows it, which is what createDatabase guarantees on Google.
  ss() {
    return {
      getSheetByName(tab) {
        return SCHEMA[tab] ? { getName: () => tab } : null;
      },
      getSheets: () => Object.keys(SCHEMA).map(t => ({ getName: () => t }))
    };
  },
  readAll(tab) {
    const cols = schemaCols(tab);
    return (store[tab] || []).map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((c, j) => { o[c] = r[j]; });
      return o;
    });
  },
  // Same contract as the real one; the store is already in memory, so the
  // targeted path and the full read are the same thing here.
  rowsWhere(tab, colName, value) {
    return this.readAll(tab).filter(r => r[colName] === value);
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
['Util', 'Ledger', 'Geo', 'Catalogue', 'SeedData', 'Policy', 'Eligibility', 'Roommate', 'Metrics', 'Allocator', 'Documents', 'DocScan', 'SignIn', 'Auth', 'Identity', 'Registration', 'RuleText', 'RuleBook', 'Gemini', 'Chatbot', 'Api', 'QrCode', 'Letters', 'Notify', 'Simulator', 'Swap', 'Vacancy', 'Grievance', 'DemoScenario', 'DryRun', 'AdminApi'].forEach(loadSrc);

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
