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

## 6. Add administrators

Open the `Admins` tab. Your own email is already there as `SUPER_ADMIN`. Add a
row per person:

| email | name | role | campus | active |
|---|---|---|---|---|
| warden.dwarka@ipu.ac.in | Dr. A. Sharma | WARDEN | DWARKA | ✓ |
| clerk@ipu.ac.in | R. Kumar | VERIFIER | ALL | ✓ |

| Role | Can do |
|---|---|
| `SUPER_ADMIN` | Everything, including committing policy changes |
| `WARDEN` | Run and commit allocations, resolve grievances |
| `VERIFIER` | Verify documents, view dashboards |
| `VIEWER` | Read-only |

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
```

`tests/stubs.js` shims `SpreadsheetApp`, `DriveApp`, `MailApp` and friends and
swaps the database for an in-memory store. The engine source is loaded unmodified,
so what passes here is the same code that runs on Google.
