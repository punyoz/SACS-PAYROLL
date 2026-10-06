/* ═══════════════════════════════════════
   accountant.js — Accountant role logic
   Handles: page nav, payroll computation,
   draft submission to admin
   Edit this file for accountant features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const ACCT_PAGES = {
  'ac-dashboard':  'Dashboard',
  'ac-process':    'Process Payroll',
  'ac-records':    'Payroll Records',
  'ac-payslips':   'Payslips',
  'ac-incentives': 'Incentives & Overload',
  'ac-cash-advances': 'Cash Advances',
  'ac-13th':       '13th Month Pay',
  'ac-attendance': 'View Attendance',
  'ac-monitoring': 'Payroll Monitoring',
  'ac-reports':    'Payroll Reports',
  'ac-profile':    'Profile',
};

const acctState = {
  loading: false,
  employees: [],
  records: [],
  draftEntries: [],
  panels: {},
  attendanceRows: [],
  leaveSummary: [],
  payslipOptions: [],
  payslip: null,
  periodOptions: [],
  currentEntryId: '',
  // false until the attendance / payroll-rate migrations are applied.
  payrollReady: true,
  payrollNotReadyMessage: '',
  // BIR semi-monthly table from GET /api/accountant/payroll (the server's own).
  taxTable: [],
  // The accountant typed a withholding tax; stop re-computing the default.
  taxEdited: false,
  // The default tax for the figures on the form (set by recalc()).
  lastTaxDefault: 0,
  // When payslips for the active period may be generated (server-computed,
  // Asia/Manila): not_open | draft | final | closed.
  generationWindow: null,
  activePeriod: '',
  canOverride: false,
  // Semi-monthly payroll for the active period (GET semi_monthly): which half
  // it is, the month, and the 2nd half's attendance window / lock day.
  semiMonthly: null,
};

let acRecordsPaginator = null;
let acAttPaginator = null;
let monPaginator = null;
let _monStatusFilter = 'all';
let _monSearch = '';
let _monAllRows = [];
let _reportData = [];

function toAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

const ACCT_SALARY_MAX = 9999999.99;

function clampSalaryInput(input) {
  if (!input) return;
  const raw = input.value;
  if (!raw) return;

  const intPart = raw.split('.')[0].replace(/^-/, '');
  if (intPart.length > 7) {
    const decimalIndex = raw.indexOf('.');
    const trimmedInt = intPart.slice(0, 7);
    input.value = decimalIndex >= 0
      ? `${trimmedInt}${raw.slice(decimalIndex)}`
      : trimmedInt;
  }

  const value = Number(input.value);
  if (Number.isFinite(value) && value > ACCT_SALARY_MAX) {
    input.value = String(ACCT_SALARY_MAX);
  }
}

function formatMoney(value) {
  return `₱ ${toAmount(value).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatMoneyCompact(value) {
  return `₱ ${toAmount(value).toLocaleString('en-PH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function normalizePortalPosition(positionValue, roleValue) {
  const role = String(roleValue || '').trim().toLowerCase();
  const position = String(positionValue || '').trim().toLowerCase();

  if (!role && !position) {
    return 'N/A';
  }

  if (role === 'accountant' || position === 'accountant' || position.includes('account')) {
    return 'Accountant';
  }

  return 'Employee';
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AC';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function applyAccountantIdentity() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;

  const fullName = String(context?.full_name || '').trim();
  const position = context ? normalizePortalPosition(context.position, context.role) : 'Accountant';
  const displayName = fullName || position || 'Accountant';
  const subtitle = position === 'Accountant' ? 'Accountant Account' : 'Employee Account';

  const nameEl = document.getElementById('ac-user-name');
  if (nameEl) nameEl.textContent = displayName;

  const roleEl = document.getElementById('ac-user-role');
  if (roleEl) roleEl.textContent = subtitle;

  const avatarEl = document.querySelector('#s-accountant .sb-foot .av');
  if (avatarEl) avatarEl.textContent = getInitials(displayName);
}

function handleLegacyAuthContextChange() {
  applyAccountantIdentity();
}

function statusMeta(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid' || normalized === 'approved') {
    return { label: 'Paid', badgeClass: 'bg' };
  }

  if (normalized === 'pending' || normalized === 'pending_approval') {
    return { label: 'Pending Approval', badgeClass: 'ba' };
  }

  if (normalized === 'on_hold' || normalized === 'rejected') {
    return { label: 'On hold', badgeClass: 'br' };
  }

  if (normalized === 'draft') {
    return { label: 'Draft', badgeClass: 'bt2' };
  }

  return { label: 'Pending Approval', badgeClass: 'ba' };
}

function showProcessFeedback(message, isError = false, isSuccess = null) {
  const feedback = document.getElementById('ac-process-feedback');
  if (!feedback) return;

  const success = isSuccess !== null ? isSuccess : (!isError && Boolean(message));
  feedback.textContent = message;
  feedback.classList.toggle('err', isError);
  feedback.classList.toggle('ok', !isError && success);
  feedback.classList.toggle('loading', !isError && !success && Boolean(message));
}

function setActionButtonsDisabled(disabled) {
  const saveButton = document.getElementById('ac-save-draft-btn');
  const submitButton = document.getElementById('ac-submit-btn');

  if (saveButton) saveButton.disabled = disabled;
  if (submitButton) submitButton.disabled = disabled;
}

/* ── NAVIGATE ── */
function acctNav(pageId, navEl) {
  Object.keys(ACCT_PAGES).forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById(pageId)?.classList.add('active');

  document.querySelectorAll('#s-accountant .ni').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  const titleEl = document.getElementById('ac-tb-title');
  if (titleEl) titleEl.textContent = ACCT_PAGES[pageId] || '';

  if (window.persistRolePageState) {
    window.persistRolePageState('accountant', pageId);
  }

  if (pageId === 'ac-profile') loadAccountantProfile();
  if (pageId === 'ac-incentives') loadMonthlyItems();
  if (pageId === 'ac-cash-advances') loadCashAdvances();
  if (pageId === 'ac-13th') loadThirteenthMonth();
  // Read-only status board (Incomplete records that hold payroll back).
  if (pageId === 'ac-attendance') window.mountAttendanceBoard?.('ac-att-board');
}

function getAccountantNavByPageId(pageId) {
  const navItems = Array.from(document.querySelectorAll('#s-accountant .ni'));
  return navItems.find((item) => String(item.getAttribute('onclick') || '').includes(`'${pageId}'`)) || null;
}

/* ── PAYROLL COMPUTATION ──
   Attendance figures, rates and defaults come from GET /api/accountant/payroll
   (attendance_rows[].pay / .rates / .defaults), computed on the server from the
   attendance logs and the rate versions in force on the period's first day.
   The figures here are a preview; the server recomputes everything when the
   payroll is saved or processed. */
const ACCT_FALLBACK_RATES = {
  hourly: 68.75, daily: 550, half_day_pct: 50, absent_pct: 100,
  late_days_per_absent: 3, late_minute_charge_pct: 0,
  early_bird_bonus: 0, perfect_attendance_bonus: 0, sss_pct: 2, philhealth_pct: 2, pagibig_pct: 2,
};

/** The attendance row, rates and unit amounts for one employee. */
function employeePayInfo(employeeId) {
  const row = (acctState.attendanceRows || []).find((r) => r.employee_id === employeeId) || null;
  const rates = { ...ACCT_FALLBACK_RATES, ...(row?.rates || {}) };
  const unit = row?.pay?.unit_amounts || {
    hourly: rates.hourly,
    daily: rates.daily,
    half_day: toAmount(rates.daily * rates.half_day_pct / 100),
    absent: toAmount(rates.daily * rates.absent_pct / 100),
    early_bird: rates.early_bird_bonus,
    perfect_attendance: rates.perfect_attendance_bonus,
    late_days_per_absent: rates.late_days_per_absent,
    late_minute_pct: rates.late_minute_charge_pct,
  };
  return { row, rates, unit, pay: row?.pay || null };
}

const acctSame = (a, b) => Math.abs(toAmount(a) - toAmount(b)) < 0.005;

/* Semi-monthly payroll (from Oct 1, 2026): the 1st half is the monthly salary
   ÷ 2 with nothing deducted; the 2nd half settles the whole month (attendance,
   leave, incentives, contributions, monthly withholding tax) less what the 1st
   half paid. 'first' | 'second' | null (earlier periods). */
function semiHalf() {
  return acctState.semiMonthly?.half || null;
}

/** The server's default basic for the period (monthly salary in a 2nd half). */
function basicDefaultFor(employee) {
  const row = (acctState.attendanceRows || []).find((r) => r.employee_id === employee?.id);
  const fallback = toAmount(Number(employee?.basic_salary || 0) / 2);
  return row?.defaults?.basic_salary !== undefined ? toAmount(row.defaults.basic_salary) : fallback;
}

/** What a 2nd half adds and settles against, from the server's preview. */
function semiExtras(info) {
  const d = info.row?.defaults || {};
  return {
    other: toAmount(Number(d.other_incentive || 0) + Number(d.overload_pay || 0)),
    overloadHours: toAmount(d.overload_hours || 0),
    firstHalfPaid: toAmount(d.first_half_paid || 0),
    firstHalfStatus: d.first_half_status || 'not_processed',
    carryIn: toAmount(d.carry_in || 0),
  };
}

/**
 * Attendance amounts for the quantities shown. Same rule as the server
 * (buildEmployeePayroll): a quantity equal to the computed one uses the
 * computed, per-log total; a changed quantity is priced at the unit rate.
 */
function computeAttendanceAmounts(info, q) {
  const { unit, pay } = info;
  const counts = pay?.counts || {};
  const amounts = pay?.amounts || {};
  const price = (quantity, computedQuantity, computedAmount, perUnit) => (
    pay && acctSame(quantity, computedQuantity) ? toAmount(computedAmount) : toAmount(quantity * perUnit)
  );
  return {
    absent: price(q.absences_days, counts.absent_days, amounts.absent, unit.absent),
    // N late days = 1 absence (Super Admin setting), plus the per-minute
    // charge from the logs when that is switched on.
    late: pay && acctSame(q.late_days, counts.late_days)
      ? toAmount(amounts.late)
      : toAmount(
        (unit.late_days_per_absent > 0 ? Math.floor(toAmount(q.late_days) / unit.late_days_per_absent) * unit.absent : 0)
        + toAmount(amounts.late_minutes_charge),
      ),
    undertime: price(q.undertime_minutes, counts.undertime_minutes, amounts.undertime, unit.hourly / 60),
    half_day: price(q.half_days, counts.half_days, amounts.half_day, unit.half_day),
    early_bird: price(q.early_bird_days, counts.early_bird_days, amounts.early_bird, unit.early_bird),
    perfect_attendance: pay && Boolean(q.perfect_attendance) === Boolean(pay.perfect_attendance)
      ? toAmount(amounts.perfect_attendance)
      : (q.perfect_attendance ? toAmount(unit.perfect_attendance) : 0),
  };
}

/** Withholding tax for one period from the BIR table the server sent. */
function acctWithholdingTax(taxable) {
  const table = acctState.taxTable || [];
  if (!table.length) return 0;
  const amount = Math.max(0, toAmount(taxable));
  let bracket = table[0];
  table.forEach((row) => { if (amount > Number(row.over)) bracket = row; });
  return toAmount(Number(bracket.base) + (amount - Number(bracket.over)) * Number(bracket.rate));
}

/** True when the server computed this employee's period with the legal tables. */
function usesLegalTables(info) {
  return info.row?.defaults?.statutory_method === 'legal';
}

/**
 * SSS / PhilHealth / Pag-IBIG defaults. With the legal tables they come from
 * the server (based on the monthly salary, so a Basic Salary edit does not
 * move them); earlier periods keep the flat % of the period's basic.
 */
function contributionDefaults(info, basic) {
  const defaults = info.row?.defaults;
  // Semi-monthly 1st half: nothing deducted.
  if (semiHalf() === 'first') return { sss: 0, philhealth: 0, pagibig: 0 };
  if (usesLegalTables(info)) {
    return {
      sss: toAmount(defaults.sss),
      philhealth: toAmount(defaults.philhealth),
      pagibig: toAmount(defaults.pagibig),
    };
  }
  return {
    sss: toAmount(basic * info.rates.sss_pct / 100),
    philhealth: toAmount(basic * info.rates.philhealth_pct / 100),
    pagibig: toAmount(basic * info.rates.pagibig_pct / 100),
  };
}

/** Approved overtime and holiday pay, computed from the logs on the server. */
function earningsFor(info) {
  const amounts = info.pay?.amounts || {};
  return {
    overtime: toAmount(amounts.overtime || 0),
    holiday: toAmount(amounts.holiday_premium || 0),
  };
}

/**
 * Default withholding tax for the figures shown: the same taxable
 * compensation the server uses (basic + overtime + holiday pay − attendance
 * and Leave Without Pay deductions − SSS / PhilHealth / Pag-IBIG). Zero for
 * periods before the legal tables.
 */
function taxDefaultFor(info, { basic, earnings, attendanceDeductions, contributions, incentives = 0 }) {
  if (semiHalf() === 'first' || !usesLegalTables(info)) return 0;
  // Semi-monthly 2nd half: the month's taxable income (incentives and
  // overload included), on the monthly table the server sent.
  const extra = semiHalf() === 'second' ? toAmount(incentives) : 0;
  const taxable = Math.max(0, toAmount(basic + earnings + extra - attendanceDeductions - contributions));
  return acctWithholdingTax(taxable);
}

function describeBlockingDays(blocking) {
  return (blocking || []).map((b) => `${b.log_date} (${b.status})`).join(', ');
}

function autoFillDeductions(basic) {
  // Contribution defaults for the selected employee and period: the legal
  // tables from Oct 1, 2026, the % in force (Super Admin → Payroll Rates)
  // before that. Withholding tax follows the figures (recalc()).
  const info = employeePayInfo(getSelectedEmployee()?.id);
  const defaults = contributionDefaults(info, basic);
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('pc-sss', defaults.sss);
  setVal('pc-philhealth', defaults.philhealth);
  setVal('pc-pagibig', defaults.pagibig);
  acctState.taxEdited = false;
}

// Fills Absent / Late / Undertime / Half Day / incentives from the logs.
function autoFillAttendance(employeeId) {
  const { pay } = employeePayInfo(employeeId);
  const counts = pay?.counts || {};
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('pc-absences', counts.absent_days || 0);
  setVal('pc-late', counts.late_days || 0);
  setVal('pc-undertime', counts.undertime_minutes || 0);
  setVal('pc-half-days', counts.half_days || 0);
  setVal('pc-early-bird', counts.early_bird_days || 0);
  setVal('pc-perfect', pay?.perfect_attendance ? 'yes' : 'no');
}

/** Rate hints next to each field, and the unresolved-attendance warning. */
function renderEmployeeRateHints(employeeId) {
  const info = employeePayInfo(employeeId);
  const { rates, unit, pay } = info;
  const setTxt = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const peso = (v) => formatMoney(v).replace('₱ ', '₱');
  if (usesLegalTables(info)) {
    setTxt('pc-sss-hint', `(legal table: ${rates.sss_pct}% of salary credit, editable)`);
    setTxt('pc-philhealth-hint', `(legal table: ${rates.philhealth_pct}% of monthly salary, editable)`);
    setTxt('pc-pagibig-hint', `(legal table: ${rates.pagibig_pct}% up to the cap, editable)`);
    // The school's payroll sheet: fixed amounts, or this employee's own (0 = exempt).
    const source = info.row?.defaults?.contribution_source || null;
    if (source) {
      const words = { fixed: 'fixed monthly amount', employee: 'set for this employee' };
      ['sss', 'philhealth', 'pagibig'].forEach((type) => {
        if (words[source[type]]) setTxt(`pc-${type}-hint`, `(${words[source[type]]}, editable)`);
      });
    }
  } else {
    setTxt('pc-sss-hint', `(default ${rates.sss_pct}% of Basic, editable)`);
    setTxt('pc-philhealth-hint', `(default ${rates.philhealth_pct}% of Basic, editable)`);
    setTxt('pc-pagibig-hint', `(default ${rates.pagibig_pct}% of Basic, editable)`);
  }
  setTxt('pc-absent-hint', `${peso(unit.absent)}/day`);
  const lateRules = [
    unit.late_days_per_absent > 0 ? `${unit.late_days_per_absent} late = 1 absent (${peso(unit.absent)})` : '',
    unit.late_minute_pct > 0 ? `+ ${unit.late_minute_pct}% of hourly per minute` : '',
  ].filter(Boolean).join(' ');
  setTxt('pc-late-hint', lateRules || 'not charged');
  setTxt('pc-undertime-hint', `${peso(unit.hourly)}/hour`);
  setTxt('pc-half-day-hint', `${peso(unit.half_day)}/day`);
  setTxt('pc-lwop-hint', `(days, ${peso(unit.daily)}/day)`);
  setTxt('pc-early-bird-hint', `${peso(unit.early_bird)}/day`);
  setTxt('pc-perfect-hint', `${peso(unit.perfect_attendance)}/period`);

  const banner = document.getElementById('pc-blocking');
  const blocking = pay?.blocking || [];
  if (banner) {
    banner.style.display = blocking.length ? '' : 'none';
    banner.innerHTML = blocking.length
      ? `⚠ Unresolved attendance: ${escapeHtml(describeBlockingDays(blocking))}. This employee cannot be processed until HR or the branch Administrator resolves ${blocking.length === 1 ? 'it' : 'them'}. <a href="#" onclick="openAcctIncompleteQueue();return false;" style="color:var(--amber);font-weight:600;">View in Attendance →</a>`
      : '';
  }
  const submitButton = document.getElementById('ac-submit-btn');
  const finalWindow = !acctState.generationWindow || acctState.generationWindow.state === 'final';
  if (submitButton) {
    submitButton.disabled = Boolean(blocking.length) || !acctState.payrollReady || !finalWindow;
    submitButton.title = finalWindow ? '' : (acctState.generationWindow?.message || '');
  }
}

