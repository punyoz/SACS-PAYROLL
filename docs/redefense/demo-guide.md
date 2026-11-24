# Demo guide: the defense data

For the redefense on Friday, November 27, 2026. Live at https://sacs-payroll.vercel.app.

- **Logins** (e-mail and password) are given **in chat only**; none are in this file. Each sign-in asks for an e-mail code, which arrives in the demo inbox.
- **The data:** every account on payroll, from Oct 1 to today. It was generated through the app itself: real RFID terminal taps, the nightly close, requests and decisions, and payroll runs.
- **Each day** a server job adds that day's taps until Nov 27: time in around 08:00, time out around 18:00. Ramon (AWOL) and Anjo (separated) are skipped.
- **Fri Nov 27, about 07:00:** a server job records everyone's time in before their shift (never a time in the future), so attendance already shows time-ins when the defense starts. If it has not run, the command is: `vercel crons run "/api/cron/demo-taps?run=early"`.
- **Payroll:** Oct 1–15, Oct 16–31 and Nov 1–15 are **Paid** at Main and Robinson. Anjo's final pay is approved. **Nov 16–30 is processed and ready for HR**: the Accountant submits it and HR approves it live.
- **Recompute:** a server job recomputes Nov 16–30 early on Fri Nov 27, after the cutoff closes. **If Nov 16–30 still says Recompute, press Recompute, then Submit.**
- **Testing mode:** the normal window for Nov 16–30 is Nov 27 – Dec 1, so Submit and HR Approve work with testing mode off on the day.

## Who is who

| Login | Role | Branch | What their data shows |
|---|---|---|---|
| Maricel Santos | HR | Main | Approves everything below; the Robinson HR's own payslip is approved by another HR |
| Rowena Dizon | Accountant | Main | Processes and submits Main's payroll |
| Marisol Santos Aquino (SACS-101) | Employee, Teacher, Regular since 2022 | Main | Vacation leave Nov 12–13; approved overtime Nov 10; honorarium ₱1,500; salary loan ₱10,000 (deducted on 16–end payslips); substitute for Carlo on Nov 17, **paid as overtime** on Nov 16–30; tenure; licensed teacher |
| Carlo Reyes Mendoza (SACS-102) | Employee, Teacher, Probationary | Main | Sick leave Nov 17, which proposed the substitution; overtime request pending; honorarium ₱800; licensed teacher |
| Liza Gomez Ferrer (SACS-103) | Employee, Teacher, Provisional | Main | Half day (AM) Nov 11; Nov 6 missing time-out fixed by an approved correction; Nov 18 correction pending; honorarium ₱1,000 |
| Ramon Cruz Salazar (SACS-104) | Employee, Registrar Staff, Regular | Main | Vacation leave rejected (preset remark); Nov 13 "Overtime not filed"; Nov 4 short day; **AWOL from Nov 18**: 1st notice sent, pay on hold, reply by Nov 29 |
| Nestor Lim Pascual (SACS-105) | Employee, **Maintenance**, Contractual | Main | Approved overtime Nov 6; vacation leave Dec 1 pending |

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
| 09b | Rest-day premium | Rowena | Super Admin › Pay Rates (rate "Rest day premium", 30) | Overtime or a substitution on a rest day: 130%; past 8 h: 169% |
| 22 | Leave conversion | Marisol; Maricel | My Requests; HR › Reports | "If the year ended today: …"; the "Leave conversion (projected)" report |

## Defense scripts

**A. Request to payslip**
1. Carlo, in My Requests, files overtime.
2. Maricel opens HR › Approvals and approves it with a preset remark.
3. Rowena opens Accountant › Process Payroll › Nov 16–30. If a payslip shows "Needs recompute", press Recompute, then **Submit**.
4. Maricel opens HR › Approvals › Payroll runs and approves the run.
5. Marisol opens My Payslips: the Nov 16–30 payslip, then the PDF.

**B. AWOL notice and reply** (Ramon's login; his notice was also e-mailed). Ramon's case is left untouched before the defense, so the reply is shown live.
1. Sign in as **Ramon**. The Dashboard shows the banner "You have an attendance notice."
2. Press **Open My Notices** (also under My Account › My Notices). Show the notice, the reply-by date and the **PDF**.
3. Press **Reply**: choose a reason (for example Illness / medical), write an explanation, attach a file (for example a medical certificate) and optionally a return date. Send.
4. The page says "Your reply was received on …". **The automation stops**, and HR is notified.
5. Sign in as **Maricel** › HR › Employees › AWOL cases. The case shows "Reply received: you decide (Separate or Close)". Open the drawer: the timeline, guards, notices, and the reply with its attachment.
6. Show **Record reply** (⋯ menu) for a reply received by phone or letter.
7. Decide: **Close** with a preset remark (for example "Excused: hospital confinement with certificate"), or **Separate** (a notice of separation, effective in 3 days).
8. Back as Ramon: My Notices shows HR's decision.

**C. Bulk approval**
1. Maricel opens HR › Approvals and filters by type and branch.
2. She ticks several items, then Approve selected or Reject selected, with one preset remark.
3. Each row reports its result, and each decision is audited.

**D. Substitution (paid as overtime):** Maricel › Approvals › Substitutions. The proposal came from Carlo's approved sick leave, and Marisol covered 3 periods. On Marisol's Nov 16–30 payslip: "Overtime (substitution): 3 h × hourly × 125%, covering Carlo Reyes Mendoza (Nov 17)". Without taps covering the class it is not paid, and HR sees it under Action needed.

**E. Attendance correction:** Liza › My Attendance › Nov 18 → the pending correction. Maricel approves it and sees the pay difference.

**F. Special working day:** Maricel › Attendance › Holidays & Duty › Sat Nov 21 make-up. Marisol's attendance shows the day.
