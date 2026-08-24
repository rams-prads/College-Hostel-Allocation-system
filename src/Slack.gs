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
   * True when a warden may close a ticket from the channel.
   *
   * Separate from SLACK_ENABLED on purpose. Posting a notification and accepting
   * a write back from the internet are different sizes of decision, and somebody
   * who wants the first should not get the second by not having read far enough.
   */
  function actionsEnabled() {
    try {
      return String(Db.cfg('SLACK_ACTIONS_ENABLED', 'FALSE')).toUpperCase() === 'TRUE';
    } catch (e) {
      return false;
    }
  }

  /**
   * The shared secret that stands in for Slack's signature.
   *
   * Slack signs every interaction with an X-Slack-Signature header, and the
   * honest way to do this is to recompute that HMAC. Apps Script cannot: doPost
   * hands over postData, parameter and queryString, and NO headers at all. There
   * is no way to read the signature, so there is no way to check it.
   *
   * So the Request URL carries a long random secret in its query string, and
   * only Slack's app configuration knows it. That is a bearer token rather than
   * a signature: anyone who learns the URL can resolve tickets. It is stored
   * where the webhook is stored, travels only over HTTPS to Slack, and can be
   * rotated by changing one property and one field in the Slack app.
   *
   * Worth saying plainly rather than burying: this is the weakest link in the
   * feature, and it is a platform limit rather than a choice.
   */
  function actionKey_() {
    return PropertiesService.getScriptProperties().getProperty('SLACK_ACTION_KEY') || '';
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
   * The same message, with a button on it.
   *
   * text is still sent alongside and still carries everything: it is what Slack
   * shows in a phone notification and in the channel list, and it is what a
   * client that cannot render blocks falls back to. The blocks are an addition,
   * never a replacement - which is also why _format stays the tested surface.
   *
   * The button is omitted for an AUTO_ANSWERED ticket. The system already
   * answered that one and closed it; offering a warden a button that says
   * "mark done" for work nobody did invites a click that means nothing.
   */
  function buildBlocks_(ticket, text, outcome) {
    var blocks = [{
      type: 'section',
      text: { type: 'mrkdwn', text: text }
    }];

    var status = (outcome || {}).status;
    if (actionsEnabled() && status && status !== 'AUTO_ANSWERED') {
      blocks.push({
        type: 'actions',
        block_id: 'grievance_actions',
        elements: [{
          type: 'button',
          action_id: 'grievance_done',
          style: 'primary',
          text: { type: 'plain_text', text: 'Mark done', emoji: false },
          value: String((ticket || {}).ticketId || ''),
          // One tap closes a resident's ticket and writes to the ledger. The
          // confirm dialog costs a warden half a second and is the only thing
          // standing between a mis-tap on a phone and a false record.
          confirm: {
            title: { type: 'plain_text', text: 'Mark this done?' },
            text: {
              type: 'mrkdwn',
              text: 'The student will be told it is resolved, and your Slack ' +
                    'name goes on the audit record.'
            },
            confirm: { type: 'plain_text', text: 'Mark done' },
            deny: { type: 'plain_text', text: 'Cancel' }
          }
        }]
      });
    }

    return blocks;
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
        var text = formatGrievanceMessage_(ticket, student, residence, outcome);
        var r = postToWebhook_({
          text: text,
          blocks: buildBlocks_(ticket, text, outcome)
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

  /** A reply that only the warden who clicked can see. */
  function ephemeral_(text) {
    return { response_type: 'ephemeral', replace_original: false, text: text };
  }

  /**
   * Update the message a second time, through the back door.
   *
   * Slack gives up on the HTTP response after three seconds and throws it away.
   * A cold Apps Script start alone can eat two of those before a line of this
   * file runs, and then the ticket has to be read, written, and hashed onto the
   * ledger - so the reply that removes the button routinely arrives too late to
   * be used. The warden sees a timeout and a button still sitting there, on work
   * that in fact completed.
   *
   * response_url is the way out: it stays valid for thirty minutes, so posting
   * the same replacement here lands whether or not the response did. Slack's own
   * guidance for a handler that cannot answer in three seconds, and the closest
   * thing to "acknowledge now, finish later" that Apps Script can reach - there
   * are no background tasks here, only this.
   *
   * Best effort, and silent. The ticket is already closed and the ledger already
   * says so by the time this runs; failing to redraw a chat message must not
   * turn that into an error.
   */
  function updateMessage_(responseUrl, body) {
    if (!responseUrl) return;
    try {
      UrlFetchApp.fetch(responseUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
    } catch (e) { /* the record is right; only the picture of it is stale */ }
  }

  /**
   * A warden pressed "Mark done".
   *
   * Returns the JSON Slack should render; never throws, because a thrown error
   * here reaches a warden as a bare red "something went wrong" with nothing to
   * act on, and leaves them unsure whether the ticket closed or not.
   *
   * Everything is checked before anything is written: the feature flag, the
   * shared secret, the workspace, the payload shape, and the ticket itself.
   *
   * @param {Object} e the doPost event
   */
  function handleInteraction(e) {
    try {
      if (!actionsEnabled()) {
        return ephemeral_('Closing tickets from Slack is switched off. ' +
                          'Set SLACK_ACTIONS_ENABLED to TRUE in the Config tab.');
      }

      var key = actionKey_();
      var given = ((e || {}).parameter || {}).k || '';
      if (!key || given !== key) {
        // Deliberately vague to whoever is knocking, precise in the ledger.
        try {
          Ledger.append('SLACK_ACTION_REJECTED', { reason: 'bad or missing key' }, 'system');
        } catch (ignored) { /* never let logging be the thing that throws */ }
        return ephemeral_('This button is not configured correctly.');
      }

      var payload = JSON.parse(((e || {}).parameter || {}).payload || '{}');

      // A second workspace posting a well-formed payload at a leaked URL is the
      // one attack the shared secret alone does not cover.
      var wantTeam = PropertiesService.getScriptProperties().getProperty('SLACK_TEAM_ID');
      if (wantTeam && ((payload.team || {}).id || '') !== wantTeam) {
        return ephemeral_('This button is not configured correctly.');
      }

      var action = (payload.actions || [])[0] || {};
      if (action.action_id !== 'grievance_done') return ephemeral_('Nothing to do.');

      var ticketId = String(action.value || '');
      var who = (payload.user || {}).username || (payload.user || {}).name || 'a warden';

      var t = Db.byId('Grievances', ticketId);
      if (!t) return ephemeral_('Ticket ' + ticketId + ' is no longer in the system.');

      // Two wardens reading the same channel both tap it. The second tap must not
      // overwrite the first one's name on the record, and must not tell them the
      // click failed - it did not, the work is done either way.
      if (t.status === 'RESOLVED' || t.status === 'CLOSED') {
        return ephemeral_(ticketId + ' was already closed. ' +
                          (t.resolution ? '(' + t.resolution + ')' : ''));
      }

      var note = 'Marked done in Slack by @' + who;
      Grievance.resolve(ticketId, note, 'slack:' + who);

      // Replace the original message rather than adding to the channel: the
      // point is that the next warden scrolling past sees it handled and does
      // not go looking, and that the button cannot be pressed a second time.
      var kept = (payload.message || {}).blocks || [];
      var blocks = kept.filter(function (b) { return b.block_id !== 'grievance_actions'; });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':white_check_mark: *Done* — ' + escape_(note) }]
      });

      var replacement = {
        replace_original: true,
        text: ((payload.message || {}).text || ticketId) + '\n:white_check_mark: ' + note,
        blocks: blocks
      };

      // Sent AND returned. Whichever of the two Slack is still listening to wins,
      // and they carry the same message, so arriving twice changes nothing.
      updateMessage_(payload.response_url, replacement);
      return replacement;
    } catch (err) {
      try {
        Ledger.append('SLACK_ACTION_FAILED', { error: String(err && err.message || err) },
          'system');
      } catch (ignored) { /* as above */ }
      return ephemeral_('That did not go through. The ticket is unchanged, and it ' +
                        'can still be closed from the admin dashboard.');
    }
  }

  return {
    enabled: enabled,
    actionsEnabled: actionsEnabled,
    notifyGrievance: notifyGrievance,
    handleInteraction: handleInteraction,
    _format: formatGrievanceMessage_,
    _blocks: buildBlocks_
  };
})();
