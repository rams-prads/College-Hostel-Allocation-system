/**
 * Slack.gs - grievances pushed to the wardens the moment they are raised.
 *
 * The second file in this project that leaves the machine, and deliberately the
 * same shape as the first: one place to audit, one place to stub. A single
 * Incoming Webhook into a single channel - no bot token, no OAuth scopes. A
 * warden's Slack workspace is not something a hostel portal should be asking
 * for admin rights over, and a webhook can be revoked by the person who made it
 * without anyone having to come back to us.
 *
 * Until now a ticket sat in a sheet until somebody thought to open the inbox.
 * The row was always there; nobody was ever told. This is the telling.
 *
 * SLACK_ENABLED in Config defaults to FALSE and the URL lives in Script
 * Properties, never in the sheet - so exfiltrating the whole spreadsheet does
 * not hand over a way to post into the wardens' channel.
 *
 * Nothing in this file throws. A Slack outage must never be the reason a
 * student cannot report that their water has been off for three days.
 */

var Slack = (function () {

  // Long enough for any real complaint, short enough that a pasted wall of text
  // cannot push the room number off a warden's phone screen.
  var MAX_ISSUE_CHARS = 500;

  function webhookUrl_() {
    var u = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
    if (!u) {
      // Name the fix, not just the fault - same argument as Gemini.key_().
      throw new Error('No Slack webhook URL is set. In the Apps Script editor open ' +
                      'Project Settings, scroll to Script Properties, and add ' +
                      'SLACK_WEBHOOK_URL with an Incoming Webhook URL from ' +
                      'api.slack.com/messaging/webhooks.');
    }
    return u;
  }

  /** True when grievances should be forwarded at all. Never throws. */
  function enabled() {
    try {
      return String(Db.cfg('SLACK_ENABLED', 'FALSE')).toUpperCase() === 'TRUE';
    } catch (e) {
      return false;
    }
  }

  /**
   * One HTTP call, and no retry.
   *
   * Gemini.fetch_ retries a 503 because a busy model is worth waiting for. A
   * webhook failure is almost always a revoked or mistyped URL, which the second
   * attempt fails at too - and the student is still sitting on the submit button
   * while it happens.
   */
  function postToWebhook_(payload) {
    var res = UrlFetchApp.fetch(webhookUrl_(), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return { code: res.getResponseCode(), body: res.getContentText() };
  }

  /**
   * Slack reads &, < and > as markup. A student writing "temp < 10 degrees" or
   * "hot & cold both dead" would otherwise arrive mangled or not at all, and
   * grievance text is the one field here that is entirely theirs to write.
   */
  function escape_(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * The message a warden actually reads.
   *
   * Plain text rather than Block Kit: this is one skimmable entry in a busy
   * channel, not a card anyone will click, and one string is far easier to
   * assert on in a test than a nested block structure.
   *
   * The triage verdict is the last line and the reason this is sent after
   * triage rather than at Db.append - "AUTO_ANSWERED" tells a warden at a
   * glance that this one needs nothing from them.
   */
  function formatGrievanceMessage_(ticket, student, residence, outcome) {
    ticket = ticket || {};
    outcome = outcome || {};

    var issue = String(ticket.text || '').trim();
    if (issue.length > MAX_ISSUE_CHARS) issue = issue.substring(0, MAX_ISSUE_CHARS) + '…';

    var lines = ['New grievance :warning: *[' + escape_(ticket.ticketId) + ']*'];

    // A line is dropped rather than printed empty when the join behind it came
    // back nothing: residence_() returns null whenever an allocation is not
    // ACTIVE, and a ticket outlives the allocation it was raised against.
    if (student) {
      lines.push('*Student:* ' + escape_(student.name) +
        (student.enrollmentNo ? ' (Enroll. ' + escape_(student.enrollmentNo) + ')' : ''));
    }

    lines.push('*Where:* ' + (residence
      ? escape_(residence.hostelName) + ', Block ' + escape_(residence.block) +
        ', Room ' + escape_(residence.roomNo)
      : 'not currently allocated'));

    lines.push('*Category:* ' + escape_(ticket.category || 'OTHER'));
    lines.push('*Issue:* "' + escape_(issue) + '"');

    if (outcome.status) {
      lines.push('*Auto-triage:* ' + escape_(outcome.status) +
        (outcome.headline ? ' — ' + escape_(outcome.headline) : ''));
    }

    return lines.join('\n');
  }

  /**
   * Forward one ticket. Returns what happened; never throws, whatever happened.
   *
   * @return {{status: string, error: string}} SENT, SKIPPED or FAILED
   */
  function notifyGrievance(ticket, student, residence, outcome) {
    var status = 'SKIPPED', error = '';

    if (!enabled()) {
      error = 'SLACK_ENABLED is FALSE';
    } else {
      try {
        // webhookUrl_() throws from inside postToWebhook_, deliberately sharing
        // this catch with the network call: "not configured" and "not reachable"
        // both end as one FAILED row that names which of the two it was.
        var r = postToWebhook_({
          text: formatGrievanceMessage_(ticket, student, residence, outcome)
        });
        if (r.code >= 200 && r.code < 300) {
          status = 'SENT';
        } else {
          status = 'FAILED';
          error = 'HTTP ' + r.code + ': ' +
                  String(r.body || '').replace(/\s+/g, ' ').substring(0, 300);
        }
      } catch (e) {
        status = 'FAILED';
        error = e.message;
      }
    }

    try {
      Ledger.append('GRIEVANCE_SLACK_NOTIFIED', {
        ticketId: (ticket || {}).ticketId || '', status: status, error: error
      }, 'system');
    } catch (e) {
      // The ticket matters more than the record of having mentioned it to Slack.
    }

    return { status: status, error: error };
  }

  return {
    enabled: enabled,
    notifyGrievance: notifyGrievance,
    _format: formatGrievanceMessage_
  };
})();