/** Manual changes from the computed defaults, for the override reason. */
function getFormDeviations() {
  const employee = getSelectedEmployee();
  if (!employee) return [];
  const info = employeePayInfo(employee.id);
  const { pay } = info;
  const counts = pay?.counts || {};
  const leave = (acctState.leaveSummary || []).find((row) => row.employee_id === employee.id);
  const get = (id) => toAmount(document.getElementById(id)?.value);
  const basic = get('pc-basic');
  // Semi-monthly 1st half: only the basic salary can differ (nothing else is deducted).
  if (semiHalf() === 'first') {
    return acctSame(basicDefaultFor(employee), basic) ? [] : [`Basic Salary: ${basicDefaultFor(employee)} → ${basic}`];
  }
  const contributions = contributionDefaults(info, basic);
  const checks = [
    ['Basic Salary', basicDefaultFor(employee), basic],
    ['SSS', contributions.sss, get('pc-sss')],
    ['PhilHealth', contributions.philhealth, get('pc-philhealth')],
    ['Pag-IBIG', contributions.pagibig, get('pc-pagibig')],
    // Tracked only with the legal tables, where the server computes a default.
    ...(usesLegalTables(info) ? [['Withholding Tax', acctState.lastTaxDefault, get('pc-tax')]] : []),
    ['Leave Without Pay', leave?.without_pay_days || 0, get('pc-leave-without-pay-days')],
    ['Absent', counts.absent_days || 0, get('pc-absences')],
    ['Late', counts.late_days || 0, get('pc-late')],
    ['Undertime', counts.undertime_minutes || 0, get('pc-undertime')],
    ['Half Day', counts.half_days || 0, get('pc-half-days')],
    ['Early Bird', counts.early_bird_days || 0, get('pc-early-bird')],
  ];
  const deviations = checks
    .filter(([, def, value]) => !acctSame(def, value))
    .map(([label, def, value]) => `${label}: ${def} → ${value}`);
  const perfect = document.getElementById('pc-perfect')?.value === 'yes';
  if (pay && perfect !== Boolean(pay.perfect_attendance)) {
    deviations.push(`Perfect Attendance: ${pay.perfect_attendance ? 'Yes' : 'No'} → ${perfect ? 'Yes' : 'No'}`);
  }
  return deviations;
}

function renderOverrideState() {
  const deviations = getFormDeviations();
  const wrap = document.getElementById('pc-override-wrap');
  const list = document.getElementById('pc-override-list');
  if (wrap) wrap.style.display = deviations.length ? '' : 'none';
  if (list) list.textContent = deviations.length ? `Changed from computed: ${deviations.join(' · ')}` : '';
}

// Auto-fills the current employee's Leave With Pay / Without Pay day counts for
// the selected pay period, from real approved leave requests (acctState.leaveSummary,
// populated by loadAccountantData() from GET /api/accountant/payroll's leave_summary).
function autoFillLeaveDays(employeeId) {
  const summary = (acctState.leaveSummary || []).find((row) => row.employee_id === employeeId);
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('pc-leave-with-pay-days', summary?.with_pay_days || 0);
  setVal('pc-leave-without-pay-days', summary?.without_pay_days || 0);
  renderLeaveDates(summary);
}

