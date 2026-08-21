/**
 * Ledger.gs - tamper-evident audit log (novelty feature 1, second half).
 *
 * Every state change appends a row whose hash covers the previous row's hash.
 * Editing any historical row breaks that row's hash AND every hash after it,
 * so verify() can point at the exact row where the chain was broken.
 *
 * This is what lets an admin answer "the allocation was manipulated" with
 * evidence instead of assurance. See PROJECT_CONTEXT.md section 4.1.
 */

var Ledger = (function () {

  var GENESIS_PREV = '0'.repeat(64);

  /** SHA-256 hex of a string. */
  function sha256(str) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
    return bytes.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  }

  /**
   * The exact string that gets hashed. Field order is part of the contract -
   * changing it invalidates every existing chain, so don't.
   */
  function canonical(seq, ts, actor, action, payloadJson, prevHash) {
    return [seq, ts, actor, action, payloadJson, prevHash].join('|');
  }

  function isoTs(d) {
    return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  }

  /** The last row of the chain, or null if only the genesis row exists. */
  function tail() {
    var rows = Db.readAll('AuditLog', { fresh: true });
    return rows.length ? rows[rows.length - 1] : null;
  }

  /**
   * Append one entry to the chain.
   * @param {string} action  e.g. 'ALLOCATION_COMMITTED'
   * @param {Object} payload anything JSON-serialisable
   * @param {string=} actor  defaults to the active user
   */
  function append(action, payload, actor) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var last = tail();
      var seq = last ? Number(last.seq) + 1 : 0;
      var prevHash = last ? last.hash : GENESIS_PREV;
      var now = new Date();
      var ts = isoTs(now);
      var payloadJson = JSON.stringify(payload || {});
      var who = actor || (Session.getActiveUser().getEmail() || 'system');
      var hash = sha256(canonical(seq, ts, who, action, payloadJson, prevHash));

      Db.append('AuditLog', {
        seq: seq,
        ts: now,
        actor: who,
        action: action,
        payloadJson: payloadJson,
        prevHash: prevHash,
        hash: hash
      });
      return { seq: seq, hash: hash };
    } finally {
      lock.releaseLock();
    }
  }

  /** Write the genesis row. Called once by createDatabase(). */
  function genesis() {
    var rows = Db.readAll('AuditLog', { fresh: true });
    if (rows.length) return null;
    return append('LEDGER_GENESIS', { note: 'Chain initialised', system: 'GGSIPU Hostel Allocation' }, 'system');
  }

  /**
   * Walk the chain and report the first break.
   * @return {{intact: boolean, length: number, brokenAt: number, reason: string}}
   */
  function verify() {
    var rows = Db.readAll('AuditLog', { fresh: true });
    if (!rows.length) return { intact: true, length: 0, brokenAt: -1, reason: 'Empty chain' };

    var prevHash = GENESIS_PREV;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r.prevHash) !== prevHash) {
        return {
          intact: false, length: rows.length, brokenAt: Number(r.seq),
          reason: 'Row ' + r.seq + ' does not link to its predecessor (prevHash mismatch)'
        };
      }
      var payloadJson = typeof r.payloadJson === 'string' ? r.payloadJson : JSON.stringify(r.payloadJson);
      var expected = sha256(canonical(r.seq, isoTs(new Date(r.ts)), r.actor, r.action, payloadJson, r.prevHash));
      if (expected !== String(r.hash)) {
        return {
          intact: false, length: rows.length, brokenAt: Number(r.seq),
          reason: 'Row ' + r.seq + ' has been modified after it was written (hash mismatch)'
        };
      }
      prevHash = String(r.hash);
    }
    return { intact: true, length: rows.length, brokenAt: -1, reason: 'All ' + rows.length + ' entries verified' };
  }

  return { append: append, verify: verify, genesis: genesis, sha256: sha256 };
})();
