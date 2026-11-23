# Demo guide: the five Main Branch demo employees

For the redefense (Fri Nov 27, 2026). The five are fictitious, flagged demo, and live only on the **Main Branch**. Their logins are Employee accounts. **The passwords are not in this guide**: they are given in chat only.

| Login (plus-address of the demo inbox) | Person | Who they are |
|---|---|---|
| `+emp-demo1` | Marisol Demo Aquino (DEMO-101) | Teacher, **Regular**, hired Jun 2022 (tenure; 5 / 5 leave credits) |
| `+emp-demo2` | Carlo Demo Mendoza (DEMO-102) | Teacher, **Probationary**, hired Aug 2026 (3 / 3 credits; regularization reminder) |
| `+emp-demo3` | Liza Demo Ferrer (DEMO-103) | Teacher, **Provisional**, hired Jun 2026 |
| `+emp-demo4` | Ramon Demo Salazar (DEMO-104) | Non-teaching office (Registrar Staff), **Regular**, hired Jul 2023 |
| `+emp-demo5` | Nestor Demo Pascual (DEMO-105) | **Maintenance**, **Contractual**, contract ends Dec 15, 2026 |

Who acts on their requests:
- **Demo HR One** decides (leave, overtime, corrections, substitution, extra pay, the loan, the payroll run).
- **Demo Accountant One Main** processes the payroll and files the extra pay and the loan.
- **Demo Admin Main** filed the substitution. It has **no login**.

Every sign-in sends a code to the demo inbox.

## What to show, and where

| Feature | Sign in as | Page | What you see |
|---|---|---|---|
| Classification (status, group, contract) | HR | Employees > Management, then open a demo employee | Regular / Probationary / Provisional / Contractual; Nestor is Maintenance with a contract end date |
| Leave credits by status | Marisol, then Carlo | My Requests > Leave | 5 / 5 for the Regular teacher; 3 / 3 for the Probationary |
| Lates, short day, absent | HR | Attendance > Monitoring (Main Branch, November) | Late: Marisol Nov 5, Carlo Nov 9, Ramon Nov 3 and 16, Nestor Nov 10. Ramon's short day Nov 4 is "Absent (short day)". Liza is absent Nov 19 with no request |
| Missing time-out → correction | Liza | My Attendance; My Requests > Attendance correction | Nov 6 corrected (HR approved); Nov 18 waiting for HR |
| Leave, every outcome | Marisol / Carlo / Liza / Ramon / Nestor | My Requests > Leave | Marisol: VL Nov 12–13 approved. Carlo: SL Nov 17 approved. Liza: half day (AM) Nov 11 approved. Ramon: VL Nov 9 rejected ("Conflicts with school activity"). Nestor: one pending |
| Overtime | Marisol / Nestor / Carlo; HR | My Requests > Overtime; HR Approvals | Marisol Nov 10 and Nestor Nov 6 approved and worked. Carlo has one pending. Ramon stayed to 18:40 on Nov 13 with no request: nothing is paid |
| Substitution | Marisol; HR; Accountant | My Attendance > Substitutions; HR Approvals; the Nov 16–30 payslip line | Marisol covers Carlo on Nov 17, 3 periods, approved |
| Honorarium and adjustment | Accountant; HR | Additional Pay; Approvals > Incentives & loans | Marisol: ₱1,500 honorarium. Ramon: ₱500 adjustment. Both approved |
| Salary loan | Marisol; Accountant | Loans & Subsidies; My Payslips > Loans & other pay | ₱10,000 over 4 payrolls from Nov 16–30, HR-approved |
| Special working day | The three teachers; HR | Dashboard card "Upcoming special days"; Attendance > Holidays & Duty | Sat Nov 28, 08:00–12:00, a make-up day for Nov 20 (teachers only) |
| Payslip, Paid | any of the five | My Payslips | Nov 1–15 Paid, with the PDF |
| Payslip, Draft | Accountant | Process Payroll (November 16–30) | Five drafts; recompute them after the last taps |
| Daily taps | HR | Attendance > Monitoring | New taps each school day until Friday (the daily job) |
| Automation | HR / Admin | Approvals; Branch Attendance (flags) | Nightly flags, recommendations and reminders on the five's data |

## After the defense

One command removes the five and everything that is theirs, logins included: `node scripts/demo/five.mjs remove --target=production`. It takes a snapshot first, tries the removal and rolls it back before asking, and asks for the project URL and a yes. The three kept demo accounts and every real account are not touched.
