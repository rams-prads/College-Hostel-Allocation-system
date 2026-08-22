/**
 * SignIn.gs - sign-in for people Google will not identify for us.
 *
 * WHY THIS EXISTS
 * ---------------
 * Under "Execute as: Me", Session.getActiveUser() returns an address only for
 * the project owner and for people on the owner's Workspace domain. Everyone
 * else gets an empty string.
 *
 * Deploying from an @ipu.ac.in account solves that for continuing students. It
 * does NOT solve it for first-years, who are issued a college address three or
 * four months AFTER they join - and hostel allocation happens before they arrive.
 * The students most likely to need a hostel bed are precisely the ones a
 * domain-only login shuts out. That is not an edge case to document, it is the
 * main case.
 *
 * So: a one-time code sent to whatever email address the applicant actually has.
 * Any address works, on any domain, with no Google Cloud project and no OAuth
 * client to configure. When the college address arrives months later, it works
 * too, through the same door.
 *
 * HOW A SESSION IS REPRESENTED
 * ----------------------------
 * The session token is not stored anywhere. It is a signed, expiring assertion:
 *
 *     <email>~<expiry>~<HMAC-SHA256 of the two, keyed>
 *
 * The server can verify it without holding any state, which means no session
 * table to grow, to leak, or to clean up, and a restart cannot log anyone out.
 * The cost is that a token cannot be revoked before it expires - so it expires
 * in twelve hours, and signing out discards the client's copy.
 *
 * The one-time codes DO need storing, briefly. They live in CacheService, which
 * forgets them by itself; a code store that leaks entries is its own outage.
 */

