# PROJECT CONTEXT — Smart Hostel Allocation & Optimization System

> **This is the single carry-everything document for the project.**
> Every new work session, every teammate, and every AI assistant starts by reading this file.
> If something about the project changes, it changes *here first*.

---

## 1. Identity

| | |
|---|---|
| **Project** | Low-Cost Lite Smart Hostel Allocation & Optimization System |
| **Event** | Smart India Hackathon (SIH) 2026 |
| **Organization** | GGSIPU Hostels — Guru Gobind Singh Indraprastha University |
| **Campuses in scope** | Dwarka Campus, East Delhi Campus (EDC) |
| **Team size** | 2–3 developers |
| **Prototype deadline** | **24 August 2026** (planning began 21 August 2026) |
| **Repository** | `SIH 2026/` — Git, hosted on GitHub |

---

## 2. Problem statement (verbatim intent)

Hostel allocation at GGSIPU is a complex annual exercise involving students from multiple
programmes with varying eligibility criteria, room preferences, accessibility requirements, gender
policies, reservation norms, roommate compatibility, academic year, branch, distance from hometown
and special accommodation requests.

The process is currently driven by **spreadsheets and physical counters**, resulting in:

- inefficient room utilisation
- allocation conflicts
- lengthy grievance processes
- limited transparency for students and parents

We must automate the **complete hostel admission lifecycle** — online applications, document
verification, optimised room allocation, waiting-list management, room upgrades, hostel transfers,
vacancy tracking and grievance redressal — in a system operable by a **small university
administrative team without dedicated servers, paid licences, or a full-time developer**.

### Required deliverables

- [ ] Smart Hostel Management Portal
- [x] Automated Allocation Engine
- [x] Student Self-Service Portal
- [ ] Administrator Dashboard
- [ ] Waiting List & Vacancy Management Module
- [ ] Automated Email Notification System
- [ ] Technical Documentation
- [ ] Source Code Repository
- [ ] Deployment Guide
- [ ] Demo Video

---

## 3. Locked decisions

These were decided at planning time. **Do not re-litigate them without a stated reason.**

| Decision | Choice | Why |
|---|---|---|
| **Stack** | Pure Google Apps Script + Google Sheets + HTML Service | Zero cost, zero servers, zero deploy dependencies. Matches the "no servers, no licences" constraint literally. Fastest path to a working demo. |
| **Optimiser** | Custom JavaScript algorithm (no OR-Tools in v1) | OR-Tools requires a Python service — an extra host, cold starts and a live-demo failure point. Our algorithm is provably strategy-proof and far more *explainable*, which serves the transparency requirement better. |
| **Auth** | Google login via `Session.getActiveUser().getEmail()`, deployed *anyone with a Google account* | No password code, no session handling, works on personal Gmail. Safe because we do not control an IPU Workspace domain. |
| **Intake** | Custom HTML form inside the web app | Google Forms cannot do preference ranking, live validation, or save-as-draft. A Google Form is kept as a *documented fallback path only*. |
| **Data** | Fully synthetic, GGSIPU-shaped, script-generated | No real data available. Generator is written so real inventory/policy can be dropped in as a one-sheet swap. |
| **Demo strategy** | End-to-end thin slice | Every lifecycle stage works but shallow. Depth is added *after* 24 Aug. Judges must see the whole lifecycle. |

---

## 4. The four novelty features

These are what make this project different from every other hostel-allocation submission.
**Ranked by how hard they are to cut.**

### 4.1 Explainable allocation + tamper-evident ledger — **NEVER CUT**

Every allotment carries a plain-English trace of *why* it happened, and every state change is
written to a hash-chained audit log.

```
WHY YOU GOT ROOM B-204
 ✓ Merit rank 142 / 900
 ✓ PwD quota: ground-floor rule applied
 ✓ Preference #2 (2-seater) matched
 ✗ Preference #1 unavailable — filled at rank 118
 ✓ Roommate compatibility 0.87

Ledger #0141  hash=a3f9…  prev=7c21…  ✔ chain intact
```

