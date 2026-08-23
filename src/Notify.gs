/**
 * Notify.gs - Gmail notifications, batched and quota-aware.
 *
 * A consumer Google account can send about 100 emails a day; Workspace allows
 * 1500. A 741-student allocation exceeds the consumer limit, so sending is
 * chunked, logged, and stops cleanly at the cap rather than throwing halfway
 * through and leaving nobody able to tell who was emailed.
 *
 * EMAIL_ENABLED in Config defaults to FALSE. Every send is recorded either way,
 * so the flow can be rehearsed end to end without mailing 741 real people.
 */

var Notify = (function () {

  var TEMPLATES = {
    SUBMITTED: {
      subject: 'Hostel application received - {{appId}}',
      heading: 'Application received',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>Your hostel application <strong>' + d.appId + '</strong> has been received for the ' +
          'academic session ' + d.session + '. You will be notified once room allocation is complete.</p>' +
          '<p>You can track your application at any time on the hostel portal.</p>';
      }
    },
    ALLOTTED: {
      subject: 'Hostel room allotted - {{hostel}} {{roomNo}}',
      heading: 'You have been allotted a room',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>You have been allotted hostel accommodation for session ' + d.session + '.</p>' +
          '<table style="border-collapse:collapse;margin:14px 0">' +
          trow_('Hostel', d.hostel) + trow_('Campus', d.campus) +
          trow_('Room', d.roomNo + ' (Block ' + d.block + ', Floor ' + d.floor + ')') +
          trow_('Bed', d.bedNo) + trow_('Reference', d.allocId) +
          '</table>' +
          '<p>Your allotment letter carries a QR code that confirms it is genuine. ' +
          'Sign in to the portal to download it, and to see exactly why you received this room.</p>';
      }
    },
    WAITLISTED: {
      subject: 'Hostel waiting list - position {{position}}',
      heading: 'You are on the waiting list',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>Rooms have been allocated for session ' + d.session + '. You were not allotted a room ' +
          'in this round and are on the waiting list at <strong>position ' + d.position + '</strong>.</p>' +
          '<p>Based on how many students historically withdraw after allotment, your estimated ' +
          'chance of being allotted is around <strong>' + d.etaPercent + '%</strong>. This is an ' +
          'estimate, not a guarantee.</p>' +
          '<p>The portal shows the full reasoning behind this outcome, including which of your ' +
          'preferences filled and at what merit position.</p>';
      }
    },
    REJECTED: {
      subject: 'Hostel application - not eligible',
      heading: 'Your application was not eligible',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>Your hostel application for session ' + d.session + ' did not meet the eligibility ' +
          'criteria.</p>' +
          (d.reasons && d.reasons.length
            ? '<ul>' + d.reasons.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>'
            : '') +
          '<p>If you believe this is an error, correct your application on the portal ' +
          'or contact the hostel office.</p>';
      }
    },
    // The two verification outcomes a student has to be TOLD about, rather
    // than left to discover by refreshing a page. The instruction the officer
    // chose travels in `message`, which is the whole point of choosing from a
    // list instead of typing "rejected".
    VERIFY_RESUBMIT: {
      subject: 'Action needed on your hostel application - {{appId}}',
      heading: 'One thing needs your attention',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>' + d.message + '</p>' +
          '<p>Nothing else about your application has changed and your position in ' +
          'the queue is unaffected. Sign in to the portal and upload the ' +
          'replacement.</p>';
      }
    },
    VERIFY_REJECTED: {
      subject: 'Hostel application not accepted at verification - {{appId}}',
      heading: 'Your application was not accepted',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>' + d.message + '</p>' +
          '<p>If you believe this is wrong, the hostel office can look at it again.</p>';
      }
    },
    DOC_REJECTED: {
      subject: 'Document rejected at verification - {{appId}}',
      heading: 'A document needs to be resubmitted',
      body: function (d) {
        return '<p>Dear ' + d.name + ',</p>' +
          '<p>One of the documents submitted with application <strong>' + d.appId + '</strong> was ' +
          'not accepted at verification' + (d.note ? ': <em>' + d.note + '</em>' : '.') + '</p>' +
          '<p>Please sign in to the portal and upload a replacement as soon as possible.</p>';
      }
    }
  };

  function trow_(k, v) {
    return '<tr><td style="padding:3px 14px 3px 0;color:#555">' + k +
           '</td><td style="padding:3px 0;font-weight:600">' + v + '</td></tr>';
  }

  function enabled() {
    return String(Db.cfg('EMAIL_ENABLED', 'FALSE')).toUpperCase() === 'TRUE';
  }

  /** How many more we may send today, respecting both Gmail and our own cap. */
  function remainingQuota() {
    var configured = Number(Db.cfg('EMAIL_DAILY_CAP', 90));
    var sentToday = countSentToday_();
    var ours = Math.max(0, configured - sentToday);
    var gmail = ours;
    try { gmail = MailApp.getRemainingDailyQuota(); } catch (e) { /* offline */ }
    return Math.min(ours, gmail);
  }

  function countSentToday_() {
    var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    return Db.readAll('Notifications').filter(function (n) {
      if (n.status !== 'SENT' || !n.sentAt) return false;
      try {
        return Utilities.formatDate(new Date(n.sentAt), 'Asia/Kolkata', 'yyyy-MM-dd') === today;
      } catch (e) { return false; }
    }).length;
  }

  function wrap_(heading, inner) {
    return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
      'max-width:560px;color:#16191d;line-height:1.55">' +
      '<div style="background:#1f3864;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">' +
      '<div style="font-size:16px;font-weight:600">GGSIPU Hostels</div>' +
      '<div style="font-size:13px;opacity:.85">' + heading + '</div></div>' +
      '<div style="border:1px solid #dde1e7;border-top:0;border-radius:0 0 8px 8px;padding:18px;' +
      'font-size:14px">' + inner +
      '<p style="color:#5b636e;font-size:12px;margin:18px 0 0;border-top:1px solid #eee;padding-top:10px">' +
      'This is an automated message from the GGSIPU hostel allocation system. ' +
      'Please do not reply to this address.</p></div></div>';
  }

  /**
   * Queue one notification. Sends immediately when email is enabled and quota
   * allows; otherwise records it as QUEUED or SKIPPED so nothing is lost.
   */
  function send(appId, template, data) {
    var spec = TEMPLATES[template];
    if (!spec) throw new Error('Notify: unknown template ' + template);

    var app = Db.byId('Applications', appId);
    var student = app ? Db.byId('Students', app.studentId) : null;
    if (!student) throw new Error('Notify: no student for ' + appId);

    var payload = Object.assign({
      name: student.name,
      appId: appId,
      session: Db.cfg('ACADEMIC_YEAR', '2026') + '-' +
               String(Number(Db.cfg('ACADEMIC_YEAR', '2026')) + 1).slice(-2)
    }, data || {});

    var subject = spec.subject.replace(/\{\{(\w+)\}\}/g, function (_, k) {
      return payload[k] !== undefined ? payload[k] : '';
    });
    var html = wrap_(spec.heading, spec.body(payload));
    var msgId = 'MSG-' + appId + '-' + template;

    var status = 'QUEUED', error = '', sentAt = '';
    if (!enabled()) {
      status = 'SKIPPED';
      error = 'EMAIL_ENABLED is FALSE';
    } else if (remainingQuota() <= 0) {
      status = 'QUEUED';
      error = 'Daily send quota reached; will retry on the next run';
    } else {
      try {
        MailApp.sendEmail({ to: student.email, subject: subject, htmlBody: html });
        status = 'SENT';
        sentAt = new Date();
      } catch (e) {
        status = 'FAILED';
        error = e.message;
      }
    }

    var existing = Db.byId('Notifications', msgId);
    var row = {
      msgId: msgId, appId: appId, toEmail: student.email, template: template,
      subject: subject, status: status, sentAt: sentAt, error: error
    };
    if (existing) Db.update('Notifications', msgId, row);
    else Db.append('Notifications', row);

    return { status: status, to: student.email, subject: subject };
  }

  /**
   * Notify everyone in a committed run. Bounded so it fits one execution;
   * call repeatedly until `remaining` is zero.
   */
  function notifyRun(runId, limit) {
    limit = limit || 50;
    var counts = { sent: 0, queued: 0, skipped: 0, failed: 0, remaining: 0 };
    var quota = remainingQuota();
    var budget = Math.min(limit, enabled() ? quota : limit);

    var targets = [];
    Db.where('Allocations', { runId: runId, status: 'ACTIVE' }).forEach(function (a) {
      targets.push({ appId: a.appId, template: 'ALLOTTED', allocId: a.allocId });
    });
    Db.where('Waitlist', { runId: runId }).forEach(function (w) {
      targets.push({ appId: w.appId, template: 'WAITLISTED',
                     position: w.position, etaPercent: Math.round(Number(w.etaProbability) * 100) });
    });

    var already = {};
    Db.readAll('Notifications').forEach(function (n) {
      if (n.status === 'SENT') already[n.appId + '|' + n.template] = true;
    });

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (already[t.appId + '|' + t.template]) continue;
      if (counts.sent >= budget) { counts.remaining = targets.length - i; break; }

      var data = {};
      if (t.template === 'ALLOTTED') {
        try {
          var d = Letters.letterData(t.allocId);
          data = {
            allocId: t.allocId, hostel: d.hostel.name, roomNo: d.room.roomNo,
            block: d.room.block, floor: d.room.floor, bedNo: d.bed.bedNo,
            campus: { DWARKA: 'Dwarka Campus', EDC: 'East Delhi Campus' }[d.hostel.campus]
          };
        } catch (e) { continue; }
      } else {
        data = { position: t.position, etaPercent: t.etaPercent };
      }

      var res = send(t.appId, t.template, data);
      if (res.status === 'SENT') counts.sent++;
      else if (res.status === 'QUEUED') counts.queued++;
      else if (res.status === 'SKIPPED') counts.skipped++;
      else counts.failed++;
    }

    Ledger.append('NOTIFICATIONS_DISPATCHED', {
      runId: runId, sent: counts.sent, queued: counts.queued,
      skipped: counts.skipped, failed: counts.failed
    }, 'system');
    return counts;
  }

  return {
    send: send,
    notifyRun: notifyRun,
    remainingQuota: remainingQuota,
    enabled: enabled,
    TEMPLATES: TEMPLATES
  };
})();
