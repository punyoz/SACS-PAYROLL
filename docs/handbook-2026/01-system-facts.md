# Employee Handbook 2026: Step 1, how the system works today

Read-only review of `ehdd` 106d0ae (25 November 2026) and the live settings (read on 26 November 2026).
Nothing in the system, the database or any payslip was changed.

The system is the source of truth for the handbook. Where a live value looks like test data, it is marked **[test value?]**.

## 1. Roles and who approves what

| Role | Scope | Approves / decides | Never |
|---|---|---|---|
| Super Admin | All branches | Staff accounts, branches, system settings, payslip schedule, holidays, automation switches; **fallback** decisions on HR's own items (only when no other HR is active); BIR forms, year-end tax annualization, BIR 2316 (Super Admin only since 12 Nov 2026); override of an approved final payslip (employee is notified) | — |
| HR | Main Branch, handles all branches | Leave, half-day, overtime, attendance corrections; AWOL cases and notices; transfers; Admin reports; incentives and cash advances filed by the Accountant; subsidies; **payroll runs and final pay**; government rates and daily rate (new version, future periods, reason required); leave credits and pay rules; encodes SSS / Pag-IBIG loans | Never decides its own requests or its own payslip (another HR or the Super Admin does) |
| Admin | Own branch | Endorses leave and transfers; confirms overtime worked and substitutes; proposes incentives; reports incidents and RFID issues; runs the branch kiosk | Does not approve pay |
| Accountant | Own branch | Processes payroll, files cash advances, additional pay, corrections, 13th month, final pay; submits runs to HR | Never approves a run it processed |
| Employee (teachers and staff) | Own records | Files leave, half day, overtime; requests attendance corrections; replies to AWOL notices | — |
| Substitute teacher | An employee assigned by HR to cover a class | HR approves the substitution; the substitute's own RFID taps must cover the class time | — |

Every decision needs a remark or reason, and each one is written to the audit log with who, when and old → new.

## 2. RFID attendance

| Item | Rule in the system | Live value |
|---|---|---|
| Kiosk | Opened by an Admin, HR or Super Admin with the kiosk password; takes only its own branch's cards | — |
| Refused taps | Unregistered / inactive card; inactive or separated employee; another branch's card; approved leave that day; a saved offline tap more than a day old; **too early for the shift** (more than 3 hours before the start). Refused taps are kept in Blocked Taps for HR | — |
| Repeat tap | Within the duplicate window, or again within 5 minutes: "Already recorded at …", not counted | duplicate window 3 s |
| First tap of the day | Time In; the next is Time Out | — |
| Late | Time-in later than **start + grace**. Once over the grace, the **whole** lateness counts (8:00 start, 10 min grace, tap 8:11 → 11 minutes late) | default 08:00–17:00, grace 10 min, 8 h; schedules may set their own grace (15) |
| Early Bird (status) | Time-in at least the threshold before the employee's own start | 15 min |
| Undertime | Time-out before the shift end | — |
| Absent (short day) | Worked less than the minimum % of the day's hours: only the time **not** worked is deducted, HR follows up | 50 % |
| Half Day | Only with an approved **half-day leave** (AM or PM); the other half is worked | — |
| Absent | No tap on a working day (nightly close) | — |
| Incomplete | Time-in with no time-out after the shift: payroll is blocked until it is corrected | — |
| Correction request | Employee asks to fix a day; HR decides | within 3 days; max 5 per cutoff |
| Holiday / On Leave | Neither attended nor absent | — |
| Rest day tap | Recorded as On Time; no late or undertime | — |
| **Waived item** | **Tenure Pay Protection**: when HR grants it, the policy is active and the employee has the minimum tenure, the day's Absent / Half Day / Late (and break / holiday / suspension days, if the policy covers them) is **not deducted**. The payslip shows it as waived, with the grant | Eligible statuses: Regular |

## 3. Schedule, cutoffs, paydays

