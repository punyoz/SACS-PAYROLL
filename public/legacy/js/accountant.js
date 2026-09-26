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

function describeBlockingDays(blocking) {
  return (blocking || []).map((b) => `${b.log_date} (${b.status})`).join(', ');
}

function autoFillDeductions(basic) {
  // Contribution defaults are the % in force for the selected employee and
  // period (Super Admin → Payroll Rates), not a fixed 2%.
  const { rates } = employeePayInfo(getSelectedEmployee()?.id);
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('pc-sss', toAmount(basic * rates.sss_pct / 100));
  setVal('pc-philhealth', toAmount(basic * rates.philhealth_pct / 100));
  setVal('pc-pagibig', toAmount(basic * rates.pagibig_pct / 100));
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
  const { rates, unit, pay } = employeePayInfo(employeeId);
  const setTxt = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const peso = (v) => formatMoney(v).replace('₱ ', '₱');
  setTxt('pc-sss-hint', `(default ${rates.sss_pct}% of Basic, editable)`);
  setTxt('pc-philhealth-hint', `(default ${rates.philhealth_pct}% of Basic, editable)`);
  setTxt('pc-pagibig-hint', `(default ${rates.pagibig_pct}% of Basic, editable)`);
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
  if (submitButton) submitButton.disabled = Boolean(blocking.length) || !acctState.payrollReady;
}

