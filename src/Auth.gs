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
  function session() {
    var email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }

    var s = {
      email: email,
      name: '',
      isAdmin: false,
      role: 'GUEST',
      campus: null,
      student: null,
      application: null
    };
    if (!email) return s;

    var admin = Db.findOne('Admins', { email: email });
    if (admin && admin.active) {
      s.isAdmin = true;
      s.role = admin.role;
      s.campus = admin.campus;
      s.name = admin.name;
    }

    var student = Db.findOne('Students', { email: email });
    if (student) {
      s.student = student;
      s.name = s.name || student.name;
      s.role = s.isAdmin ? s.role : 'STUDENT';
      s.application = Db.findOne('Applications', { studentId: student.studentId });
    }

    return s;
  }

  /** Throw unless the visitor is an admin. Use at the top of every admin RPC. */
  function requireAdmin() {
    var s = session();
    if (!s.isAdmin) throw new Error('Access denied: administrator privileges required.');
    return s;
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
    canCommit: canCommit
  };
})();
