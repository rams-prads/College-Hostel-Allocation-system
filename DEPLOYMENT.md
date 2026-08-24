# Deployment Guide

How to get this running on a Google account from scratch. Takes about fifteen
minutes. You need nothing but a Google account — no server, no domain, no
payment method.

---

## Before you start

| You need | Why |
|---|---|
| A Google account | Hosts the sheet, the script and the web app |
| Node.js | Only to run `clasp`, the upload tool |
| Ten minutes | Most of it is Google's permission screens |

**Cost: ₹0.** Everything used here is inside the free tier of a normal Google
account.

---

## 1. Create the spreadsheet

1. Go to [sheets.new](https://sheets.new) — a blank spreadsheet opens
2. Rename it, e.g. `GGSIPU Hostel System`
3. **Extensions → Apps Script**. The script editor opens in a new tab
4. Click the **gear icon (Project Settings)** in the left sidebar
5. Copy the **Script ID** — a long string of letters and numbers

The spreadsheet is now permanently bound to that script project.

---

## 2. Enable the Apps Script API

This is off by default on every Google account and `clasp` cannot work without it.

1. Open **https://script.google.com/home/usersettings**
2. Turn **Google Apps Script API** to **ON**

---

## 3. Upload the code

```bash
npm install -g @google/clasp
clasp login                      # opens a browser, sign in
cp .clasp.json.example .clasp.json
```

Open `.clasp.json` and paste your Script ID:

```json
{
  "scriptId": "YOUR_SCRIPT_ID_HERE",
  "rootDir": "src"
}
```

Then:

```bash
clasp push --force
```

You should see about 30 files listed. `.clasp.json` is gitignored, so your
Script ID never reaches the repository.

---

## 4. Build the database

1. Go back to the **spreadsheet** tab and reload the page
2. A **Hostel System** menu appears in the menu bar (give it a few seconds the
   first time)
3. **Hostel System → 1. Create database**

Google will ask for permissions. It warns *"Google hasn't verified this app"* —
that is expected for a script you wrote yourself. Click **Advanced → Go to
(project name) → Allow**. You may need to click the menu item again afterwards.

**Result:** 19 tabs across the bottom of the spreadsheet, `Config` and `Policy`
pre-filled, and a genesis row in `AuditLog`.

4. **Hostel System → 2. Seed demo data → Yes** (~30 seconds)

**Result:** 900 students, 756 beds, 336 rooms, 6 hostels.

5. **Hostel System → Run allocation → Yes**

**Result:** ~741 allotted, ~97 waitlisted, with fairness metrics in the popup.

### Check it worked

**Hostel System → Diagnostics → Verify Phase 0** and **Verify Phase 1**. Every
line should read `PASS`.

---

## 5. Publish the web app

1. In the **Apps Script** tab: **Deploy → New deployment**
2. Click the gear beside "Select type" → **Web app**
3. Fill in:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone with a Google account`
4. **Deploy**, then copy the **Web app URL**

### Why those two settings

**Execute as: Me** means the script runs with your permission to read the
spreadsheet, so students never need access to the sheet itself. This is also why
every admin function calls `Auth.requireAdmin()` — without that guard, a student
could call an admin function and it would run with *your* permissions.

**Anyone with a Google account** identifies each visitor by their Google email
without any password handling. Set it to *Anyone within your organisation* if you
deploy on a university Workspace domain.

---

## 5b. Letting other people sign in

**Read this before you test with a second account.** It is the single thing most
likely to waste an afternoon.

Google will only tell a web app who its visitor is when **the visitor is on the
same Workspace domain as the account that owns the project** — or is that owner.
Everyone else gets an empty address, and the portal, having no idea who they are,
sends them back to the sign-in page. They can sign in correctly ten times and
still land back there. Nothing in this project can change that; it is a platform
restriction on `Session.getActiveUser()` under *Execute as: Me*.

| Project owned by | `pvrk2406@gmail.com` can sign in | `someone@std.ggsipu.ac.in` can sign in |
|---|---|---|
| `pvrk2406@gmail.com` (personal) | yes | **no** |
| `you@std.ggsipu.ac.in` (college) | no | **yes — everyone on the domain** |

So: **own the project from a college account.** Then every student on
`std.ggsipu.ac.in` signs in and is recognised, which is the real deployment
anyway.

### Moving the project to your college account

Roughly ten minutes. Nothing is lost — the database rebuilds itself.

1. Sign in to Google Drive as **`you@std.ggsipu.ac.in`**.
2. **New → Google Sheets**, name it `GGSIPU Hostel Allocation`.
3. **Extensions → Apps Script**. Leave the tab open.
4. **Project Settings** (the gear) → copy the **Script ID**.
5. On your machine:
   ```bash
   npx clasp logout
   npx clasp login          # sign in as the college account this time
   ```
   Put the new Script ID into `.clasp.json`, then:
   ```bash
   npx clasp push -f
   ```
6. Back in the Apps Script editor, select **`setupEverything`** from the function
   dropdown and press **Run**. Accept the permission prompt. It builds every tab,
   seeds the cohort, makes you an administrator, and prints the portal address.
7. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access:
   Anyone with a Google account* (or *Anyone within Guru Gobind Singh Indraprastha
   University*, which is better for the real thing).

Now sign in from any `@std.ggsipu.ac.in` account and it will work.

To switch back to the personal project later, `npx clasp logout && npx clasp login`
again and restore the old Script ID. Keeping both is fine; they are separate
spreadsheets.

### If your university blocks it

Some Workspace domains disable Apps Script or external web apps for students. If
step 3 or step 7 is refused, that is an administrator policy, not a fault here.
Two fallbacks:

- **Admin → Look up a student → Open portal.** Shows any applicant's screen
  exactly as they see it, from your own account.
- **Admin → Look up a student → Preview link.** A signed, expiring, read-only URL
  that works in any browser with no sign-in. Set `ALLOW_DEMO_LINKS` to `TRUE` in
  the `Config` sheet first, and back to `FALSE` afterwards.

---

## 6. Add administrators

Open the `Admins` tab. Your own email is already there as `SUPER_ADMIN`. Add a
row per person:

| email | name | role | campus | active |
|---|---|---|---|---|
| warden.dwarka@ipu.ac.in | Dr. A. Sharma | WARDEN | DWARKA | ✓ |
| clerk@ipu.ac.in | R. Kumar | VERIFIER | ALL | ✓ |

For a warden there is a shortcut that fills the row correctly and records the
change in the ledger: **Hostel System › Add a warden**. Type their address, and
they can open `?page=admin` immediately.

| Role | Sections of the dashboard | May commit a run |
|---|---|---|
| `SUPER_ADMIN` | every section | yes |
| `WARDEN` | Occupancy and Requests only | no |
| `VERIFIER` | every section | no |
| `VIEWER` | every section | no |

A warden's account is the vacancies-and-complaints desk. They see how full each
hostel is and how many beds are free, and they read, escalate and close student
grievances. Every other section — running an allocation, reading identity
documents, changing policy, sending letters, opening any student's file — is
refused, on the server as well as being absent from their menu.

`VERIFIER` and `VIEWER` are not yet confined this way; they still see every
section. Only `SUPER_ADMIN` and `WARDEN` differ today.

---

## 6b. Turn on Wander, the assistant — deliberately

Wander answers hostel questions from the brochure and from the asking student's own
record. It is **off by default**, and that is deliberate: a question and the details
already shown on the student's page are sent to Google to compose an answer, and on
the free tier Google's terms permit using submitted content to improve its products.
That is a decision for whoever deploys this, not a default they discover afterwards.

Three steps:

1. **Get a key.** [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → *Create
   API key*. Free, no billing account.
2. **Store it.** Apps Script editor → **Project Settings** → scroll to **Script Properties** →
   add `GEMINI_API_KEY` with that value. It is never written to the spreadsheet, so
   exfiltrating the whole sheet does not hand over the key.
3. **Make the rules searchable.** The brochures ship with the code and load
   themselves when you run `setupEverything` — there is nothing to upload. Open
   **Admin → Assistant** and press **Make N passages searchable** once. It embeds
   them in batches and reports progress; if it stops, pressing it again continues
   from where it left off.

4. Set `CHATBOT_ENABLED` to `TRUE` in the `Config` tab.

**Wander cannot answer anything that is not in the rule book.** That is the design, not a
limitation to work around: it refuses rather than inventing a fee or a deadline. If it
declines a question you expected it to answer, the brochure does not cover it.

Two Config values worth knowing: `CHATBOT_DAILY_CAP` (default 200) keeps a margin below
Google's free-tier ceiling, counted on the **US Pacific** day that Google resets on rather
than the local one. `GEMINI_CHAT_MODEL` and `GEMINI_EMBED_MODEL` are in the sheet rather
than the source because Google retires model ids on its own schedule — a rename is a cell
edit, not a redeploy.

---

## 6c. Send grievances to the wardens' Slack

Until this is on, a grievance sits in the `Grievances` tab until somebody opens the
admin inbox. With it on, every new ticket is posted to one Slack channel the moment
it is raised, carrying the student's name and enrolment number, their hostel, block
and room, the complaint itself, and what auto-triage already concluded — so a warden
can see at a glance whether it needs them at all.

It is **off by default**, and that is deliberate: it puts student names and room
numbers into a third-party workspace, which is a decision for whoever deploys this.

Three steps:

1. **Create the webhook.** In Slack, add the *Incoming Webhooks* app to the channel
   the wardens share — [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)
   → *Create an app* → *Incoming Webhooks* → *Add New Webhook to Workspace*, pick the
   channel, copy the URL.
2. **Store it.** Apps Script editor → **Project Settings** → scroll to **Script Properties** →
   add `SLACK_WEBHOOK_URL` with that value. Like `GEMINI_API_KEY`, it is never written
   to the spreadsheet, so exfiltrating the whole sheet does not hand over a way to post
   into the wardens' channel.
3. Set `SLACK_ENABLED` to `TRUE` in the `Config` tab.

**A Slack failure never costs a ticket.** If the webhook is missing, revoked or simply
down, the grievance is still raised and the student sees no error — the attempt is
recorded in the `AuditLog` as `GRIEVANCE_SLACK_NOTIFIED` with the reason it failed.
Check there first if messages are not arriving.

One webhook, one channel. Routing each hostel to its own channel would need a Slack
app and a bot token; a webhook needs neither, and can be revoked by the person who
created it without anyone coming back to us.

---

## 6d. Let wardens close tickets from Slack — read this one properly

With 6c on, a warden reads a grievance in Slack and then opens the admin dashboard to
mark it done. This puts a **Mark done** button on the message itself: one tap resolves
the ticket, tells the student, and writes the warden's Slack name to the audit ledger.

This is a **separate switch from `SLACK_ENABLED`**, because it is a different size of
decision. Posting a notification sends data out. This accepts writes *in*, from the
public internet, onto a resident's record.

**Understand the weakness before switching it on.** Slack signs every button press
with an `X-Slack-Signature` header, and the correct way to trust one is to recompute
that signature. **Apps Script cannot do this** — `doPost(e)` receives the body and the
query string but *no HTTP headers at all*, so the signature cannot be read, let alone
checked. Instead the Request URL carries a long random secret, and only Slack's app
configuration knows it. That is a bearer token, not a signature: **anyone who learns
that URL can close tickets.** It is a platform limit, not a shortcut. If that trade is
not acceptable for your deployment, leave `SLACK_ACTIONS_ENABLED` at `FALSE` — 6c works
perfectly well on its own.

Four steps:

1. **Make a secret.** Any long random string, 32+ characters. Apps Script editor →
   **Project Settings** → **Script Properties** → add `SLACK_ACTION_KEY` with it.
2. **Point Slack at this deployment.** [api.slack.com/apps](https://api.slack.com/apps) →
   your app → **Interactivity & Shortcuts** → switch on → **Request URL**:

   ```
   https://script.google.com/macros/s/<YOUR-DEPLOYMENT-ID>/exec?k=<SLACK_ACTION_KEY>
   ```

   The `?k=` is the whole of the authentication. Treat that URL like a password.
3. **Optional, and worth it.** Add `SLACK_TEAM_ID` (your `T…` workspace id) to Script
   Properties. Presses from any other workspace are then refused even if the URL leaks.
4. Set `SLACK_ACTIONS_ENABLED` to `TRUE` in the `Config` tab.

**Redeploy after any code change.** The Request URL points at a *versioned* deployment.
`clasp push` updates the editor's copy but not that version — run
`clasp deploy -i <DEPLOYMENT-ID>` or the button will keep running old code.

Notes on behaviour:

- The button is **not** offered on an auto-answered ticket. The system already closed
  that one; a button saying "mark done" for work nobody did invites a meaningless click.
- Pressing it asks for confirmation first. One tap writes to the ledger, and a mis-tap
  on a phone should not.
- If two wardens press it, the second is told it was already closed and the first
  warden's name stays on the record.
- The ledger actor is recorded as `slack:<username>`, which names the channel of
  authority honestly. It is a Slack identity, not a verified administrator — the
  guarantee is that only members of that private channel can press the button.
- Rotate the secret by changing `SLACK_ACTION_KEY` and the `?k=` in the Request URL.
- Rejected presses are recorded in `AuditLog` as `SLACK_ACTION_REJECTED`.

---

## 7. Turn on email — deliberately

Email is **off by default** so a rehearsal cannot mail hundreds of real people.
Every send is still recorded in `Notifications` while it is off, so you can test
the whole flow safely.

When you genuinely want mail to go out, set `EMAIL_ENABLED` to `TRUE` in the
`Config` tab.

**Know your quota before you do.** A consumer Gmail account sends about **100
emails a day**; Google Workspace allows 1500. With 741 allotments you will need
several days on a consumer account, or a Workspace account. The system stops
cleanly at the cap and records what remains, so re-running the send continues
where it left off — it never double-sends.

`EMAIL_DAILY_CAP` in `Config` (default 90) keeps a safety margin below Google's
limit.

---

## Settings worth knowing

All in the `Config` tab, editable without touching code.

| Key | Default | What it does |
|---|---|---|
| `APPLICATIONS_OPEN` | TRUE | Set FALSE to close the intake form |
| `EMAIL_ENABLED` | FALSE | Master switch for sending mail |
| `EMAIL_DAILY_CAP` | 90 | Stay under Google's daily limit |
| `MAX_PREFERENCES` | 5 | How many choices a student may rank |
| `ALLOW_TAMPER_DEMO` | (unset) | Set TRUE **only** to demonstrate tamper detection |
| `LETTER_FOLDER_ID` | (auto) | Drive folder for generated letters |

Allocation rules live in the `Policy` tab — reservation percentages, scoring
weights, minimum distance and CGPA. **These are data, not code.** Edit a cell and
the next run uses the new value. No deployment needed.

> The seeded reservation percentages are the standard central norms and are
> **placeholders**. Verify them against your institution's actual rules before
> running a real allocation.

---

## Updating the code later

```bash
clasp push --force
```

Reload the spreadsheet to pick up menu changes. For web app changes:
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.**

Editing the deployment keeps the same URL. Creating a *new* deployment gives a
new URL and breaks every QR code already printed on a letter — so always edit.

---

## Troubleshooting

**"User has not enabled the Apps Script API"**
Step 2. Wait a minute after enabling; it takes a moment to propagate.

**The Hostel System menu is missing**
Reload the spreadsheet. If it still does not appear, open the Apps Script editor,
select `onOpen` from the function dropdown and press Run once to trigger the
permission prompt.

**"Exceeded maximum execution time"**
A single execution is capped at six minutes. Letters and emails are already
batched — press the button again to continue from where it stopped. If the
allocation itself times out, reduce the cohort in `SeedData.gs`.

**"Access denied: administrator privileges required"**
Your email is not in the `Admins` tab, or `active` is unchecked.

**A student sees "No student record found"**
The portal matches the signed-in Google email against the `Students` tab. Either
add them, or change an existing row's email to match.

**Letters have no QR code**
The QR is drawn as a grid of table cells because Apps Script's HTML-to-PDF
conversion drops images. If it renders as a smear, increase the cell size in
`Letters.gs` (`QrCode.toHtmlTable(qr, 3, 3)` → try `4`).

---

## Running the tests

The engine runs offline in Node — no Google account needed, no upload:

```bash
node tests/harness.js       # schema contract and hash chain
node tests/qr.test.js       # QR encoder against the ISO 18004 spec
node tests/phase1.test.js   # data integrity and quota arithmetic
node tests/phase2.test.js   # allocation engine correctness
node tests/phase3.test.js   # document rules and portal API
node tests/phase4.test.js   # letters, QR anti-forgery, email, admin
node tests/phase5.test.js   # simulator, swaps, grievance audit
node tests/phase6.test.js   # demo scenario and access guards
node tests/phase11.test.js  # the assistant: chunking, retrieval, prompt privacy
```

`tests/stubs.js` shims `SpreadsheetApp`, `DriveApp`, `MailApp` and friends and
swaps the database for an in-memory store. The engine source is loaded unmodified,
so what passes here is the same code that runs on Google.
