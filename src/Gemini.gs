/**
 * Gemini.gs - the only file in this project that leaves the machine.
 *
 * Everything else runs on Sheets, Drive and Gmail inside the user's own Google
 * account. This one calls an external API, so it is kept deliberately small and
 * deliberately alone: one place to audit, one place to stub, one place to
 * change when Google renames a model.
 *
 * MODEL NAMES LIVE IN Config, NOT HERE. Google retires model ids on a schedule
 * and cut free-tier limits sharply in December 2025. A name compiled into the
 * source is a redeploy; a name in the sheet is a cell edit. That is the same
 * argument Policy.gs makes for allocation rules, and it applies harder here
 * because the deprecation date is somebody else's decision.
 */

var Gemini = (function () {

  var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

  function key_() {
    var k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!k) {
      // Name the fix, not just the fault - this message reaches an administrator
      // who has never opened the Apps Script editor before.
      throw new Error('No Gemini API key is set. In the Apps Script editor open ' +
                      'Project Settings, scroll to Script Properties, and add ' +
                      'GEMINI_API_KEY with a key from aistudio.google.com/apikey.');
    }
    return k;
  }

  /** True when the assistant can run at all. Never throws - the UI asks this first. */
  function available() {
    try {
      return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    } catch (e) {
      return false;
    }
  }

  function chatModel()  { return String(Db.cfg('GEMINI_CHAT_MODEL', 'gemini-3.5-flash-lite')); }
  function embedModel() { return String(Db.cfg('GEMINI_EMBED_MODEL', 'gemini-embedding-001')); }
  function embedDims()  { return Number(Db.cfg('GEMINI_EMBED_DIMS', 768)) || 768; }

  /**
   * One HTTP call.
   *
   * The key goes in a header, never the query string. UrlFetchApp puts the URL
   * into the message of anything it throws, and an exception carrying a live
   * API key can end up in an execution log, a bug report or a screenshot.
   *
   * Retries only on 503. A 429 means the free-tier allowance is gone and
   * retrying just burns the next request too; a 400 means we built the payload
   * wrong and will build it wrong again.
   */
  function fetch_(model, method, payload) {
    var res, code;
    for (var attempt = 0; attempt < 2; attempt++) {
      res = UrlFetchApp.fetch(ENDPOINT + model + ':' + method, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key_() },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      if (code !== 503) break;
    }
    return { code: code, body: res.getContentText() };
  }

  /**
   * QUOTA is separated from TRANSIENT because they need different words. "Try
   * again in a moment" is wrong for an allowance that resets tomorrow, and a
   * student who retries all afternoon on that advice learns to distrust the
   * whole page.
   */
  function classify(code) {
    if (code === 200) return 'OK';
    if (code === 429) return 'QUOTA';
    // 404 is CONFIG, not TRANSIENT. It means the model id does not exist for
    // this key - usually because Google retired it - and no amount of retrying
    // will bring it back. Treating it as transient tells an administrator to
    // wait for a service that is never coming, instead of changing one cell.
    if (code === 400 || code === 401 || code === 403 || code === 404) return 'CONFIG';
    return 'TRANSIENT';
  }

  /**
   * How long Google says to wait.
   *
   * A 429 carries the answer, in two places depending on the endpoint: a
   * RetryInfo entry in error.details, or the tail of the message. Guessing a
   * backoff when the server has told you the number is how a client ends up
   * either hammering a closed door or sleeping far longer than it needed to.
   */
  function retryAfterMs_(body) {
    var s = String(body || '');
    try {
      var details = ((JSON.parse(s).error || {}).details) || [];
      for (var i = 0; i < details.length; i++) {
        var d = details[i].retryDelay || details[i].retry_delay;
        if (d) return Math.ceil(parseFloat(d) * 1000);
      }
    } catch (e) { /* fall through to the message */ }
    var m = s.match(/retry in ([\d.]+)\s*s/i);
    return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
  }

  // Which models have refused thinkingConfig. CacheService rather than Config:
  // it is a fact about Google's current behaviour, not a setting anyone chose,
  // and it should expire on its own rather than becoming a stale row an
  // administrator has to reason about.
  function thinkKey_(model) { return 'gem.nothink.' + model; }

  function rejectsThinking_(model) {
    try {
      var c = CacheService.getScriptCache();
      return !!(c && c.get(thinkKey_(model)));
    } catch (e) { return false; }
  }

  function noteRejectsThinking_(model) {
    try {
      var c = CacheService.getScriptCache();
      if (c) c.put(thinkKey_(model), '1', 21600);   // six hours
    } catch (e) { /* the fallback still works, just less cheaply */ }
  }

  /**
   * The replacement model Google names in a 404.
   *
   * "This model models/X is no longer available to new users. Please update
   * your code to use models/Y" - Y is the only thing in that sentence worth
   * acting on, and parsing it is more reliable than maintaining our own table
   * of what superseded what.
   */
  function successor_(body) {
    var m = String(body || '').match(/use\s+models\/([A-Za-z0-9._-]+)/);
    return m ? m[1] : '';
  }

  /**
   * Everything Google said, not just the headline.
   *
   * "Request contains an invalid argument" names no argument, and on its own it
   * sends whoever is debugging round in circles. The useful part - which field,
   * and why - is in error.details, and dropping it turns a five-second fix into
   * an afternoon of guessing.
   */
  function fail_(code, body) {
    var msg = '', extra = [];
    try {
      var e = JSON.parse(body).error || {};
      msg = e.message || '';
      (e.details || []).forEach(function (d) {
        if (d.reason) extra.push(d.reason);
        if (d.description) extra.push(d.description);
        (d.fieldViolations || []).forEach(function (v) {
          extra.push((v.field || '') + ' ' + (v.description || ''));
        });
      });
    } catch (ignored) { msg = ''; }

    if (extra.length) msg += ' [' + extra.join('; ') + ']';

    // "Request contains an invalid argument" with no details is Google saying
    // nothing at all. When that happens the raw body is the only evidence there
    // is, so it is carried rather than discarded - a truncated payload beats
    // another round of guessing at which field it disliked.
    // ...but only when it actually says more than the message already did.
    // A body that is nothing but the same sentence in JSON adds noise, and the
    // absence of detail is itself worth reading plainly: Google said nothing.
    if (!extra.length) {
      var raw = String(body || '').replace(/\s+/g, ' ').substring(0, 300);
      if (raw.length > msg.length + 40) msg += ' | raw: ' + raw;
      else if (msg) msg += ' (Google returned no further detail)';
    }

    var err = new Error(msg || ('Gemini returned HTTP ' + code));
    err.kind = classify(code);
    err.httpCode = code;
    err.retryAfterMs = code === 429 ? (retryAfterMs_(body) || 15000) : 0;
    return err;
  }

  /**
   * Embed one or more texts. Returns raw vectors - normalisation and
   * quantisation belong to RuleBook, which is where they can be tested.
   *
   * Sent in batches, so a 250-passage brochure is ten calls rather than 250 -
   * but the free tier meters the CONTENTS of a batch, not the call, so the
   * caller still has to pace itself. See the note at the loop below.
   *
   * @param {Array<string>} texts
   * @param {string} taskType RETRIEVAL_DOCUMENT when storing, RETRIEVAL_QUERY when asking
   */
  function embed(texts, taskType) {
    var list = [].concat(texts);
    if (!list.length) return [];
    var dims = embedDims();
    var model = embedModel();

    // Batches of 25, not 100.
    //
    // The free tier meters `embed_content_free_tier_requests` at 100 per minute
    // and counts the CONTENTS of a batch, not the HTTP call - so one request
    // carrying a hundred passages spends the whole minute's allowance at once
    // and the next call is refused. Smaller batches let the caller pace itself
    // and keep each rejection cheap.
    var out = [];
    for (var i = 0; i < list.length; i += 25) {
      var slice = list.slice(i, i + 25);
      var r = fetch_(model, 'batchEmbedContents', {
        requests: slice.map(function (t) {
          return {
            model: 'models/' + model,
            content: { parts: [{ text: String(t) }] },
            taskType: taskType || 'RETRIEVAL_DOCUMENT',
            outputDimensionality: dims
          };
        })
      });
      if (r.code !== 200) throw fail_(r.code, r.body);
      var parsed = JSON.parse(r.body);
      (parsed.embeddings || []).forEach(function (e) { out.push(e.values || e.value || []); });
    }
    return out;
  }

  /**
   * One completion.
   *
   * thinkingBudget 0 is the single largest latency lever available. The 2.5
   * models otherwise spend seconds generating reasoning tokens nobody will ever
   * read, and UrlFetchApp has no timeout parameter - there is no way to cut a
   * slow response short from inside Apps Script, so the only control is not
   * asking for the slow thing in the first place.
   */
  // The largest prompt worth sending. A rule book answer needs the passages and
  // the asker's own record, and nothing that size is improved by being bigger -
  // but a stray field can make a prompt grow without anyone noticing, and an
  // over-long one comes back as a bare "invalid argument" with no clue which
  // part was too much.
  var MAX_PROMPT_CHARS = 24000;

  /**
   * Make a prompt safe to send.
   *
   * Text assembled from spreadsheet cells and OCR'd documents carries things
   * JSON will happily encode and the API will then reject: C0 control
   * characters, and lone halves of surrogate pairs left behind when a string
   * was cut mid-emoji. Both produce exactly the unhelpful 400 above.
   */
  function sanitise_(text) {
    var s = String(text || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
    if (s.length > MAX_PROMPT_CHARS) {
      // Keep the head: the instructions and the highest-ranked passages are
      // there, and losing the tail costs the weakest evidence rather than the
      // rules the answer is built on.
      s = s.substring(0, MAX_PROMPT_CHARS) + '\n\n[context truncated]';
    }
    return s;
  }

  function generate(prompt, opts) {
    opts = opts || {};
    prompt = sanitise_(prompt);

    function body_(withThinking) {
      var cfg = {
        temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
        maxOutputTokens: opts.maxOutputTokens || 400
      };
      // thinkingBudget is the biggest latency lever there is, but not every
      // model accepts the field, and the ones that do not reject the whole
      // request with a 400 rather than ignoring it. Ask for it, and fall back
      // once if that is what was wrong - a slower answer beats no answer.
      if (withThinking) cfg.thinkingConfig = { thinkingBudget: 0 };
      return {
        contents: [{ role: 'user', parts: [{ text: String(prompt) }] }],
        generationConfig: cfg
      };
    }

    var model = chatModel();

    // Ask for thinkingConfig only until this model has refused it once.
    //
    // Without the memory the fallback costs a wasted request on EVERY question
    // rather than once: the model rejects the field, we retry without it, and
    // then do exactly the same thing on the next question. Remembering turns a
    // permanent 100% overhead into a single request, and the note expires by
    // itself so a model that later gains support is retried rather than
    // written off forever.
    var refuses = rejectsThinking_(model);
    var r = fetch_(model, 'generateContent', body_(!refuses));

    // Any 400 retries once without it, not only one that says so. Models that
    // reject the field do not agree on how to complain: some name it, others
    // answer the generic "Request contains an invalid argument" and leave you
    // guessing. Matching on the wording fired for one model and not the next.
    if (r.code === 400 && !refuses) {
      r = fetch_(model, 'generateContent', body_(false));
      if (r.code === 200) noteRejectsThinking_(model);
    }

    // A retired model answers with a 404 that NAMES its replacement. Reading
    // that and moving on is strictly better than making an administrator
    // translate an error message into a cell edit - and it is not a guess,
    // because the new id came from Google rather than from us.
    //
    // The new name is written back to Config so this costs one wasted request
    // once, not on every question, and so the sheet stays the honest record of
    // what the system is actually calling.
    if (r.code === 404) {
      var suggested = successor_(r.body);
      if (suggested && suggested !== chatModel()) {
        var retry = fetch_(suggested, 'generateContent', body_(true));
        if (retry.code === 400 && /thinking/i.test(retry.body)) {
          retry = fetch_(suggested, 'generateContent', body_(false));
        }
        if (retry.code === 200) {
          try {
            Db.setCfg('GEMINI_CHAT_MODEL', suggested);
            Ledger.append('CHAT_MODEL_MIGRATED',
              { from: chatModel(), to: suggested, reason: 'retired by Google' }, 'system');
          } catch (e) { /* the answer matters more than recording why */ }
          r = retry;
        }
      }
    }

    if (r.code !== 200) throw fail_(r.code, r.body);

    var parsed = JSON.parse(r.body);
    var cand = (parsed.candidates || [])[0] || {};
    var parts = ((cand.content || {}).parts || []);
    return {
      text: parts.map(function (p) { return p.text || ''; }).join('').trim(),
      finishReason: cand.finishReason || '',
      model: chatModel(),
      tokens: (parsed.usageMetadata || {}).totalTokenCount || 0
    };
  }

  return {
    available: available,
    embed: embed,
    generate: generate,
    classify: classify,
    chatModel: chatModel,
    embedModel: embedModel,
    embedDims: embedDims
  };
})();
