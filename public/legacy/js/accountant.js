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

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
}

function getAccountantNavByPageId(pageId) {
  const navItems = Array.from(document.querySelectorAll('#s-accountant .ni'));
  return navItems.find((item) => String(item.getAttribute('onclick') || '').includes(`'${pageId}'`)) || null;
}

/* ── PAYROLL COMPUTATION ── */
function autoFillDeductions(basic) {
  const pct2 = toAmount(basic * 0.02);
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('pc-sss', pct2);
  setVal('pc-philhealth', pct2);
  setVal('pc-pagibig', pct2);
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
  const absenceDays = get('pc-absences');
  const lateDays = get('pc-late');
  const leaveWithPayDays = get('pc-leave-with-pay-days');
  const leaveWithoutPayDays = get('pc-leave-without-pay-days');

  // 1 absent = ₱550, 3 late = 1 absent = ₱550
  const absenceDeduct = toAmount((absenceDays + Math.floor(lateDays / 3)) * 550);
  // Leave Without Pay deducts at the same ₱550/day rate as an absence.
  const leaveWithoutPayDeduct = toAmount(leaveWithoutPayDays * 550);
  const grossPay = basic; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(sss + philhealth + pagibig + tax + absenceDeduct + leaveWithoutPayDeduct);
  const netPay = toAmount(grossPay - totalDeductions);

  const updates = {
    'sum-basic': formatMoney(basic),
    'sum-gross': formatMoney(grossPay),
    'sum-sss': `- ${formatMoney(sss)}`,
    'sum-philhealth': `- ${formatMoney(philhealth)}`,
    'sum-pagibig': `- ${formatMoney(pagibig)}`,
    'sum-tax': `- ${formatMoney(tax)}`,
    'sum-absences': `- ${formatMoney(absenceDeduct)}`,
    'sum-leave-with-pay': `${leaveWithPayDays} day${leaveWithPayDays === 1 ? '' : 's'}`,
    'sum-leave-without-pay': `- ${formatMoney(leaveWithoutPayDeduct)}`,
    'sum-net': formatMoney(netPay),
  };

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
      leave_with_pay_days: get('pc-leave-with-pay-days'),
      leave_without_pay_days: get('pc-leave-without-pay-days'),
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
    basicInput.value = Number(employee.basic_salary || 0);
    autoFillDeductions(toAmount(basicInput.value));
    autoFillLeaveDays(employee.id);
  }

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
  window.print();
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
  setValue('pc-leave-with-pay-days', deductions.leave_with_pay_days ?? 0);
  setValue('pc-leave-without-pay-days', deductions.leave_without_pay_days ?? 0);

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

function computeBatchRowNetPay(row) {
  const absenceDeduct = toAmount((row.absences_days + Math.floor(row.late_days / 3)) * 550);
  const leaveWithoutPayDeduct = toAmount(row.leave_without_pay_days * 550);
  const totalDeductions = toAmount(row.sss + row.philhealth + row.pagibig + row.tax + absenceDeduct + leaveWithoutPayDeduct);
  return toAmount(row.basic_salary - totalDeductions);
}

function recalcBatchRow(employeeId) {
  const safeId = escapeJsAttr(employeeId);
  const get = (field) => toAmount(document.getElementById(`batch-${field}-${safeId}`)?.value);

  const row = {
    basic_salary: get('basic'),
    sss: get('sss'),
    philhealth: get('philhealth'),
    pagibig: get('pagibig'),
    tax: get('tax'),
    absences_days: get('absent'),
    late_days: get('late'),
    leave_without_pay_days: get('lwop'),
  };

  const netPay = computeBatchRowNetPay(row);
  const netEl = document.getElementById(`batch-net-${safeId}`);
  if (netEl) netEl.textContent = formatMoney(netPay);
}

