# Smart Hostel Allocation & Optimization System — GGSIPU

**SIH 2026** · A zero-cost hostel allocation platform built entirely on Google Apps Script and
Google Sheets. No servers, no licences, no paid APIs.

> **New here? Read [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) first.** It carries the full project
> context — decisions, architecture, schema, algorithm, phase plan and open questions.

---

## What it does

Automates the complete hostel admission lifecycle for GGSIPU's Dwarka and East Delhi campuses:
online application → document verification → optimised room allocation → allotment letter →
email notification → waitlist, transfers, vacancy tracking and grievance redressal.

## What makes it different

| Feature | Why it matters |
|---|---|
| **Explainable allocation** | Every student sees a plain-English trace of *why* they got their room. Grievances drop because the reasoning is visible. |
| **Tamper-evident ledger** | The audit log is hash-chained — each row hashes the previous. Manipulation of allocation records is cryptographically detectable. |
| **Roommate compatibility** | A lifestyle survey drives stable matching within rooms, cutting mid-year transfer requests. |
| **What-if policy simulator** | Admins see the effect of a quota or weight change — including who moves — *before* committing. |
| **QR-verified letters** | Allotment PDFs carry a signed QR that resolves to a live verification page. |
| **Mutual swap marketplace** | Students arrange room swaps; policy validation is automatic, no admin queue. |

## Tech stack

Google Apps Script · Google Sheets (database) · HTML Service · Gmail · Google Drive ·
Google Charts · Tailwind CSS. **Total running cost: ₹0.**

---

## Quick start

> **Anyone can sign in, on any email address.** Google identifies visitors only on the
> project owner's own Workspace domain — which would lock out every first-year, since
> GGSIPU issues college addresses three to four months *after* students join and hostel
> allocation happens before they arrive. The students most likely to need a bed are
> exactly the ones a domain login shuts out. So the portal emails a one-time code to
> whatever address an applicant actually has. Continuing students on `@std.ggsipu.ac.in`
> are recognised by Google automatically and never see it.

1. Sign in to Google as the account that should own this — for GGSIPU, a college address.
2. Create a new Google Spreadsheet.
3. **Extensions → Apps Script**, then note the script ID from **Project Settings**.
4. `cp .clasp.json.example .clasp.json` and paste your script ID in.
5. `npm i -g @google/clasp && clasp login && clasp push`
6. In the Apps Script editor run **`setupEverything`**. It builds all 20 tabs, seeds the
   cohort, makes you an administrator, and prints the portal address.
7. **Deploy → New deployment → Web app**, *Execute as: me*, *Access: anyone with a Google
   account*.

Full instructions, and what to do if your university blocks Apps Script, in
[DEPLOYMENT.md](DEPLOYMENT.md).

---

## Running the tests

The engine runs offline in Node — no Apps Script push needed, so the allocator can be
iterated in seconds:

```bash
node tests/phase1.test.js     # 66 checks: data integrity, quotas, determinism
node tests/phase2.test.js     # 110 checks: allocation engine correctness
node tests/phase3.test.js     # 73 checks: document rules and portal API
node tests/phase4.test.js     # 105 checks: letters, QR anti-forgery, email, admin
node tests/qr.test.js         # 57 checks: QR encoder vs ISO 18004, PNG round-trip
node tests/phase5.test.js     # 105 checks: simulator, swaps, grievance audit
node tests/phase6.test.js     # 45 checks: demo scenario and access guards
node tests/phase7.test.js     # 87 checks: self-registration and first-year ranking
node tests/ui.test.js         # 134 checks: every page renders, links escape the iframe
node tests/phase8.test.js     # 107 checks: identity verification and upload hardening
node tests/phase9.test.js     # 59 checks: email-code sign-in, session tokens, dispatcher
node tests/phase10.test.js    # 54 checks: reading documents, materiality, auto-clearing
node tests/sheets.test.js     # 41 checks: spreadsheet round-trip, ledger repair
node tests/harness.js         # 19 checks: schema contract, ledger, tamper detection
```

`tests/stubs.js` shims `SpreadsheetApp`, `Utilities`, `PropertiesService` and friends, and
swaps `Db` for an in-memory store. The engine source is loaded unmodified.

---

## Repository layout

```
PROJECT_CONTEXT.md   ← the carry-everything document, start here
README.md            this file
DEPLOYMENT.md        step-by-step deployment guide
TECHNICAL_DOC.md     architecture and algorithm documentation
src/                 Apps Script sources (pushed via clasp)
  Schema.gs          the frozen database contract
  Db.gs              typed access layer — nothing else touches getRange()
  Setup.gs           setupEverything(), createDatabase(), additive migrateSchema()
  Ledger.gs          hash-chained audit log
  Auth.gs            session + role guard
  Main.gs            web app router + spreadsheet menu
  ui/                HTML templates
docs/                diagrams and supporting material
```

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation — schema, Db layer, setup, ledger, auth, router | ✅ done |
| 1 | Synthetic data, hostel inventory, policy, offline pincode geo | ✅ done |
| 2 | Allocation engine, roommate matching, waitlist, metrics | ✅ done |
| 3 | Student portal | ✅ done |
| 4 | Admin dashboard, letters, QR verification, email | ✅ done |
| 5 | Simulator, swaps, grievance auto-triage | ✅ done |
| 6 | Demo hardening and deliverables | ✅ done |