- Schedule priority: (1) the employee's own schedule, (2) their level's schedule, (3) the branch schedule, (4) the default. Live profiles: Grade School 7:00–15:00, Pre-school 7:00–16:00, Senior 8:00–17:00 (Mon–Fri) **[test value?]**.
- Schedule changes always start today or later; past days are never re-judged.
- **Payslip days:** 1st half on the **15th** (weekend / holiday → next working day); 2nd half on the **last day of the month** (weekend / holiday → previous working day). The processing window is 5 days.
- **Cutoff:** each payslip counts attendance up to the **day before** its payslip day; that day moves to the next payslip. Example: Nov 1–15 (payslip Mon Nov 16) counts Oct 30 – Nov 15.
- **1–15 payslip:** monthly salary ÷ 2, less **that cutoff's attendance only**. No tax, SSS, PhilHealth, Pag-IBIG or loans.
- **16–end payslip:** monthly salary ÷ 2, less its attendance; plus the month's incentives, overtime, holiday pay; **less SSS, PhilHealth, Pag-IBIG and withholding tax computed on the whole month**, cash advances, government loans. A negative balance is paid as ₱0 and carried to next month.
- **Daily rate** = monthly salary × 12 ÷ 261. **Hourly rate** = daily ÷ 8 (never typed).
- Payday vs payslip day: the system has a payslip (generation) day; the actual **release date of pay** is not in the system **[decision]**.

## 4. Deductions for attendance (live rates)

| Item | Rule | Live value |
|---|---|---|
| Absent | % of daily rate | 100 % |
| Half day (with half-day leave, unpaid half) | % of daily rate | 50 % |
| Undertime / short day | minutes not worked ÷ 60 × hourly rate | — |
| **Late** | every N late days = 1 absence, and/or % of hourly rate per late minute | **N = 0 (off) and 0 % (off): lateness is NOT deducted today** |
| Leave without pay | daily rate × days | — |

## 5. Overtime, holidays, rest days, substitution

| Item | Rule | Live value |
|---|---|---|
| Overtime | Only **approved** overtime is paid: the smaller of the approved hours and the hours worked past the shift end. Taps alone never pay overtime | 125 % of hourly on a regular day; max 3 h a day, 10 h a cutoff; file 1 day before (late filing up to 2 days after) |
| Regular holiday worked | daily rate × (100 % + premium), by hours up to 8; only on a day HR assigned or approved (holiday duty) | premium 100 % (pays 200 %) |
| Special day worked | premium on top | 30 % (pays 130 %) |
| Rest day worked | 130 %; regular holiday on a rest day 260 %, special day on a rest day 150 % | rest-day premium 30 % |
| Holiday not worked | Monthly-paid: already in the salary (261 divisor) | — |
| Special working day | Extra working day | 130 % |
| **Substitution** | periods covered × 1 h × the substitute's hourly rate × 125 % (holiday: the holiday rate × 130 %; rest day: 130 %); paid **only when the substitute's taps cover the class time**; HR's approval is the authorization; never paid twice with overtime; max 5 periods a week | The old "₱150 a period" settings are still stored but no longer used **[mismatch]** |

## 6. Leave

| Item | Rule | Live value |
|---|---|---|
| Leave pool | Vacation, Sick and Emergency share **one pool** per year | Regular: 5 days; Probationary / Provisional / Contractual: 3 days |
| Proration | From the hire date and any status change; non-Regular staff earn the Regular rule from their 12-month anniversary | — |
| Filing (whole day) | **At least 7 days ahead, for every type (sick and emergency included)** | 7 days |
| Filing (half day) | At least 1 day before, or up to 2 days after as a late filing | 1 / 2 |
| With / without pay | The employee chooses; on approval, days beyond the remaining balance are split off as without pay | — |
| Proof | PDF / PNG / JPEG under 2 MB, stored privately | — |
| Payslip | "Leave with pay: N days (by type)" inside basic pay; Leave Balance box (credits, used to date, remaining) for information | — |
| Statutory leave (per event) | Maternity 105 days (on); Paternity 7 days, first 4 deliveries (on); Bereavement 3 days, school policy (on); **Solo Parent 7, VAWC 10, Special Leave for Women 60: OFF** | **[mismatch: mandatory by law]** |
| Unused leave conversion | On; paid at the daily rate; 10 days a year tax-free, the rest taxable | on, 10 days |

## 7. Pay items and benefits

