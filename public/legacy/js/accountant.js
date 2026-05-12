/* ═══════════════════════════════════════
   accountant.js — Accountant role logic
   Handles: page nav, payroll computation,
   draft submission to admin
   Edit this file for accountant features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const ACCT_PAGES = {
  'ac-process':          'Process Payroll',
  'ac-records':          'Payroll Records',
  'ac-payslips':         'Payslips',
  'ac-attendance':       'View Attendance',
  'ac-pending':          'Pending Submissions',
  'ac-leaves':           'Leave Approvals',
  'ac-approval-status':  'Approval Status',
};

const acctState = {
  loading: false,
  employees: [],
  records: [],
  draftEntries: [],
  pendingSubmissions: [],
  attendanceRows: [],
  payslipOptions: [],
  payslip: null,
  periodOptions: [],
  currentEntryId: '',
};

let acRecordsPaginator = null;
let acAttPaginator = null;
let acPendingLeavesPaginator = null;
let acLeaveHistPaginator = null;
let acSalaryStatusPaginator = null;
let acLeaveStatusPaginator = null;
let _salaryApprovalsAll = [];
let _leaveForwardsAll = [];
let _salaryStatusFilter = 'all';
let _leaveStatusFilter = 'all';
let _salarySearch = '';
let _leaveSearch = '';

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

  // Auto-loaders per page
  if (pageId === 'ac-leaves') {
    loadAccountantLeaveRequests();
    loadAccountantLeaveHistory();
  }
  if (pageId === 'ac-approval-status') {
    loadApprovalStatus();
  }
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
  setVal('pc-cashadvance', pct2);
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
  const cashAdv = get('pc-cashadvance');

  // 1 absent = ₱550, 3 late = 1 absent = ₱550
  const absenceDeduct = toAmount((absenceDays + Math.floor(lateDays / 3)) * 550);
  const grossPay = basic; // No allowances; Gross Pay = Basic Salary
  const totalDeductions = toAmount(sss + philhealth + pagibig + tax + absenceDeduct + cashAdv);
  const netPay = toAmount(grossPay - totalDeductions);

  const updates = {
    'sum-basic': formatMoney(basic),
    'sum-gross': formatMoney(grossPay),
    'sum-sss': `- ${formatMoney(sss)}`,
    'sum-philhealth': `- ${formatMoney(philhealth)}`,
    'sum-pagibig': `- ${formatMoney(pagibig)}`,
    'sum-tax': `- ${formatMoney(tax)}`,
    'sum-absences': `- ${formatMoney(absenceDeduct)}`,
    'sum-cashadvance': `- ${formatMoney(cashAdv)}`,
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
      cash_advance: get('pc-cashadvance'),
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
    reason: 'Payroll processed by accountant and submitted for admin approval.',
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
  return result;
}

/* ── SUBMIT FOR APPROVAL ── */
async function submitForApproval() {
  try {
    setActionButtonsDisabled(true);
    showProcessFeedback('Sending payroll for admin approval...', false, false);

    await upsertPayrollEntry('submit');
    showProcessFeedback('Approval has been sent and is now under admin review.', false, true);
    window.pushNotification?.('Payroll Submitted', 'Payroll has been sent to the admin for review and approval.', 'success');

    const banner = document.getElementById('ac-pending-banner');
    if (banner) {
      banner.style.display = 'flex';
      banner.innerHTML = '<strong>Approval sent:</strong> Payroll is now in the admin approval process. Changes stay locked until a decision is made.';
    }

    const pendingNavEl = document.querySelector('#s-accountant .ni:last-of-type');
    acctNav('ac-pending', pendingNavEl);
  } catch (error) {
    if (error.status === 409) {
      showProcessFeedback('', false);
      window.pushNotification?.('Already Submitted', 'This payroll entry has already been submitted and is awaiting admin approval.', 'info');
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

function renderPendingBadge(count) {
  const badge = document.getElementById('ac-pending-count');
  if (!badge) return;

  badge.textContent = String(count);
  badge.style.display = count > 0 ? '' : 'none';
}

function renderPendingSubmissions() {
  const container = document.getElementById('ac-pending-list');
  const lockNote = document.getElementById('ac-pending-locked');
  if (!container) return;

  const drafts = Array.isArray(acctState.draftEntries) ? acctState.draftEntries : [];
  const pending = Array.isArray(acctState.pendingSubmissions) ? acctState.pendingSubmissions : [];
  const combined = [...drafts, ...pending];

  if (!combined.length) {
    container.innerHTML = `
      <div class="pending-item">
        <div class="pending-icon">✓</div>
        <div class="pending-info">
          <div class="pi-meta">No pending submissions at the moment.</div>
        </div>
      </div>
    `;

    if (lockNote) {
      lockNote.textContent = 'You can submit payroll drafts once ready for administrator review.';
    }
    renderPendingBadge(0);
    return;
  }

  container.innerHTML = combined.map((entry) => {
    const employee = acctState.employees.find((row) => row.id === entry.employee_id);
    const currentSalary = Number(employee?.basic_salary || 0);
    const proposedSalary = Number(entry.payroll?.basic_salary || 0);
    const isDraft = String(entry.status || '').toLowerCase() === 'draft';
    const safeId = escapeHtml(entry.id);

    const icon = isDraft ? '✎' : '⏳';
    const badgeClass = isDraft ? 'ba' : 'ba';
    const badgeLabel = isDraft ? 'Draft' : 'Pending Approval';
    const metaText = isDraft
      ? `Saved ${escapeHtml(formatDateTime(entry.updated_at || entry.created_at))} · Not yet submitted`
      : `Submitted ${escapeHtml(formatDateTime(entry.submitted_at))} · Awaiting admin action`;
    const actionButton = isDraft
      ? `<button class="btn btn-outline" style="font-size:11px;padding:7px 14px;" onclick="editDraftFromPending('${safeId}')">Edit Draft</button>`
      : `<button class="btn btn-red" style="font-size:11px;padding:7px 14px;" onclick="withdrawSubmission('${safeId}')">Withdraw</button>`;

    return `
      <div class="pending-item">
        <div class="pending-icon">${icon}</div>
        <div class="pending-info">
          <div class="pi-name">${escapeHtml(entry.employee_name)}</div>
          <div class="pi-meta">${metaText}</div>
          <div class="pi-change">
            <span style="font-family:var(--mono);font-size:13px;color:var(--t2);">${formatMoneyCompact(currentSalary)}</span>
            <span style="color:var(--t3);">→</span>
            <span class="approval-change">${formatMoneyCompact(proposedSalary)}</span>
            <span class="badge ${badgeClass}" style="margin-left:4px;">${badgeLabel}</span>
          </div>
        </div>
        ${actionButton}
      </div>
    `;
  }).join('');

  if (lockNote) {
    lockNote.textContent = pending.length
      ? 'Submitted entries are locked until Administrator approves or rejects. Drafts can still be edited.'
      : 'Drafts are not yet visible to the Administrator. Submit them from Process Payroll when ready.';
  }
  renderPendingBadge(combined.length);
}

function editDraftFromPending(entryId) {
  const id = String(entryId || '').trim();
  if (!id) return;

  const processNav = document.querySelector('#s-accountant .ni[onclick*="ac-process"]');
  acctNav('ac-process', processNav);

  acctState.currentEntryId = id;
  loadAccountantData({ entryId: id });
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
  assign('ac-pf-cashadvance', formatMoney(payslip.deductions?.cash_advance || 0));
  assign('ac-pf-total-deductions', formatMoney(payslip.deductions?.total_deductions || 0));
  assign('ac-pf-net', formatMoney(payslip.net_pay || 0));
}

function populateFormFromDraft() {
  const employeeSelect = document.getElementById('pc-employee');
  const periodSelect = document.getElementById('pc-period');
  if (!employeeSelect || !periodSelect) return;

  const draft = acctState.records.find((row) => String(row.id) === String(acctState.currentEntryId))
    || acctState.pendingSubmissions.find((row) => String(row.id) === String(acctState.currentEntryId))
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
  setValue('pc-cashadvance', deductions.cash_advance);

  recalc();
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
    acctState.pendingSubmissions = payload.pending_submissions || [];
    acctState.attendanceRows = payload.attendance_rows || [];
    acctState.payslipOptions = payload.payslip_options || [];
    acctState.payslip = payload.payslip || null;
    acctState.periodOptions = payload.period_options || [];

    renderEmployeeDropdown();
    renderPeriodDropdown();
    renderRecordsPanels(payload.panels || {});
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
    renderPendingSubmissions();
    renderPayslipOptions();
    renderPayslipDetails();

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

async function withdrawSubmission(entryId) {
  const normalized = String(entryId || '').trim();
  if (!normalized) return;

  if (window.confirmDestructiveAction && !(await window.confirmDestructiveAction(
    'withdraw this pending payroll submission',
    'This removes the current approval request and returns the payroll entry to draft mode.',
  ))) {
    return;
  }

  try {
    const response = await fetch('/api/accountant/payroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'withdraw', entry_id: normalized }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Unable to withdraw pending submission.');
    }

    acctState.currentEntryId = normalized;
    await loadAccountantData();
    showProcessFeedback('Pending submission withdrawn and moved back to draft.', false);
    window.pushNotification?.('Submission Withdrawn', 'Payroll has been pulled back and returned to draft mode.', 'info');
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
        <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;margin-bottom:4px;width:100px;display:block;margin-left:auto;" onclick="processAccountantLeave('${safeId}', 'approve')">Approve</button>
        <button class="btn btn-outline" style="font-size:11px;padding:5px 10px;color:var(--red);border-color:var(--red);width:100px;display:block;margin-left:auto;" onclick="processAccountantLeave('${safeId}', 'reject')">Reject</button>
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

/* ── APPROVAL STATUS ── */
function renderSalaryStatusTable(rows) {
  const tbody = document.getElementById('ac-salary-status-tbody');
  const empty = document.getElementById('ac-salary-status-empty');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = rows.map((row) => {
    const status = String(row.status || 'pending').toLowerCase();
    const badgeClass = status === 'approved' ? 'bg' : status === 'rejected' ? 'br' : 'ba';
    const badgeLabel = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending';
    const decidedAt = row.decided_at ? formatDateTime(row.decided_at) : '—';
    return `<tr>
      <td class="nm">${escapeHtml(row.employee_name || 'Unknown')}</td>
      <td class="mn">${formatMoney(Number(row.current_salary || 0))}</td>
      <td class="mn">${formatMoney(Number(row.proposed_salary || 0))}</td>
      <td class="mn">${escapeHtml(formatDateTime(row.submitted_at))}</td>
      <td><span class="badge ${badgeClass}"><span class="bd"></span>${badgeLabel}</span></td>
      <td class="mn">${escapeHtml(decidedAt)}</td>
    </tr>`;
  }).join('');
}

function renderLeaveStatusTable(rows) {
  const tbody = document.getElementById('ac-leave-status-tbody');
  const empty = document.getElementById('ac-leave-status-empty');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = rows.map((row) => {
    const status = String(row.status || '').toLowerCase();
    let badgeClass = 'ba', badgeLabel = 'Pending Admin';
    if (status === 'approved') { badgeClass = 'bg'; badgeLabel = 'Approved'; }
    else if (status === 'rejected') { badgeClass = 'br'; badgeLabel = 'Rejected'; }
    const dateRange = `${escapeHtml(row.start_date || '?')} → ${escapeHtml(row.end_date || '?')}`;
    return `<tr>
      <td class="nm">${escapeHtml(row.employee_name || 'Unknown')}</td>
      <td>${escapeHtml(row.leave_type || '—')}</td>
      <td class="mn">${dateRange}</td>
      <td class="mn">${escapeHtml(formatDateTime(row.submitted_at))}</td>
      <td><span class="badge ${badgeClass}"><span class="bd"></span>${badgeLabel}</span></td>
    </tr>`;
  }).join('');
}

function getFilteredSalaryApprovals() {
  const search = _salarySearch.toLowerCase();
  let rows = _salaryStatusFilter === 'all'
    ? _salaryApprovalsAll
    : _salaryApprovalsAll.filter((r) => r.status === _salaryStatusFilter);
  if (search) rows = rows.filter((r) => String(r.employee_name || '').toLowerCase().includes(search));
  return rows;
}

function getFilteredLeaveForwards() {
  const search = _leaveSearch.toLowerCase();
  const dbStatus = _leaveStatusFilter === 'pending' ? 'pending_admin' : _leaveStatusFilter;
  let rows = _leaveStatusFilter === 'all'
    ? _leaveForwardsAll
    : _leaveForwardsAll.filter((r) => r.status === dbStatus);
  if (search) rows = rows.filter((r) =>
    [r.employee_name, r.leave_type].map((v) => String(v || '').toLowerCase()).join(' ').includes(search)
  );
  return rows;
}

function acSalaryFilter(filter, btn) {
  _salaryStatusFilter = filter;
  document.querySelectorAll('#ac-salary-tabs .st-tab').forEach((b) => b.classList.remove('st-active'));
  if (btn) btn.classList.add('st-active');
  acSalaryStatusPaginator?.setData(getFilteredSalaryApprovals());
}

function acLeaveFilter(filter, btn) {
  _leaveStatusFilter = filter;
  document.querySelectorAll('#ac-leave-tabs .st-tab').forEach((b) => b.classList.remove('st-active'));
  if (btn) btn.classList.add('st-active');
  acLeaveStatusPaginator?.setData(getFilteredLeaveForwards());
}

function setAcSalarySearch(value) {
  _salarySearch = String(value || '').trim();
  acSalaryStatusPaginator?.setData(getFilteredSalaryApprovals());
}

function setAcLeaveSearch(value) {
  _leaveSearch = String(value || '').trim();
  acLeaveStatusPaginator?.setData(getFilteredLeaveForwards());
}

function renderApprovalStatus(salaryApprovals, leaveForwards) {
  _salaryApprovalsAll = salaryApprovals;
  _leaveForwardsAll = leaveForwards;
  _salaryStatusFilter = 'all';
  _leaveStatusFilter = 'all';
  _salarySearch = '';
  _leaveSearch = '';

  // Reset tabs to "All" on fresh load
  document.querySelectorAll('#ac-salary-tabs .st-tab').forEach((b, i) => b.classList.toggle('st-active', i === 0));
  document.querySelectorAll('#ac-leave-tabs .st-tab').forEach((b, i) => b.classList.toggle('st-active', i === 0));

  const salarySearchEl = document.getElementById('ac-salary-search');
  if (salarySearchEl) salarySearchEl.value = '';
  const leaveSearchEl = document.getElementById('ac-leave-search');
  if (leaveSearchEl) leaveSearchEl.value = '';

  acSalaryStatusPaginator?.setData(salaryApprovals);
  acLeaveStatusPaginator?.setData(leaveForwards);

  // Update sidebar badge — count items still pending
  const pendingCount = salaryApprovals.filter((r) => r.status === 'pending').length
    + leaveForwards.filter((r) => r.status === 'pending_admin').length;
  const badge = document.getElementById('ac-approval-pending-badge');
  if (badge) {
    badge.textContent = String(pendingCount);
    badge.style.display = pendingCount > 0 ? '' : 'none';
  }
}

async function loadApprovalStatus() {
  const salaryBody = document.getElementById('ac-salary-status-tbody');
  const leaveBody = document.getElementById('ac-leave-status-tbody');
  if (salaryBody) salaryBody.innerHTML = skeletonRows(6);
  if (leaveBody) leaveBody.innerHTML = skeletonRows(5);

  try {
    const res = await fetch('/api/accountant/approval-status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load approval status.');
    renderApprovalStatus(data.salary_approvals || [], data.leave_forwards || []);
  } catch (err) {
    if (salaryBody) salaryBody.innerHTML = `<tr><td colspan="6" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
    if (leaveBody) leaveBody.innerHTML = `<tr><td colspan="5" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
  }
}

/* ── INIT ── */
function initAccountant() {
  applyAccountantIdentity();

  attachSidebarSpotlight(document.querySelector('#s-accountant .sidebar'));

  acRecordsPaginator = window.createPaginator({ id: 'ac-rec', pageSize: 15, renderFn: renderPayrollRecordsTable });
  acAttPaginator = window.createPaginator({ id: 'ac-att', pageSize: 15, renderFn: renderAttendanceTable });
  acPendingLeavesPaginator = window.createPaginator({ id: 'ac-leave-pend', pageSize: 15, renderFn: renderAccountantPendingLeaves });
  acLeaveHistPaginator = window.createPaginator({ id: 'ac-leave-hist', pageSize: 15, renderFn: renderAccountantLeaveHistory });
  acSalaryStatusPaginator = window.createPaginator({ id: 'ac-salary-status', pageSize: 15, renderFn: renderSalaryStatusTable });
  acLeaveStatusPaginator = window.createPaginator({ id: 'ac-leave-status', pageSize: 15, renderFn: renderLeaveStatusTable });

  window.acSalaryFilter = acSalaryFilter;
  window.acLeaveFilter = acLeaveFilter;
  window.setAcSalarySearch = setAcSalarySearch;
  window.setAcLeaveSearch = setAcLeaveSearch;

  // Load approval status badge silently on init
  loadApprovalStatus();

  const savedPage = window.getPersistedRolePageState
    ? window.getPersistedRolePageState('accountant')
    : '';
  const initialPage = ACCT_PAGES[savedPage] ? savedPage : 'ac-process';
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
  const payslipSelect = document.getElementById('ac-payslip-select');

  if (employeeSelect) {
    employeeSelect.addEventListener('change', () => {
      acctState.currentEntryId = '';
      syncFormForEmployee();
    });
  }

  if (periodSelect) {
    periodSelect.addEventListener('change', () => {
      loadAccountantData({ period: periodSelect.value });
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
window.submitForApproval = submitForApproval;
window.savePayrollDraft = savePayrollDraft;
window.editDraftFromPending = editDraftFromPending;
window.generatePayslip = generatePayslip;
window.printPayslip = printPayslip;
window.openPayslipFromRecord = openPayslipFromRecord;
window.withdrawSubmission = withdrawSubmission;
window.loadAccountantLeaveRequests = loadAccountantLeaveRequests;
window.loadAccountantLeaveHistory = loadAccountantLeaveHistory;
window.submitAccountantChangePassword = submitAccountantChangePassword;

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

window.addEventListener('bncs-auth-context-changed', handleLegacyAuthContextChange);