**Why it matters:** this attacks the two stated pain points — *lengthy grievance processes* and
*limited transparency* — at the root. Most grievances exist because nobody can see the reasoning.
The ledger makes allocation records tamper-evident, so a student or parent alleging manipulation
can be answered with cryptographic evidence.

**Implementation:** the trace is not a separate system — every stage of the allocator appends
`reasonCodes` as it runs, so the explanation is a byproduct of the algorithm and cannot drift out
of sync with it.

### 4.2 Roommate compatibility matching

A short lifestyle survey (sleep time, study style, cleanliness, sociability, food preference,
language, smoking tolerance) feeds a compatibility score, and students are paired within room
slots via stable matching.

**Why it matters:** most mid-year hostel transfer requests are roommate conflicts. Solving it at
allocation time reduces downstream administrative load — a real GGSIPU pain point.

### 4.3 What-if policy simulator

An admin changes a quota percentage, a scoring weight or a hostel capacity, and sees the resulting
allocation *and a who-moved diff* **before committing**.

```
SIMULATE: PwD quota 3% → 5%

  Allocated      871 → 869  (-2)
  Waitlisted      29 →  31  (+2)
  Pref-1 met     64% → 63%
  Moved students: 14   [view diff]

  [ Discard ]   [ Commit run #7 ]
```

**Why it matters:** policy decisions are currently made blind. Runs are seeded and reproducible,
so a result is defensible in an appeal — you can re-run the exact allocation months later and get
byte-identical output.

### 4.4 QR-verified allotment letter + mutual swap marketplace

- The allotment PDF carries a **cryptographically signed QR** resolving to a live verification
  page — anti-forgery at the hostel gate and the warden's desk.
- Students propose **mutual room swaps**; the system validates them against policy (gender,
  campus, quota neutrality, accessibility) and auto-approves valid ones without an admin queue.

**Why it matters:** replaces the physical counter with a scan, and removes an entire category of
manual admin work.

---

## 5. Architecture

```
                    ┌──────────────────────────────────────┐
                    │  Google Sheet  (the entire database)  │
                    │  18 tabs · Config · Policy · Rooms    │
                    │  Applications · Allocations · Ledger  │
                    └──────────────┬───────────────────────┘
                                   │  Db.gs  (typed access layer + cache)
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
  ┌─────▼──────┐          ┌────────▼────────┐        ┌────────▼────────┐
  │  ENGINE    │          │   SERVICES      │        │   WEB APP       │
  │ Eligibility│          │  Letters (+QR)  │        │  doGet router   │
  │ Allocator  │          │  Notify (Gmail) │        │  Student portal │
  │ Roommate   │          │  Ledger (hash)  │        │  Admin dashboard│
  │ Waitlist   │          │  Simulator      │        │  Verify page    │
  │ Swap       │          │  Grievance      │        │  (Tailwind CDN) │
  └────────────┘          └─────────────────┘        └─────────────────┘
```

**Deployment model:** one Apps Script project bound to one Spreadsheet, deployed as a Web App with
*Execute as: me* and *Access: anyone with a Google account*. Source is managed in Git and pushed
with `clasp`.

### Why Sheets-as-database is the right call here

It is not a compromise — it is the requirement. The admin team already lives in spreadsheets.
Policy rules, room inventory and quota percentages are **editable by a non-programmer in a
familiar interface**, with no deploy step. That is precisely what "operable without a full-time
developer" means.

---

## 6. Database schema — THE TEAM CONTRACT

**Frozen at the end of Phase 0. Changing a column means telling the whole team.**
This schema is the interface between the parallel work tracks.

