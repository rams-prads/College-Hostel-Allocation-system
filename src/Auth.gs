/**
 * Auth.gs - session resolution and role guard.
 *
 * The web app is deployed "execute as me / anyone with a Google account", so
 * Session.getActiveUser() gives us the visitor's identity for free - no
 * passwords, no token handling. Identity is then matched against Admins and
 * Students to decide what the visitor may see.
 *
 * The provider indirection below exists so an OTP login can be added later
 * (Phase 7) without touching any caller.
 */

var Auth = (function () {

  /**
   * Resolve the current visitor.
   * @return {{email, isAdmin, role, campus, student, application, name}}
   */
  /** Email addresses are case-insensitive; a stored address may not be. */
  function norm_(e) { return String(e || '').trim().toLowerCase(); }

  // The session token supplied by the client for THIS request. Apps Script runs
  // one request per execution, so a module variable is request-scoped by nature.
  var _requestToken = null;

  /** Called by the dispatcher before it runs anything. */
  function useToken(token) { _requestToken = token || null; }

  /** The address the current request's token asserts, or '' if there is none. */
  function tokenEmail() {
    if (!_requestToken) return '';
    try { return SignIn.emailFromToken(_requestToken); } catch (e) { return ''; }
  }

  function session() {
    var email = '';
    var authError = '';
    try {
      email = Session.getActiveUser().getEmail() || '';
    } catch (e) {
      // Swallowing this made an authorisation failure and an anonymous visitor
      // render the identical dead end, which is a miserable thing to diagnose.
      email = '';
      authError = e.message || String(e);
    }

    // Google identifies the owner and their own domain, and nobody else. A
    // first-year applicant has no college address yet, so for them the signed
    // token IS the session. The platform's answer wins when it has one, because
    // it cannot be forged; the token is checked only when there is no answer.
    var via = email ? 'GOOGLE' : null;
    if (!email) {
      email = tokenEmail();
      if (email) via = 'EMAIL_CODE';
    }

    var key = norm_(email);

    var s = {
      email: email,
      via: via,
      authError: authError,
      name: '',
      isAdmin: false,
      role: 'GUEST',
      campus: null,
      student: null,
      application: null
    };
    if (!key) return s;

    // Compare normalised on BOTH sides. Matching raw strings meant an admin who
    // typed their address with a capital letter was silently locked out of their
    // own dashboard, which is a miserable thing to debug at a demo.
    var admin = Db.readAll('Admins').filter(function (a) {
      return norm_(a.email) === key;
    })[0];
    if (admin && admin.active) {
      s.isAdmin = true;
      s.role = admin.role;
      s.campus = admin.campus;
      s.name = admin.name;
    }

    var student = Db.readAll('Students').filter(function (st) {
      return norm_(st.email) === key;
    })[0];
    if (student) {
      s.student = student;
      s.name = s.name || student.name;
      s.role = s.isAdmin ? s.role : 'STUDENT';
      s.application = Db.findOne('Applications', { studentId: student.studentId });
    }

    return s;
  }

  /**
   * Add the signed-in user as a super administrator.
   * Deliberately callable only from the spreadsheet, where being able to open
   * the sheet already implies ownership.
   */
  function selfEnrolAdmin() {
    var email = Session.getActiveUser().getEmail();
    if (!email) throw new Error('Could not determine your Google account.');
    var key = norm_(email);

    var existing = Db.readAll('Admins').filter(function (a) {
      return norm_(a.email) === key;
    })[0];

    if (existing) {
      Db.update('Admins', existing.email, { active: true, role: 'SUPER_ADMIN', campus: 'ALL' });
      return { email: email, action: 'reactivated' };
    }
    Db.append('Admins', {
      email: email, name: 'Administrator', role: 'SUPER_ADMIN',
      campus: 'ALL', active: true
    });
    Ledger.append('ADMIN_ENROLLED', { email: email }, email);
    return { email: email, action: 'added' };
  }

  /** Throw unless the visitor is an admin. Use at the top of every admin RPC. */
  function requireAdmin() {
    var s = session();
    if (!s.isAdmin) throw new Error('Access denied: administrator privileges required.');
    return s;
  }

  /**
   * Fixed-window rate limit, keyed per caller per action.
   *
   * Anything that costs the server real work, or that an attacker would want to
   * repeat - uploading files, submitting an identity for checking - needs a
   * ceiling. Without one, a single account can exhaust the Drive quota or grind
   * a guessed number against the identity vault.
   *
   * The counter lives in CacheService rather than Script Properties: it expires
   * by itself, and a rate limiter that leaks storage is its own denial of
   * service. A cache miss fails OPEN - losing the counter must never lock a
   * legitimate student out of their own application.
   *
   * @param {string} action  namespace, e.g. 'upload'
   * @param {string} who     caller identity, normally the email
   * @param {number} limit   attempts allowed in the window
   * @param {number} windowSeconds
   */
  function rateLimit(action, who, limit, windowSeconds) {
    windowSeconds = windowSeconds || 3600;
    var cache;
    try { cache = CacheService.getScriptCache(); } catch (e) { return; }
    if (!cache) return;

    var bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    var key = 'rl.' + action + '.' + norm_(who) + '.' + bucket;

    var n = 0;
    try { n = parseInt(cache.get(key) || '0', 10) || 0; } catch (e) { return; }

    if (n >= limit) {
      throw new Error('Too many ' + action + ' attempts. Please wait a few minutes ' +
                      'and try again.');
    }
    try { cache.put(key, String(n + 1), windowSeconds); } catch (e) { /* fail open */ }
  }

  // ------------------------------------------------------------ demo links
  //
  // Session.getActiveUser() returns an EMPTY STRING for every visitor except
  // the owner when a web app is deployed "execute as me" from a consumer Google
  // account. It is documented Apps Script behaviour, not a fault here: outside a
  // Workspace domain the platform will not tell the script who the visitor is.
  //
  // Deployed from an institutional account (@ipu.ac.in) every student in that
  // domain resolves normally and none of this is needed. But that account does
  // not exist yet, and a demo has to show a student's own screen on a second
  // device without the owner signed into it.
  //
  // So: a signed, expiring, READ-ONLY capability link. Whoever holds it sees one
  // applicant's portal and can do nothing else - every write path calls
  // session() first, finds no email, and refuses. That property is not a check
  // added here; it falls out of the design, which is why it cannot be forgotten.
  //
  // OFF by default. It is a bypass, and a bypass that ships enabled is a hole.

  function demoKey_() {
    var props = PropertiesService.getScriptProperties();
    var k = props.getProperty('DEMO_LINK_KEY');
    if (!k) {
      k = Utilities.getUuid() + '-' + Utilities.getUuid();
      props.setProperty('DEMO_LINK_KEY', k);
    }
    return k;
  }

  function demoSig_(payload) {
    var sig = Utilities.computeHmacSha256Signature(payload, demoKey_());
    return sig.map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    }).join('').substring(0, 24);
  }

  function demoEnabled() {
    return String(Db.cfg('ALLOW_DEMO_LINKS', 'FALSE')).toUpperCase() === 'TRUE';
  }

  /**
   * Mint a read-only link for one application.
   * @param {number=} hours  lifetime, default 24
   */
  function demoToken(appId, hours) {
    var exp = Date.now() + (Number(hours) || 24) * 3600 * 1000;
    var payload = appId + '~' + exp;
    return payload + '~' + demoSig_(payload);
  }

  /**
   * Validate a demo token. Returns the appId, or null for anything wrong -
   * disabled, malformed, expired, or re-signed.
   */
  function checkDemoToken(token) {
    if (!demoEnabled()) return null;
    var parts = String(token || '').split('~');
    if (parts.length !== 3) return null;

    var appId = parts[0], exp = Number(parts[1]), sig = parts[2];
    if (!appId || !exp || !sig) return null;

    var expected = demoSig_(appId + '~' + exp);
    // Constant-time: this is compared on a path anyone can call repeatedly.
    if (expected.length !== sig.length) return null;
    var diff = 0;
    for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return null;

    if (Date.now() > exp) return null;
    return appId;
  }

  /** Throw unless the visitor owns this application. Prevents ID tampering. */
  function requireOwner(appId) {
    var s = session();
    if (s.isAdmin) return s;
    if (!s.application || s.application.appId !== appId) {
      throw new Error('Access denied: this application does not belong to you.');
    }
    return s;
  }

  /** Roles that may approve allocations and commit runs. */
  function canCommit(s) {
    return s.isAdmin && (s.role === 'SUPER_ADMIN' || s.role === 'WARDEN');
  }

  return {
    session: session,
    requireAdmin: requireAdmin,
    requireOwner: requireOwner,
    canCommit: canCommit,
    rateLimit: rateLimit,
    useToken: useToken,
    tokenEmail: tokenEmail,
    demoEnabled: demoEnabled,
    demoToken: demoToken,
    checkDemoToken: checkDemoToken,
    selfEnrolAdmin: selfEnrolAdmin,
    normaliseEmail: norm_
  };
})();
