# Substitution on the payslip: proof (2026-11-25)

Current school rule (policy 2026-11-26): a substitution is paid like overtime,
**periods × period length (setting, 1 h) × hourly rate × the day's overtime rate (125% on a regular day)**.
The fixed ₱150 a period and the inside / outside / overload split are gone (old stored payslips keep their lines).

**How this was produced:** `e2e/proof/substitution-payslip.spec.mjs` on the LOCAL database, fake data only.
- Fake teachers "Benjie Proof" (₱32,000, Regular, Teaching, Full-time) and "T. Reyes" (Grade 5, ₱30,000), in a fake branch "Proof Branch". A fake branch was used so that the local copy's Main Branch runs (already approved) were not touched.
- Taps on every regular working day, T. Reyes on approved leave Nov 5, and an HR-approved substitution: Nov 5, 09:00-11:00, 2 periods, covered by Benjie's taps.
- The real screens: the Accountant processes Nov 1-15 and, on a moved local date (Dec 1, fake clock of the test server only), Nov 16-30. Each run is submitted, then HR approves it.
- Everything planted was removed at the end of the run.

Payslip line (identical for Employee, HR, Accountant, PDF and print):
**Overtime (substitution): 2 h × ₱183.91 × 125%, covering T. Reyes, Grade 5 (Nov 5): ₱459.78**

## Expected vs actual (stored payslips)

Working: daily = ₱32,000 × 12 ÷ 261 = ₱1,471.2644; hourly = ÷ 8 = ₱183.91 (to the centavo, as the payslip shows and uses);
2 × 1 h × ₱183.91 × 125% = ₱459.775, which rounds to **₱459.78**. The earlier "about ₱459.77" used the hourly rate before rounding.
Tax = (₱29,859.78 − ₱20,833) × 15% = ₱1,354.017, which rounds to **₱1,354.02**.

| Check | Expected | Actual | Difference | Result | Working |
|---|---|---|---|---|---|
| Substitution line (Nov 5, 1st half) | ₱459.78 | ₱459.78 | +0.00 | **PASS** | 2 periods × 1 h × ₱183.91 (₱32,000 × 12 ÷ 261 = ₱1471.2644 a day ÷ 8) × 125% = ₱459.7750 |
| 1st half basic pay | ₱16,000.00 | ₱16,000.00 | +0.00 | **PASS** | ₱32,000 ÷ 2 |
| Perfect attendance (system rule, 1st half; not substitution) | ₱500.00 | ₱500.00 | +0.00 | **PASS** | full attendance Oct 26 - Nov 13 on these rates |
| 1st half gross (as the payslip shows it) | ₱16,959.78 | ₱16,959.78 | +0.00 | **PASS** | ₱16,000 + substitution + ₱500 perfect attendance |
| 1st half deductions | ₱0.00 | ₱0.00 | +0.00 | **PASS** | contributions and tax are on the 2nd half |
| 1st half net | ₱16,959.78 | ₱16,959.78 | +0.00 | **PASS** | gross − 0 |
| Month gross | ₱32,959.78 | ₱32,959.78 | +0.00 | **PASS** | ₱32,000 + substitution + ₱500 perfect attendance |
| SSS | ₱1,600.00 | ₱1,600.00 | +0.00 | **PASS** | 5% × MSC ₱32,000 |
| PhilHealth | ₱800.00 | ₱800.00 | +0.00 | **PASS** | 2.5% × ₱32,000 |
| Pag-IBIG | ₱200.00 | ₱200.00 | +0.00 | **PASS** | 2% × ₱10,000 (cap) |
| Monthly taxable income | ₱29,859.78 | ₱29,859.78 | +0.00 | **PASS** | ₱32,000 + substitution − ₱2,600 contributions (perfect attendance not taxable) |
| Withholding tax (2nd half) | ₱1,354.02 | ₱1,354.02 | +0.00 | **PASS** | (taxable − ₱20,833) × 15% |
| 2nd half has no substitution line | 0 | 0 | +0 | **PASS** | Nov 5 is in the 1st half |
| Basic earned for the 13th month (1st half) | ₱16,000.00 | ₱16,000.00 | +0.00 | **PASS** | basic only, substitution not included |
| Basic earned for the 13th month (2nd half) | ₱16,000.00 | ₱16,000.00 | +0.00 | **PASS** | basic only |
| 13th month from November (basic ÷ 12) | ₱2,666.67 | ₱2,666.67 | +0.00 | **PASS** | ₱32,000 ÷ 12; with the substitution it would be ₱2704.98 |
| T. Reyes 1st half basic (paid leave Nov 5, no deduction) | ₱15,000.00 | ₱15,000.00 | +0.00 | **PASS** | ₱30,000 ÷ 2 |
| T. Reyes 1st half gross | ₱15,500.00 | ₱15,500.00 | +0.00 | **PASS** | ₱15,000 + ₱500 perfect attendance; the substitution changes nothing |
| T. Reyes has no substitution line | 0 | 0 | +0 | **PASS** |  |

**Perfect attendance (₱500)** is the system's own rule on these rates (full attendance in the half). It is not part of the substitution and is not taxable here: taxable income and tax match the substitution-only figures. The 1st half pays it directly, while the 2nd half routes it through an HR recommendation (HR rejected those in this run). See the open decisions in the report.

Extra cases under the current rule are covered by `tests/substitutions-2026-11-22.test.js` (12 tests, same hourly rate ₱183.91):
(a) no taps: not paid, listed for HR, no line; (b) approved after its cutoff was processed: paid on the next payslip;
(c) holiday 260% / special 169% / rest day 130% (rest-day premium from the rates table), the formula on the line; (d) overtime already paid for the same time counts once.

## Screenshots (deviceScaleFactor 2, headless)

| File | Shows |
|---|---|
| employee-1st-half.png | Benjie, My Payslips, Nov 1-15: the "Overtime (substitution)" line ₱459.78 under Earnings |
| employee-2nd-half.png | Benjie, My Payslips, Nov 16-30: SSS ₱1,600, PhilHealth ₱800, Pag-IBIG ₱200, tax ₱1,354.02, no substitution line |
| accountant-1st-half.png / accountant-2nd-half.png | the same two payslips in the Accountant's Payroll Records |
| hr-1st-half.png / hr-2nd-half.png | the same two payslips in HR's Payroll Records |
| pdf-1st-half.pdf / pdf-1st-half.png | the 1st-half PDF: one page, the substitution line with its amount |
| print-1st-half.png | the 1st half in the print layout |
| substitution-record.png | HR → Leave → Substitutions: Nov 5, 2 periods, Benjie covering T. Reyes, Grade 5, approved |
| substitution-report.png | HR → Reports → Substitute teaching: Benjie, 1 substitution, 2 periods, ₱459.78 (the payslip amount) |
| thirteenth-month-preview.png | Accountant → 13th month preview: Benjie basic ₱32,000 → ₱2,666.67 (the substitution is not included) |

`results.json` has the table as data. To run it again (local only):
`E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test -c playwright.proof.config.mjs`
(`PROOF_KEEP=1` keeps the fake data afterwards; the next run removes it first.)