| Tab | Purpose | Key columns |
|---|---|---|
| `Config` | runtime settings | key, value |
| `Policy` | **rules as data, not code** | ruleId, category, key, value, effectiveFrom, notes |
| `Students` | student master registry | studentId, name, enrollmentNo, email, gender, programme, branch, year, cgpa, category, isPwD, homePincode |
| `Applications` | one row per application | appId, studentId, campusPref, status, submittedAt, meritScore, distanceKm, eligibility, docStatus |
| `Preferences` | ranked, long format | appId, rank, hostelId, roomType |
| `Lifestyle` | roommate survey | appId, sleepTime, studyStyle, cleanliness, sociability, foodPref, language, smokingTolerance |
| `Hostels` | hostel master | hostelId, name, campus, gender, warden, contact |
| `Rooms` | room inventory | roomId, hostelId, block, floor, roomNo, capacity, roomType, isAccessible |
| `Beds` | **bed-level** inventory | bedId, roomId, bedNo, status, occupantAppId |
| `Allocations` | results | allocId, runId, appId, bedId, allocatedAt, prefRankMet, reasonCodes, compatScore |
| `Waitlist` | ordered queue | appId, hostelId, position, etaProbability, updatedAt |
| `Transfers` | transfer + swap requests | reqId, type, appId, counterpartAppId, status, decidedAt, reason |
| `Grievances` | tickets | ticketId, appId, category, text, autoTriage, status, resolution, slaDueAt |
| `AuditLog` | **hash chain** | seq, ts, actor, action, payloadJson, prevHash, hash |
| `Runs` | allocation run metadata | runId, mode (draft/committed), seed, policyHash, startedAt, metricsJson |
| `Admins` | RBAC | email, role, campus |
| `PincodeGeo` | offline distance table | pinPrefix, lat, lng, district, state |
| `Notifications` | email outbox / log | msgId, appId, template, sentAt, status |

### Design note: why bed-level, not room-level

Bed-level granularity is deliberate. It is what makes **roommate matching**, **mutual swaps** and
**partial vacancies** expressible at all. A room-level model cannot represent "bed 2 of a 3-seater
is free because one student withdrew" — which is exactly the vacancy-tracking case the problem
statement asks for.

---

## 7. Source layout

```
SIH 2026/
  PROJECT_CONTEXT.md      ← you are here
  README.md
  DEPLOYMENT.md
  TECHNICAL_DOC.md
  .clasp.json
  src/
    appsscript.json
    Setup.gs         one-click createDatabase()
    Main.gs          doGet router, include(), custom menu
    Db.gs            sheet access, batch read/write, ID gen, cache
    Auth.gs          session resolution, role guard
    Policy.gs        policy load + snapshot hashing
    Eligibility.gs   rule evaluation → {pass, reasons[]}
    Allocator.gs     the optimiser (stages A–H)
    Roommate.gs      compatibility scoring + stable matching
    Waitlist.gs      ordering + ETA prediction
    Swap.gs          mutual swap validation
    Grievance.gs     lifecycle + auto-triage
    Letters.gs       HTML→PDF letter + QR renderer
    Notify.gs        Gmail templates, batched send
    Ledger.gs        hash chain append + verify
    Simulator.gs     what-if run + diff
    SeedData.gs      synthetic data generator
    Metrics.gs       fairness metrics
    ui/
      index.html  apply.html  student.html  admin.html  verify.html
      styles.html  scripts.html
```

---

## 8. The allocation algorithm

Deterministic, seeded, and explainable by construction. Lives in `Allocator.gs`.

