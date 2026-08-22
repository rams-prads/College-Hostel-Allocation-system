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
    var key = norm_(email);

    var s = {
      email: email,
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
    selfEnrolAdmin: selfEnrolAdmin,
    normaliseEmail: norm_
  };
})();