/** Manual changes from the computed defaults, for the override reason. */
function getFormDeviations() {
  const employee = getSelectedEmployee();
  if (!employee) return [];
  const { pay, rates } = employeePayInfo(employee.id);
  const counts = pay?.counts || {};
  const leave = (acctState.leaveSummary || []).find((row) => row.employee_id === employee.id);
  const get = (id) => toAmount(document.getElementById(id)?.value);
  const basic = get('pc-basic');
  const checks = [
    ['Basic Salary', toAmount(Number(employee.basic_salary || 0) / 2), basic],
    ['SSS', toAmount(basic * rates.sss_pct / 100), get('pc-sss')],
    ['PhilHealth', toAmount(basic * rates.philhealth_pct / 100), get('pc-philhealth')],
    ['Pag-IBIG', toAmount(basic * rates.pagibig_pct / 100), get('pc-pagibig')],
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
}

function recalc() {
  const get = (id) => toAmount(document.getElementById(id)?.value);
  const basic = get('pc-basic');
  const sss = get('pc-sss');
  const philhealth = get('pc-philhealth');
  const pagibig = get('pc-pagibig');
  const tax = get('pc-tax');
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
  const grossPay = basic; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(
    sss + philhealth + pagibig + tax
    + amounts.absent + amounts.late + amounts.undertime + amounts.half_day
    + leaveWithoutPayDeduct,
  );
  // Net Pay = Gross - deductions + incentives, floored at zero like the server.
  const netPay = Math.max(0, toAmount(grossPay - totalDeductions + incentives));

  const updates = {
    'sum-basic': formatMoney(basic),
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
    'sum-incentives': `+ ${formatMoney(incentives)}`,
    'sum-net': formatMoney(netPay),
  };
  renderOverrideState();

  Object.entries(updates).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
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
    throw new Error('Select an employee first.');
  }

  const payPeriod = String(document.getElementById('pc-period')?.value || '').trim();
  if (!payPeriod) {
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
    // Payroll runs twice a month (1-15 and 16-end), each covering half the
    // employee's monthly rate, so the two runs together add up to one month's pay.
    basicInput.value = toAmount(Number(employee.basic_salary || 0) / 2);
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
        <td><button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openPayslipFromRecord('${escapeHtml(record.id)}')" ${payslipDisabled}>Payslip</button></td>
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
    const safeId = escapeHtml(record.id);

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
  const csv = [headers, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
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
  assign('ac-pf-total-deductions', formatMoney(payslip.deductions?.total_deductions || 0));
  assign('ac-pf-net', formatMoney(payslip.net_pay || 0));
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
  setValue('pc-absences', deductions.absences_days);
  setValue('pc-late', deductions.late_days ?? 0);
  setValue('pc-undertime', deductions.undertime_minutes ?? 0);
  setValue('pc-half-days', deductions.half_days ?? 0);
  setValue('pc-leave-with-pay-days', deductions.leave_with_pay_days ?? 0);
  setValue('pc-leave-without-pay-days', deductions.leave_without_pay_days ?? 0);
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
    + row.attendance_deductions + leaveWithoutPayDeduct,
  );
  return Math.max(0, toAmount(row.basic_salary - totalDeductions + row.incentives));
}

/** The editable batch cells that differ from their computed defaults. */
function batchRowDeviations(employeeId) {
  const safeId = escapeJsAttr(employeeId);
  return ['sss', 'philhealth', 'pagibig', 'lwop'].filter((field) => {
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

function recalcBatchRow(employeeId) {
  const safeId = escapeJsAttr(employeeId);
  const get = (field) => toAmount(document.getElementById(`batch-${field}-${safeId}`)?.value);
  const tr = document.querySelector(`#pc-batch-table-body tr[data-employee-id="${CSS.escape(String(employeeId))}"]`);

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
  };

  const netPay = computeBatchRowNetPay(row);
  const netEl = document.getElementById(`batch-net-${safeId}`);
  if (netEl) netEl.textContent = formatMoney(netPay);

  ['sss', 'philhealth', 'pagibig', 'lwop'].forEach((field) => {
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
    tbody.innerHTML = '<tr><td colspan="14" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  // Two lines per cell: the quantity and what it costs (or earns).
  const cell = (quantity, amount, sign = '-') => {
    const color = sign === '+' ? 'var(--green)' : 'var(--red)';
    return `<span>${escapeHtml(quantity)}</span>${amount ? `<div style="font-size:11px;color:${color};">${sign} ${formatMoney(amount)}</div>` : ''}`;
  };

  tbody.innerHTML = acctState.employees.map((employee) => {
    const id = escapeJsAttr(employee.id);
    // Payroll runs twice a month (1-15 and 16-end), each covering half the
    // employee's monthly rate, so the two runs together add up to one month's pay.
    const basic = toAmount(Number(employee.basic_salary || 0) / 2);
    const info = employeePayInfo(employee.id);
    const counts = info.pay?.counts || {};
    const amounts = info.pay?.amounts || {};
    const blocking = info.pay?.blocking || [];
    const sss = toAmount(basic * info.rates.sss_pct / 100);
    const philhealth = toAmount(basic * info.rates.philhealth_pct / 100);
    const pagibig = toAmount(basic * info.rates.pagibig_pct / 100);
    const leave = acctState.leaveSummary.find((row) => row.employee_id === employee.id);
    const leaveWithPayDays = leave?.with_pay_days || 0;
    const leaveWithoutPayDays = leave?.without_pay_days || 0;
    const attendanceDeductions = toAmount((amounts.absent || 0) + (amounts.late || 0) + (amounts.undertime || 0) + (amounts.half_day || 0));
    const incentives = toAmount((amounts.early_bird || 0) + (amounts.perfect_attendance || 0));
    const netPay = computeBatchRowNetPay({
      basic_salary: basic,
      sss,
      philhealth,
      pagibig,
      tax: 0,
      leave_without_pay_days: leaveWithoutPayDays,
      daily_rate: info.unit.daily,
      attendance_deductions: attendanceDeductions,
      incentives,
    });
    const incentiveLabel = [
      counts.early_bird_days ? `${counts.early_bird_days} day${counts.early_bird_days === 1 ? '' : 's'}` : '',
      info.pay?.perfect_attendance ? 'Perfect' : '',
    ].filter(Boolean).join(' · ') || '0';
    const numberInput = (field, value, width, step) => `<input class="fc" type="number" id="batch-${field}-${id}" value="${value}" data-default="${value}" min="0" step="${step}" inputmode="${step === '1' ? 'numeric' : 'decimal'}" style="width:${width}px;" oninput="recalcBatchRow('${employee.id}')"${blocking.length ? ' disabled' : ''}>`;

    const mainRow = `
      <tr data-employee-id="${escapeHtml(employee.id)}" data-blocked="${blocking.length ? '1' : '0'}" data-daily-rate="${info.unit.daily}" data-attendance-deductions="${attendanceDeductions}" data-incentives="${incentives}"${blocking.length ? ' style="opacity:.75;"' : ''}>
        <td class="nm">${escapeHtml(employee.full_name)}</td>
        <td class="mn"><span>${formatMoney(basic)}</span><input type="hidden" id="batch-basic-${id}" value="${basic}"></td>
        <td class="mn">${numberInput('sss', sss, 75, '0.01')}</td>
        <td class="mn">${numberInput('philhealth', philhealth, 75, '0.01')}</td>
        <td class="mn">${numberInput('pagibig', pagibig, 75, '0.01')}</td>
        <td class="mn">${numberInput('tax', 0, 75, '0.01')}</td>
        <td class="mn">${cell(`${counts.absent_days || 0}`, amounts.absent)}</td>
        <td class="mn">${cell(`${counts.late_days || 0}`, amounts.late)}</td>
        <td class="mn">${cell(counts.undertime_minutes ? `${counts.undertime_minutes} min` : '0', amounts.undertime)}</td>
        <td class="mn">${cell(`${counts.half_days || 0}`, amounts.half_day)}</td>
        <td class="mn">${cell(incentiveLabel, incentives, '+')}</td>
        <td class="mn"><span id="batch-lwp-display-${id}">${leaveWithPayDays}</span><input type="hidden" id="batch-lwp-${id}" value="${leaveWithPayDays}"></td>
        <td class="mn">${numberInput('lwop', leaveWithoutPayDays, 60, '1')}</td>
        <td class="mn" style="font-family:var(--mono);font-weight:600;" id="batch-net-${id}">${formatMoney(netPay)}</td>
      </tr>`;

    // Only this employee waits; the rest of the batch is processed.
    const warningRow = blocking.length ? `
      <tr class="pc-blocked-row">
        <td colspan="14" style="font-size:12px;color:var(--amber);background:var(--amber-s);white-space:normal;">
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
      console.log('[accountant] payroll diag:', payload.diag, 'draft_entries:', (payload.draft_entries || []).length, 'records:', (payload.records || []).length);
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
    const notReady = document.getElementById('pc-not-ready');
    if (notReady) {
      notReady.style.display = acctState.payrollReady ? 'none' : '';
      notReady.textContent = acctState.payrollReady ? '' : `⚠ ${acctState.payrollNotReadyMessage}`;
    }
    const batchButton = document.getElementById('pc-batch-submit-btn');
    if (batchButton) batchButton.disabled = !acctState.payrollReady;

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
  ['pc-sss', 'pc-philhealth', 'pc-pagibig', 'pc-tax', 'pc-absences', 'pc-late', 'pc-undertime', 'pc-half-days', 'pc-early-bird', 'pc-leave-without-pay-days'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalc);
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