```
A. PARTITION      hard constraint: GENDER (+ accessibility need).
                  Dwarka and EDC are ONE pool - campus is a preference, not a
                  partition, so a student may be allotted to either campus.
                  → students who cannot legally share a hostel never enter the same pool

B. SCORE          composite = w_merit    · norm(cgpa / merit rank)
                            + w_distance · norm(distanceKm from home)
                            + w_year     · seniority
                            + w_special  · specialNeed
                  ALL WEIGHTS READ FROM THE Policy SHEET — never hardcoded

C. ORDER          sort descending; deterministic tie-break = hash(appId + runSeed)
                  → identical inputs always produce identical output

D. QUOTA PASS     reserve seats per category using the LARGEST-REMAINDER method
                  → avoids the rounding disputes that generate real grievances
                    ("why did SC get 15 seats and not 16 at 15% of 103?")

E. SERIAL DICTATORSHIP
                  in score order, each applicant takes their best still-available
                  ranked preference.
                  → strategy-proof: no student benefits from lying about preferences
                  → trivially explainable: "the person at rank 118 took the last
                    2-seater in Hostel A"

F. LOCAL SEARCH   bounded pairwise-swap hill climbing. Accept a swap ONLY if it
                  raises total preference welfare AND creates no new envy —
                  no higher-ranked student may end up worse off. Capped iterations.

G. ROOMMATES      within each multi-bed room, maximise compatibility via greedy
                  seeding + Gale–Shapley refinement

H. WAITLIST       unallocated students → ordered queue + ETA probability derived
                  from historical churn rate
```

### Why serial dictatorship rather than a solver

A CP-SAT solver returns an optimum but cannot tell a student *why*. Serial dictatorship over
ranked preferences produces an allocation that is **strategy-proof, Pareto-efficient, and
explainable in one sentence per student**. Given that transparency and grievance reduction are the
stated problems, explainability is worth more here than the last few percent of optimality — and
stage F recovers most of that gap anyway.

### Fairness metrics (`Metrics.gs`)

Emitted per run, shown on the admin dashboard, and used as the evidence base for grievance replies:

- % of students granted preference #1
- mean granted preference rank
- per-category quota compliance table
- envy-pair count
- Gini coefficient of preference satisfaction
- room utilisation %

---

## 9. Novelty implementation notes

**Hash chain.** `hash = SHA256(seq | ts | actor | action | payload | prevHash)` computed with
`Utilities.computeDigest`. A genesis row is written at setup. `Ledger.verify()` walks the chain and
reports the first break. Any hand-edit to a historical row breaks every subsequent hash.

**QR codes with no external API.** A minimal QR encoder is ported to JS; the module matrix is
rendered as an HTML table of coloured cells and the PDF is produced with
`Utilities.newBlob(html, 'text/html').getAs('application/pdf')`. No image service, no CDN, fully
offline. *HTML→PDF is used instead of Docs→PDF specifically because a cell-grid QR survives that
conversion reliably.*

**Signed QR links.** `?page=verify&id=<allocId>&sig=<HMAC>` with the secret held in Script
Properties, so a valid-looking QR cannot be forged.

**Distance with no paid API.** A precomputed `PincodeGeo` table (~750 three-digit pincode prefixes
→ lat/lng) plus haversine to each campus. Genuinely free, fully offline, no Maps API key.

**Grievance auto-triage closes the loop.** An allocation-dispute ticket automatically pulls the
student's explainability trace and ledger entry and drafts the reply showing exactly why the
allocation happened. Only genuine anomalies escalate to a human. *This is the payoff of building
explainability first — the two features compound.*

**Simulator isolation.** Simulation runs the pipeline in `draft` mode against a modified policy
snapshot, then diffs `Allocations` against the committed run. It **never writes to live state**
until Commit is pressed.

---

## 10. Phase plan

Each phase carries a **YOUR INPUT** hook — the point where GGSIPU-specific knowledge gets injected
before that phase is built — and a **CUT LINE** naming exactly what to drop if time runs short.

### Phase 0 — Foundation · *21 Aug · ~3h · all hands*
Freeze the contract so 2–3 people can work in parallel without collisions.
1. `git init`, repo scaffold, `.clasp.json`, `appsscript.json`
2. **`PROJECT_CONTEXT.md`** (this file)
3. `Setup.gs` — one-click `createDatabase()` building all 18 tabs, validation, genesis ledger row
4. `Db.gs` access layer + `Config` / `Policy` seeded with defaults

