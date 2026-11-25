# Cash advances & government loans: proof (2026-11-25)

Owner rules: the school does not lend. It gives cash advances (limited to one month's basic salary), additional pay and subsidies.
The only loans are GOVERNMENT loans (SSS, Pag-IBIG), encoded by HR and deducted through payroll. The salary limit never applies to them.

**How this was produced:** `e2e/proof/government-loans.spec.mjs` on the LOCAL database, fake data only (fake branch "Loans Proof Branch", fake employee "Gina Proof", ₱30,000). Everything planted was removed at the end of the run.

| Step (real screens) | Result |
|---|---|
| HR → Employees → Government loans → Encode: SSS salary loan, ref. SSS-0451, ₱24,000, ₱1,000 per payroll, from Nov 16-30 | saved, approved at once (HR's own entry), final-pay authority off by default |
| HR encodes a Pag-IBIG multi-purpose loan, ref. MPL-2026-77, ₱9,600, ₱800 per payroll | saved |
| Accountant → Cash Advances & Subsidies: ₱3,000 cash advance | the form shows "Salary limit ₱30,000.00, already owed on cash advances ₱0.00, you can take up to ₱30,000.00 more"; filed for HR |
| Accountant tries ₱27,001 more | refused: "This cash advance would make the total ₱30,001.00, which is more than the limit of ₱30,000.00 (1 month's salary). The most that can be added is ₱27,000.00." |
| Nov 1-15 processed and approved | no loan or cash advance deducted (1st half) |
| Nov 16-30 processed and approved (on a moved local date, Dec 1) | three lines: SSS loan (salary loan) ₱1,000 (remaining ₱23,000, ref. SSS-0451); Pag-IBIG loan (multi-purpose) ₱800 (remaining ₱8,800, ref. MPL-2026-77); Cash advance ₱1,000 |
| Remittances (November) | SSS loan payments ₱1,000, Pag-IBIG loan payments ₱800 for Gina, shown separately from the contributions |

## Screenshots

| File | Shows |
|---|---|
| hr-encoding-form.png | HR's encoding form: employee, agency, loan kind, reference, total, per payroll, first payslip, optional payrolls and notes, final-pay authority |
| hr-government-loans-list.png | HR's list: both loans with reference, per payslip, remaining, status, Edit / Suspend / End |
| accountant-cash-advance-form.png | the Accountant's cash advance form with the salary-limit line |
| accountant-cash-advance-refused.png | the plain refusal above the limit |
| accountant-cash-advances-page.png | the renamed page: Cash Advances & Subsidies |
| employee-my-deductions.png | Employee → My Requests → My deductions: cash advance, SSS and Pag-IBIG loans with agency, per payslip, total, remaining, reference |
| employee-payslip-2nd-half.png | the employee's Nov 16-30 payslip: one line per agency with "Remaining balance ₱X · Ref. …" under it |
| accountant-payslip-2nd-half.png / hr-payslip-2nd-half.png | the same payslip for the Accountant and HR |
| print-2nd-half.png | the print layout |
| pdf-2nd-half.pdf / .png / -bw.png | the PDF: one A4 page, readable in black and white |

`deductions.json` and `remittance-row.json` hold the stored figures.
