# Revision report: panel items and what changed

For the redefense on Friday, November 27, 2026.

**Screenshots.** Each item has a BEFORE/AFTER pair in [shots/](shots/).
- BEFORE is the version live at the defense on November 20, run on the local test stack.
- AFTER is the final version with the defense data. It uses demo logins, and no real personal data is visible.

**Status key.** *done*, built and tested · *partly*, what is missing is named · *deferred*, with the reason.

| # | Panel item | What changed | Where (role › page) | Screenshots | Status |
|---|---|---|---|---|---|
| 01 | Half-day and overtime requests | Employees file a half day (morning or afternoon) or overtime ahead of time, and HR approves. Payroll pays only approved overtime: the smaller of the approved and the worked hours. | Employee › My Requests; HR › Approvals | 01-half-day-overtime | done |
| 02 | No request → Late / Absent | Without an approved request, arriving after the shift start is Late (minutes), and leaving early is Undertime. Working under half the shift is "Absent (short day)", which deducts only the time not worked. | HR › Attendance | 02-late-absent | done |
| 03 | Overtime only with a request | Taps after the shift end are recorded and flagged "Overtime not filed", and pay nothing. | HR › Attendance; Employee › My Attendance | 03-overtime-not-filed | done |
| 04 | Employee category and status | Category is Teaching or Non-teaching. Status is Regular, Probationary, Provisional or Contractual, changed with an effective date and kept in a history. **Employment type was removed**: the school has no part-time employees. **Maintenance is a position**, not a group. | HR › Employees | 04-category-status | done |
| 05 | Leave credits not fixed | **One shared pool** per Category × Status: Regular 5 days, new staff 3, and the Regular 5 from the 1-year anniversary, pro-rated. Vacation, Sick and Emergency leave draw from it. A half day uses 0.5; anything beyond the pool is without pay, and the balance never goes below 0. | Employee › My Requests (Leave credits); HR › Settings › Status & leave rules | 05-leave-credits | done |
| 06 | Maternity / paternity as statutory leave | Filed per event when eligible, never as a yearly credit, and never part of the pool or the conversion. | HR › Settings › Status & leave rules | 06-statutory-leave | done |
| 07 | AWOL automation | After 5 working days absent, with every guard passed (including an active RFID card), the system confirms AWOL, holds pay and sends the 1st notice. A reply, a tap or a request stops it. When the reply period ends, **HR decides**: Separate (a notice of separation, then separation on its date, card off, final pay) or Close (with a preset remark). The employee replies from My Notices. | HR › Employees › AWOL cases; Employee › My Profile › My Notices | 07-awol | done |
| 08 | Sidebar categories | One sidebar item per module, with tabs inside. | Every role | 08-sidebar | done |
| 09 | Substitute teaching pay | A teacher's approved leave proposes the substitution automatically, and HR picks the substitute and approves. The pay is confirmed by the substitute's taps and shown on its own payslip line. | HR › Approvals; Employee › My Payslips | 09-substitution | done |
| 10 | Honorarium / bonus / adjustment | Additional pay kinds, filed by the Accountant and approved by HR, each on its own payslip line. | Accountant › Additional Pay; HR › Approvals › Incentives & loans | 10-additional-pay | done |
| 11 | Special working days (Saturday) | HR declares a make-up or extra working day for chosen staff, who are notified and scheduled. | HR › Attendance › Holidays & Duty | 11-special-working-day | done |
| 12 | Checkboxes / multi-select (bulk approval) | Tick several items, then approve or reject them with one preset remark. Each row is checked and reported, and each decision is audited. | HR › Approvals (every tab) | 12-bulk-approval | done |
| 13 | Search and filters | **One shared filter bar** on every list: search, compact dropdowns on one row, From/To and sort, kept in the address. Pending/Decided sits beside Refresh in the card header. | HR › Approvals, AWOL cases; Admin pages | 13-filters | done |
| 14 | Automation for Admin / HR | The system prepares, checks, forwards, escalates and sends digests. HR decides, and every action can be paused. Branch Admins are view-only. | Settings › Automation; Dashboards › Action needed | 14-automation | done |
| 15 | Tenure pay protection automatic | The system grants it from 2 years of service, and HR can revoke it. | HR › Employees › Tenure pay | 15-tenure | done |
| 16 | RFID in one place | Cards, terminal and issues in one module. **Every account on payroll taps**, HR officers included. Admin and Super Admin cards are refused, and nobody registers or changes their own card. | HR › Attendance (RFID) | 16-rfid | done |
| 17 | HR dashboard charts split | Separate charts per measure. The "By branch" card was removed; its counts remain in Approvals and Action needed. | HR › Dashboard | 17-hr-dashboard | done |
| 18 | Wording ("Override") | Plain words on buttons and labels. Dates read as dates (for example "Oct 7, 2026"). | Accountant › Process Payroll | 18-wording | done |
| 19 | Preset remarks | Every decision offers preset remarks, and HR manages the list. | HR › Settings › Preset remarks | 19-preset-remarks | done |
| 20 | Attendance correction requests | The employee files a correction, and HR sees the evidence and the pay difference. The original taps stay in the history. | Employee › My Requests; HR › Approvals | 20-corrections | done |
| 21 | Payslip PDF two-panel layout | Earnings and deductions side by side on one page. The year-to-date box adds **13th month accrued (basic ÷ 12)**. | Employee › My Payslips › PDF | 21-payslip-pdf | done |
| 22 | Leave conversion | Unused pool days are paid at monthly × 12 ÷ 261: on the Dec 16–31 payslip, and in final pay on separation. The tax is de minimis up to 10 days a year and the excess is taxable; to verify with the school's accountant. A preview ("If the year ended today: …") shows on Leave credits and the HR record, and there is a projected report per branch. Statutory leave is never converted. | Employee › My Requests; HR › Settings; HR › Reports | 22-leave-conversion | done (the policy manual is pending) |
| 23 | Part-time pay | Hourly pay for part-time staff. | — | — | **deferred**: the school has no part-time employees, so the employment type was removed (item 04). |
