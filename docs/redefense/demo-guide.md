# Demo guide: the defense data

For the redefense on Friday, November 27, 2026. Live at https://sacs-payroll.vercel.app.

- **Logins** (e-mail and password) are given **in chat only**; none are in this file. Each sign-in asks for an e-mail code, which arrives in the demo inbox.
- **The data:** every account on payroll, from Oct 1 to today. It was generated through the app itself: real RFID terminal taps, the nightly close, requests and decisions, and payroll runs.
- **Each day** a server job adds that day's taps until Nov 27: time in around 08:00, time out around 18:00. Ramon (AWOL) and Anjo (separated) are skipped.
- **Payroll:** Oct 1–15, Oct 16–31 and Nov 1–15 are **Paid** at Main and Robinson. Anjo's final pay is approved. **Nov 16–30 is processed and ready for HR**: the Accountant submits it and HR approves it live.

## Who is who

| Login | Role | Branch | What their data shows |
|---|---|---|---|
| Maricel Santos | HR | Main | Approves everything below; the Robinson HR's own payslip is approved by another HR |
| Rowena Dizon | Accountant | Main | Processes and submits Main's payroll |
| Marisol Santos Aquino (DEMO-101) | Employee, Teacher, Regular since 2022 | Main | Vacation leave Nov 12–13; approved overtime Nov 10; honorarium ₱1,500; salary loan ₱10,000 (deducted on 16–end payslips); substitute for Carlo on Nov 17; tenure; licensed teacher |
| Carlo Reyes Mendoza (DEMO-102) | Employee, Teacher, Probationary | Main | Sick leave Nov 17, which proposed the substitution; overtime request pending; honorarium ₱800; licensed teacher |
| Liza Gomez Ferrer (DEMO-103) | Employee, Teacher, Provisional | Main | Half day (AM) Nov 11; Nov 6 missing time-out fixed by an approved correction; Nov 18 correction pending; honorarium ₱1,000 |
| Ramon Cruz Salazar (DEMO-104) | Employee, Registrar Staff, Regular | Main | Vacation leave rejected (preset remark); Nov 13 "Overtime not filed"; Nov 4 short day; **AWOL from Nov 18**: 1st notice sent, pay on hold, reply by Nov 29 |
| Nestor Lim Pascual (DEMO-105) | Employee, **Maintenance**, Contractual | Main | Approved overtime Nov 6; vacation leave Dec 1 pending |

The other accounts on payroll are Andrea Villanueva, Ehd Astillero Refuerzo, Jane Dela Pena Benitez, Jarvis Pasion, Joanna Marquez, Reinjelyn Garaña, Teresa Bautista, Nona Guido, Jane Marinel (Robinson, Accountant and HR) and Karlos Dela Cruz (Robinson). Each has a complete record and the same kind of data, with lates, leave, loans (Andrea's cash advance, Jane's salary loan) and tenure (Andrea).

## Panel item → where to show it

| # | Item | Login | Page | What to show |
|---|---|---|---|---|
| 01 | Half day / overtime | Liza; Carlo; Maricel | Employee › My Requests; HR › Approvals | Liza's AM half day; Carlo's pending overtime → HR approves |
| 02 | Late / Absent without a request | Maricel | HR › Attendance | Lates (time in − shift start) and Ramon's Nov 4 short day |
| 03 | Overtime only with a request | Ramon; Maricel | Employee › My Attendance; HR › Attendance | Nov 13, out 18:40: "Overtime not filed", unpaid |
| 04 | Category, status, Maintenance | Maricel | HR › Employees | Nestor's position Maintenance; statuses; no employment type |
| 05 | Leave credits pool | Marisol | Employee › My Requests | "Leave credits: 2 of 5 days used · 3 days left" |
| 06 | Statutory leave | Maricel | HR › Settings › Status & leave rules | Separate from the pool |
| 07 | AWOL | Ramon; Maricel | My Notices; HR › AWOL cases | Script B below |
| 09 | Substitution | Maricel; Marisol | HR › Approvals; My Payslips | Proposed from Carlo's sick leave; Marisol's substitution line |
| 10 | Additional pay | Rowena; Maricel | Accountant › Additional Pay; HR › Incentives & loans | Honoraria and Ramon's adjustment |
| 11 | Special working day | Maricel; a teacher | HR › Holidays & Duty | Sat Nov 21 make-up, 08:00–12:00, three teachers |
| 12–13 | Bulk approval, filters | Maricel | HR › Approvals | Script C below |
| 15 | Tenure | Maricel | HR › Employees › Tenure pay | Marisol, Ramon and Andrea (2+ years) |
| 16 | RFID / HR taps | Maricel | HR › Attendance | HR officers have taps too; nobody handles their own card |
| 20 | Corrections | Liza; Maricel | My Requests; HR › Approvals | Nov 6 approved (history keeps the original), Nov 18 pending |
| 21 | Payslip PDF | Marisol | My Payslips | Two panels; YTD box with 13th month accrued |
| 22 | Leave conversion | Marisol; Maricel | My Requests; HR › Reports | "If the year ended today: …"; the "Leave conversion (projected)" report |

## Defense scripts

**A. Request to payslip**
1. Carlo, in My Requests, files overtime.
2. Maricel opens HR › Approvals and approves it with a preset remark.
3. Rowena opens Accountant › Process Payroll › Nov 16–30. If a payslip shows "Needs recompute", press Recompute, then **Submit**.
4. Maricel opens HR › Approvals › Payroll runs and approves the run.
5. Marisol opens My Payslips: the Nov 16–30 payslip, then the PDF.

**B. AWOL**
1. Ramon sees the Dashboard banner and opens My Notices. He opens the 1st notice PDF and replies with a reason, an explanation and an attachment.
2. Maricel opens HR › AWOL cases. The case shows "Reply received". The details drawer shows the timeline, guards, notices and the reply.
3. Maricel either Separates (the notice of separation, effective after 3 days) or Closes with a preset remark.
4. Ramon sees HR's decision in My Notices.

**C. Bulk approval**
1. Maricel opens HR › Approvals and filters by type and branch.
2. She ticks several items, then Approve selected or Reject selected, with one preset remark.
3. Each row reports its result, and each decision is audited.

**D. Substitution:** Maricel › Approvals › Substitutions. The proposal came from Carlo's approved sick leave, and Marisol covered 3 periods. Show the line on Marisol's payslip.

**E. Attendance correction:** Liza › My Attendance › Nov 18 → the pending correction. Maricel approves it and sees the pay difference.

**F. Special working day:** Maricel › Attendance › Holidays & Duty › Sat Nov 21 make-up. Marisol's attendance shows the day.