**Exit:** `createDatabase()` produces the complete empty database. Schema frozen.
**YOUR INPUT:** any GGSIPU field we're missing — fee category, quota codes, campus-specific rules.

---

### Phase 1 — Data & policy · *22 Aug AM · Track C*
1. `SeedData.gs` — ~900 students with realistic GGSIPU distribution (B.Tech / MBA / LLB / M.Tech /
   MCA mix, gender split, category split incl. ~3% PwD, home pincodes weighted Delhi-NCR vs rest of
   India, CGPA distribution, ranked preferences, lifestyle answers)
2. Hostel + room + bed inventory for Dwarka and EDC — blocks, floors, room types
   (single / 2-seater / 3-seater), accessible ground-floor rooms
3. `PincodeGeo` table + haversine distance
4. `Policy` rows — reservation percentages, eligibility thresholds, scoring weights,
   **all editable in the sheet with zero code changes**

**Exit:** a populated, believable GGSIPU dataset.
**CUT LINE:** drop to 300 students if generation is slow.
**YOUR INPUT:** real hostel names/blocks and actual reservation percentages if obtainable —
swapping synthetic for real inventory is a one-sheet change.

---

### Phase 2 — Allocation engine · *22 Aug PM → 23 Aug AM · Track A*
1. `Eligibility.gs` — evaluates Policy rules → `{pass, reasons[]}`
2. `Allocator.gs` — stages A–H
3. `Roommate.gs` — compatibility scoring + stable matching
4. `Waitlist.gs` — ordering + ETA
5. `Ledger.gs` — hash chain append + verify
6. `Metrics.gs` — fairness metrics
7. Test harness — assert quota compliance, no double-booked beds, no gender violations, chain intact

**Exit:** `runAllocation(seed)` allocates ~900 students in one call, writing traces and ledger rows.
**CUT LINE:** drop stage F (local search). Serial dictatorship alone is defensible and explainable.
**YOUR INPUT:** the scoring weights — what does GGSIPU actually value: merit, distance, seniority?

---

### Phase 3 — Student portal · *22 Aug PM → 23 Aug · Track B, parallel with Phase 2*
1. `Auth.gs` + `Main.gs` router; role guard against `Admins`
2. `apply.html` — sectioned form, live validation, **drag-to-rank preferences**, Drive document
   upload, lifestyle survey, save-as-draft
3. `student.html` — status tracker, allotment card, **"Why did I get this room?" panel**, letter
   download, waitlist position + ETA, raise grievance, swap marketplace entry
4. Tailwind via CDN, mobile-first

**Exit:** a student can log in, apply, and see their result and its explanation.
**CUT LINE:** drop Drive upload and save-as-draft. Keep ranking and the explanation panel.
**YOUR INPUT:** which documents GGSIPU actually demands at verification.

---

### Phase 4 — Admin dashboard, letters, email · *23 Aug · Tracks B + C*
1. `admin.html` — occupancy/vacancy by hostel/block/floor, run allocation, fairness charts
   (Google Charts), verification queue, waitlist, grievance inbox, **ledger integrity badge**
2. `Letters.gs` — allotment letter HTML→PDF with signed QR, saved to Drive
3. `verify.html` — public QR verification page
4. `Notify.gs` — Gmail templates (submitted / verified / allotted / waitlisted / grievance update),
   batched, logged to `Notifications`, respecting free-tier quota

**Exit:** admin runs allocation → letters generate → emails send → QR verifies.
**CUT LINE:** one chart instead of four; plain-text email instead of HTML.
**YOUR INPUT:** the letter format — GGSIPU letterhead, signatory, required clauses.

---

### Phase 5 — Novelty layer · *23 Aug PM → 24 Aug AM · all hands*
1. `Simulator.gs` — what-if run + who-moved diff + Commit/Discard
2. `Swap.gs` — swap marketplace, mutual consent, policy validation, auto-approval, ledger entry,
   letter reissue
