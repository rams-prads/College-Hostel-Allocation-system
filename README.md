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

1. Create a new Google Spreadsheet.
2. **Extensions → Apps Script**, then note the script ID from **Project Settings**.
3. `cp .clasp.json.example .clasp.json` and paste your script ID in.
4. `npm i -g @google/clasp && clasp login && clasp push`
5. Reload the spreadsheet. Use the **Hostel System** menu:
   - *1. Create database* — builds all 18 tabs, seeds Config/Policy, writes the genesis ledger row
   - *2. Seed demo data* — generates the synthetic GGSIPU cohort
   - *Verify Phase 0 setup* — confirms the foundation is sound
6. **Deploy → New deployment → Web app**, *Execute as: me*, *Access: anyone with a Google account*.

Full instructions in [DEPLOYMENT.md](DEPLOYMENT.md).

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
  Setup.gs           one-click createDatabase()
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
| 1 | Synthetic data, hostel inventory, policy, pincode geo | ⏳ next |
| 2 | Allocation engine, roommate matching, waitlist, metrics | ⏳ |
| 3 | Student portal | ⏳ |
| 4 | Admin dashboard, letters, email | ⏳ |
| 5 | Simulator, swaps, grievance auto-triage | ⏳ |
| 6 | Demo hardening and deliverables | ⏳ |
