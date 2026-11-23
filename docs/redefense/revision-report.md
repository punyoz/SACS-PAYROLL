# Revision report: panel items and what changed

For the redefense on Friday, November 27, 2026.

- Screenshots were taken on the local test stack with seed data, so no real employees appear.
- BEFORE is the version that was live at the defense on November 20. AFTER is the final Batch 3 version.
- Each pair uses the same desktop window size and the same page state.

**Employment type (Full-time/Part-time) removed:** the school has no part-time employees. Employees are classified by Category (Teaching / Non-teaching, with Maintenance as a non-teaching group) and Status (Regular / Probationary / Provisional / Contractual).

| # | Panel item | What changed | Where to find it (role › page) | Screenshots | Status |
|---|---|---|---|---|---|
| 01 | Half-day and overtime requests | Employees file a half day (morning or afternoon) or overtime ahead of time. HR approves; payroll pays only approved overtime, the smaller of approved and actual hours. | Employee › My Requests (Half day, Overtime tabs); HR › Approvals | 01-half-day-overtime-before/after.png | done |
| 02 | No request → Late / Absent | Without an approved request, arriving after the shift start is Late (minutes), leaving early is Undertime, and working less than the minimum is Absent. There is no "Half day" status without a request. | HR › Attendance › Monitoring | 02-no-request-late-absent-before/after.png | done |
| 03 | Overtime only with a request | Taps after the shift end are recorded and flagged "Overtime not filed", and paid nothing. | HR › Attendance; Employee › My Attendance | 03-overtime-request-only-before/after.png | done |
| 04 | Employee category and status | Category Teaching / Non-teaching (Maintenance as a Non-teaching group, filterable). Status Regular / Probationary / Provisional / Contractual, changed with an effective date and kept in a history. Employment type removed. | HR › Employees › Management (Change status) | 04-category-status-before/after.png | done |
| 05 | Leave credits not fixed | Credits per Category × Status: Regular 5 vacation / 5 sick; new staff (Probationary, Provisional, Contractual, under 1 year) 3 / 3; 5 from the 1-year anniversary, pro-rated. HR can edit them, and the legal-minimum warning stays. | HR › Settings › Status & leave rules | 05-leave-credits-before/after.png | done |
| 06 | Maternity / paternity as statutory leave | Filed per event when eligible, never a yearly credit. | HR › Settings › Status & leave rules (Statutory leaves) | 06-statutory-leave-before/after.png | done |
| 07 | AWOL automation | The system flags possible AWOL from the attendance and skips device-problem days. HR follows the case through its stages. | HR › Employees › AWOL cases | 07-awol-before/after.png | done |
| 08 | Sidebar categories | One sidebar item per module with tabs inside. Accountant 9, HR 8, Admin 5, Employee 6, Super Admin 8; old links open the right tab. | Every role's sidebar | 08-sidebar-before/after.png | done |
| 09 | Substitute teaching pay | The Admin files a substitution and HR approves it. Pay is confirmed by the substitute's taps and shown as its own payslip line. | Admin › Branch Review; HR › Approvals; Accountant › Process Payroll | 09-substitution-before/after.png | done (payslip line-type fix in Batch 3) |
| 10 | Honorarium / bonus / adjustment | Additional Pay kinds, filed by the Accountant (one honorarium for several employees at once) and approved by HR. Each is its own payslip line. A bonus is tax-free with the 13th month up to ₱90,000. | Accountant › Additional Pay; HR › Approvals › Incentives & loans | 10-additional-pay-before/after.png | done |
| 11 | Special working days (Saturday) | HR declares a make-up or an extra working day for chosen branches and staff. Covered staff are notified and scheduled. An extra day is paid only when the employee taps in. | HR › Attendance › Holidays & Duty | 11-special-working-day-before/after.png | done |
| 12 | Checkboxes / multi-select | Approve or reject several items at once, with one remark; each row is checked and reported. | HR › Approvals (every tab) | 12-multi-select-before/after.png | done |
| 13 | Search and filters on approvals | Search, type, branch, category, status, dates and sort, kept in the address. | HR › Approvals | 13-approval-filters-before/after.png | done |
| 14 | Automation for Admin / HR | The system prepares and checks items, and forwards, escalates and sends a digest. Admins check, HR decides, and every action can be paused or undone. | Admin and HR › Dashboard (Automation card) | 14-automation-before/after.png | done |
| 15 | Tenure pay protection automatic | Granted by the system per the rules; HR checks and can revoke it. | HR › Employees › Tenure pay | 15-tenure-before/after.png | waiting for Nona Guido's hire date to switch on |
| 16 | RFID in one place | Cards, terminal and issues in one module. Lost cards are blocked at once, and issues are flagged nightly with a suggested fix. | HR › Attendance (RFID tabs); Super Admin › RFID | 16-rfid-before/after.png | done |
| 17 | HR dashboard charts split | Separate charts per measure. | HR › Dashboard | 17-hr-charts-before/after.png | done |
| 18 | Wording ("Override") | Plain words on buttons and labels. | Accountant › Process Payroll | 18-wording-before/after.png | done |
| 19 | Preset remarks | Every decision offers preset remarks; HR manages the list. | HR › Settings › Preset remarks | 19-preset-remarks-before/after.png | done |
| 20 | Attendance correction requests | The employee files a correction from their attendance. HR sees the evidence and the pay difference first, and the difference reaches the next payslip once. | Employee › My Requests › Attendance correction; HR › Approvals | 20-correction-requests-before/after.png | done |
| 21 | Payslip PDF two-panel layout | Earnings and deductions side by side, on one page. | Employee › My Payslips › PDF | 21-payslip-pdf-before/after.png | done |