function escapeJsAttr(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function loadBatchPayrollTable() {
  const tbody = document.getElementById('pc-batch-table-body');
  if (!tbody) return;

  if (!acctState.employees.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  tbody.innerHTML = acctState.employees.map((employee) => {
    const id = escapeJsAttr(employee.id);
    const basic = toAmount(employee.basic_salary);
    const pct2 = toAmount(basic * 0.02);
    const attendance = acctState.attendanceRows.find((row) => row.employee_id === employee.id);
    const leave = acctState.leaveSummary.find((row) => row.employee_id === employee.id);
    const absentDays = attendance?.absent_days || 0;
    const lateDays = attendance?.late_days || 0;
    const leaveWithPayDays = leave?.with_pay_days || 0;
    const leaveWithoutPayDays = leave?.without_pay_days || 0;
    const netPay = computeBatchRowNetPay({
      basic_salary: basic,
      sss: pct2,
      philhealth: pct2,
      pagibig: pct2,
      tax: 0,
      absences_days: absentDays,
      late_days: lateDays,
      leave_without_pay_days: leaveWithoutPayDays,
    });

    return `
      <tr data-employee-id="${escapeHtml(employee.id)}">
        <td class="nm">${escapeHtml(employee.full_name)}</td>
        <td class="mn"><span>${formatMoney(basic)}</span><input type="hidden" id="batch-basic-${id}" value="${basic}"></td>
        <td class="mn"><span id="batch-sss-display-${id}">${formatMoney(pct2)}</span><input type="hidden" id="batch-sss-${id}" value="${pct2}"></td>
        <td class="mn"><span id="batch-philhealth-display-${id}">${formatMoney(pct2)}</span><input type="hidden" id="batch-philhealth-${id}" value="${pct2}"></td>
        <td class="mn"><span id="batch-pagibig-display-${id}">${formatMoney(pct2)}</span><input type="hidden" id="batch-pagibig-${id}" value="${pct2}"></td>
        <td class="mn"><input class="fc" type="number" id="batch-tax-${id}" value="0" min="0" style="width:75px;" oninput="recalcBatchRow('${employee.id}')"></td>
        <td class="mn"><input class="fc" type="number" id="batch-absent-${id}" value="${absentDays}" min="0" style="width:60px;" oninput="recalcBatchRow('${employee.id}')"></td>
        <td class="mn"><input class="fc" type="number" id="batch-late-${id}" value="${lateDays}" min="0" style="width:60px;" oninput="recalcBatchRow('${employee.id}')"></td>
        <td class="mn"><span id="batch-lwp-display-${id}">${leaveWithPayDays}</span><input type="hidden" id="batch-lwp-${id}" value="${leaveWithPayDays}"></td>
        <td class="mn"><input class="fc" type="number" id="batch-lwop-${id}" value="${leaveWithoutPayDays}" min="0" style="width:60px;" oninput="recalcBatchRow('${employee.id}')"></td>
        <td class="mn" style="font-family:var(--mono);font-weight:600;" id="batch-net-${id}">${formatMoney(netPay)}</td>
      </tr>
    `;
  }).join('');
}

async function processBatchPayroll() {
  const feedbackEl = document.getElementById('pc-batch-feedback');
  const submitBtn = document.getElementById('pc-batch-submit-btn');
  const payPeriod = String(document.getElementById('pc-batch-period')?.value || '').trim();

  if (!payPeriod) {
    if (feedbackEl) { feedbackEl.textContent = 'Select a pay period first.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const rows = Array.from(document.querySelectorAll('#pc-batch-table-body tr[data-employee-id]'));
  if (!rows.length) {
    if (feedbackEl) { feedbackEl.textContent = 'No employees to process.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const confirmed = window.confirmApproveAction
    ? await window.confirmApproveAction(`process payroll for all ${rows.length} employees`, 'This will generate a payslip for each employee. Already-paid employees for this period will be skipped.')
    : window.confirm(`Process payroll for all ${rows.length} employees?`);
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
        absences_days: get('absent'),
        late_days: get('late'),
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
      body: JSON.stringify({ action: 'batch_submit', pay_period: payPeriod, entries }),
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
    window.pushNotification?.('Batch Payroll Processed', message, skippedList.length && !processedList.length ? 'info' : 'success');

    await loadAccountantData({ period: payPeriod });
    const singlePeriodSelect = document.getElementById('pc-period');
    if (singlePeriodSelect && acctState.periodOptions.includes(payPeriod)) {
      singlePeriodSelect.value = payPeriod;
    }
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
  }
}

async function loadAccountantData(options = {}) {
  if (acctState.loading) return;
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
  window.print();
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


/* ── LEAVE APPROVALS ── */
function renderAccountantPendingLeaves(requests) {
  const tbody = document.getElementById('al-pending-tbody');
  const emptyMsg = document.getElementById('al-pending-empty');
  if (!tbody || !emptyMsg) return;

  if (!requests.length) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';
  tbody.innerHTML = requests.map(req => {
    const safeId = escapeHtml(req.id);
    const proofCell = req.proof_url
      ? `<button class="btn btn-outline" style="font-size:11px;padding:4px 8px;" onclick="openProofDocument(window._acctProofUrls['${safeId}'])">View Proof</button>`
      : `<span style="color:var(--t3);font-size:12px;">No proof</span>`;

    return `
    <tr>
      <td>
        <div style="font-weight:500;">${escapeHtml(req.employee_name)}</div>
        <div style="font-size:12px;color:var(--t3);">${escapeHtml(req.position)}</div>
      </td>
      <td><span class="badge bt2">${escapeHtml(req.leave_type)}</span></td>
      <td style="font-size:13px;">
        <div>${formatDateOnly(req.start_date)}</div>
        <div style="color:var(--t3);">to ${formatDateOnly(req.end_date)}</div>
      </td>
      <td style="font-size:13px;max-width:200px;" class="truncate" title="${escapeHtml(req.reason)}">
        ${escapeHtml(req.reason)}
      </td>
      <td>${proofCell}</td>
      <td style="text-align:right;">
        ${req.employee_archived
          ? `<span class="badge br" style="display:inline-block;white-space:nowrap;">Employee Archived</span>`
          : `<button class="btn btn-primary" style="font-size:11px;padding:5px 10px;margin-bottom:4px;width:100px;display:block;margin-left:auto;" onclick="processAccountantLeave('${safeId}', 'approve')">✓ Approve</button>
             <button class="btn btn-outline" style="font-size:11px;padding:5px 10px;color:var(--red);border-color:var(--red);width:100px;display:block;margin-left:auto;" onclick="processAccountantLeave('${safeId}', 'reject')">✕ Reject</button>`
        }
      </td>
    </tr>
    `;
  }).join('');
}

function renderAccountantLeaveHistory(requests) {
  const tbody = document.getElementById('al-history-tbody');
  const emptyMsg = document.getElementById('al-history-empty');
  if (!tbody || !emptyMsg) return;

  if (!requests.length) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';
  tbody.innerHTML = requests.map(req => {
    let badge = '<span class="badge ba">Pending Admin</span>';
    if (req.status === 'approved') badge = '<span class="badge bg">Approved</span>';
    if (req.status === 'rejected') badge = '<span class="badge br">Rejected</span>';

    return `
    <tr>
      <td>
        <div style="font-weight:500;">${escapeHtml(req.employee_name)}</div>
        <div style="font-size:12px;color:var(--t3);">${escapeHtml(req.position)}</div>
      </td>
      <td><span class="badge bt2">${escapeHtml(req.leave_type)}</span></td>
      <td style="font-size:13px;">
        ${formatDateOnly(req.start_date)} - ${formatDateOnly(req.end_date)}
      </td>
      <td>${badge}</td>
    </tr>
    `;
  }).join('');
}

async function loadAccountantLeaveRequests() {
  const tbody = document.getElementById('al-pending-tbody');
  const emptyMsg = document.getElementById('al-pending-empty');
  const errorMsg = document.getElementById('al-pending-error');
  if (!tbody || !emptyMsg || !errorMsg) return;

  try {
    errorMsg.textContent = '';
    tbody.innerHTML = skeletonRows(6);

    const res = await fetch('/api/accountant/leave-requests?status=pending_accountant');
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load leave requests');

    const requests = data.requests || [];

    // Store ALL proof URLs before paginating so page navigation can still reference them.
    if (!window._acctProofUrls) window._acctProofUrls = {};
    requests.forEach((req) => {
      window._acctProofUrls[req.id] = req.proof_url || '';
    });

    updateLeavesBadge(requests.length);

    if (acPendingLeavesPaginator) {
      acPendingLeavesPaginator.setData(requests);
    } else {
      renderAccountantPendingLeaves(requests);
    }
  } catch (err) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'none';
    errorMsg.textContent = err.message;
  }
}

function updateLeavesBadge(count) {
  const badge = document.getElementById('ac-leaves-badge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.style.display = count > 0 ? '' : 'none';
}

async function refreshLeavesBadge() {
  try {
    const res = await fetch('/api/accountant/leave-requests?status=pending_accountant');
    const data = await res.json();
    if (res.ok) updateLeavesBadge((data.requests || []).length);
  } catch {
    // silent — badge just won't update
  }
}

async function loadAccountantLeaveHistory() {
  const tbody = document.getElementById('al-history-tbody');
  const emptyMsg = document.getElementById('al-history-empty');
  const errorMsg = document.getElementById('al-history-error');
  if (!tbody || !emptyMsg || !errorMsg) return;

  try {
    errorMsg.textContent = '';
    tbody.innerHTML = skeletonRows(4);

    const res = await fetch('/api/accountant/leave-requests?status=history');
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load history');

    const requests = Array.isArray(data.requests) ? data.requests : (data.history_requests || []);
    requests.sort((a, b) => new Date(b.decided_at || b.updated_at) - new Date(a.decided_at || a.updated_at));

    if (acLeaveHistPaginator) {
      acLeaveHistPaginator.setData(requests);
    } else {
      renderAccountantLeaveHistory(requests);
    }
  } catch (err) {
    tbody.innerHTML = '';
    emptyMsg.style.display = 'none';
    errorMsg.textContent = err.message;
  }
}

function formatDateOnly(isoString) {
  if (!isoString) return 'N/A';
  const d = new Date(isoString);
  if (isNaN(d)) return isoString;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

window.processAccountantLeave = async function(id, action) {
  if (action === 'reject') {
    if (window.confirmDestructiveAction && !(await window.confirmDestructiveAction(
      'reject this leave request', 
      'This will permanently decline the leave request and notify the employee.'
    ))) {
      return;
    }
  } else if (action === 'approve') {
    if (window.confirmApproveAction && !(await window.confirmApproveAction(
      'forward this leave request to the admin for final approval',
      'The administrator will be notified to review this request.'
    ))) {
      return;
    }
  }

  try {
    const errorMsg = document.getElementById('al-pending-error');
    if (errorMsg) {
      errorMsg.textContent = '';
      errorMsg.style.color = '';
    }

    const res = await fetch('/api/accountant/leave-requests', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to process request');
    
    // Refresh both tables
    loadAccountantLeaveRequests();
    loadAccountantLeaveHistory();

    window.pushNotification?.(
      action === 'approve' ? 'Leave Forwarded to Admin' : 'Leave Request Rejected',
      action === 'approve' ? 'The leave request has been forwarded to the admin for final approval.' : 'The leave request has been declined.',
      action === 'approve' ? 'success' : 'info'
    );

    // Attempt to show a temporary success message
    if (errorMsg) {
      errorMsg.textContent = `Leave request successfully ${action === 'approve' ? 'forwarded' : 'rejected'}.`;
      errorMsg.style.color = "var(--teal)";
      setTimeout(() => { 
        if (errorMsg.textContent.includes('successfully')) {
          errorMsg.textContent = ''; 
          errorMsg.style.color = ""; 
        }
      }, 3000);
    }
  } catch (err) {
    const errorMsg = document.getElementById('al-pending-error');
    if (errorMsg) {
      errorMsg.textContent = err.message;
      errorMsg.style.color = "var(--red)";
    } else {
      alert('Error: ' + err.message);
    }
  }
};


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
  setTxt('ac-ep-info-role',   ctx.role);
  setTxt('ac-ep-bank-name',   ctx.bank_name);
  setTxt('ac-ep-bank-account',ctx.bank_account_number);
}

/* ── INIT ── */
function initAccountant() {
  applyAccountantIdentity();

  attachSidebarSpotlight(document.querySelector('#s-accountant .sidebar'));

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

  // Basic salary triggers auto-fill of 2% deductions then recalc
  const basicEl = document.getElementById('pc-basic');
  if (basicEl) {
    basicEl.addEventListener('input', () => {
      clampSalaryInput(basicEl);
      autoFillDeductions(toAmount(basicEl.value));
      recalc();
    });
  }
  // Manual deduction inputs only trigger recalc
  ['pc-tax', 'pc-absences', 'pc-late'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalc);
  });

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
function showAcctChangePasswordFeedback(message, isError = false) {
  const el = document.getElementById('ac-change-password-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

async function submitAccountantChangePassword() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const email = String(context?.email || '').trim();

  const currentPassword = String(document.getElementById('ac-cur-password')?.value || '').trim();
  const newPassword = String(document.getElementById('ac-new-password')?.value || '').trim();
  const confirmPassword = String(document.getElementById('ac-confirm-password')?.value || '').trim();

  if (!email) {
    showAcctChangePasswordFeedback('Unable to identify account. Please sign in again.', true);
    return;
  }

  if (!currentPassword || !newPassword || !confirmPassword) {
    showAcctChangePasswordFeedback('All password fields are required.', true);
    return;
  }

  if (newPassword !== confirmPassword) {
    showAcctChangePasswordFeedback('New passwords do not match.', true);
    return;
  }

  if (newPassword.length < 8) {
    showAcctChangePasswordFeedback('New password must be at least 8 characters.', true);
    return;
  }

  try {
    showAcctChangePasswordFeedback('Updating password...', false);

    const response = await fetch('/api/legacy-auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, current_password: currentPassword, new_password: newPassword }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'Failed to update password.');
    }

    document.getElementById('ac-cur-password').value = '';
    document.getElementById('ac-new-password').value = '';
    document.getElementById('ac-confirm-password').value = '';

    showAcctChangePasswordFeedback('Password updated successfully.', false);
    window.pushNotification?.('Password Changed', 'Your account password has been updated successfully.', 'success');
    setTimeout(() => window.closeSettingsModal?.('ac'), 1200);
  } catch (error) {
    showAcctChangePasswordFeedback(error.message, true);
  }
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
window.loadAccountantLeaveRequests = loadAccountantLeaveRequests;
window.loadAccountantLeaveHistory = loadAccountantLeaveHistory;
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
