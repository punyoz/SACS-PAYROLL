# Demo guide: the five demo employees on live

For the redefense on Friday, November 27, 2026. Loaded on live on November 24, 2026.

- All five are **demo accounts**, in Main Branch (BR-001), and are marked as demo. They are removed after the defense with `node scripts/demo/five.mjs remove --target=production`.
- The logins (e-mail and password) were given **in chat only**. They are not in this file or anywhere in the repository. Each sign-in asks for an e-mail code, which arrives in the demo inbox.
- The HR and Accountant steps use the kept demo accounts, **Demo HR One** and **Demo Accountant One Main**, or your own HR / Accountant login.
- A daily tap job adds ordinary taps for four of the five before the nightly jobs, every school day until the defense. Ramon is left out on purpose because of his AWOL case.

## The five

| Person | Category · Status | Position | What their data shows |
|---|---|---|---|
| Marisol Aquino (DEMO-101) | Teaching · Regular since 2022 | Teacher | 2-day vacation leave (Nov 12–13, approved); approved overtime worked on Nov 10; honorarium ₱1,500; salary loan ₱10,000 over 4 payrolls; substitutes for Carlo on Nov 17; leave credits **2 of 5 days used · 3 days left** |
| Carlo Mendoza (DEMO-102) | Teaching · Probationary from Aug 2026 | Teacher | Sick leave Nov 17 (approved), which **proposed the substitution by itself**; overtime request pending; leave credits **1 of 1 used · 0 left** |
| Liza Ferrer (DEMO-103) | Teaching · Provisional from Jun 2026 | Teacher | Half day (AM) on Nov 11; missing time-outs: Nov 6 correction approved, Nov 18 correction pending; leave credits **0.5 of 1.5 used** |
| Ramon Salazar (DEMO-104) | Non-teaching · Regular since 2023 | Registrar Staff | Vacation leave rejected with a preset remark; adjustment ₱500; Nov 13 worked past the shift with no overtime request; **absent from Nov 18: AWOL case, 1st notice sent, pay on hold** |
| Nestor Pascual (DEMO-105) | Non-teaching · Contractual to Dec 15 | **Maintenance** | Approved overtime worked on Nov 6; vacation leave pending (Dec 1); contract-end reminder |

**Payroll:** Main Branch's own Nov 1–15 run (run 1) on live is still waiting for HR, and the system locks the whole period at that branch until HR decides it. So the five have **no Nov 1–15 payslip yet**. Once run 1 is decided, the Accountant processes the five for Nov 1–15 on screen, submits them as a supplemental run and HR approves it. Their **Nov 16–30 drafts** show the full month for now ("1-15 payslip paid 0.00"). After Nov 1–15 is processed they show **Needs recompute** and drop back to the half.

## Panel items: where to show each one

| # | Panel item | Login (role) | Page | What to show |
|---|---|---|---|---|
| 01 | Half-day and overtime requests | Liza (Employee); Carlo (Employee); HR | Employee › My Requests (Half day, Overtime); HR › Approvals | Liza's AM half day on Nov 11; Carlo's pending overtime; HR approves it |
| 02 | No request → Late / Absent | HR | HR › Attendance › Monitoring | Marisol late on Nov 5; Ramon leaving early on Nov 4 ("Absent (short day)") |
| 03 | Overtime only with a request | Ramon (Employee); HR | Employee › My Attendance; HR › Attendance | Nov 13 out at 18:40, flagged "Overtime not filed", paid nothing |
| 04 | Category and status; Maintenance as a position | HR | HR › Employees › Management | Five statuses across the five; Nestor's **position is Maintenance** (the Group field is gone) |
| 05 | Leave credits (one shared pool) | Marisol (Employee); HR | Employee › My Requests ("Leave credits: 2 of 5 days used · 3 days left"); HR › Settings › Status & leave rules | One pool per Category × Status; Vacation / Sick / Emergency draw from it; a half day uses 0.5; beyond the pool is without pay |
| 06 | Maternity / paternity as statutory leave | HR | HR › Settings › Status & leave rules (Statutory leaves) | Separate from the pool |
| 07 | AWOL | Ramon (Employee); HR | Employee › Dashboard (banner) and My Profile › **My Notices**; HR › Employees › AWOL cases | See **AWOL** below |
| 08 | Sidebar categories | any | every sidebar | One item per module, with tabs inside |
| 09 | Substitute teaching | HR; Marisol (Employee) | HR › Approvals (Substitutions); Marisol's Nov 16–30 draft | Proposed by the system from Carlo's approved sick leave; HR picked Marisol (3 periods); substitution line on her payslip |
| 10 | Honorarium / adjustment | Accountant; HR | Accountant › Additional Pay; HR › Approvals › Incentives & loans | Marisol's honorarium ₱1,500 and Ramon's adjustment ₱500, filed by the Accountant and approved by HR |
| 11 | Special working day (Saturday) | HR; a teacher | HR › Attendance › Holidays & Duty | Sat Nov 28 make-up, 08:00–12:00, for the three teachers (they were notified) |
| 12–13 | Checkboxes, search and filters | HR | HR › Approvals | Select several and decide with one remark; filter by branch, category, status and dates |
| 14 | Automation for Admin / HR | HR; Admin | Dashboards › Action needed; Settings › Automation | Proposed substitution, AWOL, reminders |
| 16 | RFID in one place | HR | HR › Attendance (RFID tabs) | The five's cards (issued Oct 28) |
| 19 | Preset remarks | HR | any decision dialog | Ramon's rejected leave: "Conflicts with school activity" |
| 20 | Attendance corrections | Liza (Employee); HR | Employee › My Requests › Attendance correction; HR › Approvals | Nov 6 approved, Nov 18 pending: HR sees the evidence and the pay difference |
| 21 | Payslip layout / PDF | an employee | Employee › My Payslips | After Nov 1–15 is approved (see Payroll) |

## AWOL (item 07)

- **What happened:** Ramon has not tapped since Nov 18. His card is active, he is on his schedule and he has no request. The case was opened the way the nightly job opens one, with the real guard results. Two guards failed, so it went to **Needs review**:
  - "a demo / test account";
  - Main Branch's Nov 23 data gap, because its real staff do not tap yet.
- **What HR did:** HR pressed **Proceed**. That confirmed AWOL, put his pay on hold and sent the 1st notice. The reply is due Nov 29.
- **What to show:**
  1. Sign in as Ramon: the Dashboard banner says "You have an attendance notice".
  2. Open **My Notices**: the notice and its PDF.
  3. Reply with a reason, an explanation and an attachment, and optionally a return date. The automation stops.
  4. A follow-up can be added; a reply can't be edited.
  5. As HR, open AWOL cases. The case shows the reply and its attachment, the guards, **Record reply** for a reply received offline, and **Separate** or **Close** (with a preset remark).
  6. Ramon sees HR's decision in My Notices.
- **AWOL automation stays paused on live** (your decision). At Main Branch, the data-gap rule is the only thing keeping its real staff, who don't tap yet, from being flagged. A dry run on live on Nov 24, with AWOL switched on and then rolled back, would have acted on nobody.