// Which working days each leave figure is (the employee's On Leave days).
function renderLeaveDates(summary) {
  const fmt = (dates) => (dates || []).map((key) => {
    const date = new Date(`${key}T00:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? key
      : new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' }).format(date);
  }).join(', ');
  const set = (id, dates, note) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = dates?.length ? `${fmt(dates)} · ${note}` : '';
    el.style.display = dates?.length ? '' : 'none';
  };
  set('pc-lwp-dates', summary?.with_pay_dates, 'paid, no deduction');
  set('pc-lwop-dates', summary?.without_pay_dates, 'deducted at the daily rate');
}

function recalc() {
  applyFirstHalfLock();
  const get = (id) => toAmount(document.getElementById(id)?.value);
  const basic = get('pc-basic');
  const sss = get('pc-sss');
  const philhealth = get('pc-philhealth');
  const pagibig = get('pc-pagibig');
  let tax = get('pc-tax');
  const leaveWithPayDays = get('pc-leave-with-pay-days');
  const leaveWithoutPayDays = get('pc-leave-without-pay-days');

  // Absent: % of the daily rate; Late / Undertime: minutes ÷ 60 × hourly
  // rate; Half Day: % of the daily rate; Leave Without Pay: the daily rate.
  const info = employeePayInfo(getSelectedEmployee()?.id);
  const amounts = computeAttendanceAmounts(info, {
    absences_days: get('pc-absences'),
    late_days: get('pc-late'),
    undertime_minutes: get('pc-undertime'),
    half_days: get('pc-half-days'),
    early_bird_days: get('pc-early-bird'),
    perfect_attendance: document.getElementById('pc-perfect')?.value === 'yes',
  });
  const leaveWithoutPayDeduct = toAmount(leaveWithoutPayDays * info.unit.daily);
  const incentives = toAmount(amounts.early_bird + amounts.perfect_attendance);
  // Approved overtime and holiday pay (from the logs) are part of gross pay.
  const earnings = earningsFor(info);
  const grossPay = toAmount(basic + earnings.overtime + earnings.holiday);
  // Semi-monthly 2nd half: incentives / overload filed for the month.
  const settling = semiHalf() === 'second';
  const extras = settling ? semiExtras(info) : { other: 0, firstHalfPaid: 0, carryIn: 0 };
  // The school's payroll sheet (each half on its own attendance): the month's
  // incentives / overload on the 2nd half, as the server computed them.
  if (!settling && info.row?.defaults?.per_half) extras.other = semiExtras(info).other;
  // Cash advance installments (Cash Advances page), as the server computed them.
  const cashAdvance = toAmount(info.row?.defaults?.cash_advance || 0);

  // Withholding tax follows the figures until the accountant types one.
  acctState.lastTaxDefault = taxDefaultFor(info, {
    basic,
    earnings: earnings.overtime + earnings.holiday,
    attendanceDeductions: amounts.absent + amounts.late + amounts.undertime + amounts.half_day + leaveWithoutPayDeduct,
    contributions: sss + philhealth + pagibig,
    incentives: incentives + extras.other,
  });
  if (!acctState.taxEdited) {
    tax = acctState.lastTaxDefault;
    const taxInput = document.getElementById('pc-tax');
    if (taxInput) taxInput.value = tax;
  }
  const totalDeductions = toAmount(
    sss + philhealth + pagibig + tax
    + amounts.absent + amounts.late + amounts.undertime + amounts.half_day
    + leaveWithoutPayDeduct + cashAdvance,
  );
  // Net Pay = Gross - deductions + incentives, floored at zero like the server.
  // A 2nd half pays the month's net less the 1st half and any carried balance.
  const monthNet = toAmount(grossPay - totalDeductions + incentives + extras.other);
  const secondHalfNet = toAmount(monthNet - extras.firstHalfPaid - extras.carryIn);
  const netPay = Math.max(0, settling ? secondHalfNet : monthNet);
  renderSemiMonthlySummary(settling, { extras, monthNet, secondHalfNet });

  const updates = {
    'sum-basic': formatMoney(basic),
    'sum-overtime': `+ ${formatMoney(earnings.overtime)}`,
    'sum-holiday': `+ ${formatMoney(earnings.holiday)}`,
    'sum-gross': formatMoney(grossPay),
    'sum-sss': `- ${formatMoney(sss)}`,
    'sum-philhealth': `- ${formatMoney(philhealth)}`,
    'sum-pagibig': `- ${formatMoney(pagibig)}`,
    'sum-tax': `- ${formatMoney(tax)}`,
    'sum-absences': `- ${formatMoney(amounts.absent)}`,
    'sum-late': `- ${formatMoney(amounts.late)}`,
    'sum-undertime': `- ${formatMoney(amounts.undertime)}`,
    'sum-half-day': `- ${formatMoney(amounts.half_day)}`,
    'sum-leave-with-pay': `${leaveWithPayDays} day${leaveWithPayDays === 1 ? '' : 's'}`,
    'sum-leave-without-pay': `- ${formatMoney(leaveWithoutPayDeduct)}`,
    'sum-cash-advance': `- ${formatMoney(cashAdvance)}`,
    'sum-incentives': `+ ${formatMoney(incentives + (settling ? 0 : extras.other))}`,
    'sum-net': formatMoney(netPay),
  };
  renderOverrideState();

  Object.entries(updates).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

/** The 2nd half rows of the Computation Summary, and the 1st half's locked fields. */
function renderSemiMonthlySummary(settling, { extras, monthNet, secondHalfNet }) {
  const wrap = document.getElementById('sum-semi-wrap');
  if (wrap) wrap.style.display = settling ? '' : 'none';
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const half = semiHalf();
  set('sum-net-label', half === 'second' ? '2nd Half Net Pay' : half === 'first' ? '1st Half Net Pay' : 'Net Pay');
  if (settling) {
    set('sum-other-incentives', `+ ${formatMoney(extras.other)}`);
    set('sum-month-net', formatMoney(monthNet));
    set('sum-first-half-label', extras.firstHalfStatus === 'final' ? 'Paid in 1st Half' : 'Paid in 1st Half (not processed)');
    set('sum-first-half', `- ${formatMoney(extras.firstHalfPaid)}`);
    set('sum-carry-in', `- ${formatMoney(extras.carryIn)}`);
    const carryRow = document.getElementById('sum-carry-out-row');
    if (carryRow) carryRow.style.display = secondHalfNet < 0 ? '' : 'none';
    set('sum-carry-out', formatMoney(Math.max(0, -secondHalfNet)));
  }
}

/** 1st half: no deductions at all, so those fields are zero and cannot be typed in. */
function applyFirstHalfLock() {
  const firstHalf = semiHalf() === 'first';
  ['pc-sss', 'pc-philhealth', 'pc-pagibig', 'pc-tax', 'pc-absences', 'pc-late', 'pc-undertime', 'pc-half-days',
    'pc-leave-with-pay-days', 'pc-leave-without-pay-days', 'pc-early-bird', 'pc-perfect'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = firstHalf;
    if (firstHalf) el.value = id === 'pc-perfect' ? 'no' : 0;
  });
}

function getPayrollFormValues() {
  const get = (id) => toAmount(document.getElementById(id)?.value);

  return {
    basic_salary: get('pc-basic'),
    allowances: {
      transportation: 0,
      rice: 0,
      overtime: 0,
      bonus: 0,
    },
    deductions: {
      sss: get('pc-sss'),
      philhealth: get('pc-philhealth'),
      pagibig: get('pc-pagibig'),
      withholding_tax: get('pc-tax'),
      absences_days: get('pc-absences'),
      late_days: get('pc-late'),
      undertime_minutes: get('pc-undertime'),
      half_days: get('pc-half-days'),
      leave_with_pay_days: get('pc-leave-with-pay-days'),
      leave_without_pay_days: get('pc-leave-without-pay-days'),
    },
    incentives: {
      early_bird_days: get('pc-early-bird'),
      perfect_attendance: document.getElementById('pc-perfect')?.value === 'yes',
    },
  };
}

function getSelectedEmployee() {
  const employeeSelect = document.getElementById('pc-employee');
  const selectedId = String(employeeSelect?.value || '');
  return acctState.employees.find((employee) => employee.id === selectedId) || null;
}

function buildSubmissionPayload(action) {
  const employee = getSelectedEmployee();
  if (!employee) {
    showFieldError('pc-employee', 'Select an employee.');
    throw new Error('Select an employee first.');
  }

  const payPeriod = String(document.getElementById('pc-period')?.value || '').trim();
  if (!payPeriod) {
    showFieldError('pc-period', 'Select a pay period.');
    throw new Error('Select a pay period first.');
  }

  const formValues = getPayrollFormValues();

  return {
    action,
    entry_id: acctState.currentEntryId || undefined,
    employee_id: employee.id,
    pay_period: payPeriod,
    basic_salary: formValues.basic_salary,
    allowances: formValues.allowances,
    deductions: formValues.deductions,
    incentives: formValues.incentives,
    // Required by the server whenever a value differs from the computed one.
    override_reason: String(document.getElementById('pc-override-reason')?.value || '').trim(),
    reason: 'Payroll processed by accountant.',
  };
}

async function upsertPayrollEntry(action) {
  const payload = buildSubmissionPayload(action);

  const response = await fetch('/api/accountant/payroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(result.error || 'Failed to save payroll entry.');
    err.status = response.status;
    if (result.code === 'override_reason_required') {
      showFieldError('pc-override-reason', 'Give a reason for the values changed from the computed defaults.');
    }
    throw err;
  }

  acctState.currentEntryId = String(result.entry?.id || acctState.currentEntryId || '');

  await loadAccountantData();

  if (result.db_synced === false) {
    console.warn('[accountant] payroll_entries DB sync failed:', result.db_error);
    window.pushNotification?.('Draft Saved', 'Draft saved. Database sync pending — contact your administrator if this keeps occurring.', 'info');
  }

  return result;
}

/* ── PROCESS PAYROLL ── */
async function processPayroll() {
  try {
    setActionButtonsDisabled(true);
    showProcessFeedback('Processing payroll...', false, false);

    await upsertPayrollEntry('submit');
    showProcessFeedback('Payroll processed successfully. Payslip generated.', false, true);
    window.pushNotification?.('Payroll Processed', 'Payroll has been processed and payslip generated.', 'success');

    const banner = document.getElementById('ac-pending-banner');
    if (banner) {
      banner.style.display = 'flex';
      banner.innerHTML = '<strong>Payroll Processed:</strong> Payslip has been generated and recorded in Payroll Records.';
      setTimeout(() => { banner.style.display = 'none'; }, 5000);
    }

    openPayslipFromRecord(acctState.currentEntryId);
  } catch (error) {
    if (error.status === 409) {
      showProcessFeedback('', false);
      window.pushNotification?.('Already Processed', 'Payroll for this employee and period has already been processed.', 'info');
    } else {
      showProcessFeedback(error.message, true);
    }
  } finally {
    setActionButtonsDisabled(false);
    renderEmployeeRateHints(getSelectedEmployee()?.id);
  }
}

async function savePayrollDraft() {
  try {
    setActionButtonsDisabled(true);
    showProcessFeedback('Saving payroll draft...', false, false);
    await upsertPayrollEntry('save_draft');
    showProcessFeedback('Payroll draft saved.', false, true);
    window.pushNotification?.('Draft Saved', 'Payroll draft has been saved and can be edited before submission.', 'info');
  } catch (error) {
    showProcessFeedback(error.message, true);
  } finally {
    setActionButtonsDisabled(false);
    renderEmployeeRateHints(getSelectedEmployee()?.id);
  }
}

function renderEmployeeDropdown() {
  const select = document.getElementById('pc-employee');
  if (!select) return;

  if (!acctState.employees.length) {
    select.innerHTML = '<option value="">No employees found</option>';
    return;
  }

  select.innerHTML = acctState.employees.map((employee) => {
    const label = `${employee.full_name} — ${employee.employee_id} (${employee.employee_type})`;
    return `<option value="${escapeHtml(employee.id)}">${escapeHtml(label)}</option>`;
  }).join('');

  if (!select.value) {
    select.value = acctState.employees[0].id;
  }
}

function renderPeriodDropdown() {
  const select = document.getElementById('pc-period');
  if (!select) return;

  if (!acctState.periodOptions.length) {
    select.innerHTML = '<option>Current period</option>';
    return;
  }

  const previousValue = select.value;
  select.innerHTML = acctState.periodOptions.map((period) => `<option value="${escapeHtml(period)}">${escapeHtml(period)}</option>`).join('');

  if (previousValue && acctState.periodOptions.includes(previousValue)) {
    select.value = previousValue;
  }
}

function syncFormForEmployee() {
  const employee = getSelectedEmployee();
  if (!employee) return;

  const basicInput = document.getElementById('pc-basic');
  if (!basicInput) return;

  if (!acctState.currentEntryId) {
    // Payroll runs twice a month (1-15 and 16-end). Semi-monthly payroll: the
    // 1st half is half the monthly salary; the 2nd half computes the whole
    // month on the monthly salary (the server's default either way).
    basicInput.value = basicDefaultFor(employee);
    autoFillDeductions(toAmount(basicInput.value));
    autoFillLeaveDays(employee.id);
    autoFillAttendance(employee.id);
    const reason = document.getElementById('pc-override-reason');
    if (reason) reason.value = '';
  }

  renderEmployeeRateHints(employee.id);
  recalc();
}

function renderRecordsPanels(panels = {}) {
  const grossEl = document.getElementById('ac-total-gross');
  const deductionsEl = document.getElementById('ac-total-deductions');
  const netEl = document.getElementById('ac-total-net');
  const periodEl = document.getElementById('ac-record-period');

  if (grossEl) grossEl.textContent = formatMoneyCompact(panels.total_gross || 0);
  if (deductionsEl) deductionsEl.textContent = formatMoneyCompact(panels.total_deductions || 0);
  if (netEl) netEl.textContent = formatMoneyCompact(panels.total_net || 0);

  const periodSelect = document.getElementById('pc-period');
  if (periodEl) {
    periodEl.textContent = periodSelect?.value || 'Current period';
  }
}

function renderPayrollRecordsTable(rows) {
  const tbody = document.getElementById('ac-records-body');
  if (!tbody) return;

  const data = Array.isArray(rows) ? rows : acctState.records;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No payroll records available yet.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((record) => {
    const status = statusMeta(record.status);
    const payslipDisabled = String(record.status || '').toLowerCase() === 'draft' ? 'disabled' : '';

    return `
      <tr>
        <td class="nm">${escapeHtml(record.employee_name)}</td>
        <td>${escapeHtml(record.pay_period)}</td>
        <td class="mn">${formatMoneyCompact(record.gross_pay)}</td>
        <td class="mn">${formatMoneyCompact(record.total_deductions)}</td>
        <td class="mn">${formatMoneyCompact(record.net_pay)}</td>
        <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        <td><button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openPayslipFromRecord('${escapeJsArg(record.id)}')" ${payslipDisabled}>Payslip</button></td>
      </tr>
    `;
  }).join('');
}

function renderAttendanceTable(rows) {
  const tbody = document.getElementById('ac-attendance-body');
  if (!tbody) return;

  const data = Array.isArray(rows) ? rows : acctState.attendanceRows;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--t3);">No attendance rows available.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((row) => `
    <tr>
      <td class="nm">${escapeHtml(row.employee_name)}</td>
      <td class="mn">${Number(row.present_days || 0)}</td>
      <td class="mn">${Number(row.late_days || 0)}</td>
      <td class="mn">${Number(row.absent_days || 0)}</td>
      <td class="mn">${Number(row.deduction_days || 0)}</td>
    </tr>
  `).join('');
}

/* ── DASHBOARD ── */
function renderDashboard() {
  const employees = acctState.employees || [];
  const records = acctState.records || [];
  const drafts = acctState.draftEntries || [];
  const panels = acctState.panels || {};

  const paidRecords = records.filter((r) => r.status === 'paid' || r.status === 'approved');

  const empEl = document.getElementById('dash-total-employees');
  if (empEl) empEl.textContent = String(employees.length);

  const grossEl = document.getElementById('dash-month-gross');
  if (grossEl) grossEl.textContent = formatMoneyCompact(panels.total_gross || 0);

  const netEl = document.getElementById('dash-month-net');
  if (netEl) netEl.textContent = formatMoneyCompact(panels.total_net || 0);

  const deductEl = document.getElementById('dash-total-deductions');
  if (deductEl) deductEl.textContent = formatMoneyCompact(panels.total_deductions || 0);

  const paidCountEl = document.getElementById('dash-paid-count');
  if (paidCountEl) paidCountEl.textContent = String(paidRecords.length);

  const draftCountEl = document.getElementById('dash-draft-count');
  if (draftCountEl) draftCountEl.textContent = String(drafts.length);

  const tbody = document.getElementById('dash-recent-body');
  if (!tbody) return;

  const recent = records.slice(0, 5);
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">No recent payroll activity.</td></tr>';
    return;
  }

  tbody.innerHTML = recent.map((r) => {
    const status = statusMeta(r.status);
    const date = r.submitted_at || r.updated_at || '';
    return `
      <tr>
        <td class="nm">${escapeHtml(r.employee_name)}</td>
        <td>${escapeHtml(r.pay_period)}</td>
        <td class="mn">${formatMoneyCompact(r.gross_pay)}</td>
        <td class="mn">${formatMoneyCompact(r.net_pay)}</td>
        <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        <td class="mn" style="font-size:11px;">${date ? formatDateTime(date) : '—'}</td>
      </tr>`;
  }).join('');
}

/* ── MONITORING ── */
function getFilteredMonRows() {
  let rows = _monStatusFilter === 'all'
    ? _monAllRows
    : _monAllRows.filter((r) => String(r.status || '').toLowerCase() === _monStatusFilter);
  if (_monSearch) {
    rows = rows.filter((r) => String(r.employee_name || '').toLowerCase().includes(_monSearch));
  }
  return rows;
}

function renderMonitoringTable(rows) {
  const tbody = document.getElementById('mon-tbody');
  if (!tbody) return;

  const data = Array.isArray(rows) ? rows : getFilteredMonRows();

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--t3);">No payroll records found.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((record) => {
    const status = statusMeta(record.status);
    const date = record.submitted_at || record.updated_at || '';
    const isDraft = String(record.status || '').toLowerCase() === 'draft';
    const safeId = escapeJsArg(record.id);

    const actionBtn = isDraft
      ? `<button class="btn btn-outline" style="font-size:11px;padding:4px 8px;margin-right:4px;" onclick="editDraftEntry('${safeId}')">Edit</button><button class="btn btn-red" style="font-size:11px;padding:4px 8px;" onclick="cancelDraft('${safeId}')">Cancel</button>`
      : `<button class="btn btn-outline" style="font-size:11px;padding:4px 8px;" onclick="openPayslipFromRecord('${safeId}')">Payslip</button>`;

    return `
      <tr>
        <td class="nm">${escapeHtml(record.employee_name)}</td>
        <td>${escapeHtml(record.pay_period)}</td>
        <td class="mn">${formatMoneyCompact(record.gross_pay)}</td>
        <td class="mn">${formatMoneyCompact(record.total_deductions)}</td>
        <td class="mn">${formatMoneyCompact(record.net_pay)}</td>
        <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        <td class="mn" style="font-size:11px;">${date ? formatDateTime(date) : '—'}</td>
        <td>${actionBtn}</td>
      </tr>`;
  }).join('');
}

function renderMonitoringStats() {
  const allRows = _monAllRows;
  const paidCount = allRows.filter((r) => r.status === 'paid' || r.status === 'approved').length;
  const holdCount = allRows.filter((r) => r.status === 'on_hold').length;

  const totalEl = document.getElementById('mon-total-count');
  const paidEl = document.getElementById('mon-paid-count');
  const holdEl = document.getElementById('mon-hold-count');

  if (totalEl) totalEl.textContent = String(allRows.length);
  if (paidEl) paidEl.textContent = String(paidCount);
  if (holdEl) holdEl.textContent = String(holdCount);
}

function renderMonitoringPage() {
  const all = [...(acctState.records || []), ...(acctState.draftEntries || [])];
  _monAllRows = all;
  renderMonitoringStats();
  if (monPaginator) {
    monPaginator.setData(getFilteredMonRows());
  } else {
    renderMonitoringTable(getFilteredMonRows());
  }
}

function monFilter(filter, btn) {
  _monStatusFilter = filter;
  document.querySelectorAll('#mon-status-tabs .st-tab').forEach((b) => b.classList.remove('st-active'));
  if (btn) btn.classList.add('st-active');
  if (monPaginator) monPaginator.setData(getFilteredMonRows());
  else renderMonitoringTable(getFilteredMonRows());
}

function setMonSearch(value) {
  _monSearch = String(value || '').trim().toLowerCase();
  if (monPaginator) monPaginator.setData(getFilteredMonRows());
  else renderMonitoringTable(getFilteredMonRows());
}

function editDraftEntry(entryId) {
  const id = String(entryId || '').trim();
  if (!id) return;
  const processNav = getAccountantNavByPageId('ac-process');
  acctNav('ac-process', processNav);
  acctState.currentEntryId = id;
  loadAccountantData({ entryId: id });
}

/* ── REPORTS ── */
function renderReportPeriodDropdown() {
  const select = document.getElementById('rpt-period');
  if (!select) return;
  const periods = acctState.periodOptions || [];
  const prev = select.value;
  select.innerHTML = `<option value="all">All Periods</option>${periods.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}`;
  if (prev && (prev === 'all' || periods.includes(prev))) select.value = prev;
}

function generateReport() {
  const period = document.getElementById('rpt-period')?.value || 'all';
  const reportType = document.getElementById('rpt-type')?.value || 'summary';

  // Payroll Sheet (School Format) is built on the server, per branch.
  if (reportType === 'sheet') {
    generatePayrollSheet();
    return;
  }
  const sheetEl = document.getElementById('rpt-sheet');
  if (sheetEl) sheetEl.style.display = 'none';
  const tableCard = document.getElementById('rpt-table-card');
  if (tableCard) tableCard.style.display = '';

  const all = [...(acctState.records || []), ...(acctState.draftEntries || [])];
  _reportData = period === 'all' ? all : all.filter((r) => r.pay_period === period);

  const summaryBox = document.getElementById('rpt-summary-box');
  const titleEl = document.getElementById('rpt-table-title');

  if (summaryBox) {
    const total_gross = _reportData.reduce((s, r) => s + Number(r.gross_pay || 0), 0);
    const total_deductions = _reportData.reduce((s, r) => s + Number(r.total_deductions || 0), 0);
    const total_net = _reportData.reduce((s, r) => s + Number(r.net_pay || 0), 0);
    summaryBox.innerHTML = `
      <div class="sr"><span>Records</span><span style="font-family:var(--mono);">${_reportData.length}</span></div>
      <div class="sr"><span>Total Gross Pay</span><span style="font-family:var(--mono);color:var(--teal);">${formatMoney(total_gross)}</span></div>
      <div class="sr" style="color:var(--red);"><span>Total Deductions</span><span style="font-family:var(--mono);">- ${formatMoney(total_deductions)}</span></div>
      <div class="sr tot"><span>Total Net Pay</span><span style="font-family:var(--mono);color:var(--amber);">${formatMoney(total_net)}</span></div>`;
  }

  if (titleEl) titleEl.textContent = `Payroll Report — ${period === 'all' ? 'All Periods' : period}`;
  renderReportTable(reportType);
}

function renderReportTable(reportType) {
  const tbody = document.getElementById('rpt-tbody');
  const thead = document.getElementById('rpt-thead');
  if (!tbody) return;

  if (!_reportData.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">No records for selected period.</td></tr>';
    return;
  }

  if (reportType === 'deductions') {
    if (thead) thead.innerHTML = '<tr><th>Employee</th><th>Period</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th><th>Absence Ded.</th><th>Net Pay</th></tr>';
    tbody.innerHTML = _reportData.map((r) => {
      const ded = r.payroll?.deductions || {};
      const absence = r.payroll?.totals?.absence_deduction || 0;
      return `
        <tr>
          <td class="nm">${escapeHtml(r.employee_name)}</td>
          <td>${escapeHtml(r.pay_period)}</td>
          <td class="mn">${formatMoneyCompact(ded.sss || 0)}</td>
          <td class="mn">${formatMoneyCompact(ded.philhealth || 0)}</td>
          <td class="mn">${formatMoneyCompact(ded.pagibig || 0)}</td>
          <td class="mn">${formatMoneyCompact(ded.withholding_tax || 0)}</td>
          <td class="mn">${formatMoneyCompact(absence)}</td>
          <td class="mn">${formatMoneyCompact(r.net_pay)}</td>
        </tr>`;
    }).join('');
  } else {
    if (thead) thead.innerHTML = '<tr><th>Employee</th><th>Period</th><th>Gross Pay</th><th>Deductions</th><th>Net Pay</th><th>Status</th></tr>';
    tbody.innerHTML = _reportData.map((r) => {
      const status = statusMeta(r.status);
      return `
        <tr>
          <td class="nm">${escapeHtml(r.employee_name)}</td>
          <td>${escapeHtml(r.pay_period)}</td>
          <td class="mn">${formatMoneyCompact(r.gross_pay)}</td>
          <td class="mn">${formatMoneyCompact(r.total_deductions)}</td>
          <td class="mn">${formatMoneyCompact(r.net_pay)}</td>
          <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        </tr>`;
    }).join('');
  }
}

function exportReportCSV() {
  if (document.getElementById('rpt-type')?.value === 'sheet') {
    exportPayrollSheetCSV();
    return;
  }
  if (!_reportData.length) {
    window.pushNotification?.('No Data', 'Generate a report first before exporting.', 'info');
    return;
  }
  const period = document.getElementById('rpt-period')?.value || 'all';
  const headers = ['Employee', 'Pay Period', 'Gross Pay', 'Total Deductions', 'Net Pay', 'Status'];
  const rows = _reportData.map((r) => [
    r.employee_name || '',
    r.pay_period || '',
    String(toAmount(r.gross_pay)),
    String(toAmount(r.total_deductions)),
    String(toAmount(r.net_pay)),
    r.status || '',
  ]);
  // A cell starting with = + - @ (or tab / CR) runs as a formula in Excel;
  // a leading ' keeps it text. Plain numbers such as -12.50 are left alone.
  const csvText = (v) => {
    const s = String(v);
    return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  };
  const csv = [headers, ...rows].map((row) => row.map((v) => `"${csvText(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payroll-report-${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function printReport() {
  // Stamp the printed letterhead with what was actually generated, so a
  // filed copy is self-describing.
  const periodSelect = document.getElementById('rpt-period');
  const periodLabel = periodSelect?.selectedOptions?.[0]?.textContent?.trim();
  const periodEl = document.getElementById('rpt-print-period');
  if (periodEl) periodEl.textContent = periodLabel || 'All Periods';

  const generatedEl = document.getElementById('rpt-print-generated');
  if (generatedEl) {
    generatedEl.textContent = `Generated ${new Intl.DateTimeFormat('en-PH', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date())}`;
  }

  printDocument('report');
}

function editDraftFromPending(entryId) {
  editDraftEntry(entryId);
}

function renderPayslipOptions() {
  const select = document.getElementById('ac-payslip-select');
  if (!select) return;

  if (!acctState.payslipOptions.length) {
    select.innerHTML = '<option value="">No payslips available</option>';
    return;
  }

  const previousValue = select.value;
  select.innerHTML = acctState.payslipOptions.map((option) => (
    `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`
  )).join('');

  if (previousValue && acctState.payslipOptions.some((option) => option.id === previousValue)) {
    select.value = previousValue;
  }
}

function renderPayslipDetails() {
  const payslip = acctState.payslip;
  if (!payslip) return;

  const assign = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };

  assign('ac-pf-slip-no', payslip.payslip_no || '—');
  assign('ac-pf-period', payslip.pay_period || 'N/A');
  assign('ac-pf-issued', `Issued: ${formatDateTime(payslip.issued_at)}`);
  assign('ac-pf-name', payslip.employee?.name || 'N/A');
  assign('ac-pf-id', payslip.employee?.id || 'N/A');
  assign('ac-pf-position', normalizePortalPosition(payslip.employee?.position, payslip.employee?.role));
  assign('ac-pf-type', payslip.employee?.type || 'N/A');

  assign('ac-pf-basic', formatMoney(payslip.earnings?.basic_salary || 0));
  assign('ac-pf-transport', formatMoney(payslip.earnings?.transportation || 0));
  assign('ac-pf-rice', formatMoney(payslip.earnings?.rice || 0));
  assign('ac-pf-overtime', formatMoney(payslip.earnings?.overtime || 0));
  assign('ac-pf-holiday', formatMoney(payslip.earnings?.holiday_pay || 0));
  assign('ac-pf-bonus', formatMoney(payslip.earnings?.bonus || 0));
  assign('ac-pf-gross', formatMoney(payslip.earnings?.gross_pay || 0));

  assign('ac-pf-sss', formatMoney(payslip.deductions?.sss || 0));
  assign('ac-pf-philhealth', formatMoney(payslip.deductions?.philhealth || 0));
  assign('ac-pf-pagibig', formatMoney(payslip.deductions?.pagibig || 0));
  assign('ac-pf-tax', formatMoney(payslip.deductions?.withholding_tax || 0));
  assign('ac-pf-absence', formatMoney(payslip.deductions?.absence_deduction || 0));
  const lateDays = payslip.deductions?.late_days || 0;
  const undertimeMinutes = payslip.deductions?.undertime_minutes || 0;
  const halfDays = payslip.deductions?.half_days || 0;
  const earlyBirdDays = payslip.incentives?.early_bird_days || 0;
  assign('ac-pf-late-label', lateDays ? `Late (${lateDays} day${lateDays === 1 ? '' : 's'})` : 'Late');
  assign('ac-pf-late', formatMoney(payslip.deductions?.late_deduction || 0));
  assign('ac-pf-undertime-label', undertimeMinutes ? `Undertime (${undertimeMinutes} min)` : 'Undertime');
  assign('ac-pf-undertime', formatMoney(payslip.deductions?.undertime_deduction || 0));
  assign('ac-pf-half-day-label', halfDays ? `Half Day (${halfDays} day${halfDays === 1 ? '' : 's'})` : 'Half Day');
  assign('ac-pf-half-day', formatMoney(payslip.deductions?.half_day_deduction || 0));
  assign('ac-pf-early-bird-label', earlyBirdDays ? `Early Bird (${earlyBirdDays} day${earlyBirdDays === 1 ? '' : 's'})` : 'Early Bird');
  assign('ac-pf-early-bird', formatMoney(payslip.incentives?.early_bird_incentive || 0));
  assign('ac-pf-perfect', formatMoney(payslip.incentives?.perfect_attendance_incentive || 0));
  const leaveWithPayDays = payslip.deductions?.leave_with_pay_days || 0;
  assign('ac-pf-leave-with-pay', `${leaveWithPayDays} day${leaveWithPayDays === 1 ? '' : 's'}`);
  assign('ac-pf-leave-without-pay', formatMoney(payslip.deductions?.leave_without_pay_deduction || 0));
  assign('ac-pf-cash-advance', formatMoney(payslip.deductions?.cash_advance || 0));
  assign('ac-pf-total-deductions', formatMoney(payslip.deductions?.total_deductions || 0));
  assign('ac-pf-net', formatMoney(payslip.net_pay || 0));
  renderSemiMonthlyPayslip(payslip);
  renderPayslipGeneration(payslip);
}

function populateFormFromDraft() {
  const employeeSelect = document.getElementById('pc-employee');
  const periodSelect = document.getElementById('pc-period');
  if (!employeeSelect || !periodSelect) return;

  const draft = acctState.records.find((row) => String(row.id) === String(acctState.currentEntryId))
    || acctState.draftEntries.find((row) => String(row.id) === String(acctState.currentEntryId));

  if (!draft) {
    syncFormForEmployee();
    return;
  }

  employeeSelect.value = draft.employee_id;
  periodSelect.value = draft.pay_period;

  const payroll = draft.payroll || {};
  const allowances = payroll.allowances || {};
  const deductions = payroll.deductions || {};

  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = Number(value || 0);
  };

  setValue('pc-basic', payroll.basic_salary);
  setValue('pc-sss', deductions.sss);
  setValue('pc-philhealth', deductions.philhealth);
  setValue('pc-pagibig', deductions.pagibig);
  setValue('pc-tax', deductions.withholding_tax);
  // A draft keeps a typed tax; otherwise the tax follows the figures again.
  acctState.taxEdited = (payroll.audit?.deviations?.items || []).some((d) => d.field === 'withholding_tax');
  setValue('pc-absences', deductions.absences_days);
  setValue('pc-late', deductions.late_days ?? 0);
  setValue('pc-undertime', deductions.undertime_minutes ?? 0);
  setValue('pc-half-days', deductions.half_days ?? 0);
  setValue('pc-leave-with-pay-days', deductions.leave_with_pay_days ?? 0);
  setValue('pc-leave-without-pay-days', deductions.leave_without_pay_days ?? 0);
  renderLeaveDates((acctState.leaveSummary || []).find((row) => row.employee_id === draft.employee_id));
  setValue('pc-early-bird', payroll.incentives?.early_bird_days ?? 0);
  const perfectSelect = document.getElementById('pc-perfect');
  if (perfectSelect) perfectSelect.value = payroll.incentives?.perfect_attendance ? 'yes' : 'no';
  const reasonInput = document.getElementById('pc-override-reason');
  if (reasonInput) reasonInput.value = payroll.audit?.deviations?.reason || '';

  renderEmployeeRateHints(draft.employee_id);
  recalc();
}

/* ── BATCH PAYROLL PROCESSING ── */
function renderBatchPeriodDropdown() {
  const select = document.getElementById('pc-batch-period');
  if (!select) return;

  if (!acctState.periodOptions.length) {
    select.innerHTML = '<option>Current period</option>';
    return;
  }

  const previousValue = select.value;
  select.innerHTML = acctState.periodOptions.map((period) => `<option value="${escapeHtml(period)}">${escapeHtml(period)}</option>`).join('');

  if (previousValue && acctState.periodOptions.includes(previousValue)) {
    select.value = previousValue;
  }
}

// Net Pay = Basic - SSS - PhilHealth - Pag-IBIG - Tax - attendance deductions
// (computed from the logs) - Leave w/o Pay + incentives, floored at zero.
function computeBatchRowNetPay(row) {
  const leaveWithoutPayDeduct = toAmount(row.leave_without_pay_days * row.daily_rate);
  const totalDeductions = toAmount(
    row.sss + row.philhealth + row.pagibig + row.tax
    + row.attendance_deductions + leaveWithoutPayDeduct + (row.cash_advance || 0),
  );
  // Gross = basic + approved overtime + holiday pay. A semi-monthly 2nd half
  // adds the month's incentives / overload and pays the month less the 1st
  // half and any balance carried in.
  const monthNet = toAmount(row.basic_salary + (row.earnings || 0) - totalDeductions + row.incentives + (row.other_incentives || 0));
  return Math.max(0, toAmount(monthNet - (row.first_half_paid || 0) - (row.carry_in || 0)));
}

/** The editable batch cells that differ from their computed defaults. */
function batchRowDeviations(employeeId) {
  const safeId = escapeJsAttr(employeeId);
  const tr = document.querySelector(`#pc-batch-table-body tr[data-employee-id="${CSS.escape(String(employeeId))}"]`);
  // Withholding tax has a computed default only with the legal tables.
  const fields = ['sss', 'philhealth', 'pagibig', 'lwop', ...(tr?.dataset.legal === '1' ? ['tax'] : [])];
  return fields.filter((field) => {
    const input = document.getElementById(`batch-${field}-${safeId}`);
    return input && !acctSame(input.value, input.dataset.default);
  });
}

function refreshBatchReasonVisibility() {
  const rows = Array.from(document.querySelectorAll('#pc-batch-table-body tr[data-employee-id]'));
  const anyChanged = rows.some((row) => row.dataset.blocked !== '1' && batchRowDeviations(row.getAttribute('data-employee-id')).length);
  const wrap = document.getElementById('pc-batch-reason-wrap');
  if (wrap) wrap.style.display = anyChanged ? '' : 'none';
}

function recalcBatchRow(employeeId, changedField) {
  const safeId = escapeJsAttr(employeeId);
  const get = (field) => toAmount(document.getElementById(`batch-${field}-${safeId}`)?.value);
  const tr = document.querySelector(`#pc-batch-table-body tr[data-employee-id="${CSS.escape(String(employeeId))}"]`);
  const taxInput = document.getElementById(`batch-tax-${safeId}`);
  if (changedField === 'tax' && taxInput) taxInput.dataset.edited = '1';

  // With the legal tables the tax follows this row's figures until typed.
  if (tr?.dataset.legal === '1' && taxInput && taxInput.dataset.edited !== '1') {
    const info = employeePayInfo(employeeId);
    const taxDefault = taxDefaultFor(info, {
      basic: get('basic'),
      earnings: toAmount(tr.dataset.earnings),
      attendanceDeductions: toAmount(tr.dataset.attendanceDeductions) + toAmount(get('lwop') * toAmount(tr.dataset.dailyRate)),
      contributions: get('sss') + get('philhealth') + get('pagibig'),
      incentives: toAmount(tr.dataset.incentives) + toAmount(tr.dataset.otherIncentives),
    });
    taxInput.value = taxDefault;
    taxInput.dataset.default = taxDefault;
  }

  const row = {
    basic_salary: get('basic'),
    sss: get('sss'),
    philhealth: get('philhealth'),
    pagibig: get('pagibig'),
    tax: get('tax'),
    leave_without_pay_days: get('lwop'),
    daily_rate: toAmount(tr?.dataset.dailyRate),
    attendance_deductions: toAmount(tr?.dataset.attendanceDeductions),
    incentives: toAmount(tr?.dataset.incentives),
    earnings: toAmount(tr?.dataset.earnings),
    other_incentives: toAmount(tr?.dataset.otherIncentives),
    first_half_paid: toAmount(tr?.dataset.firstHalfPaid),
    carry_in: toAmount(tr?.dataset.carryIn),
    cash_advance: toAmount(tr?.dataset.cashAdvance),
  };

  const netPay = computeBatchRowNetPay(row);
  const netEl = document.getElementById(`batch-net-${safeId}`);
  if (netEl) netEl.textContent = formatMoney(netPay);

  ['sss', 'philhealth', 'pagibig', 'tax', 'lwop'].forEach((field) => {
    const input = document.getElementById(`batch-${field}-${safeId}`);
    if (input) input.style.borderColor = acctSame(input.value, input.dataset.default) ? '' : 'var(--amber)';
  });
  refreshBatchReasonVisibility();
}

// The accountant's own View Attendance page, on the Incomplete Queue tab.
function openAcctIncompleteQueue() {
  const nav = getAccountantNavByPageId('ac-attendance');
  acctNav('ac-attendance', nav);
  setTimeout(() => {
    document.querySelector('#ac-att-board [data-att-tab="incomplete"]')?.click();
    document.getElementById('ac-att-board')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 300);
}

function escapeJsAttr(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function loadBatchPayrollTable() {
  const tbody = document.getElementById('pc-batch-table-body');
  if (!tbody) return;

  if (!acctState.employees.length) {
    tbody.innerHTML = '<tr><td colspan="15" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  // Two lines per cell: the quantity and what it costs (or earns).
  const cell = (quantity, amount, sign = '-') => {
    const color = sign === '+' ? 'var(--green)' : 'var(--red)';
    return `<span>${escapeHtml(quantity)}</span>${amount ? `<div style="font-size:11px;color:${color};">${sign} ${formatMoney(amount)}</div>` : ''}`;
  };

  tbody.innerHTML = acctState.employees.map((employee) => {
    const id = escapeJsAttr(employee.id);
    // Payroll runs twice a month (1-15 and 16-end). Semi-monthly payroll: the
    // 1st half is half the monthly salary, the 2nd half the whole month.
    const basic = basicDefaultFor(employee);
    const info = employeePayInfo(employee.id);
    const half = semiHalf();
    // Per-half (the school's payroll sheet): the month's incentives / overload
    // ride on the 2nd half too, with nothing settled against a 1st half.
    const extras = half === 'second' || info.row?.defaults?.per_half ? semiExtras(info) : { other: 0, overloadHours: 0, firstHalfPaid: 0, carryIn: 0 };
    const cashAdvance = toAmount(info.row?.defaults?.cash_advance || 0);
    // A 1st half counts no attendance: it is settled in the 2nd half.
    const counts = half === 'first' ? {} : info.pay?.counts || {};
    const amounts = half === 'first' ? {} : info.pay?.amounts || {};
    const blocking = half === 'first' ? [] : info.pay?.blocking || [];
    const legal = usesLegalTables(info);
    const { sss, philhealth, pagibig } = contributionDefaults(info, basic);
    const leave = acctState.leaveSummary.find((row) => row.employee_id === employee.id);
    const leaveWithPayDays = half === 'first' ? 0 : leave?.with_pay_days || 0;
    const leaveWithoutPayDays = half === 'first' ? 0 : leave?.without_pay_days || 0;
    const attendanceDeductions = toAmount((amounts.absent || 0) + (amounts.late || 0) + (amounts.undertime || 0) + (amounts.half_day || 0));
    const incentives = toAmount((amounts.early_bird || 0) + (amounts.perfect_attendance || 0));
    const earningsParts = earningsFor(info);
    const earnings = toAmount(earningsParts.overtime + earningsParts.holiday);
    const tax = taxDefaultFor(info, {
      basic,
      earnings,
      attendanceDeductions: attendanceDeductions + toAmount(leaveWithoutPayDays * info.unit.daily),
      contributions: sss + philhealth + pagibig,
      incentives: incentives + extras.other,
    });
    const netPay = computeBatchRowNetPay({
      basic_salary: basic,
      sss,
      philhealth,
      pagibig,
      tax,
      leave_without_pay_days: leaveWithoutPayDays,
      daily_rate: info.unit.daily,
      attendance_deductions: attendanceDeductions,
      incentives,
      earnings,
      other_incentives: extras.other,
      first_half_paid: extras.firstHalfPaid,
      carry_in: extras.carryIn,
      cash_advance: cashAdvance,
    });
    const incentiveLabel = [
      counts.early_bird_days ? `${counts.early_bird_days} day${counts.early_bird_days === 1 ? '' : 's'}` : '',
      info.pay?.perfect_attendance && half !== 'first' ? 'Perfect' : '',
      extras.other ? `Incentive/overload${extras.overloadHours ? ` (${extras.overloadHours} h)` : ''}` : '',
    ].filter(Boolean).join(' · ') || '0';
    const lockInput = blocking.length || half === 'first';
    const numberInput = (field, value, width, step) => `<input class="fc" type="number" id="batch-${field}-${id}" value="${value}" data-default="${value}" min="0" step="${step}" inputmode="${step === '1' ? 'numeric' : 'decimal'}" style="width:${width}px;" oninput="recalcBatchRow('${employee.id}','${field}')"${lockInput ? ' disabled' : ''}>`;
    const netNote = (half === 'second'
      ? `<div style="font-size:11px;color:var(--t3);font-weight:400;white-space:normal;" title="Monthly net less what the 1st half paid">less 1st half ${formatMoney(extras.firstHalfPaid)}${extras.carryIn ? ` and carried ${formatMoney(extras.carryIn)}` : ''}</div>`
      : '')
      + (cashAdvance ? `<div style="font-size:11px;color:var(--red);font-weight:400;white-space:normal;" title="Cash advance installment (Cash Advances page)">less cash advance ${formatMoney(cashAdvance)}</div>` : '');

    const mainRow = `
      <tr data-employee-id="${escapeHtml(employee.id)}" data-blocked="${blocking.length ? '1' : '0'}" data-daily-rate="${info.unit.daily}" data-attendance-deductions="${attendanceDeductions}" data-incentives="${incentives}" data-earnings="${earnings}" data-legal="${legal ? '1' : '0'}" data-other-incentives="${extras.other}" data-first-half-paid="${extras.firstHalfPaid}" data-carry-in="${extras.carryIn}" data-cash-advance="${cashAdvance}"${blocking.length ? ' style="opacity:.75;"' : ''}>
        <td class="nm">${escapeHtml(employee.full_name)}</td>
        <td class="mn"><span>${formatMoney(basic)}</span><input type="hidden" id="batch-basic-${id}" value="${basic}">${earnings ? `<div style="font-size:11px;color:var(--green);" title="Approved overtime and holiday pay">+ ${formatMoney(earnings)} OT/holiday</div>` : ''}</td>
        <td class="mn">${numberInput('sss', sss, 75, '0.01')}</td>
        <td class="mn">${numberInput('philhealth', philhealth, 75, '0.01')}</td>
        <td class="mn">${numberInput('pagibig', pagibig, 75, '0.01')}</td>
        <td class="mn">${numberInput('tax', tax, 75, '0.01')}</td>
        <td class="mn">${cell(`${counts.absent_days || 0}`, amounts.absent)}</td>
        <td class="mn">${cell(`${counts.late_days || 0}`, amounts.late)}</td>
        <td class="mn">${cell(counts.undertime_minutes ? `${counts.undertime_minutes} min` : '0', amounts.undertime)}</td>
        <td class="mn">${cell(`${counts.half_days || 0}`, amounts.half_day)}</td>
        <td class="mn">${cell(incentiveLabel, toAmount(incentives + extras.other), '+')}</td>
        <td class="mn"><span id="batch-lwp-display-${id}">${leaveWithPayDays}</span><input type="hidden" id="batch-lwp-${id}" value="${leaveWithPayDays}"></td>
        <td class="mn">${numberInput('lwop', leaveWithoutPayDays, 60, '1')}</td>
        <td class="mn" style="font-family:var(--mono);font-weight:600;"><span id="batch-net-${id}">${formatMoney(netPay)}</span>${netNote}</td>
        <td>${acctPayslipCell(employee)}</td>
      </tr>`;

    // Only this employee waits; the rest of the batch is processed.
    const warningRow = blocking.length ? `
      <tr class="pc-blocked-row">
        <td colspan="15" style="font-size:12px;color:var(--amber);background:var(--amber-s);white-space:normal;">
          ⚠ ${escapeHtml(employee.full_name)} will be skipped — unresolved attendance: ${escapeHtml(describeBlockingDays(blocking))}. HR or the branch Administrator must resolve ${blocking.length === 1 ? 'it' : 'them'} first.
          <a href="#" onclick="openAcctIncompleteQueue();return false;" style="color:var(--amber);font-weight:600;">View in Attendance →</a>
        </td>
      </tr>` : '';

    return mainRow + warningRow;
  }).join('');
  refreshBatchReasonVisibility();
}

async function processBatchPayroll() {
  const feedbackEl = document.getElementById('pc-batch-feedback');
  const submitBtn = document.getElementById('pc-batch-submit-btn');
  const payPeriod = String(document.getElementById('pc-batch-period')?.value || '').trim();

  if (!payPeriod) {
    if (feedbackEl) { feedbackEl.textContent = 'Select a pay period first.'; feedbackEl.className = 'adm-feedback err'; }
    showFieldError('pc-batch-period');
    return;
  }

  if (!acctState.payrollReady) {
    if (feedbackEl) { feedbackEl.textContent = acctState.payrollNotReadyMessage; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const allRows = Array.from(document.querySelectorAll('#pc-batch-table-body tr[data-employee-id]'));
  // Employees with unresolved attendance are left out; everyone else goes.
  const rows = allRows.filter((row) => row.dataset.blocked !== '1');
  const blockedCount = allRows.length - rows.length;
  if (!rows.length) {
    if (feedbackEl) {
      feedbackEl.textContent = blockedCount ? 'Every employee has unresolved attendance for this period.' : 'No employees to process.';
      feedbackEl.className = 'adm-feedback err';
    }
    return;
  }

  const overrideReason = String(document.getElementById('pc-batch-reason')?.value || '').trim();
  const changed = rows.some((row) => batchRowDeviations(row.getAttribute('data-employee-id')).length);
  if (changed && !overrideReason) {
    if (feedbackEl) { feedbackEl.textContent = 'Give a reason for the values changed from the computed defaults (highlighted).'; feedbackEl.className = 'adm-feedback err'; }
    showFieldError('pc-batch-reason', 'Give a reason for the changed values.');
    document.getElementById('pc-batch-reason')?.focus();
    return;
  }

  const confirmed = window.confirmApproveAction
    ? await window.confirmApproveAction(
      `process payroll for ${rows.length} employee${rows.length === 1 ? '' : 's'}`,
      `This will generate a payslip for each employee. Already-paid employees for this period will be skipped.${blockedCount ? ` ${blockedCount} employee${blockedCount === 1 ? '' : 's'} with unresolved attendance will wait.` : ''}`,
    )
    : window.confirm(`Process payroll for ${rows.length} employees?`);
  if (!confirmed) return;

  const entries = rows.map((row) => {
    const employeeId = row.getAttribute('data-employee-id');
    const id = escapeJsAttr(employeeId);
    const get = (field) => toAmount(document.getElementById(`batch-${field}-${id}`)?.value);

    return {
      employee_id: employeeId,
      basic_salary: get('basic'),
      deductions: {
        sss: get('sss'),
        philhealth: get('philhealth'),
        pagibig: get('pagibig'),
        withholding_tax: get('tax'),
        // Absent / Late / Undertime / Half Day / incentives are computed on
        // the server from the attendance logs; they are not sent.
        leave_with_pay_days: get('lwp'),
        leave_without_pay_days: get('lwop'),
      },
    };
  });

  try {
    submitBtn.disabled = true;
    if (feedbackEl) { feedbackEl.textContent = 'Processing payroll for all employees...'; feedbackEl.className = 'adm-feedback'; }

    const response = await fetch('/api/accountant/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'batch_submit', pay_period: payPeriod, entries, override_reason: overrideReason }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Failed to process batch payroll.');

    const processedList = result.processed || [];
    const skippedList = result.skipped || [];
    let message = `Processed ${processedList.length} payslip${processedList.length === 1 ? '' : 's'}.`;
    if (skippedList.length) {
      const reasons = skippedList
        .map((s) => `${s.employee_name || s.employee_id || 'Unknown'}: ${s.reason || 'skipped'}`)
        .join(' · ');
      message += ` ${skippedList.length} skipped — ${reasons}`;
    }

    if (feedbackEl) { feedbackEl.textContent = message; feedbackEl.className = 'adm-feedback ok'; }
    const reasonInput = document.getElementById('pc-batch-reason');
    if (reasonInput) reasonInput.value = '';
    window.pushNotification?.('Batch Payroll Processed', message, skippedList.length && !processedList.length ? 'info' : 'success');

    await loadAccountantData({ period: payPeriod });
    const singlePeriodSelect = document.getElementById('pc-period');
    if (singlePeriodSelect && acctState.periodOptions.includes(payPeriod)) {
      singlePeriodSelect.value = payPeriod;
    }

    // Same handoff as the single-employee "Process Payroll" action: land the
    // accountant on the Payslips tab with a printable payslip already selected
    // instead of leaving them to find it manually.
    if (processedList.length) {
      openPayslipFromRecord(processedList[0].entry_id);
    }
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
  }
}

// A load asked for while another is in flight used to be dropped outright:
// switching the pay period during the initial load left every table on the
// old period while the dropdown showed the new one. Now the latest such
// request is remembered and run as soon as the current load finishes, and its
// callers wait for that follow-up run rather than returning early.
let acctQueuedLoad = null; // { options, promise, resolve }

function loadAccountantData(options = {}) {
  if (acctState.loading) {
    if (acctQueuedLoad) {
      acctQueuedLoad.options = options;
    } else {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      acctQueuedLoad = { options, promise, resolve };
    }
    return acctQueuedLoad.promise;
  }

  return runAccountantLoad(options).finally(() => {
    const queued = acctQueuedLoad;
    if (!queued) return undefined;
    acctQueuedLoad = null;
    return loadAccountantData(queued.options).then(queued.resolve);
  });
}

async function runAccountantLoad(options = {}) {
  acctState.loading = true;

  const recTbody = document.getElementById('ac-records-body');
  if (recTbody) recTbody.innerHTML = skeletonRows(7);
  const attTbody = document.getElementById('ac-attendance-body');
  if (attTbody) attTbody.innerHTML = skeletonRows(5);

  try {
    const params = new URLSearchParams();
    const selectedPeriod = options.period || document.getElementById('pc-period')?.value;

    if (options.period && selectedPeriod) {
      params.set('period', selectedPeriod);
    } else if (!options.period && selectedPeriod && acctState.periodOptions.includes(selectedPeriod)) {
      params.set('period', selectedPeriod);
    }

    if (options.entryId) {
      params.set('entry_id', options.entryId);
    }

    const query = params.toString();
    const response = await fetch(`/api/accountant/payroll${query ? `?${query}` : ''}`, { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load accountant data.');
    }

    acctState.employees = payload.employees || [];
    acctState.records = payload.records || [];
    acctState.draftEntries = payload.draft_entries || [];
    acctState.panels = payload.panels || {};

    if (payload.diag) {
      if (payload.diag.db_error) {
        console.error('[accountant] payroll_entries DB read error:', payload.diag.db_error);
      }
    }
    acctState.attendanceRows = payload.attendance_rows || [];
    acctState.leaveSummary = payload.leave_summary || [];
    acctState.payslipOptions = payload.payslip_options || [];
    acctState.payslip = payload.payslip || null;
    acctState.periodOptions = payload.period_options || [];
    acctState.payrollReady = payload.payroll_ready !== false;
    acctState.payrollNotReadyMessage = payload.payroll_not_ready_message || '';
    acctState.taxTable = Array.isArray(payload.tax_table) ? payload.tax_table : [];
    acctState.generationWindow = payload.generation_window || null;
    acctState.activePeriod = payload.active_period?.label || '';
    acctState.canOverride = payload.can_override === true;
    acctState.semiMonthly = payload.semi_monthly || null;
    renderGenerationWindow();
    renderSemiMonthlyBanner();
    const notReady = document.getElementById('pc-not-ready');
    if (notReady) {
      notReady.style.display = acctState.payrollReady ? 'none' : '';
      notReady.textContent = acctState.payrollReady ? '' : `⚠ ${acctState.payrollNotReadyMessage}`;
    }
    const batchButton = document.getElementById('pc-batch-submit-btn');
    const finalWindow = !acctState.generationWindow || acctState.generationWindow.state === 'final';
    if (batchButton) {
      batchButton.disabled = !acctState.payrollReady || !finalWindow;
      batchButton.title = finalWindow ? '' : (acctState.generationWindow?.message || '');
    }

    renderEmployeeDropdown();
    renderPeriodDropdown();
    renderBatchPeriodDropdown();
    loadBatchPayrollTable();
    renderRecordsPanels(acctState.panels);
    if (acRecordsPaginator) {
      acRecordsPaginator.setData(acctState.records);
    } else {
      renderPayrollRecordsTable();
    }
    if (acAttPaginator) {
      acAttPaginator.setData(acctState.attendanceRows);
    } else {
      renderAttendanceTable();
    }
    renderPayslipOptions();
    renderPayslipDetails();
    renderDashboard();
    renderMonitoringPage();
    renderReportPeriodDropdown();

    if (!acctState.currentEntryId && payload.draft_entries?.length) {
      acctState.currentEntryId = String(payload.draft_entries[0].id || '');
    }

    populateFormFromDraft();
    showProcessFeedback('', false);
  } catch (error) {
    showProcessFeedback(error.message, true);
  } finally {
    acctState.loading = false;
  }
}

async function generatePayslip() {
  const select = document.getElementById('ac-payslip-select');
  const entryId = String(select?.value || '').trim();
  if (!entryId) return;

  await loadAccountantData({ entryId });
}

function printPayslip() {
  printDocument('payslip');
}

function openPayslipFromRecord(entryId) {
  const select = document.getElementById('ac-payslip-select');
  if (select) {
    select.value = String(entryId || '');
  }

  generatePayslip();

  const navItems = Array.from(document.querySelectorAll('#s-accountant .ni'));
  const payslipNav = navItems.find((item) => item.textContent.includes('Payslips'));
  acctNav('ac-payslips', payslipNav || null);
}

async function cancelDraft(entryId) {
  const normalized = String(entryId || '').trim();
  if (!normalized) return;

  if (window.confirmDestructiveAction && !(await window.confirmDestructiveAction(
    'withdraw this payroll draft',
    'The draft will be permanently removed and cannot be recovered.',
  ))) {
    return;
  }

  try {
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel_draft', entry_id: normalized }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Unable to withdraw draft.');
    }

    if (String(acctState.currentEntryId) === normalized) {
      acctState.currentEntryId = '';
    }

    await loadAccountantData();
    showProcessFeedback('Draft withdrawn.', false);
    window.pushNotification?.('Draft Withdrawn', 'The payroll draft has been removed.', 'info');
  } catch (error) {
    showProcessFeedback(error.message, true);
  }
}



/* ── PAYSLIP GENERATION (per employee, inside the generation window) ──
   The server decides the window (src/lib/payroll/generation-window.js):
   from 3 days before the period ends a Draft counting attendance up to
   today; after it ends, up to the pay date, the Final payslip (locked).
   These only mirror it on the buttons. */

const ACCT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-12" -> "Oct 12, 2026". */
function acctDateLabel(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  return y && m && d ? `${ACCT_MONTHS[m - 1]} ${d}, ${y}` : String(key || '');
}

function renderGenerationWindow() {
  const banner = document.getElementById('pc-window-banner');
  const win = acctState.generationWindow;
  if (!banner) return;
  if (!win) {
    banner.style.display = 'none';
    return;
  }
  const tone = win.state === 'final' ? 'green' : win.state === 'draft' ? 'blue' : 'warn';
  const icon = win.state === 'final' || win.state === 'draft' ? 'ℹ' : '⚠';
  banner.style.display = '';
  banner.style.background = `var(--${tone}-s)`;
  banner.style.border = `1px solid var(--${tone})`;
  banner.style.color = `var(--${tone})`;
  banner.innerHTML = `<strong>${escapeHtml(acctState.activePeriod || 'This period')}:</strong> ${icon} ${escapeHtml(win.message)}`
    + ` <span style="opacity:.85;">Window ${escapeHtml(acctDateLabel(win.opens_on))} – ${escapeHtml(acctDateLabel(win.pay_date))}${win.pay_date_scheduled ? ' (pay date from the Pay Calendar)' : ''}.</span>`;
}

/** The Payslip cell of an employee's batch row: state + Generate / Regenerate / View. */
function acctPayslipCell(employee) {
  const win = acctState.generationWindow;
  const row = acctState.attendanceRows.find((r) => r.employee_id === employee.id);
  const state = row?.payslip || null;
  const id = escapeJsAttr(employee.id);
  const small = (text) => `<div style="font-size:11px;color:var(--t3);margin-top:3px;white-space:normal;">${text}</div>`;
  const view = (entryId) => `<button class="btn btn-outline" type="button" style="padding:4px 10px;font-size:12px;" onclick="openPayslipFromRecord('${escapeJsAttr(entryId)}')">View</button>`;

  if (state?.status === 'final') {
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;"><span class="badge bg"><span class="bd"></span>Final</span>${view(state.entry_id)}</div>${small(`${escapeHtml(state.payslip_no || '')} · locked`)}`;
  }

  const canGenerate = Boolean(win?.can_generate);
  const isDraft = state?.status === 'draft';
  const label = isDraft ? 'Regenerate' : 'Generate';
  const finalNext = win?.state === 'final';
  const title = canGenerate
    ? (finalNext ? 'Creates the Final payslip (locked once saved)' : `Draft with attendance up to ${acctDateLabel(win.attendance_through)}`)
    : (win?.message || '');
  const button = `<button class="btn ${finalNext && canGenerate ? 'btn-primary' : 'btn-outline'}" type="button" style="padding:4px 10px;font-size:12px;" title="${escapeHtml(title)}" onclick="generateEmployeePayslip('${id}')"${canGenerate ? '' : ' disabled'}>${finalNext && canGenerate ? 'Generate Final' : label}</button>`;
  const badge = isDraft ? '<span class="badge ba"><span class="bd"></span>Draft</span>' : '';
  const note = isDraft
    ? small(`Up to ${escapeHtml(acctDateLabel(state.attendance_through))}`)
    : (!canGenerate && win?.state === 'not_open' ? small(`Opens ${escapeHtml(acctDateLabel(win.opens_on))}`) : '')
      + (!canGenerate && win?.state === 'closed' ? small('Window closed') : '');
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">${badge}${button}${isDraft ? view(state.entry_id) : ''}</div>${note}`;
}

/** Generate (or regenerate) one employee's payslip for the active period. */
async function generateEmployeePayslip(employeeId, confirmIncomplete = false) {
  const employee = acctState.employees.find((e) => e.id === employeeId);
  const feedbackEl = document.getElementById('pc-batch-feedback');
  const say = (text, isError = false) => {
    if (!feedbackEl) return;
    feedbackEl.textContent = text;
    feedbackEl.className = `adm-feedback${text ? (isError ? ' err' : ' ok') : ''}`;
  };

  try {
    say(`Generating ${employee?.full_name || 'the'} payslip...`);
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'generate',
        employee_id: employeeId,
        pay_period: acctState.activePeriod,
        confirm_incomplete: confirmIncomplete,
      }),
    });
    const data = await response.json().catch(() => ({}));

    // Unresolved Incomplete days: resolve first, or confirm to leave them out.
    if (response.status === 422 && data.code === 'unresolved_attendance') {
      say('');
      const proceed = window.confirmApproveAction
        ? await window.confirmApproveAction(
          'generate this payslip without counting the unresolved days',
          `${data.error} They will be listed on the payslip as not counted.`,
          { title: 'Unresolved Attendance', confirmLabel: 'Generate Anyway' },
        )
        : window.confirm(`${data.error}\n\nGenerate anyway?`);
      if (proceed) await generateEmployeePayslip(employeeId, true);
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Unable to generate the payslip.');

    const final = data.status === 'final';
    say(final
      ? `Final payslip ${data.entry?.payslip_no || ''} generated for ${employee?.full_name || 'the employee'}. It is now locked.`
      : `Draft payslip generated for ${employee?.full_name || 'the employee'} (attendance up to ${acctDateLabel(data.window?.attendance_through)}).`);
    window.pushNotification?.(final ? 'Final Payslip Generated' : 'Draft Payslip Generated', final ? 'The payslip is final and locked.' : 'You can regenerate it until the period ends.', 'success');

    await loadAccountantData({ period: acctState.activePeriod });
    if (data.entry?.id) openPayslipFromRecord(data.entry.id);
  } catch (error) {
    say(error.message, true);
  }
}

/** Payslip page: Draft / Final, branch, attendance summary, deduction basis, who generated it. */
function renderPayslipGeneration(payslip) {
  const statusEl = document.getElementById('ac-pf-status');
  const noteEl = document.getElementById('ac-pf-status-note');
  const attendanceEl = document.getElementById('ac-pf-attendance');
  const basisEl = document.getElementById('ac-pf-basis');
  const generatedEl = document.getElementById('ac-pf-generated');
  const branchEl = document.getElementById('ac-pf-branch');
  const draft = payslip.status === 'draft';
  const generation = payslip.generation || null;

  if (statusEl) {
    statusEl.innerHTML = draft
      ? '<span class="badge ba"><span class="bd"></span>Draft</span>'
      : '<span class="badge bg"><span class="bd"></span>Final</span>';
  }
  if (branchEl) branchEl.textContent = payslip.employee?.branch || '—';

  if (noteEl) {
    const notes = [];
    if (draft && generation?.attendance_through) notes.push(`Includes attendance up to ${acctDateLabel(generation.attendance_through)}.`);
    if (generation?.confirmed_incomplete?.length) {
      notes.push(`Not counted (unresolved when generated): ${generation.confirmed_incomplete.map((item) => `${acctDateLabel(item.log_date)} (${item.status})`).join(', ')}.`);
    }
    if (generation?.override) notes.push(`Overridden by ${generation.override.by_name || 'Super Admin'}: ${generation.override.reason}`);
    noteEl.style.display = notes.length ? '' : 'none';
    noteEl.innerHTML = notes.map((text) => `<div>${escapeHtml(text)}</div>`).join('');
  }

  const summary = payslip.attendance_summary;
  if (attendanceEl) {
    attendanceEl.style.display = summary ? '' : 'none';
    attendanceEl.innerHTML = summary ? `
      <div class="pf-stitle">Attendance Summary</div>
      <div class="pf-att-grid">
        ${[
          ['Days present', summary.days_present],
          ['Days absent', summary.days_absent],
          ['Half days', summary.half_days],
          ['Late minutes', summary.late_minutes],
          ['Undertime minutes', summary.undertime_minutes],
          ['Leave days', summary.leave_days],
        ].map(([label, value]) => `<div class="pf-att-item"><span>${escapeHtml(label)}</span><strong class="mn">${escapeHtml(String(value ?? 0))}</strong></div>`).join('')}
      </div>` : '';
  }

  const basis = Array.isArray(payslip.deduction_basis) ? payslip.deduction_basis : [];
  if (basisEl) {
    basisEl.style.display = basis.length ? '' : 'none';
    basisEl.innerHTML = basis.length
      ? `<div class="pf-stitle">How Deductions Were Computed</div>${basis.map((line) => `<div class="pf-basis-row">${escapeHtml(line.basis)}</div>`).join('')}`
      : '';
  }

  if (generatedEl) {
    generatedEl.textContent = generation?.generated_by_name
      ? `Generated by ${generation.generated_by_name} on ${generation.generated_at_label || formatDateTime(generation.generated_at)}${generation.regenerations ? ` · regenerated ${generation.regenerations} time${generation.regenerations === 1 ? '' : 's'}` : ''}.`
      : '';
  }
}

/** Download the selected payslip as a PDF (built on the server). */
async function downloadPayslipPdf() {
  const entryId = acctState.payslip?.entry_id;
  if (!entryId) return;
  try {
    const response = await fetch(`/api/accountant/payroll?format=pdf&entry_id=${encodeURIComponent(entryId)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to download the payslip.');
    }
    const blob = await response.blob();
    const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = match ? match[1] : 'payslip.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    window.pushNotification?.('Download Failed', error.message, 'error');
  }
}

/* ── SEMI-MONTHLY PAYROLL ──
   The server computes everything (src/lib/payroll/semi-monthly.js); these
   only show it. */

function acctShortDate(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  return y && m && d ? `${ACCT_MONTHS[m - 1]} ${d}` : String(key || '');
}

function renderSemiMonthlyBanner() {
  const banner = document.getElementById('pc-semi-banner');
  const semi = acctState.semiMonthly;
  if (!banner) return;
  banner.style.display = semi ? '' : 'none';
  if (!semi) return;
  banner.innerHTML = semi.half === 'first'
    ? `<strong>1st half:</strong> the full semi-monthly salary (monthly salary ÷ 2) with no deductions. Absences, leave, incentives, contributions and withholding tax for ${escapeHtml(semi.month_label)} are settled on the ${escapeHtml(semi.second_half_label)} payslip.`
    : `<strong>2nd half settles ${escapeHtml(semi.month_label)}:</strong> attendance ${escapeHtml(acctShortDate(semi.window?.start_key))} – ${escapeHtml(acctDateLabel(semi.window?.end_key))}${semi.lock_day ? ` (locked on day ${escapeHtml(String(semi.lock_day))}; later items go to next month)` : ''}, approved leave, incentives and overload, the month's SSS / PhilHealth / Pag-IBIG and withholding tax from the monthly table. Net pay is the month's net less what the 1st half paid.`;
}

/** Payslip page: the month behind a semi-monthly payslip, in place of the per-period breakdown. */
function renderSemiMonthlyPayslip(payslip) {
  const monthlyEl = document.getElementById('ac-pf-monthly');
  const classicEl = document.getElementById('ac-pf-breakdown');
  const netLabel = document.getElementById('ac-pf-net-label');
  const m = payslip?.monthly || null;
  if (!monthlyEl || !classicEl) return;
  monthlyEl.style.display = m ? '' : 'none';
  classicEl.style.display = m ? 'none' : '';
  if (netLabel) netLabel.textContent = m ? (m.half === 'first' ? '1st Half Net Pay' : '2nd Half Net Pay') : 'Net Pay';
  if (!m) return;

  const row = (label, amount, { sign = '', color = '', bold = false, muted = false } = {}) => `
    <div class="pf-row"${bold ? ' style="font-weight:600;color:var(--t1);border-top:1px solid var(--border);margin-top:4px;padding-top:8px;"' : ''}>
      <span${muted ? ' style="color:var(--t3);"' : ''}>${escapeHtml(label)}</span>
      <span class="mn"${color ? ` style="color:var(--${color});"` : ''}>${typeof amount === 'number' ? `${sign}${formatMoney(amount)}` : escapeHtml(amount)}</span>
    </div>`;
  const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

  if (m.half === 'first') {
    monthlyEl.innerHTML = `
      <div>
        <div class="pf-stitle">Earnings — 1st Half</div>
        ${row('Monthly Salary', Number(m.monthly_salary || 0))}
        ${row('Semi-monthly Pay (÷ 2)', Number(m.semi_monthly_pay || 0), { bold: true, color: 'teal' })}
      </div>
      <div>
        <div class="pf-stitle">Deductions</div>
        ${row('None this half', 0)}
        <div class="pf-row" style="color:var(--t3);font-size:12px;white-space:normal;"><span>Absences, leave, incentives, contributions and withholding tax for ${escapeHtml(m.month_label || 'the month')} are settled on the ${escapeHtml(m.second_half_label || '2nd half')} payslip.</span></div>
      </div>`;
    return;
  }

  const attendanceDeductions = [
    ['Late', m.late_deduction], ['Undertime', m.undertime_deduction], ['Half Day', m.half_day_deduction],
  ].filter(([, amount]) => Number(amount) > 0);
  monthlyEl.innerHTML = `
    <div>
      <div class="pf-stitle">Month of ${escapeHtml(m.month_label || '')}</div>
      ${m.window ? row(`Attendance ${acctShortDate(m.window.start_key)} – ${acctShortDate(m.window.end_key)}`, `Daily ${formatMoney(m.daily_rate)}`, { muted: true }) : ''}
      ${row('Monthly Salary', Number(m.monthly_salary || 0))}
      ${row(`Absences without pay (${plural(m.absent_days || 0, 'day')})`, Number(m.absent_deduction || 0), { sign: '- ', color: 'red' })}
      ${row(`Leave Without Pay (${plural(m.leave_without_pay_days || 0, 'day')})`, Number(m.leave_without_pay_deduction || 0), { sign: '- ', color: 'red' })}
      ${attendanceDeductions.map(([label, amount]) => row(label, Number(amount), { sign: '- ', color: 'red' })).join('')}
      ${row(`Leave With Pay (${plural(m.leave_with_pay_days || 0, 'day')})`, 'No deduction')}
      ${row('Incentives', toAmount(Number(m.other_incentive || 0) + Number(m.attendance_incentives || 0)), { sign: '+ ', color: 'green' })}
      ${Number(m.overload_pay) > 0 ? row(`Overload Pay (${m.overload_hours} h)`, Number(m.overload_pay), { sign: '+ ', color: 'green' }) : ''}
      ${Number(m.overtime_pay) > 0 ? row('Overtime', Number(m.overtime_pay), { sign: '+ ', color: 'green' }) : ''}
      ${Number(m.holiday_pay) > 0 ? row('Holiday Pay', Number(m.holiday_pay), { sign: '+ ', color: 'green' }) : ''}
      ${row('Monthly Gross', Number(m.monthly_gross || 0), { bold: true, color: 'teal' })}
    </div>
    <div>
      <div class="pf-stitle">Contributions &amp; Tax</div>
      ${row('SSS', Number(m.sss || 0), { sign: '- ' })}
      ${row('PhilHealth', Number(m.philhealth || 0), { sign: '- ' })}
      ${row('Pag-IBIG', Number(m.pagibig || 0), { sign: '- ' })}
      ${row('Taxable Income', Number(m.taxable_income || 0), { muted: true })}
      ${row('Withholding Tax (monthly)', Number(m.withholding_tax || 0), { sign: '- ' })}
      ${row('Monthly Net', Number(m.monthly_net || 0), { bold: true })}
      ${row(m.first_half_status === 'final' ? 'Paid in 1st Half' : 'Paid in 1st Half (not processed)', Number(m.first_half_paid || 0), { sign: '- ' })}
      ${Number(m.carry_in) > 0 ? row(`Balance carried from ${m.carry_from || 'last month'}`, Number(m.carry_in), { sign: '- ', color: 'red' }) : ''}
      ${Number(m.carry_over_out) > 0 ? row('Carried to next month', Number(m.carry_over_out), { color: 'amber' }) : ''}
    </div>`;
}

/* ── INCENTIVES & OVERLOAD ── */

function acctCurrentMonthKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).format(new Date());
}

function onMonthlyItemKindChange() {
  const overload = document.getElementById('ac-item-kind')?.value === 'overload';
  const amountWrap = document.getElementById('ac-item-amount-wrap');
  const hoursWrap = document.getElementById('ac-item-hours-wrap');
  if (amountWrap) amountWrap.style.display = overload ? 'none' : '';
  if (hoursWrap) hoursWrap.style.display = overload ? '' : 'none';
}

function renderMonthlyItemEmployees() {
  const select = document.getElementById('ac-item-employee');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = acctState.employees.length
    ? acctState.employees.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(`${e.full_name} — ${e.employee_id}`)}</option>`).join('')
    : '<option value="">No employees found</option>';
  if (previous && acctState.employees.some((e) => e.id === previous)) select.value = previous;
}

async function loadMonthlyItems() {
  renderMonthlyItemEmployees();
  const monthInput = document.getElementById('ac-items-month');
  const dateInput = document.getElementById('ac-item-date');
  if (monthInput && !monthInput.value) monthInput.value = acctCurrentMonthKey();
  if (dateInput && !dateInput.value) dateInput.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const tbody = document.getElementById('ac-items-body');
  const lockBanner = document.getElementById('ac-items-lock');
  if (!tbody) return;
  tbody.innerHTML = skeletonRows(8);
  try {
    const response = await fetch(`/api/accountant/payroll?view=monthly_items&month=${encodeURIComponent(monthInput?.value || acctCurrentMonthKey())}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load incentives.');
    if (!data.available) throw new Error(data.error || 'Incentives are not set up yet.');
    if (lockBanner) {
      lockBanner.style.display = '';
      lockBanner.innerHTML = `<strong>${escapeHtml(data.month?.label || '')}:</strong> attendance ${escapeHtml(acctShortDate(data.window?.start_key))} – ${escapeHtml(acctDateLabel(data.window?.end_key))}. ${data.lock_day ? `Locked on day ${escapeHtml(String(data.lock_day))} — anything dated or filed after it is paid next month.` : 'Locked at month end.'}`;
    }
    const items = data.items || [];
    tbody.innerHTML = items.length ? items.map((item) => `
      <tr>
        <td class="nm">${escapeHtml(item.employee_name)}<div style="font-size:11px;color:var(--t3);">${escapeHtml(item.employee_code || '')}</div></td>
        <td class="mn">${escapeHtml(acctDateLabel(item.item_date))}</td>
        <td>${item.kind === 'overload' ? '<span class="badge bt2"><span class="bd"></span>Overload</span>' : '<span class="badge bg"><span class="bd"></span>Incentive</span>'}</td>
        <td style="white-space:normal;">${escapeHtml(item.description)}</td>
        <td class="mn">${item.kind === 'overload' ? `${escapeHtml(String(item.hours))} h` : formatMoney(item.amount)}</td>
        <td>${escapeHtml(item.payroll_month_label)}${item.moved_to_next_month ? '<div style="font-size:11px;color:var(--amber);">After the lock — next month</div>' : ''}</td>
        <td style="font-size:12px;color:var(--t3);">${escapeHtml(item.created_by_name || '')}</td>
        <td><button class="btn btn-outline" type="button" style="padding:4px 10px;font-size:12px;" onclick="archiveMonthlyItem('${escapeJsAttr(item.id)}')">Remove</button></td>
      </tr>`).join('') : '<tr><td colspan="8" style="color:var(--t3);">No incentives or overload for this month.</td></tr>';
  } catch (error) {
    if (lockBanner) lockBanner.style.display = 'none';
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function submitMonthlyItem() {
  const feedback = document.getElementById('ac-item-feedback');
  const button = document.getElementById('ac-item-submit');
  const value = (id) => String(document.getElementById(id)?.value || '').trim();
  const say = (text, kind = '') => { if (feedback) { feedback.textContent = text; feedback.className = `adm-feedback${kind ? ` ${kind}` : ''}`; } };
  const kind = value('ac-item-kind');
  const payload = {
    action: 'add_monthly_item',
    employee_id: value('ac-item-employee'),
    kind,
    item_date: value('ac-item-date'),
    description: value('ac-item-description'),
    amount: kind === 'incentive' ? value('ac-item-amount') : undefined,
    hours: kind === 'overload' ? value('ac-item-hours') : undefined,
  };
  if (!payload.employee_id) { showFieldError('ac-item-employee', 'Select an employee.'); return; }
  if (!payload.item_date) { showFieldError('ac-item-date', 'Choose the date it is for.'); return; }
  if (kind === 'incentive' && !(Number(payload.amount) > 0)) { showFieldError('ac-item-amount', 'Enter an amount greater than 0.'); return; }
  if (kind === 'overload' && !(Number(payload.hours) > 0)) { showFieldError('ac-item-hours', 'Enter the overload hours.'); return; }
  if (!payload.description) { showFieldError('ac-item-description', 'Describe what it is for.'); return; }

  try {
    if (button) button.disabled = true;
    say('Saving...');
    const response = await fetch('/api/accountant/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to add it.');
    say(`Added — counted in the ${data.payroll_month_label} payroll.`, 'ok');
    ['ac-item-amount', 'ac-item-hours', 'ac-item-description'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    window.pushNotification?.('Added to Payroll', `Counted in the ${data.payroll_month_label} 2nd half payroll.`, 'success');
    await loadMonthlyItems();
    loadAccountantData();
  } catch (error) {
    say(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

async function archiveMonthlyItem(itemId) {
  const confirmed = window.confirmDestructiveAction
    ? await window.confirmDestructiveAction('remove this item from payroll', 'It will no longer be paid. The record is kept in the history.')
    : window.confirm('Remove this item from payroll?');
  if (!confirmed) return;
  try {
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive_monthly_item', item_id: itemId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to remove it.');
    window.pushNotification?.('Removed', 'The item was removed from payroll.', 'info');
    await loadMonthlyItems();
    loadAccountantData();
  } catch (error) {
    window.pushNotification?.('Not Removed', error.message, 'error');
  }
}

/* ── CASH ADVANCES (GET ?view=cash_advances) ──
   Deducted in installments from the payslips they apply to until repaid;
   repayments are read from Final payslips (src/lib/payroll/cash-advance.js). */

const acctCash = { data: null, cancelling: '' };

const CASH_DEDUCT_ON_LABELS = { both: 'Every payslip', first: '1–15 only', second: '16–end only' };

/** The next pay periods as { value: first day, label }, for "First Pay Period to Deduct". */
function cashAdvancePeriodOptions() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const [year, month] = today.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const options = [];
  for (let offset = 0; offset < 4; offset += 1) {
    const index = (month - 1) + offset;
    const y = year + Math.floor(index / 12);
    const m = (index % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    // Deducted on the 16-end payslip only, like every deduction.
    options.push({ value: `${y}-${mm}-16`, label: `${names[m - 1]} 16-${last}, ${y}` });
  }
  return options;
}

function renderCashAdvanceForm() {
  const select = document.getElementById('ac-ca-employee');
  if (select) {
    const previous = select.value;
    select.innerHTML = acctState.employees.length
      ? acctState.employees.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(`${e.full_name} — ${e.employee_id}`)}</option>`).join('')
      : '<option value="">No employees found</option>';
    if (previous && acctState.employees.some((e) => e.id === previous)) select.value = previous;
  }
  const start = document.getElementById('ac-ca-start');
  if (start && !start.options.length) {
    start.innerHTML = cashAdvancePeriodOptions().map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join('');
  }
  const granted = document.getElementById('ac-ca-granted');
  if (granted && !granted.value) granted.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

async function loadCashAdvances() {
  renderCashAdvanceForm();
  const tbody = document.getElementById('ac-ca-body');
  if (!tbody) return;
  tbody.innerHTML = skeletonRows(9);
  try {
    const response = await fetch('/api/accountant/payroll?view=cash_advances');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load cash advances.');
    if (!data.available) throw new Error(data.error || 'Cash advances are not set up yet.');
    acctCash.data = data;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('ac-ca-open', String(data.summary?.open_count || 0));
    set('ac-ca-outstanding', formatMoneyCompact(data.summary?.outstanding || 0));
    set('ac-ca-repaid', formatMoneyCompact(data.summary?.repaid || 0));
    renderCashAdvances();
  } catch (error) {
    acctCash.data = null;
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
  }
}

function cashAdvanceStatusBadge(advance) {
  if (advance.status === 'cancelled') return '<span class="badge br"><span class="bd"></span>Cancelled</span>';
  if (advance.fully_paid) return '<span class="badge bg"><span class="bd"></span>Repaid</span>';
  if (advance.status === 'on_hold') return '<span class="badge ba"><span class="bd"></span>On Hold</span>';
  return '<span class="badge bt2"><span class="bd"></span>Active</span>';
}

function renderCashAdvances() {
  const tbody = document.getElementById('ac-ca-body');
  if (!tbody || !acctCash.data) return;
  const filter = document.getElementById('ac-ca-filter')?.value || 'open';
  const rows = (acctCash.data.advances || []).filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'cancelled') return a.status === 'cancelled';
    if (filter === 'repaid') return a.status !== 'cancelled' && a.fully_paid;
    return a.status !== 'cancelled' && !a.fully_paid;
  });
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--t3);">No cash advances here.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((a) => {
    const id = escapeJsAttr(a.id);
    const open = a.status !== 'cancelled' && !a.fully_paid;
    const actions = open
      ? `<div style="display:flex;gap:6px;">
          <button class="btn btn-outline" type="button" style="padding:4px 10px;font-size:12px;" onclick="setCashAdvanceStatus('${id}','${a.status === 'on_hold' ? 'active' : 'on_hold'}')">${a.status === 'on_hold' ? 'Resume' : 'Hold'}</button>
          <button class="btn btn-outline" type="button" style="padding:4px 10px;font-size:12px;" onclick="startCancelCashAdvance('${id}')">Cancel</button>
        </div>`
      : '';
    const payments = (a.payments || []).map((p) => `${escapeHtml(p.pay_period)}: ${formatMoney(p.amount)}`).join('<br>');
    const main = `
      <tr>
        <td class="nm">${escapeHtml(a.employee_name)}<div style="font-size:11px;color:var(--t3);">${escapeHtml(a.employee_code || '')}${a.description ? ` · ${escapeHtml(a.description)}` : ''}</div></td>
        <td class="mn">${escapeHtml(acctDateLabel(a.date_granted))}</td>
        <td class="mn">${formatMoney(a.principal)}</td>
        <td class="mn">${formatMoney(a.installment_amount)}</td>
        <td>${escapeHtml(CASH_DEDUCT_ON_LABELS[a.deduct_on] || a.deduct_on)}<div style="font-size:11px;color:var(--t3);">from ${escapeHtml(acctDateLabel(a.start_date))}</div></td>
        <td class="mn"${payments ? ` title="${escapeHtml(payments.replace(/<br>/g, '\n'))}"` : ''}>${formatMoney(a.repaid)}</td>
        <td class="mn" style="font-weight:600;">${formatMoney(a.balance)}</td>
        <td>${cashAdvanceStatusBadge(a)}${a.status_reason ? `<div style="font-size:11px;color:var(--t3);white-space:normal;">${escapeHtml(a.status_reason)}</div>` : ''}</td>
        <td>${actions}</td>
      </tr>`;
    const cancelRow = acctCash.cancelling === a.id ? `
      <tr>
        <td colspan="9" style="background:var(--red-s);white-space:normal;">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input class="fc" type="text" id="ac-ca-cancel-reason" maxlength="300" placeholder="Reason for cancelling (required)" style="flex:1;min-width:200px;">
            <button class="btn btn-primary" type="button" onclick="confirmCancelCashAdvance('${id}')">Cancel Advance</button>
            <button class="btn btn-outline" type="button" onclick="startCancelCashAdvance('')">Keep</button>
          </div>
        </td>
      </tr>` : '';
    return main + cancelRow;
  }).join('');
}