3. `Grievance.gs` — auto-triage; allocation disputes auto-answered from the trace
4. Ledger verification UI + a deliberate tamper-detection demo button

**Exit:** all four novelty features demonstrable.
**CUT LINE (strict, in this order):** grievance auto-triage → swap market → simulator.
**Never cut explainability or the ledger** — they are the spine of the differentiation story.

---

### Phase 6 — Demo hardening & deliverables · *24 Aug*
1. Scripted demo scenario with pre-seeded characters
2. `DEPLOYMENT.md`, `TECHNICAL_DOC.md`, README, architecture diagram
3. Demo video script + recording
4. Two full end-to-end dry runs

---

### Phase 7+ — Post-deadline depth · *after 24 Aug*
Optional OR-Tools / CP-SAT solver behind a `solverAdapter` interface (identical signature to the JS
solver, swappable at runtime); OTP login as a second auth provider; real GGSIPU inventory and
policy ingestion; multi-year historical analytics; cross-campus hostel-transfer workflow.

---

## 11. Parallel work tracks

| Track | Owner | Phases | Files owned (no overlap) |
|---|---|---|---|
| **A — Engine** | dev 1 | 2, 5 (simulator, swap) | `Allocator` `Eligibility` `Roommate` `Waitlist` `Metrics` `Swap` `Simulator` |
| **B — Portal** | dev 2 | 3, 4 (admin UI) | `Main` `Auth` `ui/*.html` |
| **C — Data & services** | dev 3 | 1, 4 (letters/email), 6 | `SeedData` `Letters` `Notify` `Ledger` `Grievance` docs |

If only 2 people: dev 1 takes A, dev 2 takes B + C, and Phase 5 is cut from the bottom up.

**The contract between tracks is the frozen sheet schema (§6) and the `Db.gs` signatures.** Both
land in Phase 0 before anyone else starts work.

---

## 12. Verification

### Per phase

- **Phase 0** — `createDatabase()` creates 18 tabs with correct headers; genesis ledger row present.
- **Phase 1** — `seedAll()` populates students/rooms/beds; spot-check distributions;
  bed count = Σ room capacity.
- **Phase 2** — run allocation on seed data and assert:
  - no bed double-booked
  - no gender or campus violation
  - every PwD applicant needing accessibility is in an accessible room
  - quota counts match Policy within largest-remainder tolerance
  - every allocation has a non-empty `reasonCodes`
  - `Ledger.verify()` returns intact
- **Phase 3** — apply as a real Google account end-to-end; confirm the application row is written
  and the explanation panel renders.
- **Phase 4** — generate a letter, scan the QR with a phone, confirm the verify page loads; confirm
  the email arrives; corrupt the QR signature and confirm it is rejected.
- **Phase 5** — run the simulator with a changed quota, confirm the diff is non-empty and Discard
  leaves live state untouched; execute a swap and confirm both letters reissue; hand-edit an
  `AuditLog` cell and confirm the integrity badge turns red.

### Full end-to-end rehearsal (this *is* the demo)

