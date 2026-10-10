# Super Admin settings guide

Everything here is under **Super Admin → System Configuration**. Payroll
settings are **versioned**: each save adds a new version from a date you
choose, and payslips already generated are never changed. Fill in "Reason for
the change" every time; it goes to the change log.

Rules and worked examples: [payroll-schedule-loans-awol.md](payroll-schedule-loans-awol.md).

## General / Attendance tabs

- **Attendance policy**, a default plus per-branch overrides: work start,
  work end, late grace (minutes, default 15) and required hours. The nightly
  close (00:05) uses them to mark Late, Undertime, Absent and Incomplete.
- **Payroll configuration**: the approval block printed on the Payroll Sheet.

## Payroll tab

### Payslip Schedule

| Field | Default | Notes |
|---|---|---|
| 1st half (1–15) generation day | 15 | 1–15 |
| 2nd half (16–end) generation day | month end | 16–31 (31 = last day in short months) |
| Generation stays open for (days) | 5 | after that only a Super Admin override |
| 1st half: when the day is a weekend or holiday | next working day | it deducts nothing, so later is safe |
| 2nd half: when the day is a weekend or holiday | previous working day | keeps it inside the month |
| Takes effect from | — | a period whose generation day has not arrived yet |

The 2nd half deducts attendance up to the day **before** its generation day;
the generation day itself goes to next month. With the defaults:
Oct 15 and Oct 30, 2026; Nov 16 and Nov 27; Dec 15 and Dec 29.

### Licensed Teacher Subsidy

Set up once per subsidy year (none is set up yet):
annual amount (₱), subsidy year and the month it starts, the payout payslip
(e.g. December 16–31), mid-year hire / newly licensed (prorate by month),
advance limit, what happens on resignation (prorate) and dismissal
(forfeit), tax treatment (other benefit under the ceiling, or taxable), and
how many days before a license expires HR is warned.

## Rates tab (effective-dated)

Add a new version with "Takes effect from"; never edit history.

| Rate | Live value (from Oct 1, 2026) | Meaning |
|---|---|---|
| Working days per year (the divisor) | **261** | Daily = monthly × 12 ÷ 261. 313 if Saturdays are school days. 31 or less = days per month. Attendance deductions never exceed the monthly salary. |
| Contributions as fixed amounts | On | use the fixed amounts below, not the legal tables |
| SSS / PhilHealth / Pag-IBIG fixed | ₱400 / ₱0 / ₱200 | per month, on the 2nd half |
| Overtime premium | 0% | school decision |
| Late minute charge / late days per absence | 0 | lates not charged |
| Regular / special holiday premium | 100% / 30% | for holidays worked |
| Benefits exempt ceiling | ₱90,000 | 13th month + subsidy above this is taxed |
| Half day | 50% | of the daily rate |

Rows on the same date: the one saved **last** wins. Several rate types have
older same-day rows from testing; they are history and do no harm.

## Tax & contributions tab

- **Withholding tax table (monthly)**: the BIR table (2023 onward). Save a new
  version from its effective date if BIR changes it.
- **Contribution amounts** per employee: override the fixed amounts; 0 = exempt.

## Holidays tab

- Regular and special holidays; **Generate Year** fills the days fixed by
  law, Holy Week and National Heroes Day (also automatic every December 1
  for the next year).
- Add proclaimed days by hand when announced.
- Suspensions: whole day, morning or afternoon, with a cutoff time.

## Security tab

Session timeout (idle minutes, currently 60; 8 hours at most), max login
attempts (5), password minimum length, password expiry.

## Payslip override

Generates a payslip outside its window, e.g. the held payslips of an
employee whose AWOL case closed as "returned". Every override is logged.