var SignIn = (function () {

  var CODE_TTL_SECONDS    = 600;        // ten minutes to type six digits
  var SESSION_TTL_HOURS   = 12;
  var MAX_ATTEMPTS        = 5;          // per issued code
  var CODES_PER_HOUR      = 4;          // per email address

  // ------------------------------------------------------------------ keys

  function key_(name) {
    var props = PropertiesService.getScriptProperties();
    var k = props.getProperty(name);
    if (!k) {
      k = Utilities.getUuid() + '-' + Utilities.getUuid();
      props.setProperty(name, k);
    }
    return k;
  }

  function hmac_(payload, keyName) {
    var sig = Utilities.computeHmacSha256Signature(payload, key_(keyName));
    return sig.map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    }).join('');
  }

  /** Constant-time compare. Both codes and tokens are attacker-supplied. */
  function equal_(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function normEmail_(e) { return String(e || '').trim().toLowerCase(); }

  function validEmail_(e) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(normEmail_(e));
  }

  // ------------------------------------------------------------- one-time code

  /**
   * Six digits from getUuid(), which is a random v4 UUID. Math.random() is not
   * seeded from anything unpredictable in Apps Script and must not be used to
   * generate something that authorises access.
   */
  function makeCode_() {
    var hex = Utilities.getUuid().replace(/-/g, '');
    var n = 0;
    for (var i = 0; i < 8; i++) n = (n * 16 + parseInt(hex.charAt(i), 16)) % 1000000;
    var s = String(n);
    while (s.length < 6) s = '0' + s;
    return s;
  }

  function cache_() {
    try { return CacheService.getScriptCache(); } catch (e) { return null; }
  }

  /**
   * Send a one-time code.
   *
   * Always reports success. Saying "no account with that address" would turn
   * this into a way to test which addresses are registered, and registration is
   * open to anyone anyway - there is nothing to gain by leaking it.
   */
  function requestCode(email) {
    var addr = normEmail_(email);
    if (!validEmail_(addr)) throw new Error('Enter a valid email address.');

    Auth.rateLimit('signin-code', addr, CODES_PER_HOUR, 3600);

    var c = cache_();
    if (!c) throw new Error('Sign-in is temporarily unavailable. Please try again shortly.');

    var code = makeCode_();
    // The code is stored hashed. A cache dump should not hand over live codes.
    c.put('otp.' + addr, hmac_(addr + '|' + code, 'SIGNIN_CODE_KEY'), CODE_TTL_SECONDS);
    c.put('otpn.' + addr, '0', CODE_TTL_SECONDS);

    var institution = Db.cfg('INSTITUTION_SHORT', 'GGSIPU');
    var support = Db.cfg('SUPPORT_EMAIL', '');

    MailApp.sendEmail({
      to: addr,
      subject: code + ' is your ' + institution + ' hostel portal sign-in code',
      htmlBody:
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:460px;' +
        'color:#121c2e;line-height:1.55">' +
        '<p style="margin:0 0 18px">Use this code to sign in to the ' + institution +
        ' hostel allocation portal:</p>' +
        '<p style="font-size:34px;font-weight:700;letter-spacing:7px;margin:0 0 18px;' +
        'font-variant-numeric:tabular-nums">' + code + '</p>' +
        '<p style="margin:0 0 14px;font-size:14px">It expires in ten minutes and can be ' +
        'used once.</p>' +
        '<p style="margin:0;font-size:13px;color:#6b7a90">If you did not ask for this, ' +
        'someone typed your address by mistake. You can ignore it &mdash; nobody can sign ' +
        'in without the code' + (support ? ', but tell ' + support + ' if it keeps happening'
                                          : '') + '.</p></div>'
    });

    return { sent: true, email: addr, expiresInMinutes: Math.round(CODE_TTL_SECONDS / 60) };
  }

  /**
   * Exchange a code for a session token.
   *
   * A wrong code burns an attempt. Five wrong attempts destroy the code
   * outright, so a six-digit space cannot be searched: an attacker gets five
   * guesses out of a million and then has to trigger another email, which is
   * itself capped at four an hour.
   */
  function verifyCode(email, code) {
    var addr = normEmail_(email);
    var digits = String(code || '').replace(/\D/g, '');
    var c = cache_();
    if (!c) throw new Error('Sign-in is temporarily unavailable. Please try again shortly.');

    var stored = c.get('otp.' + addr);
    if (!stored) {
      throw new Error('That code has expired or was already used. Ask for a new one.');
    }

    var attempts = parseInt(c.get('otpn.' + addr) || '0', 10) + 1;
    if (attempts > MAX_ATTEMPTS) {
      c.remove('otp.' + addr);
      c.remove('otpn.' + addr);
      throw new Error('Too many incorrect attempts. Ask for a new code.');
    }
    c.put('otpn.' + addr, String(attempts), CODE_TTL_SECONDS);

    if (!equal_(stored, hmac_(addr + '|' + digits, 'SIGNIN_CODE_KEY'))) {
      throw new Error('That code is not right. ' +
                      (MAX_ATTEMPTS - attempts) + ' attempt' +
                      (MAX_ATTEMPTS - attempts === 1 ? '' : 's') + ' left.');
    }

    // Single use.
    c.remove('otp.' + addr);
    c.remove('otpn.' + addr);

    Ledger.append('SIGNIN_EMAIL_VERIFIED', { email: addr }, addr);
    return { token: mintToken(addr), email: addr, expiresInHours: SESSION_TTL_HOURS };
  }

  // ------------------------------------------------------------------ session

  function mintToken(email) {
    var addr = normEmail_(email);
    var exp = Date.now() + SESSION_TTL_HOURS * 3600 * 1000;
    var payload = addr + '~' + exp;
    return payload + '~' + hmac_(payload, 'SIGNIN_SESSION_KEY').substring(0, 32);
  }

  /** The email a token asserts, or '' for anything wrong. */
  function emailFromToken(token) {
    var parts = String(token || '').split('~');
    if (parts.length !== 3) return '';

    var addr = parts[0], exp = Number(parts[1]), sig = parts[2];
    if (!addr || !exp || !sig) return '';
    if (!equal_(sig, hmac_(addr + '~' + exp, 'SIGNIN_SESSION_KEY').substring(0, 32))) return '';
    if (Date.now() > exp) return '';
    return addr;
  }

  return {
    requestCode: requestCode,
    verifyCode: verifyCode,
    mintToken: mintToken,
    emailFromToken: emailFromToken,
    sessionHours: SESSION_TTL_HOURS
  };
})();

// ------------------------------------------------------------------ endpoints

/** Ask for a one-time code. */
function apiRequestSignInCode(email) {
  return SignIn.requestCode(email);
}

/** Exchange the code for a session token the client keeps. */
function apiVerifySignInCode(email, code) {
  return SignIn.verifyCode(email, code);
}

/** Who does this token say I am? Used on every page load. */
function apiWhoAmI() {
  var s = Auth.session();
  return {
    signedIn: !!s.email,
    email: s.email,
    name: s.name,
    isAdmin: s.isAdmin,
    hasStudentRecord: !!s.student,
    // How the visitor got in, decided where the decision was actually made
    // rather than re-derived here. Holding a token while Google also knows you
    // is normal, and reporting the token in that case would be a lie.
    via: s.via || null
  };
}
