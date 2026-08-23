/**
 * RuleBook.gs - the corpus the assistant is allowed to answer from.
 *
 * Chunking, quantisation, and retrieval. NOTHING here touches the network:
 * embeddings arrive as plain arrays from Gemini.gs and leave as base64. That
 * split is deliberate - it is what lets the whole of retrieval be asserted
 * offline, including the ranking, rather than only the plumbing.
 *
 * WHY THE VECTORS ARE NOT JSON
 * ----------------------------
 * A 768-dimension float32 vector written as JSON is about 10 KB. At 400 chunks
 * that is 4 MB read out of the sheet and JSON.parse'd on EVERY question, which
 * costs seconds against a budget where the browser gives up at twenty-five.
 *
 * Normalised, quantised to int8 and base64'd, the same vector is ~1 KB. Four
 * hundred of them is 410 KB, decodes in milliseconds, and the reconstruction
 * error is around 0.4% - far below anything that reorders a top-six ranking.
 *
 * Cosine itself was never the problem. 400 x 768 is 307k multiply-adds, which
 * V8 does in single-digit milliseconds. The cost is transfer and parse, and
 * that is what quantising attacks.
 */

var RuleBook = (function () {

  var MAX_CHARS   = 1200;
  var TARGET_CHARS = 700;
  var MIN_CHARS   = 200;

  // ------------------------------------------------------------ text hygiene

  /**
   * The girls' brochure wraps every heading in zero-width spaces. Left in, a
   * heading never matches anything and half the students silently get a corpus
   * with no section titles - the worst kind of bug, because the other half is
   * fine and nobody looks.
   */
  function clean(text) {
    return String(text || '')
      .replace(/[​-‍﻿]/g, '')     // zero-width, and the BOM
      .replace(/ /g, ' ')                   // non-breaking space
      .replace(/\r\n?/g, '\n')
      // Dot and underscore leaders are the blank a form wants filled in. Sixty
      // full stops embed to nothing and crowd out real text in a chunk with
      // only 1200 characters to spend - but they are also the ONLY signal that
      // separates a form field from a numbered rule, so they collapse to a
      // single ellipsis rather than vanishing. isFormField_ reads that mark.
      .replace(/[.․]{4,}/g, ' … ')
      .replace(/_{4,}/g, ' … ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * Lines that repeat on almost every page are furniture, not content. Counting
   * them is more reliable than a regex per brochure: a header we have not seen
   * still gets stripped, and a genuine rule that happens to look like a header
   * survives because it appears once.
   */
  function stripFurniture_(lines) {
    var seen = {};
    lines.forEach(function (l) {
      var k = l.trim();
      if (k) seen[k] = (seen[k] || 0) + 1;
    });
    var threshold = Math.max(3, Math.floor(lines.length / 60));
    return lines.filter(function (l) {
      var k = l.trim();
      if (!k) return true;
      if (/^Page\s+\d+/i.test(k)) return false;
      if (/^\d{1,3}$/.test(k)) return false;               // a bare page number
      return (seen[k] || 0) < threshold || k.length > 80;  // long lines are content
    });
  }

  // ---------------------------------------------------------------- chunking

  /**
   * A dotted leader means a form field, not a rule.
   *
   * The girls' brochure numbers its application form the same way it numbers
   * its rules - "1. Name of Student Mr./Ms./Mrs. ......" - and treating those
   * as rule boundaries shreds the document into blanks. Boys has 139 genuine
   * numbered rules, girls appears to have 33; the whole difference is this.
   */
  function isFormField_(line) {
    // The ellipsis is what clean() leaves where a dot leader was. Raw runs are
    // still matched so the predicate works on text that never went through it.
    return /…/.test(line) || /\.{4,}/.test(line) || /_{4,}/.test(line);
  }

  function isHeadingLine_(line) {
    var t = line.trim();
    if (!t || t.length > 70 || isFormField_(t)) return false;
    if (/[.;,]$/.test(t)) return false;
    if (!/[A-Za-z]/.test(t)) return false;
    var letters = t.replace(/[^A-Za-z]/g, '');
    if (!letters) return false;
    return letters === letters.toUpperCase();
  }

  function isRuleStart_(line) {
    var t = line.trim();
    return /^\(?\d{1,3}[.)]\s+\S/.test(t) && !isFormField_(t) && t.length > 12;
  }

  /**
   * Split prose into retrievable chunks.
   *
   * @param {string} text
   * @param {{headings?: Array}} opts  parallel array of per-line headings when the
   *   source came from a converted Doc that carried real heading styles; the
   *   ALLCAPS heuristic is the fallback for everything else.
   */
  function chunkText(text, opts) {
    opts = opts || {};
    var lines = stripFurniture_(clean(text).split('\n'));
    var styled = opts.headings || null;

    var out = [];
    var heading = '';
    var buf = [];

    function flush() {
      var body = buf.join(' ').replace(/\s+/g, ' ').trim();
      buf = [];
      if (!body) return;
      // Oversized sections get a sliding window, and every continuation
      // re-carries the heading so a fragment still says what it belongs to.
      while (body.length > MAX_CHARS) {
        var cut = body.lastIndexOf(' ', TARGET_CHARS);
        if (cut < MIN_CHARS) cut = TARGET_CHARS;
        out.push({ heading: heading, text: body.slice(0, cut).trim() });
        body = body.slice(cut).trim();
      }
      if (body) out.push({ heading: heading, text: body });
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();
      if (!t) continue;

      var styledHeading = styled && styled[i] && styled[i] !== 'NORMAL';
      if (styledHeading || isHeadingLine_(t)) {
        flush();
        heading = t;
        continue;
      }
      if (isRuleStart_(t) && buf.join(' ').length >= MIN_CHARS) flush();
      buf.push(t);
    }
    flush();

    // Coalesce neighbours that share a heading, up to the target size.
    //
    // Splitting on every numbered rule is right for finding a boundary and
    // wrong for what gets embedded: a single clause of thirty words has too
    // little context to retrieve well, and answers arrive stripped of the
    // sentence that qualified them. Merging back up to ~700 characters keeps
    // whole rules together with their neighbours while never crossing a
    // section, which is the boundary that actually carries meaning.
    var merged = [];
    out.forEach(function (c) {
      var prev = merged[merged.length - 1];
      if (prev && prev.heading === c.heading &&
          prev.text.length + c.text.length + 1 <= TARGET_CHARS) {
        prev.text += ' ' + c.text;
        return;
      }
      merged.push(c);
    });
    return merged;
  }

  // ------------------------------------------------------------ quantisation

  function norm_(vec) {
    var s = 0;
    for (var i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    s = Math.sqrt(s) || 1;
    var out = new Array(vec.length);
    for (var j = 0; j < vec.length; j++) out[j] = vec[j] / s;
    return out;
  }

  /**
   * L2-normalise, then symmetric int8.
   *
   * Normalising first is REQUIRED, not tidy: gemini-embedding-001 returns unit
   * vectors only at its full 3072 dimensions. Ask for 768 and what comes back
   * is truncated and no longer unit length, so a cosine computed on it is not a
   * cosine.
   *
   * `scale` is kept per vector. It is tempting to drop it and rank on the raw
   * integer dot product, but scale varies between vectors, so that would order
   * by cos/scale_a - close enough to look right and wrong often enough to
   * matter. One float multiply per chunk buys correctness.
   */
  function quantise(vec) {
    var v = norm_(vec);
    var scale = 0;
    for (var i = 0; i < v.length; i++) scale = Math.max(scale, Math.abs(v[i]));
    if (!scale) scale = 1;

    var bytes = new Array(v.length);
    for (var j = 0; j < v.length; j++) {
      var q = Math.round(v[j] / scale * 127);
      if (q > 127) q = 127;
      if (q < -127) q = -127;
      bytes[j] = q;                       // signed, which is what Java expects
    }
    return { b64: Utilities.base64Encode(bytes), scale: scale, dims: v.length };
  }

  /**
   * SIGNED BYTES. Utilities.base64Decode hands back signed bytes on Apps Script
   * and unsigned ones under the Node stub. A decoder written against only one
   * of those passes its tests and is quietly wrong in production for every
   * value above 127 - which is half of them.
   *
   * Normalising on the way in makes both conventions the same. Util.sha256Hex
   * carries the same note for the same reason.
   */
  function dequantise(b64, scale, dims) {
    var raw = Utilities.base64Decode(b64);
    var n = dims || raw.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var b = raw[i];
      if (b > 127) b -= 256;
      out[i] = b / 127 * scale;
    }
    return out;
  }

  function dot(a, b) {
    var n = Math.min(a.length, b.length), s = 0;
    for (var i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  // --------------------------------------------------------------- retrieval

  var _matrix = null;

  /** Decoded corpus, memoised for the execution. */
  function matrix(fresh) {
    if (_matrix && !fresh) return _matrix;
    _matrix = Db.readAll('RuleChunks', { fresh: !!fresh })
      .filter(function (r) { return r.active !== false && r.vec; })
      .map(function (r) {
        return {
          chunkId: r.chunkId, source: r.source, sourceRef: r.sourceRef,
          gender: r.gender, campus: r.campus, heading: r.heading, text: r.text,
          vec: dequantise(r.vec, Number(r.scale) || 1, Number(r.dims) || 0)
        };
      });
    return _matrix;
  }

  function invalidate() { _matrix = null; }

  function numericTokens_(s) {
    return String(s || '').match(/\d[\d,.]*%?/g) || [];
  }

  /**
   * Rank the corpus against an already-embedded question.
   *
   * The bonus, not a prefilter. A lexical PREfilter would cut the number of
   * cosines, and cosines are already free - while costing recall on exactly the
   * questions students ask, which are paraphrases sharing no rare words with
   * the rule that answers them. What dense retrieval is genuinely bad at is
   * literal numbers: "35000", "75%", "rule 12". So numbers get a small bonus
   * and nothing gets excluded.
   *
   * @param {Array<number>} queryVec  raw or normalised; normalised here anyway
   * @param {string} question         for the numeric bonus
   * @param {{k?, minSim?, gender?, campus?}} opts
   */
  function search(queryVec, question, opts) {
    opts = opts || {};
    var k = opts.k || 6;
    var minSim = opts.minSim === undefined ? 0.45 : opts.minSim;
    var q = norm_(queryVec);
    var qNums = numericTokens_(question);

    var scored = matrix().filter(function (c) {
      // The two hard partitions. A blank or ALL on the chunk means it applies
      // to everyone; anything else must match the person asking.
      if (opts.gender && c.gender && c.gender !== 'ALL' && c.gender !== opts.gender) return false;
      if (opts.campus && c.campus && c.campus !== 'ALL' && c.campus !== opts.campus) return false;
      return true;
    }).map(function (c) {
      var cos = dot(q, c.vec);
      var bonus = 0;
      if (qNums.length) {
        var hit = 0;
        for (var i = 0; i < qNums.length; i++) {
          if (c.text.indexOf(qNums[i]) >= 0) hit++;
        }
        bonus = 0.08 * (hit / qNums.length);
      }
      return {
        chunkId: c.chunkId, source: c.source, sourceRef: c.sourceRef,
        heading: c.heading, text: c.text,
        similarity: Util.round(cos, 4), score: cos + bonus
      };
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunkId < b.chunkId ? -1 : 1;      // deterministic ties
    });
    return scored.filter(function (c) { return c.score >= minSim; }).slice(0, k);
  }

  // --------------------------------------------------------------- ingestion

  /**
   * A short fingerprint of a passage.
   *
   * This is what lets a reload keep the vectors it has already paid for:
   * identical text keeps its embedding, so re-running after a code change costs
   * nothing and only genuinely altered passages go back to the API.
   */
  function hash_(text) {
    return Ledger.sha256(String(text)).substring(0, 16);
  }

  /**
   * Load the brochures that ship with this project.
   *
   * The admission brochures are fixed for the session, so they live in
   * RuleText.gs and arrive with the code. There is no upload step, no Drive
   * file id to find, and no way for a deployment to end up with a rule book
   * that does not match the source it claims to quote.
   *
   * Vectors are preserved wherever the text is byte-identical, so re-running
   * this after a code change costs nothing. Only genuinely new or altered
   * passages need embedding again.
   */
  function loadBundled() {
    if (typeof RULE_TEXT === 'undefined') {
      throw new Error('RuleText.gs is missing from this deployment, so there are no ' +
                      'hostel rules to load. Push the full source and try again.');
    }

    var byHash = {};
    Db.readAll('RuleChunks', { fresh: true }).forEach(function (r) {
      if (r.vec) byHash[r.textHash] = r;
    });

    var rows = [];
    RULE_TEXT.sources.forEach(function (src) {
      src.chunks.forEach(function (pair, i) {
        var heading = pair[0], text = pair[1];
        var h = hash_(text);
        var prior = byHash[h];
        rows.push({
          chunkId: 'RC-' + src.gender + '-' + Util.pad(i + 1, 4),
          source: 'BROCHURE',
          sourceRef: src.sourceRef,
          gender: src.gender,
          campus: src.campus,
          heading: heading,
          text: text,
          textHash: h,
          dims: prior ? prior.dims : '',
          scale: prior ? prior.scale : '',
          vec: prior ? prior.vec : '',
          embeddedAt: prior ? prior.embeddedAt : '',
          active: true
        });
      });
    });

    Db.replaceAll('RuleChunks', rows);
    invalidate();
    return {
      session: RULE_TEXT.session,
      chunks: rows.length,
      reused: rows.filter(function (r) { return !!r.vec; }).length,
      sources: RULE_TEXT.sources.map(function (s) { return s.sourceRef; })
    };
  }

  /** Rows still needing an embedding. */
  function pending(limit) {
    var rows = Db.readAll('RuleChunks', { fresh: true }).filter(function (r) {
      return r.active !== false && !r.vec;
    });
    return limit ? rows.slice(0, limit) : rows;
  }

  /** Write vectors back for a batch that Gemini.gs has just embedded. */
  function storeVectors(pairs) {
    var byId = {};
    pairs.forEach(function (p) { byId[p.chunkId] = p.vector; });

    var all = Db.readAll('RuleChunks', { fresh: true });
    var now = new Date();
    var n = 0;
    all.forEach(function (r) {
      var v = byId[r.chunkId];
      if (!v) return;
      var q = quantise(v);
      r.vec = q.b64; r.scale = q.scale; r.dims = q.dims; r.embeddedAt = now;
      n++;
    });
    Db.replaceAll('RuleChunks', all);
    invalidate();
    return n;
  }

  function stats() {
    var rows = Db.readAll('RuleChunks', { fresh: true });
    var bySource = {};
    rows.forEach(function (r) { bySource[r.source] = (bySource[r.source] || 0) + 1; });
    return {
      total: rows.length,
      embedded: rows.filter(function (r) { return !!r.vec; }).length,
      pending: rows.filter(function (r) { return !r.vec; }).length,
      bySource: bySource
    };
  }

  return {
    clean: clean,
    chunkText: chunkText,
    quantise: quantise,
    dequantise: dequantise,
    matrix: matrix,
    invalidate: invalidate,
    search: search,
    loadBundled: loadBundled,
    pending: pending,
    storeVectors: storeVectors,
    stats: stats
  };
})();