```
createDatabase() → seedAll()
  → student applies via portal
  → admin verifies documents
  → admin runs a SIMULATION, adjusts a quota, sees the diff, commits
  → letters generate with QR
  → emails send
  → student logs in, sees room + "why" trace, downloads letter
  → QR scanned → verification page confirms validity
  → student proposes a SWAP → policy-validated → auto-approved → letters reissue
  → student raises a GRIEVANCE → auto-triage answers from the trace
  → admin shows the LEDGER intact → tampers with a row → detection turns red
```

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Apps Script 6-minute execution limit on 900 students | Batch all reads/writes through `Db.gs`, chunk the run, cache in `PropertiesService`; fall back to 300 students |
| Gmail free-tier daily send quota | Batch + throttle, log to `Notifications`, use a demo-sized cohort for live sending |
| 3-day timeline | CUT LINE per phase; the thin slice completes before any depth is added |
| Two devs editing the same `.gs` file | Track ownership table (§11); schema frozen in Phase 0 |
| HTML→PDF rendering quirks | QR drawn as a cell grid, letter kept to simple HTML/CSS; verified early in Phase 4 |
| Judges ask "where is OR-Tools?" | Answer prepared: explainability > marginal optimality for this problem; `solverAdapter` interface exists so CP-SAT can be plugged in — see §8 and Phase 7 |

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Allotment letter** | The official PDF confirming a student's hostel and room |
| **Bed** | The atomic allocatable unit. One room contains 1–3 beds |
| **Commit** | Promoting a draft allocation run to live state |
| **CUT LINE** | The pre-agreed thing to drop in a phase if time runs out |
| **Draft run** | A simulated allocation that has not touched live state |
| **EDC** | East Delhi Campus |
| **Envy pair** | Two students where the lower-ranked one got a better outcome |
| **Genesis row** | The first row of the hash chain, with no predecessor |
| **Largest remainder** | Quota rounding method that avoids seat-count disputes |
| **PwD** | Person with Disability — triggers accessibility hard constraints |
| **reasonCodes** | The explainability trace attached to every allocation |
| **Serial dictatorship** | Allocation in score order, each taking their best available choice |
| **Thin slice** | Every lifecycle stage working, none deeply |
| **Track** | A parallel work stream owned by one developer |

---

## 15. Open questions for the team

Fill these in as GGSIPU-specific information becomes available. Each maps to a **YOUR INPUT** hook.

- [ ] **Phase 0** — Missing fields? Fee category, quota codes, campus-specific rules?
- [ ] **Phase 1** — Real hostel names, blocks, floor counts, room-type mix per campus?
- [ ] **Phase 1** — Actual reservation percentages under GGSIPU rules?
- [ ] **Phase 2** — Scoring weights: how should merit, distance, seniority and special need trade off?
- [ ] **Phase 2** — Is there a minimum distance-from-home threshold for eligibility? A minimum CGPA?
- [x] **Phase 3** — Documents confirmed 21 Aug 2026: admission letter (year 1, no ID card issued yet), ID card (year 2+), category certificate (non-GEN only, where a reserved seat is claimed), PwD certificate (PwD only), address proof (everyone - distance gates eligibility and carries score weight, so it is the main gaming vector).
- [ ] **Phase 4** — Letter format: letterhead, signatory, mandatory clauses?
- [x] **General** — Dwarka and EDC are a SINGLE allocation pool. Confirmed 21 Aug 2026. Students compete in one merit pool and may be allotted to either campus; campus choice is expressed through ranked hostel preferences, not a hard partition. Gender remains the only hard partition.

---

## 16. Changelog

| Date | Change |
|---|---|
| 2026-08-21 | Phase 3 complete. Student portal: apply form with drag-to-rank preferences, dashboard with the "why did I get this room?" panel, per-applicant document rules, roommate display. Added a Documents tab (19 total). 65 offline checks passing. |
| 2026-08-21 | Phase 2 complete. Allocation engine (stages A-H), eligibility with reasons, roommate matching, waitlist ETA, fairness metrics. Two significant fixes: unfilled reserved seats are now dereserved and reissued (utilisation 82 -> 98%), and the vacancy buffer holds real beds per hostel instead of a global seat cap that made one gender absorb the whole reserve. 93 offline checks passing. |
| 2026-08-21 | Phase 1 complete. Synthetic cohort (900 students, 756 beds, 6 hostels), offline pincode geo table, seeded generator. Fixed a real bug in largest-remainder apportionment that over-reserved quota seats. 57 offline checks passing. |
| 2026-08-21 | Dwarka and EDC confirmed as a SINGLE allocation pool. Gender is the only hard partition. |
| 2026-08-21 | Project initiated. Stack, auth, intake, data strategy and four novelty features locked. Phase plan written. This document created. |
