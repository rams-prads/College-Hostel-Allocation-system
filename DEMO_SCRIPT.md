# Demo Script

A twelve-minute run-through. Built around six named students so the audience
follows a story rather than a dashboard.

**Before you begin:** `Hostel System → Prepare demo scenario`, and enter your own
Google address when prompted. That names the cast and attaches your account to
Arjun so you can sign in as him live.

Keep two browser tabs open: the **student portal** (the web app URL) and the
**admin dashboard** (same URL + `?page=admin`).

---

## The one-sentence pitch

> Hostel allocation at GGSIPU runs on spreadsheets and physical counters. We
> rebuilt it as software that costs nothing to run, and made every decision it
> takes explainable to the student it affects.

---

## 0 · The problem (45 seconds)

Say this without slides:

> Nine hundred students apply. Seven hundred and fifty beds. Reservation quotas,
> gender rules, accessibility requirements, and a preference list from every
> applicant. Today that is reconciled by hand in a spreadsheet, and when a
> student asks why they did not get a room, nobody can answer.

> Everything you are about to see runs inside a free Google account. No server,
> no licence, no developer on staff.

---

## 1 · The allocation (2 min) — admin tab

**Do:** point at the occupancy table, then press **Run allocation**.

**Say while it runs:** it is reallocating all nine hundred applicants from
scratch, in about a second.

**When the numbers land, say:**

> 741 allotted, 97 waitlisted, 98% of beds occupied.

> That 98% is the interesting number. Our first version got 82%, because quotas
> are set as a percentage of capacity and the applicant mix never matches those
> percentages exactly — so reserved seats sat empty while students waited. The
> engine now dereserves unfilled seats and reissues them in strict merit order.
> Sixteen percent of the hostel, recovered.

**Then point at "Pareto swaps found: 0" and say:**

> After allocating, the engine searches for any two students who would *both*
> rather have each other's room. Zero means no such pair exists — nobody can be
> made better off without making someone else worse off. That is a proof, run
> fresh every time, not a claim on a slide.

---

## 2 · Arjun — the explanation (2 min) — student tab

**Do:** sign in as yourself. You are Arjun.

**Say:**

> This is what a student sees. Room, hostel, roommates. And then this —

**Do:** scroll to **Why you got this result**.

**Say:**

> Merit position 1 of 838. The four factors behind his score, each with the
> weight the hostel policy gives it. Which preference was granted.

> This text was written by the engine while it was allocating. It is not a
> report generated afterwards from the outcome — which means it cannot describe
> a decision the engine did not actually make.

---

## 3 · Rohan — the uncomfortable case (2 min) — admin tab

**Do:** in **Look up a student**, type `Rohan`, click **Open portal**.

**Say:**

> Rohan did not get a room. This is the screen that decides whether he files a
> grievance.

**Read one line aloud from his panel** — the one naming the merit position where
open seats ran out.

**Then say:**

> It tells him open seats ran out at a specific position. That as a
> General-category applicant he has no reserved pool to fall back on. That a
> converted seat *did* reach him, but no bed in a boys' hostel remained. And his
> realistic odds if someone withdraws.

> Every one of those is a fact about his own case. Nothing is hidden and nothing
> is softened.

---

## 4 · Priya — accessibility (1 min)

**Do:** look up `Priya`, open her portal.

**Say:**

> Priya declared a locomotor disability. Ground floor, accessible room. The
> engine treats that as a hard constraint — it cannot place her anywhere else.

> One detail we got wrong first time: the emergency bed reserve was taken from
> whatever was left, which meant accessible rooms could be held back while a
> wheelchair user waited. It now draws from ordinary stock first.

---

## 5 · The what-if simulator (2 min) — admin tab

**Do:** scroll to **What-if simulator**. Change **PwD reservation** from 5 to 12.
Press **Simulate**.

**Say while it runs:**

> It is running two complete allocations — one on current policy, one on the
> proposed policy, from the same random seed. Only the rule differs, so any
> difference is caused by the rule.

**When the diff appears:**

> Before and after on every measure. And underneath — the students who actually
> move. Not a percentage. Names.

> Nothing has been written. The modified policy exists only in memory. The
> hostel office can try a policy, see who it hurts, and walk away.

**Do:** press **Discard**.

---

## 6 · The swap marketplace (1.5 min)

**Say:**

> Most mid-year transfer requests are roommate conflicts. Instead of an
> administrative queue, students arrange it themselves.

**Do:** look up `Kavya`, then `Meera`, to show they are in different rooms.
Describe the flow: Kavya posts, Meera accepts, done.

**Say:**

> A swap cannot change seat totals or quota counts — the entitlement belongs to
> the student, not the bed. The two things it *can* break are the gender
> partition and the accessibility guarantee, and both are checked before it goes
> through. So it approves itself. No warden involved.