| Item | Rule | Live value |
|---|---|---|
| Early Bird incentive | **One winner per pay period per branch**: most early time-ins (≥ threshold before own start); ties by earliest average arrival, then fewest late days, then fewest absences, then lower employee ID; an unexcused absence makes ineligible; locked when HR approves the period's first run; ₱0 switches it off | ₱300, 15 min **[test value?]** |
| Perfect Attendance | **Not a school benefit.** Retired 25 Nov 2026: resolves to ₱0 | the old ₱500 rate row is still stored, unused |
| Additional pay | Accountant files (incentive, overload, honorarium, bonus, own pay types with taxable or not); HR approves; paid on the 16–end payslip | — |
| 13th month | Total basic salary actually earned in the year ÷ 12 (absences and leave without pay reduce it; late, undertime, overtime and incentives do not); paid in December as a separate payout | — |
| Licensed-teacher subsidy | Accountant processes, HR approves; yearly amount, prorated monthly, advances up to the amount earned, paid in the payout month; on resignation prorated, on dismissal forfeited | ₱6,000 a year, December **[test value: note says DEMO]** |
| Tax-free ceiling | 13th month + other benefits (subsidy as "other benefit") tax-free up to ₱90,000 a calendar year; only the excess is taxed | ₱90,000 |
| SSS | 5 % of the monthly salary credit (table, ₱5,000–₱35,000); employer 10 % | — |
| PhilHealth | 2.5 % of monthly basic within ₱10,000–₱100,000 (5 % shared) | — |
| Pag-IBIG | 2 % of salary up to ₱10,000 (max ₱200); 1 % at ₱1,500 or less | — |
| Withholding tax | BIR monthly table on (month's gross − attendance − non-taxable − contributions), on the 16–end payslip | — |
| Year-end tax | Super Admin runs the annualization; the difference goes on a 16–end payslip (usually Dec 16–31) as a collection or refund | — |
| Contributions mode | Legal tables (fixed amounts switch off); all on the 16–end payslip; per-employee amounts win (0 = exempt) | — |

## 8. Cash advances and government loans

| Item | Rule |
|---|---|
| School loans | **None.** The school does not lend |
| Cash advance | Accountant files, HR approves. Limit = monthly basic salary × 1.0, counting only the **amount still borrowed (principal), never interest**; also a ₱50,000 cap. Deducted in installments on the 16–end payslip, never pushing net pay below ₱0 (the rest stays on the balance) |
| SSS / Pag-IBIG loans | **HR encodes** them from the agency's notice (reference number, amount per 16–end payslip, reason); never HR's own (the Super Admin does it only for an HR officer when no other HR exists); no limit (the agency sets it); every change audited |
| My deductions | The employee sees cash advances and government loans together, with the remaining balance and reference |

## 9. Payslips, corrections, audit

- A payslip is visible to the employee only once HR approves the run.
- An approved payslip is **never edited**. A mistake is fixed by a **correction**: the Accountant files it, HR approves it, and it is paid (underpayment) or recovered (overpayment) on a later payslip. A negative pay item appears as its own deduction line.
- The Super Admin can override an approved final payslip within the override window; the employee gets a notice and HR sees a read-only log.
- **There is no "dispute this payslip" button for the employee** **[mismatch]**: today an employee must ask HR or the Accountant directly.
- Every change carries a reason and is in Audit & Monitoring.

## 10. AWOL and separation

- AWOL case opens after **5 consecutive unexcused working-day absences**. Pay is held, a notice to return and explain is sent; reply within 5 days; HR decides separation, effective 3 days after the notice of separation. A return or a filed leave closes the case.
- Final pay within 30 days: unpaid salary, prorated 13th month, subsidy earned, less contributions, tax and cash advances (only with the signed final-pay authority); Accountant computes, HR approves.

## 11. Where the school's written policy is missing

Grace period, school year dates, mission and values, dress code, meal break, evaluation, discipline steps and penalties, HMO, conference funds, payday release date, probation for teachers (the system uses 6 months), leave-filing rule for sick / emergency leave, whether lateness is deducted, the subsidy and Early Bird amounts, the statutory leaves that are off. See the decision list in the mapping file.