async function submitCashAdvance() {
  const feedback = document.getElementById('ac-ca-feedback');
  const button = document.getElementById('ac-ca-submit');
  const value = (id) => String(document.getElementById(id)?.value || '').trim();
  const say = (text, kind = '') => { if (feedback) { feedback.textContent = text; feedback.className = `adm-feedback${kind ? ` ${kind}` : ''}`; } };
  const payload = {
    action: 'add_cash_advance',
    employee_id: value('ac-ca-employee'),
    principal: value('ac-ca-principal'),
    installment_amount: value('ac-ca-installment'),
    date_granted: value('ac-ca-granted'),
    deduct_on: value('ac-ca-deduct-on') || 'both',
    start_date: value('ac-ca-start'),
    description: value('ac-ca-description'),
  };
  if (!payload.employee_id) { showFieldError('ac-ca-employee', 'Select an employee.'); return; }
  if (!(Number(payload.principal) > 0)) { showFieldError('ac-ca-principal', 'Enter the amount advanced.'); return; }
  if (!(Number(payload.installment_amount) > 0)) { showFieldError('ac-ca-installment', 'Enter the amount deducted per payslip.'); return; }
  if (Number(payload.installment_amount) > Number(payload.principal)) { showFieldError('ac-ca-installment', 'It cannot be more than the amount advanced.'); return; }
  if (!payload.date_granted) { showFieldError('ac-ca-granted', 'Choose the date it was given.'); return; }

  try {
    if (button) button.disabled = true;
    say('Saving...');
    const response = await fetch('/api/accountant/payroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to add the cash advance.');
    say(`Added — deducted from ${data.start_period} on.`, 'ok');
    ['ac-ca-principal', 'ac-ca-installment', 'ac-ca-description'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    window.pushNotification?.('Cash Advance Added', `Deducted from the ${data.start_period} payslip on.`, 'success');
    await loadCashAdvances();
    loadAccountantData();
  } catch (error) {
    say(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

async function setCashAdvanceStatus(advanceId, status, reason = '') {
  try {
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_cash_advance_status', advance_id: advanceId, status, reason }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to update the cash advance.');
    const words = { active: 'Resumed', on_hold: 'On Hold', cancelled: 'Cancelled' };
    window.pushNotification?.(`Cash Advance ${words[status] || 'Updated'}`, status === 'on_hold' ? 'It is skipped until resumed.' : 'Payroll will use the change on the next payslip computed.', 'info');
    acctCash.cancelling = '';
    await loadCashAdvances();
    loadAccountantData();
  } catch (error) {
    window.pushNotification?.('Not Updated', error.message, 'error');
  }
}

function startCancelCashAdvance(advanceId) {
  acctCash.cancelling = advanceId || '';
  renderCashAdvances();
  document.getElementById('ac-ca-cancel-reason')?.focus();
}

async function confirmCancelCashAdvance(advanceId) {
  const reason = String(document.getElementById('ac-ca-cancel-reason')?.value || '').trim();
  if (reason.length < 5) { showFieldError('ac-ca-cancel-reason', 'Give a reason (at least 5 characters).'); return; }
  const confirmed = window.confirmDestructiveAction
    ? await window.confirmDestructiveAction('cancel this cash advance', 'Nothing more will be deducted. What was already repaid stays on the payslips.')
    : window.confirm('Cancel this cash advance?');
  if (!confirmed) return;
  await setCashAdvanceStatus(advanceId, 'cancelled', reason);
}

/* ── PAYROLL SHEET (School Format) (GET ?view=payroll_sheet) ──
   The school's own payroll sheet: one table per branch, with Days, Reg. Hrs.,
   Rate, Amount, OT, Cash Advance, SSS, Pag-IBIG, totals, a signature column
   and the "Approved for payment" block. */

let _sheetData = null;

function onReportTypeChange() {
  const sheet = document.getElementById('rpt-type')?.value === 'sheet';
  const wrap = document.getElementById('rpt-branch-wrap');
  if (wrap) wrap.style.display = sheet ? '' : 'none';
}

const sheetMoney = (value) => {
  const n = toAmount(value);
  return n ? n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
};
const sheetNumber = (value) => {
  const n = Number(value) || 0;
  return n ? n.toLocaleString('en-PH', { maximumFractionDigits: 2 }) : '-';
};

async function generatePayrollSheet() {
  const period = document.getElementById('rpt-period')?.value || 'all';
  const container = document.getElementById('rpt-sheet');
  const tableCard = document.getElementById('rpt-table-card');
  const summaryBox = document.getElementById('rpt-summary-box');
  if (!container) return;
  if (period === 'all') {
    window.pushNotification?.('Choose a Period', 'The payroll sheet is for one pay period. Choose it under Pay Period.', 'info');
    return;
  }
  container.style.display = '';
  if (tableCard) tableCard.style.display = 'none';
  container.innerHTML = '<div class="card"><div style="color:var(--t3);">Loading payroll sheet...</div></div>';
  try {
    const branch = document.getElementById('rpt-branch')?.value || 'all';
    const response = await fetch(`/api/accountant/payroll?view=payroll_sheet&period=${encodeURIComponent(period)}&branch_id=${encodeURIComponent(branch)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load the payroll sheet.');
    _sheetData = data;
    renderSheetBranchOptions(data.branch_options || []);
    const totals = data.grand_totals || {};
    if (summaryBox) {
      summaryBox.innerHTML = `
        <div class="sr"><span>Payslips</span><span style="font-family:var(--mono);">${(data.branches || []).reduce((n, b) => n + b.rows.length, 0)}${data.draft_count ? ` (${data.draft_count} draft)` : ''}</span></div>
        <div class="sr"><span>Total Amount</span><span style="font-family:var(--mono);color:var(--teal);">${formatMoney(totals.total_amount || 0)}</span></div>
        <div class="sr" style="color:var(--red);"><span>Total Deduction</span><span style="font-family:var(--mono);">- ${formatMoney(totals.total_deduction || 0)}</span></div>
        <div class="sr tot"><span>Total Net Pay</span><span style="font-family:var(--mono);color:var(--amber);">${formatMoney(totals.net_pay || 0)}</span></div>
        ${data.missing?.length ? `<div class="sr" style="color:var(--amber);white-space:normal;"><span>No payslip yet</span><span>${data.missing.length} employee${data.missing.length === 1 ? '' : 's'}</span></div>` : ''}`;
    }
    renderPayrollSheet(data);
  } catch (error) {
    _sheetData = null;
    container.innerHTML = `<div class="card"><div style="color:var(--red);">${escapeHtml(error.message)}</div></div>`;
  }
}

function renderSheetBranchOptions(options) {
  const select = document.getElementById('rpt-branch');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = `<option value="all">All Branches</option>${options.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}`;
  if (previous && [...select.options].some((o) => o.value === previous)) select.value = previous;
}

function renderPayrollSheet(data) {
  const container = document.getElementById('rpt-sheet');
  if (!container) return;
  const header = data.header || {};
  if (!(data.branches || []).length) {
    container.innerHTML = '<div class="card"><div style="color:var(--t3);">No payslips for this period yet. Generate or process payroll first.</div></div>';
    return;
  }
  const head = `<tr>
    <th>Employees</th><th>Days</th><th>Reg. Hrs.</th><th>Rate</th><th>Amount</th><th>OT</th><th>Rate</th><th>Amount</th>
    <th>Other Pay</th><th>Total Amount</th><th>Cash Advance</th><th>SSS</th><th>PhilHealth</th><th>Pag-IBIG</th><th>Tax</th>
    <th>Late / Undertime</th><th>Total Deduction</th><th>Net Pay</th><th>Signature</th></tr>`;
  const line = (r) => `
    <tr>
      <td class="nm">${escapeHtml(r.name)}${r.status === 'draft' ? ' <span class="badge bt2"><span class="bd"></span>Draft</span>' : ''}</td>
      <td class="mn">${sheetNumber(r.days)}</td>
      <td class="mn">${sheetNumber(r.regular_hours)}</td>
      <td class="mn">${sheetMoney(r.rate)}</td>
      <td class="mn">${sheetMoney(r.amount)}</td>
      <td class="mn">${sheetNumber(r.ot_hours)}</td>
      <td class="mn">${sheetMoney(r.ot_rate)}</td>
      <td class="mn">${sheetMoney(r.ot_amount)}</td>
      <td class="mn">${sheetMoney(r.other_pay)}</td>
      <td class="mn">${sheetMoney(r.total_amount)}</td>
      <td class="mn">${sheetMoney(r.cash_advance)}</td>
      <td class="mn">${sheetMoney(r.sss)}</td>
      <td class="mn">${sheetMoney(r.philhealth)}</td>
      <td class="mn">${sheetMoney(r.pagibig)}</td>
      <td class="mn">${sheetMoney(r.withholding_tax)}</td>
      <td class="mn">${sheetMoney(r.late_undertime)}</td>
      <td class="mn">${sheetMoney(r.total_deduction)}</td>
      <td class="mn" style="font-weight:700;">${sheetMoney(r.net_pay)}${r.net_note ? `<div style="font-size:10px;color:var(--t3);font-weight:400;white-space:normal;">${escapeHtml(r.net_note)}</div>` : ''}</td>
      <td style="min-width:110px;"></td>
    </tr>`;
  const totalRow = (t) => `
    <tr class="pay-sheet-total" style="font-weight:700;background:var(--bg3);">
      <td class="nm">TOTAL NET PAY</td><td></td><td></td>
      <td class="mn">${sheetMoney(t.rate)}</td><td class="mn">${sheetMoney(t.amount)}</td>
      <td class="mn">${sheetNumber(t.ot_hours)}</td><td></td><td class="mn">${sheetMoney(t.ot_amount)}</td>
      <td class="mn">${sheetMoney(t.other_pay)}</td><td class="mn">${sheetMoney(t.total_amount)}</td>
      <td class="mn">${sheetMoney(t.cash_advance)}</td><td class="mn">${sheetMoney(t.sss)}</td>
      <td class="mn">${sheetMoney(t.philhealth)}</td><td class="mn">${sheetMoney(t.pagibig)}</td>
      <td class="mn">${sheetMoney(t.withholding_tax)}</td><td class="mn">${sheetMoney(t.late_undertime)}</td>
      <td class="mn">${sheetMoney(t.total_deduction)}</td><td class="mn">${sheetMoney(t.net_pay)}</td><td></td>
    </tr>`;
  const schoolName = header.school_name || 'Shepherd Angels Christian School';
  container.innerHTML = data.branches.map((branch) => `
    <div class="card pay-sheet" style="margin-bottom:14px;">
      <div class="pay-sheet-head" style="text-align:center;margin-bottom:10px;">
        <div style="font-weight:700;text-decoration:underline;color:var(--t1);">${escapeHtml(schoolName)}</div>
        <div style="font-weight:700;text-decoration:underline;color:var(--t1);">PAYROLL — ${escapeHtml(String(branch.branch_name).toUpperCase())}</div>
      </div>
      <p style="font-size:12px;color:var(--t2);margin-bottom:10px;white-space:normal;">
        FOR THE PERIOD OF <strong style="color:var(--red);">${escapeHtml(String(data.period?.label || '').toUpperCase())}</strong>, WE HEREBY ACKNOWLEDGE TO HAVE RECEIVED FROM ${escapeHtml(schoolName)}
        the sum specified opposite our respective names, as full compensation for services rendered.
      </p>
      ${data.attendance_window ? `<p style="font-size:11px;color:var(--t3);margin:-4px 0 10px;white-space:normal;">Days, absences and deductions are from attendance ${escapeHtml(acctDateLabel(data.attendance_window.start_key))} – ${escapeHtml(acctDateLabel(data.attendance_window.end_key))}.</p>` : ''}
      <div class="tw"><table class="pay-sheet-table">
        <thead>${head}</thead>
        <tbody>${branch.rows.map(line).join('')}${totalRow(branch.totals)}</tbody>
      </table></div>
      <div class="pay-sheet-approval" style="margin-top:14px;font-size:12px;color:var(--t1);">
        <div style="font-weight:700;">APPROVED FOR PAYMENT</div>
        <div style="margin-top:22px;font-weight:700;">${escapeHtml(header.approver_name || '______________________________')}</div>
        <div>${escapeHtml(header.approver_title || '')}</div>
      </div>
    </div>`).join('');
}

function exportPayrollSheetCSV() {
  if (!_sheetData?.branches?.length) {
    window.pushNotification?.('No Data', 'Generate the payroll sheet first before exporting.', 'info');
    return;
  }
  const headers = ['Branch', 'Employee', 'Status', 'Days', 'Reg. Hrs.', 'Rate', 'Amount', 'OT Hours', 'OT Rate', 'OT Amount', 'Other Pay',
    'Total Amount', 'Cash Advance', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Tax', 'Late/Undertime', 'Total Deduction', 'Net Pay', 'Signature'];
  const fields = ['days', 'regular_hours', 'rate', 'amount', 'ot_hours', 'ot_rate', 'ot_amount', 'other_pay', 'total_amount', 'cash_advance',
    'sss', 'philhealth', 'pagibig', 'withholding_tax', 'late_undertime', 'total_deduction', 'net_pay'];
  const rows = [];
  _sheetData.branches.forEach((branch) => {
    branch.rows.forEach((r) => rows.push([branch.branch_name, r.name, r.status, ...fields.map((f) => String(Number(r[f]) || 0)), '']));
    rows.push([branch.branch_name, 'TOTAL NET PAY', '', '', '', ...['rate', 'amount', 'ot_hours'].map((f) => String(Number(branch.totals[f]) || 0)), '',
      ...['ot_amount', 'other_pay', 'total_amount', 'cash_advance', 'sss', 'philhealth', 'pagibig', 'withholding_tax', 'late_undertime', 'total_deduction', 'net_pay']
        .map((f) => String(Number(branch.totals[f]) || 0)), '']);
  });
  const csvText = (v) => {
    const s = String(v);
    return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  };
  const csv = [headers, ...rows].map((row) => row.map((v) => `"${csvText(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payroll-sheet-${String(_sheetData.period?.label || 'period').replace(/[^\w-]+/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── 13TH MONTH PAY ── */

const acct13th = { data: null };

async function loadThirteenthMonth() {
  const yearSelect = document.getElementById('ac-13th-year');
  const thisYear = Number(acctCurrentMonthKey().slice(0, 4));
  if (yearSelect && !yearSelect.options.length) {
    const years = [];
    for (let year = thisYear; year >= Math.min(2026, thisYear); year -= 1) years.push(year);
    yearSelect.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
  }
  const year = Number(yearSelect?.value || thisYear);
  const tbody = document.getElementById('ac-13th-body');
  const banner = document.getElementById('ac-13th-banner');
  const button = document.getElementById('ac-13th-submit');
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  if (!tbody) return;
  tbody.innerHTML = skeletonRows(5);
  try {
    const response = await fetch(`/api/accountant/payroll?view=thirteenth_month&year=${year}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load the 13th month pay.');
    acct13th.data = data;
    const rows = data.rows || [];
    const processedCount = rows.filter((row) => row.processed).length;
    set('ac-13th-count', String(rows.length));
    set('ac-13th-year-label', `Year ${data.year}`);
    set('ac-13th-total', formatMoneyCompact(data.total_amount || 0));
    set('ac-13th-processed', `${processedCount} / ${rows.length}`);
    if (banner) {
      banner.style.display = '';
      banner.innerHTML = data.can_process
        ? `<strong>${data.year}:</strong> processing is open. Each payout is recorded once and locked.`
        : `<strong>${data.year}:</strong> figures so far. The 13th month pay is processed in December, from ${escapeHtml(acctDateLabel(data.process_opens))}.`;
    }
    if (button) {
      button.disabled = !data.can_process || processedCount === rows.length;
      button.title = data.can_process ? '' : `Opens ${acctDateLabel(data.process_opens)}`;
    }
    tbody.innerHTML = rows.length ? rows.map((row) => {
      const amount = row.processed ? Number(row.processed.amount) : row.amount;
      const status = row.processed
        ? `<span class="badge bg"><span class="bd"></span>Processed</span><div style="font-size:11px;color:var(--t3);margin-top:3px;">${escapeHtml(formatDateTime(row.processed.processed_at))}${row.processed.processed_by_name ? ` · ${escapeHtml(row.processed.processed_by_name)}` : ''}</div>`
        : '<span class="badge ba"><span class="bd"></span>Not processed</span>';
      return `
        <tr>
          <td class="nm">${escapeHtml(row.employee_name)}<div style="font-size:11px;color:var(--t3);">${escapeHtml(row.employee_code || '')} · ${escapeHtml(row.employee_type || '')}</div></td>
          <td class="mn">${(row.periods || []).length}</td>
          <td class="mn">${formatMoney(row.processed ? row.processed.basic_earned : row.total_basic_earned)}</td>
          <td class="mn" style="font-weight:600;">${formatMoney(amount)}</td>
          <td>${status}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="5" style="color:var(--t3);">No employees found.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function processThirteenthMonth() {
  const data = acct13th.data;
  const feedback = document.getElementById('ac-13th-feedback');
  const button = document.getElementById('ac-13th-submit');
  if (!data?.can_process) return;
  const pending = (data.rows || []).filter((row) => !row.processed && row.amount > 0);
  if (!pending.length) return;
  const confirmed = window.confirmApproveAction
    ? await window.confirmApproveAction(
      `process the ${data.year} 13th month pay for ${pending.length} employee${pending.length === 1 ? '' : 's'}`,
      'Each payout is recorded once and cannot be processed again.',
    )
    : window.confirm(`Process the ${data.year} 13th month pay?`);
  if (!confirmed) return;
  try {
    if (button) button.disabled = true;
    if (feedback) { feedback.textContent = 'Processing...'; feedback.className = 'adm-feedback'; }
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'process_13th_month', year: data.year }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Unable to process the 13th month pay.');
    const message = `Processed ${result.processed.length} payout${result.processed.length === 1 ? '' : 's'}.${result.skipped.length ? ` ${result.skipped.length} skipped.` : ''}`;
    if (feedback) { feedback.textContent = message; feedback.className = 'adm-feedback ok'; }
    window.pushNotification?.('13th Month Pay Processed', message, 'success');
    await loadThirteenthMonth();
  } catch (error) {
    if (feedback) { feedback.textContent = error.message; feedback.className = 'adm-feedback err'; }
    if (button) button.disabled = false;
  }
}

/* ── PROFILE ── */
function loadAccountantProfile() {
  const ctx = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  if (!ctx) return;

  const initials = (String(ctx.full_name || '').trim()
    .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('') || 'AC').toUpperCase();

  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };

  setTxt('ac-ep-avatar',    initials);
  setTxt('ac-ep-name',      ctx.full_name    || 'Accountant');
  setTxt('ac-ep-pos',       ctx.position     || ctx.employee_type || '');
  setTxt('ac-ep-role-tag',  ctx.role         || 'Accountant');
  setTxt('ac-ep-info-name',    ctx.full_name);
  setTxt('ac-ep-info-id',     ctx.employee_id);
  setTxt('ac-ep-info-pos',    ctx.position);
  setTxt('ac-ep-info-type',   ctx.employee_type);
  setTxt('ac-ep-info-email',  ctx.email);
  setTxt('ac-ep-bank-name',   ctx.bank_name);
  setTxt('ac-ep-bank-account',ctx.bank_account_number);
  if (typeof renderOwnContactAndGovIds === 'function') renderOwnContactAndGovIds('ac-ep', ctx);
  if (typeof loadOwnEmergencyContact === 'function') loadOwnEmergencyContact('ac-ep-ec');
}

/* ── INIT ── */
function initAccountant() {
  applyAccountantIdentity();

  attachSidebarSpotlight(document.querySelector('#s-accountant .sidebar'));

  // Every payroll computation box accepts numbers only — money fields digits
  // and one decimal point, day counts whole numbers (inputmode on each input).
  // Delegated, so the batch table's rows rendered later are covered as well.
  window.enforceNumericInputs(document.getElementById('s-accountant'));

  acRecordsPaginator = window.createPaginator({ id: 'ac-rec', pageSize: 15, renderFn: renderPayrollRecordsTable });
  acAttPaginator = window.createPaginator({ id: 'ac-att', pageSize: 15, renderFn: renderAttendanceTable });
  monPaginator = window.createPaginator({ id: 'mon', pageSize: 15, renderFn: renderMonitoringTable });

  window.monFilter = monFilter;
  window.setMonSearch = setMonSearch;
  window.generateReport = generateReport;
  window.exportReportCSV = exportReportCSV;
  window.printReport = printReport;

  const savedPage = window.getPersistedRolePageState
    ? window.getPersistedRolePageState('accountant')
    : '';
  const initialPage = ACCT_PAGES[savedPage] ? savedPage : 'ac-dashboard';
  const initialNav = getAccountantNavByPageId(initialPage);
  acctNav(initialPage, initialNav);

  // Basic salary only triggers recalc — SSS/PhilHealth/Pag-IBIG are
  // editable (actual contribution tables vary per employee/employer and
  // aren't a flat 2%), so a basic-salary edit must not clobber whatever the
  // accountant already typed into those fields. The 2% figure is only ever
  // suggested as a starting point when a new employee is selected — see
  // autoFillDeductions() in syncFormForEmployee().
  const basicEl = document.getElementById('pc-basic');
  if (basicEl) {
    basicEl.addEventListener('input', () => {
      clampSalaryInput(basicEl);
      recalc();
    });
  }
  // Manual deduction inputs only trigger recalc
  // Leave Without Pay is editable too (₱550/day) — it was missing here, so
  // changing it left the Net Pay summary showing the old figure.
  ['pc-sss', 'pc-philhealth', 'pc-pagibig', 'pc-absences', 'pc-late', 'pc-undertime', 'pc-half-days', 'pc-early-bird', 'pc-leave-without-pay-days'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalc);
  });
  // A typed withholding tax stays as typed; until then it follows the figures.
  document.getElementById('pc-tax')?.addEventListener('input', () => {
    acctState.taxEdited = true;
    recalc();
  });
  document.getElementById('pc-perfect')?.addEventListener('change', recalc);

  const employeeSelect = document.getElementById('pc-employee');
  const periodSelect = document.getElementById('pc-period');
  const batchPeriodSelect = document.getElementById('pc-batch-period');
  const payslipSelect = document.getElementById('ac-payslip-select');

  if (employeeSelect) {
    employeeSelect.addEventListener('change', () => {
      acctState.currentEntryId = '';
      syncFormForEmployee();
    });
  }

  // The single-entry and batch sections share one "current period" concept —
  // changing either selector keeps the other in sync and reloads Payroll
  // Records/Monitoring/Payslips for that period, so nothing looks empty just
  // because a different period is selected elsewhere on the page.
  if (periodSelect) {
    periodSelect.addEventListener('change', () => {
      if (batchPeriodSelect && acctState.periodOptions.includes(periodSelect.value)) {
        batchPeriodSelect.value = periodSelect.value;
      }
      loadAccountantData({ period: periodSelect.value });
    });
  }

  if (batchPeriodSelect) {
    batchPeriodSelect.addEventListener('change', () => {
      if (periodSelect && acctState.periodOptions.includes(batchPeriodSelect.value)) {
        periodSelect.value = batchPeriodSelect.value;
      }
      loadAccountantData({ period: batchPeriodSelect.value });
    });
  }

  if (payslipSelect) {
    payslipSelect.addEventListener('change', generatePayslip);
  }

  const initBasic = toAmount(document.getElementById('pc-basic')?.value);
  autoFillDeductions(initBasic);
  recalc();
  loadAccountantData();
}

/* ── CHANGE PASSWORD ── */
function submitAccountantChangePassword() {
  return submitAccountPasswordChange('ac', {
    current: 'ac-cur-password',
    next: 'ac-new-password',
    confirm: 'ac-confirm-password',
  });
}

window.acctNav = acctNav;
window.processPayroll = processPayroll;
window.savePayrollDraft = savePayrollDraft;
window.editDraftFromPending = editDraftFromPending;
window.editDraftEntry = editDraftEntry;
window.generatePayslip = generatePayslip;
window.printPayslip = printPayslip;
window.openPayslipFromRecord = openPayslipFromRecord;
window.cancelDraft = cancelDraft;
window.recalcBatchRow = recalcBatchRow;
window.openAcctIncompleteQueue = openAcctIncompleteQueue;
window.submitAccountantChangePassword = submitAccountantChangePassword;
window.loadAccountantData = loadAccountantData;
window.loadAccountantProfile = loadAccountantProfile;

function maybeInitAccountant() {
  const currentRole = new URLSearchParams(window.location.search).get('role');
  if (String(currentRole || '').toLowerCase() !== 'accountant') {
    return;
  }
  initAccountant();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', maybeInitAccountant);
} else {
  maybeInitAccountant();
}

window.addEventListener('sacs-auth-context-changed', handleLegacyAuthContextChange);
window.generateEmployeePayslip = generateEmployeePayslip;
window.onMonthlyItemKindChange = onMonthlyItemKindChange;
window.loadMonthlyItems = loadMonthlyItems;
window.submitMonthlyItem = submitMonthlyItem;
window.archiveMonthlyItem = archiveMonthlyItem;
window.loadThirteenthMonth = loadThirteenthMonth;
window.processThirteenthMonth = processThirteenthMonth;
window.loadCashAdvances = loadCashAdvances;
window.renderCashAdvances = renderCashAdvances;
window.submitCashAdvance = submitCashAdvance;
window.setCashAdvanceStatus = setCashAdvanceStatus;
window.startCancelCashAdvance = startCancelCashAdvance;
window.confirmCancelCashAdvance = confirmCancelCashAdvance;
window.onReportTypeChange = onReportTypeChange;
window.downloadPayslipPdf = downloadPayslipPdf;