> Both allotment letters are reissued immediately, which matters more than it
> sounds: a stale letter would still scan as genuine and send a warden to the
> wrong door.

---

## 7 · The letter and the QR (1.5 min)

**Do:** open a generated PDF from Drive. Either scan the QR, or — more reliably —
open the verification page and paste the code printed beneath the QR.

> The typed route is not a fallback to apologise for. Say it plainly: a gate
> should not depend on a camera focusing. Both routes reach the same check.

**Say as the verification page loads:**

> The letter carries a signature over its reference number. The QR resolves to a
> live page that checks it.

**Do:** show the green "Genuine allotment letter" panel.

**Then say:**

> We wrote the QR encoder ourselves — Reed-Solomon, masking, the lot — because
> every hosted QR service is either paid or an external call this demo could die
> on. Nothing here touches the network.

> Change one character of that reference and it fails. Cancel the allotment and
> it fails, even with a valid signature — otherwise an old letter still opens the
> gate.

---

## 8 · The ledger — the closer (1.5 min) — admin tab

**Do:** point at the green **Chain intact** badge. Click **View recent entries**.

**Say:**

> Every state change is logged, and each row's hash covers the previous row's
> hash. Editing history breaks every hash after it.

**Do:** open the `AuditLog` tab in the spreadsheet, edit any cell in an old
`payloadJson`, return to the dashboard and reload.

**Say as it turns red:**

> It names the exact row. So when a parent alleges the allocation was
> manipulated, the answer is evidence rather than assurance.

**Do:** undo the edit (Ctrl+Z), reload, show it green again.

---

## 9 · The grievance that answers itself (1.5 min)

**Do:** as Arjun (or Rohan), raise a grievance: *"My rank was decent but I did
not get a room. Please explain."*

**Say while it processes:**

> Watch what it does. It does not reply with the stored explanation — that would
> prove nothing, because a broken engine would faithfully describe its own
> breakage.

**When the reply appears:**

> It re-checked three things independently. That nobody below him took a seat he
> was entitled to. That the preferences he missed really were full at his
> position. That the audit log covering the run is unbroken.

> All three passed, so it answered him and cited the ledger entry. If any one had
> failed, this would have gone to a warden with the irregularity named — which is
> the only case actually worth a person's time.

---

## Closing (30 seconds)

> Google Apps Script, Google Sheets, Gmail. Zero rupees a year. Deployable by
> one administrator in fifteen minutes.

> The problem statement asked us to fix inefficient utilisation, allocation
> conflicts, slow grievances and no transparency. Utilisation is 98%. Conflicts
> are prevented by construction and checked by tests. Grievances answer
> themselves when the answer is defensible and escalate when it is not. And every
> student can see exactly why they got what they got.

---

## If a judge asks

**"Why not Google OR-Tools?"**

> A solver returns an optimum but cannot tell a student why. We use serial
> dictatorship over ranked preferences — strategy-proof, so nobody gains by
> lying about their preferences, and Pareto-efficient, which the engine verifies
> on every run. For a problem where the stated pain is *transparency*,
> explainability is worth more than the last few percent of optimality. The
> solver interface is separable if you want CP-SAT later.

**"Is the data real?"**

> The cohort is synthetic and the hostel names are placeholders. The generator is
> seeded, so the same nine hundred students appear on every machine. Real
> inventory is a one-sheet swap — the schema is already shaped for it.

**"What if two administrators run it at once?"**

> Writes go through a locked layer, and every run records its seed and a hash of
> the policy that produced it. Re-running with both unchanged reproduces the
> allocation byte for byte, months later.

**"How is this secure if it runs as you?"**

> That is exactly why every admin function starts with an authorisation check.
> A student passing another student's ID from the browser console gets an error,
> not their data. There is a test for that specific attack.

**"What is not finished?"**

> Document upload is built but only lightly exercised. Cross-campus transfers
> beyond swaps are not built. The reservation percentages are the central norms
> and need verifying against IPU's actual rules before any real use. And the OTP
> login for students without a Google account is designed but not implemented.

---

## Recording checklist

- [ ] `Prepare demo scenario` run, cast confirmed
- [ ] Ledger green before you start
- [ ] `ALLOW_TAMPER_DEMO` set TRUE in `Config` if using the button rather than a
      manual edit — **set it back to FALSE afterwards**
- [ ] At least 25 letters generated so a PDF is ready to scan
- [ ] Phone charged, camera tested against the QR beforehand
- [ ] `EMAIL_ENABLED` left FALSE unless you are demonstrating a send to yourself
- [ ] Both tabs open and signed in before recording starts
