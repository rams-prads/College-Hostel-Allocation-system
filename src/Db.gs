/**
 * Db.gs - typed access layer over the spreadsheet.
 *
 * EVERY other file goes through here. Nothing else may call getRange() directly.
 * Two reasons: (1) column names stay decoupled from column positions, and
 * (2) all reads/writes are batched, which is what keeps a 900-student allocation
 * inside the 6-minute Apps Script execution limit.
 *
 * The function signatures below are part of the team contract - see
 * PROJECT_CONTEXT.md section 11.
 */

var Db = (function () {

  var _ssCache = null;
  var _tableCache = {};   // tab -> array of row objects, per execution

  // ---------------------------------------------------------------- spreadsheet

  /** The bound spreadsheet, or the one whose id is in Script Properties. */
  function ss() {
    if (_ssCache) return _ssCache;
    var bound = SpreadsheetApp.getActiveSpreadsheet();
    if (bound) {
      _ssCache = bound;
    } else {
      var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      if (!id) throw new Error('Db: no bound spreadsheet and no SPREADSHEET_ID property set.');
      _ssCache = SpreadsheetApp.openById(id);
    }
    return _ssCache;
  }

  function sheet(tab) {
    var sh = ss().getSheetByName(tab);
    if (!sh) {
      // Name the fix, not just the fault. This message reaches students.
      throw new Error('The "' + tab + '" sheet does not exist yet. An administrator ' +
                      'needs to run setupEverything() once in the Apps Script editor.');
    }
    return sh;
  }

  // ------------------------------------------------------------------ coercion

  /** Sheet cell value -> JS value, per the schema column type. */
  function decode(value, col) {
    if (value === '' || value === null || value === undefined) {
      return col.type === T.BOOL ? false : (col.type === T.JSON ? null : '');
    }
    switch (col.type) {
      case T.NUM:  return Number(value);
      case T.INT:  return parseInt(value, 10);
      case T.BOOL: return value === true || value === 'TRUE' || value === 'true' || value === 1;
      case T.DATE: return value instanceof Date ? value : new Date(value);
      case T.JSON:
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch (e) { return value; }
      default:     return value;
    }
  }

  /** JS value -> sheet cell value. */
  function encode(value, col) {
    if (value === null || value === undefined) return '';
    if (col.type === T.JSON) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (col.type === T.BOOL) return !!value;
    return value;
  }

  // ---------------------------------------------------------------------- read

  /**
   * Every row of a tab as objects keyed by column name.
   * Cached per execution - repeated calls in one allocation run are free.
   */
  function readAll(tab, opts) {
    opts = opts || {};
    if (!opts.fresh && _tableCache[tab]) return _tableCache[tab];

    var cols = SCHEMA[tab].cols;
    var sh = sheet(tab);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { _tableCache[tab] = []; return []; }

    var values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
    var out = values.map(function (row, i) {
      var obj = { _row: i + 2 };
      for (var c = 0; c < cols.length; c++) obj[cols[c].name] = decode(row[c], cols[c]);
      return obj;
    });
    _tableCache[tab] = out;
    return out;
  }

  /** Rows matching a {col: value} filter. */
  function where(tab, filter) {
    var keys = Object.keys(filter);
    return readAll(tab).filter(function (row) {
      return keys.every(function (k) { return row[k] === filter[k]; });
    });
  }

  /** First row matching the filter, or null. */
  function findOne(tab, filter) {
    var hits = where(tab, filter);
    return hits.length ? hits[0] : null;
  }

  /** Row by primary key, or null. */
  function byId(tab, id) {
    var pk = SCHEMA[tab].pk;
    if (!pk) throw new Error('Db: tab "' + tab + '" has no primary key.');
    var f = {}; f[pk] = id;
    return findOne(tab, f);
  }

  /** Index a tab by one column: { value: row }. Use before tight loops. */
  function indexBy(tab, colName) {
    var idx = {};
    readAll(tab).forEach(function (row) { idx[row[colName]] = row; });
    return idx;
  }

  /** Group a tab by one column: { value: [rows] }. */
  function groupBy(tab, colName) {
    var g = {};
    readAll(tab).forEach(function (row) {
      var k = row[colName];
      (g[k] = g[k] || []).push(row);
    });
    return g;
  }

  // --------------------------------------------------------------------- write

  function objToRow(tab, obj) {
    return SCHEMA[tab].cols.map(function (col) { return encode(obj[col.name], col); });
  }

  /** Append one row. Prefer appendMany in loops. */
  function append(tab, obj) {
    return appendMany(tab, [obj]);
  }

  /** Append many rows in ONE write. This is the hot path - use it. */
  function appendMany(tab, objs) {
    if (!objs || !objs.length) return 0;
    var sh = sheet(tab);
    var rows = objs.map(function (o) { return objToRow(tab, o); });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, SCHEMA[tab].cols.length).setValues(rows);
    delete _tableCache[tab];
    return rows.length;
  }

  /**
   * Patch specific fields of the row with the given primary key.
   * Writes only the touched cells, so it is safe on wide sheets.
   */
  function update(tab, id, patch) {
    var row = byId(tab, id);
    if (!row) throw new Error('Db: no row with id "' + id + '" in "' + tab + '"');
    var sh = sheet(tab);
    Object.keys(patch).forEach(function (k) {
      var col = SCHEMA[tab].cols.filter(function (c) { return c.name === k; })[0];
      if (!col) throw new Error('Db: no column "' + k + '" in "' + tab + '"');
      sh.getRange(row._row, schemaColIndex(tab, k)).setValue(encode(patch[k], col));
    });
    delete _tableCache[tab];
    return true;
  }

  /**
   * Rewrite a whole tab's data in one write. Used by the allocator when it
   * flushes bed states - far cheaper than hundreds of update() calls.
   */
  function replaceAll(tab, objs) {
    var sh = sheet(tab);
    var nCols = SCHEMA[tab].cols.length;
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, nCols).clearContent();
    if (objs && objs.length) {
      var rows = objs.map(function (o) { return objToRow(tab, o); });
      sh.getRange(2, 1, rows.length, nCols).setValues(rows);
    }
    delete _tableCache[tab];
    return objs ? objs.length : 0;
  }

  /** Drop the per-execution cache. Call after any out-of-band write. */
  function invalidate(tab) {
    if (tab) delete _tableCache[tab]; else _tableCache = {};
  }

  // ----------------------------------------------------------------- id + misc

  // Which tab each id prefix lives in, so a generated id can be checked against
  // what already exists.
  var ID_TABLE = {
    STU: ['Students', 'studentId'],
    APP: ['Applications', 'appId'],
    GRV: ['Grievances', 'ticketId'],
    SWP: ['Transfers', 'reqId']
  };

  /**
   * Prefixed sequential id, e.g. nextId('APP') -> 'APP-2026-0001'.
   *
   * The counter alone is not enough. Seeded demo data writes its own ids
   * directly without advancing it, so a freshly registered student was handed
   * an id that already belonged to someone else - and silently aliased their
   * record. Every candidate is now checked against the table it will be written
   * to before it is issued.
   */
  function nextId(prefix) {
    var props = PropertiesService.getScriptProperties();
    var key = 'SEQ_' + prefix;
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var taken = {};
      var spec = ID_TABLE[prefix];
      if (spec) {
        try {
          readAll(spec[0], { fresh: true }).forEach(function (r) { taken[r[spec[1]]] = true; });
        } catch (e) { /* tab may not exist yet during setup */ }
      }

      var n = parseInt(props.getProperty(key) || '0', 10);
      var id;
      do {
        n++;
        id = prefix + '-' + cfg('ACADEMIC_YEAR', '2026') + '-' + padLeft(n, 4);
      } while (taken[id]);

      props.setProperty(key, String(n));
      return id;
    } finally {
      lock.releaseLock();
    }
  }

  function padLeft(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /**
   * Config value by key, with a fallback.
   *
   * An EMPTY cell falls back too. Returning '' for a key someone blanked meant
   * Number('') or Number(undefined) reached arithmetic and produced NaN, and a
   * NaN date is written to the sheet as an invalid value that nothing downstream
   * can read back.
   */
  function cfg(key, fallback) {
    var rows = readAll('Config');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === key) {
        var v = rows[i].value;
        if (v === '' || v === null || v === undefined) return fallback;
        return v;
      }
    }
    return fallback;
  }

  function setCfg(key, value) {
    var existing = byId('Config', key);
    if (existing) return update('Config', key, { value: value });
    return append('Config', { key: key, value: value, notes: '' });
  }

  return {
    ss: ss,
    sheet: sheet,
    readAll: readAll,
    where: where,
    findOne: findOne,
    byId: byId,
    indexBy: indexBy,
    groupBy: groupBy,
    append: append,
    appendMany: appendMany,
    update: update,
    replaceAll: replaceAll,
    invalidate: invalidate,
    nextId: nextId,
    cfg: cfg,
    setCfg: setCfg
  };
})();
