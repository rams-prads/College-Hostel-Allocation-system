/**
 * DryRun.gs - end-to-end self-test against the LIVE spreadsheet.
 *
 * The offline suites prove the engine is correct. They cannot prove the
 * deployment is correct - and every failure so far has been in that gap:
 * an invisible QR, an admin locked out of their own dashboard, a menu item
 * pointing at a function that did not exist.
 *
 * This runs the whole lifecycle against real Google infrastructure and reports
 * a checklist. Run it before a demo, and after any push.
 *
 * NON-DESTRUCTIVE BY DEFAULT: the allocation is previewed, not committed, so a
 * dry run on the morning of a demo cannot reshuffle the rooms you rehearsed.
 */

var DryRun = (function () {

  function run(opts) {
    opts = opts || {};
    var t0 = new Date().getTime();
    var results = [];

    function step(name, fn, critical) {
      var started = new Date().getTime();
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || '',
                       ms: new Date().getTime() - started, critical: !!critical });
      } catch (e) {
        results.push({ name: name, ok: false, detail: e.message,
                       ms: new Date().getTime() - started, critical: !!critical });
      }
    }

    // ---------------------------------------------------------- foundation
    step('Database structure', function () {
      var missing = SHEET_ORDER.filter(function (tab) {
        return !Db.ss().getSheetByName(tab);
      });
      if (missing.length) throw new Error('Missing tabs: ' + missing.join(', '));
      return SHEET_ORDER.length + ' tabs present';
    }, true);

    step('Configuration seeded', function () {
      var n = Db.readAll('Config').length;
      if (!n) throw new Error('Config is empty - run Create database');
      return n + ' settings';
    }, true);

    step('Policy seeded', function () {
      var p = Db.readAll('Policy').filter(function (r) { return r.active; });
      if (!p.length) throw new Error('No active policy rules');
      var w = Policy.weights();
      var sum = w.W_MERIT + w.W_DISTANCE + w.W_YEAR + w.W_SPECIAL;
      if (Math.abs(sum - 1) > 0.001) throw new Error('Scoring weights sum to ' + sum.toFixed(3));
      return p.length + ' rules, weights sum to 1.000';
    }, true);

    step('Administrator configured', function () {
      var admins = Db.readAll('Admins').filter(function (a) { return a.active; });
      if (!admins.length) throw new Error('No active administrator - use "Add me as administrator"');
      return admins.length + ' active: ' + admins.map(function (a) { return a.email; }).join(', ');
    }, true);

    // ---------------------------------------------------------------- data
    step('Cohort seeded', function () {
      var s = Db.readAll('Students').length;
      var a = Db.readAll('Applications').length;
      if (!s) throw new Error('No students - run Seed demo data');
      if (a !== s) throw new Error(s + ' students but ' + a + ' applications');
      return s + ' students, ' + a + ' applications';
    }, true);

    step('Inventory consistent', function () {
      var rooms = Db.readAll('Rooms');
      var beds = Db.readAll('Beds');
      var capacity = rooms.reduce(function (t, r) { return t + Number(r.capacity); }, 0);
      if (beds.length !== capacity) {
        throw new Error(beds.length + ' beds but room capacity totals ' + capacity);
      }
      return beds.length + ' beds in ' + rooms.length + ' rooms';
    }, true);

    step('Home distances resolved', function () {
      var apps = Db.readAll('Applications');
      var bad = apps.filter(function (a) { return Number(a.distanceKm) < 0; }).length;
      if (bad) throw new Error(bad + ' applications have an unresolved home PIN');
      return 'all ' + apps.length + ' resolved';
    });

    // ------------------------------------------------------------- engine
    var preview = null;
    step('Allocation engine', function () {
      preview = Allocator.run({ seed: opts.seed || ('GGSIPU-' + Db.cfg('ACADEMIC_YEAR', '2026')) });
      if (!preview.allocations.length) throw new Error('Allocated nobody');
      return preview.allocations.length + ' allotted, ' + preview.waitlist.length +
             ' waitlisted, ' + preview.rejected.length + ' ineligible, in ' +
             preview.elapsedSec + 's';
    }, true);

    step('No bed double-booked', function () {
      var used = {}, dupes = 0;
      preview.allocations.forEach(function (a) {
        if (used[a.bedId]) dupes++;
        used[a.bedId] = true;
      });
      if (dupes) throw new Error(dupes + ' beds allotted twice');
      return 'all ' + preview.allocations.length + ' unique';
    }, true);

    step('Gender partition holds', function () {
      var rooms = Db.indexBy('Rooms', 'roomId');
      var hostels = Db.indexBy('Hostels', 'hostelId');
      var bad = preview.allocations.filter(function (a) {
        var h = hostels[rooms[a.roomId].hostelId];
        return h.gender !== 'CO' && h.gender !== a.candidate.gender;
      }).length;
      if (bad) throw new Error(bad + ' students placed in the wrong hostel');
      return 'no violations';
    }, true);

    step('Accessibility honoured', function () {
      var rooms = Db.indexBy('Rooms', 'roomId');
      var need = preview.allocations.filter(function (a) { return a.candidate.needsAccessible; });
      var bad = need.filter(function (a) { return !rooms[a.roomId].isAccessible; }).length;
      if (bad) throw new Error(bad + ' students needing accessible rooms did not get one');
      var waiting = preview.waitlist.filter(function (w) { return w.candidate.needsAccessible; }).length;
      if (waiting) throw new Error(waiting + ' students needing accessible rooms are waitlisted');
      return need.length + ' honoured, none waitlisted';
    }, true);

    step('Quotas not oversubscribed', function () {
      var filled = {};
      preview.allocations.forEach(function (a) {
        filled[a.quotaUsed] = (filled[a.quotaUsed] || 0) + 1;
      });
      var over = [];
      Object.keys(preview.quota.reserved).forEach(function (cat) {
        if ((filled[cat] || 0) > preview.quota.reserved[cat]) over.push(cat);
      });
      if ((filled.OPEN || 0) > preview.quota.open) over.push('OPEN');
      if (over.length) throw new Error('Oversubscribed: ' + over.join(', '));
      return 'all within limits';
    }, true);

    step('Room utilisation', function () {
      var pct = preview.metrics.summary.utilisationPct;
      if (pct < 90) throw new Error('Only ' + pct + '% of beds used - beds are being stranded');
      return pct + '% of beds occupied';
    });

    step('Allocation is efficient', function () {
      var swaps = preview.metrics.summary.paretoSwaps;
      if (swaps > 0) return swaps + ' improving swaps found and applied';
      return 'no student can be improved without harming another';
    });

    step('Every outcome is explained', function () {
      var missing = 0;
      preview.allocations.concat(preview.waitlist).forEach(function (x) {
        if (!(preview.traces[x.appId] || []).length) missing++;
      });
      if (missing) throw new Error(missing + ' students have no explanation trace');
      return 'all ' + (preview.allocations.length + preview.waitlist.length) + ' traced';
    }, true);

    step('Run is reproducible', function () {
      var again = Allocator.run({ seed: preview.seed });
      var a = preview.allocations.map(function (x) { return x.appId + ':' + x.bedId; }).join();
      var b = again.allocations.map(function (x) { return x.appId + ':' + x.bedId; }).join();
      if (a !== b) throw new Error('Two runs on the same seed produced different results');
      return 'identical output from seed ' + preview.seed;
    }, true);

    // -------------------------------------------------------------- ledger
    step('Audit ledger intact', function () {
      var v = Ledger.verify();
      if (!v.intact) throw new Error(v.reason);
      return v.length + ' entries, chain unbroken';
    }, true);

    // ------------------------------------------------------------- outputs
    step('Letter generation', function () {
      var committed = Db.readAll('Allocations').filter(function (a) { return a.status === 'ACTIVE'; });
      if (!committed.length) return 'skipped - no committed allocation yet';
      var html = Letters.buildHtml(committed[0].allocId);
      if (html.indexOf('<img src="data:image/png;base64,') < 0) {
        throw new Error('The letter has no QR image embedded');
      }
      if (html.indexOf('src="http') >= 0) throw new Error('The letter fetches a remote resource');
      return Math.round(html.length / 1024) + ' KB, QR embedded, no external requests';
    });

    step('QR is scannable density', function () {
      var committed = Db.readAll('Allocations').filter(function (a) { return a.status === 'ACTIVE'; });
      if (!committed.length) return 'skipped - no committed allocation yet';
      var url = Letters.verifyUrl(committed[0].allocId);
      var qr = QrCode.encode(url, { ec: 'L' });
      var perModule = 186 / (qr.size + 8);
      if (perModule < 3) {
        throw new Error('Only ' + perModule.toFixed(1) + ' px per module - too dense to scan');
      }
      return 'version ' + qr.version + ', ' + perModule.toFixed(1) + ' px per module';
    });

    step('Letter verification', function () {
      var committed = Db.readAll('Allocations').filter(function (a) { return a.status === 'ACTIVE'; });
      if (!committed.length) return 'skipped - no committed allocation yet';
      var id = committed[0].allocId;
      var good = Letters.verifyAllotment(id, Letters.signature(id));
      if (!good.valid) throw new Error('A genuine letter failed to verify: ' + good.reason);
      var forged = Letters.verifyAllotment(id, 'ffffffffff');
      if (forged.valid) throw new Error('A forged signature was accepted');
      return 'genuine accepted, forged rejected';
    }, true);

    step('Web app deployed', function () {
      var url = ScriptApp.getService().getUrl();
      if (!url) throw new Error('Not deployed - use Deploy > New deployment');
      return url;
    }, true);

    step('Email configuration', function () {
      var on = Notify.enabled();
      var quota = Notify.remainingQuota();
      return on ? 'ENABLED, ' + quota + ' sends left today'
                : 'disabled (safe for rehearsal) - set EMAIL_ENABLED to TRUE to send';
    });

    step('Tamper demo safety', function () {
      var on = String(Db.cfg('ALLOW_TAMPER_DEMO', 'FALSE')).toUpperCase() === 'TRUE';
      if (on) return 'ENABLED - remember to set ALLOW_TAMPER_DEMO back to FALSE';
      return 'disabled, as it should be outside a demo';
    });

    // ---------------------------------------------------------------- demo
    step('Demo cast', function () {
      if (!Db.readAll('Runs').length) return 'skipped - no committed run yet';
      var cast = DemoScenario.prepare({});
      if (cast.cast.length < 4) throw new Error('Only ' + cast.cast.length + ' characters found');
      return cast.cast.map(function (c) { return c.code; }).join(', ');
    });

    var failed = results.filter(function (r) { return !r.ok; });
    var criticalFailed = failed.filter(function (r) { return r.critical; });

    return {
      results: results,
      passed: results.length - failed.length,
      failed: failed.length,
      criticalFailed: criticalFailed.length,
      ready: criticalFailed.length === 0,
      elapsedSec: Util.round((new Date().getTime() - t0) / 1000, 1)
    };
  }

  /** Human-readable report. */
  function format(r) {
    var lines = [];
    r.results.forEach(function (x) {
      lines.push((x.ok ? 'PASS  ' : (x.critical ? 'FAIL  ' : 'WARN  ')) +
                 pad_(x.name, 28) + x.detail);
    });
    lines.push('');
    lines.push(r.passed + ' passed, ' + r.failed + ' failed, in ' + r.elapsedSec + 's');
    lines.push('');
    lines.push(r.ready
      ? 'READY. Nothing critical is broken.'
      : r.criticalFailed + ' CRITICAL FAILURE(S) - fix before demonstrating.');
    return lines.join('\n');
  }

  function pad_(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  return { run: run, format: format };
})();

/** Menu entry. */
function runDryRun() {
  var r = DryRun.run({});
  var text = DryRun.format(r);
  Logger.log(text);
  SpreadsheetApp.getUi().alert(
    r.ready ? 'Dry run: ready' : 'Dry run: ' + r.criticalFailed + ' critical failure(s)',
    text, SpreadsheetApp.getUi().ButtonSet.OK);
  return text;
}
