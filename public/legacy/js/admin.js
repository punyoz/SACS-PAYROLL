/* ═══════════════════════════════════════
   admin.js — Administrator role logic
   Handles: page navigation, approvals
   Edit this file for admin-specific features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const ADMIN_PAGES = {
  'adm-dashboard':    'Dashboard',
  'adm-attendance':   'Attendance',
  'adm-audit-logs':   'Audit Logs',
  'adm-users':        'User Management',
  'adm-branch-assign':'Branch Assignment',
  'adm-branches':     'Branch Management',
  'adm-maintenance':  'System Maintenance',
  'adm-profile':      'Profile',
};

const AVATAR_COLORS = ['#3EC97A', '#F5A623', '#1DB8A0', '#E85555', '#7F77DD'];
let dashboardData = null;
let attendanceData = null;
let auditLogsData = [];
let auditSummary = { total: 0, success: 0, failed: 0 };
let auditSearch = '';
let auditModuleFilter = 'all';
let auditActionFilter = 'all';

let attPaginator = null;
let auditPaginator = null;

/* ── USER MANAGEMENT STATE ── */
let allUsers = [];
let userRoleFilter = 'all';
let userSearch = '';
let currentEditingUser = null;
let usersPaginator = null;

/* ── BRANCH ASSIGNMENT STATE ── */
let branchAllEmployees = [];
let branchFilter = 'all';
let branchSearch = '';
let currentBranchEmployee = null;
let branchPaginator = null;

/* ── BRANCH MANAGEMENT STATE ── */
let admBranches = [];
let admAssignBranches = [];

/* ── SYSTEM MAINTENANCE STATE ── */
let systemData = null;
let allRfidDevices = [];
let rfidDeviceSearch = '';
let rfidPaginator = null;
let currentEditingRfid = null;

/* ── NAVIGATE ── */
function adminNav(pageId, navEl) {
  // hide all admin pages
  Object.keys(ADMIN_PAGES).forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });

  // show target page
  document.getElementById(pageId)?.classList.add('active');

  // update sidebar highlight
  document.querySelectorAll('#s-admin .ni').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  // update topbar title
  const titleEl = document.getElementById('adm-tb-title');
  if (titleEl) titleEl.textContent = ADMIN_PAGES[pageId] || '';

  if (window.persistRolePageState) {
    window.persistRolePageState('admin', pageId);
  }

  if (pageId === 'adm-dashboard') {
    loadDashboard();
  }

  if (pageId === 'adm-attendance') {
    loadAttendanceData();
    // Auto-focus the scan field so a HID RFID reader's keystrokes land there
    // immediately without an extra click.
    setTimeout(() => document.getElementById('adm-rfid-input')?.focus(), 0);
  }

  if (pageId === 'adm-audit-logs') {
    loadAuditLogs();
  }

  if (pageId === 'adm-users') {
    loadUsers();
  }

  if (pageId === 'adm-branch-assign') {
    loadBranchAssignment();
  }

  if (pageId === 'adm-maintenance') {
    loadSystemData();
  }

  if (pageId === 'adm-branches') {
    loadAdmBranches();
  }

  if (pageId === 'adm-profile') {
    loadAdminProfile();
  }

  logAuditMovement({
    module: 'ui',
    action: 'navigate',
    entity_type: 'page',
    entity_id: pageId,
    description: `Admin opened ${ADMIN_PAGES[pageId] || 'page'}.`,
    source: 'ui',
    metadata: { page_id: pageId },
  });
}

function getAdminNavByPageId(pageId) {
  const navItems = Array.from(document.querySelectorAll('#s-admin .ni'));
  return navItems.find((item) => String(item.getAttribute('onclick') || '').includes(`'${pageId}'`)) || null;
}


function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'NA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function applyAdminIdentity() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const fullName = String(context?.full_name || '').trim();
  const displayName = fullName || 'Admin User';

  const avatarEl = document.querySelector('#s-admin .sb-foot .av');
  if (avatarEl) avatarEl.textContent = getInitials(displayName);

  const nameEl = document.querySelector('#s-admin .sb-foot .un');
  if (nameEl) nameEl.textContent = displayName;

  const roleEl = document.querySelector('#s-admin .sb-foot .ur');
  if (roleEl) roleEl.textContent = 'Administrator';
}

function loadAdminProfile() {
  const ctx = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  if (!ctx) return;

  const initials = (String(ctx.full_name || '').trim()
    .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('') || 'AD').toUpperCase();

  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };

  setTxt('adm-ep-avatar',    initials);
  setTxt('adm-ep-name',      ctx.full_name    || 'Admin User');
  setTxt('adm-ep-pos',       ctx.position     || 'Administrator');
  setTxt('adm-ep-role-tag',  ctx.role         || 'Administrator');
  setTxt('adm-ep-info-name',    ctx.full_name);
  setTxt('adm-ep-info-id',     ctx.employee_id);
  setTxt('adm-ep-info-email',  ctx.email);
  setTxt('adm-ep-info-role',   ctx.role);
  setTxt('adm-ep-bank-name',   ctx.bank_name);
  setTxt('adm-ep-bank-account',ctx.bank_account_number);
}

function handleLegacyAuthContextChange() {
  applyAdminIdentity();
}

function getAvatarColor(seed) {
  let hash = 0;
  const text = String(seed || 'employee');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '₱ 0';
  return `₱ ${amount.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeJsString(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function normalizePortalPosition(positionValue, roleValue) {
  const role = String(roleValue || '').trim().toLowerCase();
  const position = String(positionValue || '').trim().toLowerCase();

  if (role === 'accountant' || position === 'accountant' || position.includes('account')) {
    return 'Accountant';
  }

  if (role === 'hr' || position === 'hr officer' || position.includes('hr officer')) {
    return 'HR Officer';
  }

  return 'Employee';
}

const ALLOWED_SUFFIXES = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

function isValidNamePart(nameValue) {
  const normalized = String(nameValue || '').trim();
  return normalized.length > 0 && /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/.test(normalized);
}

function setupNameFieldValidation() {
  const INVALID_CHARS = /[^A-Za-z\s]/g;

  document.querySelectorAll('.name-input').forEach((input) => {
    const errorSpan = input.nextElementSibling;

    input.addEventListener('input', () => {
      const original = input.value;
      const cleaned = original.replace(INVALID_CHARS, '');

      if (cleaned !== original) {
        const pos = input.selectionStart - (original.length - cleaned.length);
        input.value = cleaned;
        input.setSelectionRange(pos, pos);
        if (errorSpan) errorSpan.textContent = 'Only letters and spaces are allowed.';
      } else {
        if (errorSpan) errorSpan.textContent = '';
      }
    });
  });
}

const ADMIN_SALARY_MAX = 9999999.99;

function setupSalaryFieldValidation(scope = document) {
  scope.querySelectorAll('.salary-input').forEach((input) => {
    if (input.dataset.salaryClampBound === '1') return;
    input.dataset.salaryClampBound = '1';

    const errorSpan = input.nextElementSibling;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'e' || e.key === 'E' || e.key === '+') {
        e.preventDefault();
        if (errorSpan) { errorSpan.textContent = 'Only numbers are allowed.'; }
        setTimeout(() => { if (errorSpan) errorSpan.textContent = ''; }, 2000);
      }
    });

    input.addEventListener('input', () => {
      const raw = input.value;
      if (!raw) { if (errorSpan) errorSpan.textContent = ''; return; }

      const intPart = raw.split('.')[0].replace(/^-/, '');
      if (intPart.length > 7) {
        const decimalIndex = raw.indexOf('.');
        const trimmedInt = intPart.slice(0, 7);
        input.value = decimalIndex >= 0
          ? `${trimmedInt}${raw.slice(decimalIndex)}`
          : trimmedInt;
      }

      const value = Number(input.value);
      if (Number.isFinite(value) && value > ADMIN_SALARY_MAX) {
        input.value = String(ADMIN_SALARY_MAX);
      }

      if (errorSpan) errorSpan.textContent = '';
    });
  });
}

function setupGovIdBankFieldValidation(scope = document) {
  const INVALID_CHARS = /[A-Za-z]/g;
  const fields = ['sss_number', 'pagibig_number', 'philhealth_number', 'bank_account_number'];

  fields.forEach((fieldName) => {
    scope.querySelectorAll(`[name="${fieldName}"]`).forEach((input) => {
      if (input.dataset.govIdBound === '1') return;
      input.dataset.govIdBound = '1';
      const errorSpan = input.nextElementSibling;
      input.addEventListener('input', () => {
        const original = input.value;
        const cleaned = original.replace(INVALID_CHARS, '');
        if (cleaned !== original) {
          const pos = input.selectionStart - (original.length - cleaned.length);
          input.value = cleaned;
          input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
          if (errorSpan && errorSpan.classList.contains('field-error')) {
            errorSpan.textContent = 'Letters are not allowed in this field.';
          }
        } else {
          if (errorSpan && errorSpan.classList.contains('field-error')) {
            errorSpan.textContent = '';
          }
        }
      });
    });
  });
}

function normalizeSuffix(value) {
  return String(value || '').trim().slice(0, 16);
}

function toTitleCaseWords(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDateOfBirthForPassword(dateValue) {
  const raw = String(dateValue || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return '';

  const [, year, month, day] = match;
  return `${month}${day}${year}`;
}

function buildDefaultPassword(lastName, dateOfBirth) {
  const sanitizedLastName = toTitleCaseWords(lastName).replaceAll(/\s+/g, '');
  const dobDigits = formatDateOfBirthForPassword(dateOfBirth);
  if (!sanitizedLastName || !dobDigits) return '';
  return `${sanitizedLastName}${dobDigits}`;
}

function composeFullName({ first_name = '', middle_initial = '', last_name = '', suffix = '' }) {
  const first = toTitleCaseWords(first_name);
  const middle = String(middle_initial || '').trim();
  const last = toTitleCaseWords(last_name);
  const resolvedSuffix = normalizeSuffix(suffix);

  const parts = [first, middle, last].filter(Boolean);
  return [parts.join(' '), resolvedSuffix].filter(Boolean).join(' ');
}

function splitFullName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) {
    return {
      first_name: '',
      second_name: '',
      middle_initial: '',
      last_name: '',
      suffix: '',
    };
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  const result = {
    first_name: '',
    second_name: '',
    middle_initial: '',
    last_name: '',
    suffix: '',
  };

  if (tokens.length === 1) {
    result.first_name = tokens[0];
    return result;
  }

  let nameTokens = [...tokens];
  const maybeSuffix = nameTokens[nameTokens.length - 1];
  if (ALLOWED_SUFFIXES.includes(maybeSuffix)) {
    result.suffix = maybeSuffix;
    nameTokens.pop();
  }

  if (!nameTokens.length) return result;

  const maybeMiddle = nameTokens[nameTokens.length - 2] || '';
  if (/^[A-Za-z]\.?$/.test(maybeMiddle)) {
    result.middle_initial = maybeMiddle[0].toUpperCase();
    nameTokens.splice(nameTokens.length - 2, 1);
  }

  result.first_name = nameTokens[0] || '';
  result.last_name = nameTokens[nameTokens.length - 1] || '';
  result.second_name = nameTokens.slice(1, -1).join(' ');

  if (!result.second_name) {
    result.second_name = result.last_name;
  }

  return result;
}

function syncPositionFieldWithRole(form) {
  if (!form?.elements) return;

  const role = String(form.elements.role?.value || 'employee').toLowerCase();
  const positionInput = form.elements.position;
  if (!positionInput) return;

  positionInput.value = normalizePortalPosition(positionInput.value, role);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  return new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatTimeOnly(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatHours(value) {
  const total = Number(value || 0);
  if (!Number.isFinite(total) || total <= 0) return '—';

  const wholeHours = Math.floor(total);
  const minutes = Math.round((total - wholeHours) * 60);
  return `${wholeHours}h ${String(minutes).padStart(2, '0')}m`;
}

function renderDashboardPanels(panels = {}) {
  const totalEmployeesEl = document.getElementById('adm-panel-total-employees');
  const totalPayrollEl = document.getElementById('adm-panel-total-payroll');
  const absentTodayEl = document.getElementById('adm-panel-absent-today');

  if (totalEmployeesEl) totalEmployeesEl.textContent = String(panels.total_employees || 0);
  if (totalPayrollEl) totalPayrollEl.textContent = formatMoney(panels.total_payroll_month || 0);
  if (absentTodayEl) absentTodayEl.textContent = String(panels.absent_today || 0);

  const presentTodayEl = document.getElementById('adm-panel-present-today');
  const lateTodayEl = document.getElementById('adm-panel-late-today');
  const teachingCountEl = document.getElementById('adm-panel-teaching-count');
  const nonTeachingHintEl = document.getElementById('adm-panel-non-teaching-hint');
  const empBreakdownEl = document.getElementById('adm-panel-emp-breakdown');

  if (presentTodayEl) presentTodayEl.textContent = String(panels.present_today || 0);
  if (lateTodayEl) lateTodayEl.textContent = String(panels.late_today || 0);
  if (teachingCountEl) teachingCountEl.textContent = String(panels.teaching_count || 0);
  if (nonTeachingHintEl) nonTeachingHintEl.textContent = `Non-Teaching: ${panels.non_teaching_count || 0}`;
  if (empBreakdownEl) {
    const t = panels.teaching_count || 0;
    const nt = panels.non_teaching_count || 0;
    empBreakdownEl.textContent = `Teaching: ${t} · Non-Teaching: ${nt}`;
  }
}


function renderMonthlyPayrollChart(monthlyPayroll = []) {
  const chartContainer = document.getElementById('adm-monthly-payroll-chart');
  const avgEl = document.getElementById('adm-monthly-avg');
  const ytdEl = document.getElementById('adm-ytd-total');
  if (!chartContainer || !avgEl || !ytdEl) return;

  if (!monthlyPayroll.length) {
    chartContainer.innerHTML = '<div class="bc"><div class="bar active" style="height:42px;"></div><div class="bl">N/A</div></div>';
    avgEl.textContent = '₱ 0';
    ytdEl.textContent = '₱ 0';
    return;
  }

  const maxValue = Math.max(...monthlyPayroll.map((entry) => Number(entry.amount || 0)), 1);
  const total = monthlyPayroll.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const avg = total / monthlyPayroll.length;

  chartContainer.innerHTML = monthlyPayroll.map((entry) => {
    const amount = Number(entry.amount || 0);
    const height = Math.max(24, Math.round((amount / maxValue) * 78));
    const label = escapeHtml(entry.label || 'N/A');
    const activeClass = entry.isCurrentMonth ? ' active' : '';
    return `<div class="bc"><div class="bar${activeClass}" style="height:${height}px;"></div><div class="bl">${label}</div></div>`;
  }).join('');

  avgEl.textContent = formatMoney(avg);
  ytdEl.textContent = formatMoney(total);
}

function renderRecentPayrollActivity(activity = []) {
  const list = document.getElementById('adm-recent-activity-list');
  if (!list) return;

  if (!activity.length) {
    list.innerHTML = '<div class="ai-item"><div class="ai2"><div class="s">No recent payroll activity available.</div></div></div>';
    return;
  }

  list.innerHTML = activity.slice(0, 5).map((item) => {
    const initials = getInitials(item.name);
    const avatarColor = getAvatarColor(item.id || item.name);
    const name = escapeHtml(item.name);
    const type = escapeHtml(item.employee_type);
    const subText = escapeHtml(item.sub_text || item.period || '');
    const status = String(item.status || '').toLowerCase();
    const isPaid = status === 'paid' || status === 'approved';
    const isRejected = status === 'on_hold' || status === 'rejected';
    const isNotPaid = status === 'not_paid' || status === 'unpaid';
    const statusClass = isPaid ? 'bg' : isRejected || isNotPaid ? 'br' : 'ba';
    const statusText = isPaid
      ? 'Paid'
      : isRejected
        ? 'On Hold'
        : isNotPaid
          ? 'Not Paid'
          : 'Pending';

    return `
      <div class="ai-item">
        <div class="av" style="width:32px;height:32px;font-size:11px;background:${avatarColor};">${initials}</div>
        <div class="ai2">
          <div class="n">${name} — ${type}</div>
          <div class="s">${subText}</div>
        </div>
        <div class="air">
          <div class="amt">${formatMoney(item.amount)}</div>
          <div class="st"><span class="badge ${statusClass}"><span class="bd"></span>${statusText}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderAttendancePanels(payload = {}) {
  const panels = payload?.panels || {};
  const presentEl = document.getElementById('adm-att-present');
  const lateEl = document.getElementById('adm-att-late');
  const absentEl = document.getElementById('adm-att-absent');
  const titleEl = document.getElementById('adm-attendance-title');

  if (presentEl) presentEl.textContent = String(panels.present_today || 0);
  if (lateEl) lateEl.textContent = String(panels.late_today || 0);
  if (absentEl) absentEl.textContent = String(panels.absent_today || 0);
  if (titleEl) {
    const dateLabel = payload?.date_label || 'Today';
    titleEl.textContent = `Attendance Log — ${dateLabel}`;
  }
}

function renderAttendanceTable(rows = []) {
  const tbody = document.getElementById('adm-attendance-table-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">No attendance records found for today.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((row) => {
    const name = escapeHtml(row.employee_name || 'Unknown Employee');
    const type = escapeHtml(row.employee_type || 'Teaching');
    const typeBadgeClass = type === 'Non-Teaching' ? 'ba' : 'bt2';

    const status = String(row.status || 'Absent');
    const normalizedStatus = status.toLowerCase();
    const statusClass = normalizedStatus === 'late'
      ? 'ba'
      : (normalizedStatus === 'present' ? 'bg' : 'br');

    return `
      <tr>
        <td class="nm">${name}</td>
        <td><span class="badge ${typeBadgeClass}">${type}</span></td>
        <td class="mn">${formatTimeOnly(row.time_in)}</td>
        <td class="mn">${formatTimeOnly(row.time_out)}</td>
        <td class="mn">${formatHours(row.total_hours)}</td>
        <td><span class="badge ${statusClass}"><span class="bd"></span>${escapeHtml(status)}</span></td>
      </tr>
    `;
  }).join('');
}

function showRfidFeedback(message, isError = false) {
  const feedback = document.getElementById('adm-rfid-feedback');
  if (!feedback) return;

  feedback.textContent = message;
  feedback.classList.toggle('err', isError);
  feedback.classList.toggle('ok', !isError && Boolean(message));
}

async function loadAttendanceData() {
  const tbody = document.getElementById('adm-attendance-table-body');
  if (tbody) {
    tbody.innerHTML = skeletonRows(6);
  }

  try {
    const response = await fetch('/api/admin/attendance', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load attendance data');
    }

    attendanceData = payload;
    renderAttendancePanels(payload);
    if (attPaginator) {
      attPaginator.setData(payload.attendance_logs || []);
    } else {
      renderAttendanceTable(payload.attendance_logs || []);
    }
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function formatRfidScanFeedback(record) {
  if (!record) return '';
  const name = record.employee_name || 'Employee';
  if (record.time_out) {
    return `${name}: Time Out recorded at ${formatTimeOnly(record.time_out)}.`;
  }
  return `${name}: Time In recorded at ${formatTimeOnly(record.time_in)} (${record.status || 'Present'}).`;
}

// USB RFID readers plug in as HID keyboards: tapping a card types the UID
// into whichever input has focus, then sends Enter. Bound once so the field
// auto-submits on Enter instead of requiring a manual button click.
function attachRfidScannerInput() {
  const input = document.getElementById('adm-rfid-input');
  if (!input || input.dataset.scannerBound === '1') return;
  input.dataset.scannerBound = '1';

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitRfidAttendanceScan();
    }
  });

  // Some readers never send Enter/Tab after a tap — auto-submit once
  // keystrokes stop arriving for a beat so those readers still work.
  // Restricted to purely numeric values (RFID UIDs) so a paused manual
  // employee-ID entry (e.g. "SACS-001") never auto-fires mid-typing.
  let idleTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(idleTimer);
    const value = input.value.trim();
    if (!/^\d{6,}$/.test(value)) return;
    idleTimer = setTimeout(() => {
      if (/^\d{6,}$/.test(input.value.trim()) && !rfidScanInFlight) submitRfidAttendanceScan();
    }, 400);
  });
}

let rfidScanInFlight = false;

async function submitRfidAttendanceScan() {
  const input = document.getElementById('adm-rfid-input');
  if (!input || rfidScanInFlight) return;

  const rfidCode = String(input.value || '').trim();
  if (!rfidCode) {
    showRfidFeedback('Enter RFID or employee ID first.', true);
    return;
  }

  rfidScanInFlight = true;
  input.disabled = true;

  try {
    showRfidFeedback('Processing RFID scan...', false);

    const response = await fetch('/api/admin/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rfid_code: rfidCode }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to process RFID scan');
    }

    input.value = '';
    showRfidFeedback(formatRfidScanFeedback(payload.record) || payload.message || 'RFID scan recorded.', false);
    logAuditMovement({
      module: 'ui',
      action: 'rfid_scan',
      entity_type: 'attendance',
      entity_id: rfidCode,
      description: 'Admin submitted RFID attendance scan.',
      source: 'ui',
      metadata: { persisted: Boolean(payload.persisted) },
    });
    await loadAttendanceData();
  } catch (error) {
    showRfidFeedback(error.message, true);
  } finally {
    rfidScanInFlight = false;
    input.disabled = false;
    input.focus();
  }
}

function exportAttendanceCsv() {
  const rows = attendanceData?.attendance_logs || [];
  if (!rows.length) {
    window.alert('No attendance data available to export.');
    return;
  }

  const headers = ['Employee', 'Type', 'Time In', 'Time Out', 'Hours', 'Status'];
  const lines = [headers.join(',')];

  rows.forEach((row) => {
    lines.push([
      toCsvValue(row.employee_name || ''),
      toCsvValue(row.employee_type || ''),
      toCsvValue(formatTimeOnly(row.time_in)),
      toCsvValue(formatTimeOnly(row.time_out)),
      toCsvValue(formatHours(row.total_hours)),
      toCsvValue(row.status || ''),
    ].join(','));
  });

  const csvContent = `\uFEFF${lines.join('\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const dateKey = String(attendanceData?.date_key || 'today').replaceAll('/', '-');

  anchor.href = url;
  anchor.download = `sacs-attendance-${dateKey}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  logAuditMovement({
    module: 'ui',
    action: 'export_csv',
    entity_type: 'attendance',
    entity_id: dateKey,
    description: 'Admin exported attendance CSV.',
    source: 'ui',
    metadata: { row_count: rows.length },
  });
}

function toCsvValue(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function logAuditMovement(payload) {
  try {
    await fetch('/api/admin/audit-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Keep user flow unaffected when audit endpoint is unavailable.
  }
}

function renderAuditSummary(summary = {}) {
  const totalEl = document.getElementById('adm-audit-total');
  const successEl = document.getElementById('adm-audit-success');
  const failedEl = document.getElementById('adm-audit-failed');

  if (totalEl) totalEl.textContent = String(summary.total || 0);
  if (successEl) successEl.textContent = String(summary.success || 0);
  if (failedEl) failedEl.textContent = String(summary.failed || 0);
}

function renderAuditTable(logs = []) {
  const tbody = document.getElementById('adm-audit-table-body');
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No audit logs found for current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map((log) => {
    const timestamp = escapeHtml(formatDateTime(log.created_at));
    const moduleName = escapeHtml(String(log.module || '').replaceAll('_', ' '));
    const action = escapeHtml(String(log.action || '').replaceAll('_', ' '));
    const entity = `${escapeHtml(log.entity_type || '')}${log.entity_id ? ` · ${escapeHtml(log.entity_id)}` : ''}`;
    const description = escapeHtml(log.description || 'No description provided.');
    const status = String(log.status || '').toLowerCase();
    const statusClass = status === 'success' ? 'bg' : status === 'failed' ? 'br' : 'ba';
    const source = escapeHtml(log.source || 'api');

    return `
      <tr>
        <td class="mn">${timestamp}</td>
        <td>${moduleName}</td>
        <td>${action}</td>
        <td class="mn">${entity || '—'}</td>
        <td>${description}</td>
        <td><span class="badge ${statusClass}"><span class="bd"></span>${escapeHtml(status)}</span></td>
        <td>${source}</td>
      </tr>
    `;
  }).join('');
}

function setAuditSearch(value) {
  auditSearch = String(value || '').trim();
  loadAuditLogs();
}

function setAuditModuleFilter(value) {
  auditModuleFilter = String(value || 'all').trim().toLowerCase();
  loadAuditLogs();
}

function setAuditActionFilter(value) {
  auditActionFilter = String(value || 'all').trim().toLowerCase();
  loadAuditLogs();
}

async function loadAuditLogs() {
  const tbody = document.getElementById('adm-audit-table-body');
  if (tbody) {
    tbody.innerHTML = skeletonRows(7);
  }

  try {
    const params = new URLSearchParams({
      module: auditModuleFilter,
      action: auditActionFilter,
      search: auditSearch,
      limit: '250',
    });

    const response = await fetch(`/api/admin/audit-logs?${params.toString()}`, { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load audit logs');
    }

    auditLogsData = payload.logs || [];
    auditSummary = payload.summary || { total: 0, success: 0, failed: 0 };
    renderAuditSummary(auditSummary);
    if (auditPaginator) {
      auditPaginator.setData(auditLogsData);
    } else {
      renderAuditTable(auditLogsData);
    }
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function exportAuditLogsCsv() {
  if (!auditLogsData.length) {
    window.alert('No audit logs available to export.');
    return;
  }

  const headers = ['Timestamp', 'Module', 'Action', 'Entity Type', 'Entity ID', 'Description', 'Status', 'Source'];
  const lines = [headers.join(',')];

  auditLogsData.forEach((log) => {
    lines.push([
      toCsvValue(formatDateTime(log.created_at)),
      toCsvValue(log.module || ''),
      toCsvValue(log.action || ''),
      toCsvValue(log.entity_type || ''),
      toCsvValue(log.entity_id || ''),
      toCsvValue(log.description || ''),
      toCsvValue(log.status || ''),
      toCsvValue(log.source || ''),
    ].join(','));
  });

  const csvContent = `\uFEFF${lines.join('\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = 'sacs-audit-logs.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  logAuditMovement({
    module: 'ui',
    action: 'export_csv',
    entity_type: 'audit_logs',
    entity_id: 'audit_logs',
    description: 'Admin exported audit logs CSV.',
    source: 'ui',
    metadata: { row_count: auditLogsData.length },
  });
}

function renderDashboard(data) {
  dashboardData = data || null;
  const panels = data?.panels || {};

  renderDashboardPanels(panels);
  renderRecentPayrollActivity(data?.recent_activity || []);
}

async function loadDashboard() {
  try {
    const response = await fetch('/api/admin/dashboard', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load dashboard data');
    }

    renderDashboard(payload);
  } catch (error) {
    console.error('Dashboard load error:', error.message);
  }
}

window.onAddUserRoleChange = onAddUserRoleChange;
window.openAddUserModal = openAddUserModal;
window.closeAddUserModal = closeAddUserModal;
window.submitAddUser = submitAddUser;
window.openEditUserModal = openEditUserModal;
window.closeEditUserModal = closeEditUserModal;
window.submitEditUser = submitEditUser;
window.toggleArchiveCurrentUser = toggleArchiveCurrentUser;
window.setUserRoleFilter = setUserRoleFilter;
window.setUserSearch = setUserSearch;
window.openRfidEditModal = openRfidEditModal;
window.closeRfidEditModal = closeRfidEditModal;
window.submitRfidUpdate = submitRfidUpdate;
window.voidRfidCard = voidRfidCard;
window.setRfidDeviceSearch = setRfidDeviceSearch;
window.loadSystemData = loadSystemData;
window.submitRfidAttendanceScan = submitRfidAttendanceScan;
window.exportAttendanceCsv = exportAttendanceCsv;
window.setAuditSearch = setAuditSearch;
window.setAuditModuleFilter = setAuditModuleFilter;
window.setAuditActionFilter = setAuditActionFilter;
window.exportAuditLogsCsv = exportAuditLogsCsv;
window.loadBranchAssignment = loadBranchAssignment;
window.setBranchFilter = setBranchFilter;
window.setBranchSearch = setBranchSearch;
window.openBranchAssignModal = openBranchAssignModal;
window.closeBranchAssignModal = closeBranchAssignModal;
window.submitBranchAssign = submitBranchAssign;
window.loadAdminProfile = loadAdminProfile;

/* ── CHANGE PASSWORD ── */
function showAdmChangePasswordFeedback(message, isError = false) {
  const el = document.getElementById('adm-change-password-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

async function submitAdminChangePassword() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const email = String(context?.email || '').trim();

  const currentPassword = String(document.getElementById('adm-cur-password')?.value || '').trim();
  const newPassword = String(document.getElementById('adm-new-password')?.value || '').trim();
  const confirmPassword = String(document.getElementById('adm-confirm-password')?.value || '').trim();

  if (!email) { showAdmChangePasswordFeedback('Unable to identify account. Please sign in again.', true); return; }
  if (!currentPassword || !newPassword || !confirmPassword) { showAdmChangePasswordFeedback('All password fields are required.', true); return; }
  if (newPassword !== confirmPassword) { showAdmChangePasswordFeedback('New passwords do not match.', true); return; }
  if (newPassword.length < 8) { showAdmChangePasswordFeedback('New password must be at least 8 characters.', true); return; }

  try {
    showAdmChangePasswordFeedback('Updating password...', false);
    const response = await fetch('/api/legacy-auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, current_password: currentPassword, new_password: newPassword }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Failed to update password.');

    document.getElementById('adm-cur-password').value = '';
    document.getElementById('adm-new-password').value = '';
    document.getElementById('adm-confirm-password').value = '';

    showAdmChangePasswordFeedback('Password updated successfully.', false);
    window.pushNotification?.('Password Changed', 'Your account password has been updated successfully.', 'success');
    setTimeout(() => window.closeSettingsModal?.('adm'), 1200);
  } catch (error) {
    showAdmChangePasswordFeedback(error.message, true);
  }
}

window.submitAdminChangePassword = submitAdminChangePassword;

/* ═══════════════════════════════════════
   USER MANAGEMENT
   ═══════════════════════════════════════ */

const ROLE_LABELS = {
  admin:     'Administrator',
  hr:        'HR',
  accountant:'Accountant',
  employee:  'Employee',
};

const ROLE_BADGE_CLASS = {
  admin:     'ba',
  hr:        'bt2',
  accountant:'bt2',
  employee:  'bg',
};

function getRoleLabel(role) {
  return ROLE_LABELS[String(role || '').toLowerCase()] || 'Employee';
}

function getRoleBadgeClass(role) {
  return ROLE_BADGE_CLASS[String(role || '').toLowerCase()] || 'bg';
}

function updateUserPanels() {
  const active = allUsers.filter((u) => !u.archived);
  const archived = allUsers.filter((u) => u.archived);

  const totalEl = document.getElementById('adm-users-total');
  const activeEl = document.getElementById('adm-users-active');
  const archivedEl = document.getElementById('adm-users-archived');

  if (totalEl) totalEl.textContent = String(allUsers.length);
  if (activeEl) activeEl.textContent = String(active.length);
  if (archivedEl) archivedEl.textContent = String(archived.length);

  document.querySelectorAll('#adm-users-filter-chips .chip').forEach((chip) => {
    const filter = chip.getAttribute('data-role-filter');
    if (filter === 'all') {
      chip.textContent = `All (${active.length})`;
    } else if (filter === 'archived') {
      chip.textContent = `Archived (${archived.length})`;
    } else {
      const count = active.filter((u) => u.role === filter).length;
      chip.textContent = `${getRoleLabel(filter)} (${count})`;
    }
  });
}

function getFilteredUsers() {
  const search = userSearch.toLowerCase();
  return allUsers.filter((user) => {
    if (userRoleFilter === 'archived') return user.archived;
    if (user.archived) return false;
    if (userRoleFilter !== 'all' && user.role !== userRoleFilter) return false;
    if (!search) return true;
    const haystack = [user.full_name, user.email, user.role, user.employee_type, user.employee_id]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    return haystack.includes(search);
  });
}

function renderUsers(users) {
  const tbody = document.getElementById('adm-users-table-body');
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--t3);">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((user) => {
    const initials = getInitials(user.full_name);
    const avatarColor = getAvatarColor(user.email || user.id);
    const role = String(user.role || 'employee').toLowerCase();
    const badgeClass = getRoleBadgeClass(role);
    const statusClass = user.archived ? 'br' : 'bg';
    const statusText = user.archived ? 'Archived' : 'Active';
    const lastLogin = user.last_sign_in ? formatDateTime(user.last_sign_in) : 'Never';
    const safeId = escapeHtml(user.id);
    const safeName = escapeHtml(user.full_name);
    const safeEmail = escapeHtml(user.email);
    const typeText = user.employee_type ? escapeHtml(user.employee_type) : '—';
    const typeClass = user.employee_type === 'Non-Teaching' ? 'ba' : (user.employee_type ? 'bt2' : '');
    const empIdText = user.employee_id ? escapeHtml(user.employee_id) : '—';

    return `
      <tr>
        <td class="nm">
          <div style="display:flex;align-items:center;gap:9px;">
            <div class="av" style="width:28px;height:28px;font-size:10px;background:${avatarColor};">${initials}</div>
            ${safeName}
          </div>
        </td>
        <td class="mn">${safeEmail}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(getRoleLabel(role))}</span></td>
        <td>${typeClass ? `<span class="badge ${typeClass}">${typeText}</span>` : `<span style="color:var(--t3);">—</span>`}</td>
        <td class="mn">${empIdText}</td>
        <td class="mn" style="font-size:11px;">${escapeHtml(lastLogin)}</td>
        <td><span class="badge ${statusClass}"><span class="bd"></span>${statusText}</span></td>
        <td><button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openEditUserModal('${safeId}')">Edit</button></td>
      </tr>
    `;
  }).join('');
}

function renderFilteredUsers() {
  updateUserPanels();
  if (usersPaginator) {
    usersPaginator.setData(getFilteredUsers());
  } else {
    renderUsers(getFilteredUsers());
  }
}

function setUserRoleFilter(filter) {
  userRoleFilter = filter;
  document.querySelectorAll('#adm-users-filter-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.getAttribute('data-role-filter') === filter);
  });
  renderFilteredUsers();
}

function setUserSearch(value) {
  userSearch = String(value || '').trim();
  renderFilteredUsers();
}

async function loadUsers() {
  const tbody = document.getElementById('adm-users-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(8);

  try {
    const [usersRes, empRes] = await Promise.all([
      fetch('/api/admin/users', { method: 'GET' }),
      fetch('/api/admin/employees', { method: 'GET' }),
    ]);
    const usersPayload = await usersRes.json();
    if (!usersRes.ok) throw new Error(usersPayload.error || 'Failed to load users');

    const empPayload = empRes.ok ? await empRes.json() : { employees: [] };
    const empMap = new Map((empPayload.employees || []).map((e) => [e.id, e]));

    allUsers = (usersPayload.users || []).map((u) => {
      const empData = empMap.get(u.id) || {};
      return { ...u, ...empData, last_sign_in: u.last_sign_in, created_at: u.created_at };
    });

    renderFilteredUsers();
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function showAddUserFeedback(message, isError = false) {
  const el = document.getElementById('add-user-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

function onAddUserRoleChange(role) {
  const form = document.getElementById('add-user-form');
  if (!form) return;
  const isEmpRole = ['employee', 'accountant', 'hr'].includes(String(role || '').toLowerCase());
  form.querySelectorAll('.adm-emp-fields').forEach((el) => { el.style.display = isEmpRole ? '' : 'none'; });
  form.querySelectorAll('.adm-nomp-fields').forEach((el) => { el.style.display = isEmpRole ? 'none' : ''; });
  syncPositionFieldWithRole(form);
}

function openAddUserModal() {
  const modal = document.getElementById('add-user-modal');
  const form = document.getElementById('add-user-form');
  if (!modal || !form) return;
  form.reset();
  if (form.elements.suffix) form.elements.suffix.value = '';
  showAddUserFeedback('');
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  onAddUserRoleChange('employee');
  modal.style.display = 'flex';
}

function closeAddUserModal() {
  const modal = document.getElementById('add-user-modal');
  if (modal) modal.style.display = 'none';
}

async function submitAddUser(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);

  const role = String(formData.get('role') || 'employee').trim().toLowerCase();
  const firstName = String(formData.get('first_name') || '').trim();
  const lastName = String(formData.get('last_name') || '').trim();
  const middleInitial = String(formData.get('middle_initial') || '').trim();
  const suffix = String(formData.get('suffix') || '').trim();
  const email = String(formData.get('email') || '').trim();
  const isEmpRole = ['employee', 'accountant', 'hr'].includes(role);

  if (!firstName || !lastName) {
    showAddUserFeedback('First name and last name are required.', true);
    return;
  }
  if (!email) {
    showAddUserFeedback('Email is required.', true);
    return;
  }

  const fullName = composeFullName({ first_name: firstName, middle_initial: middleInitial, last_name: lastName, suffix });

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    let response;
    if (isEmpRole) {
      const dateOfBirth = String(formData.get('date_of_birth') || '').trim();
      if (!dateOfBirth) {
        showAddUserFeedback('Date of birth is required.', true);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create User';
        return;
      }
      response = await fetch('/api/admin/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: firstName,
          middle_initial: middleInitial,
          last_name: lastName,
          suffix,
          email,
          role,
          date_of_birth: dateOfBirth,
          employee_type: String(formData.get('employee_type') || 'Teaching').trim(),
          position: String(formData.get('position') || '').trim(),
          basic_salary: Number(formData.get('basic_salary') || 0) || 0,
          employee_status: String(formData.get('employee_status') || 'Active').trim(),
          address: String(formData.get('address') || '').trim(),
          sss_number: String(formData.get('sss_number') || '').trim(),
          pagibig_number: String(formData.get('pagibig_number') || '').trim(),
          philhealth_number: String(formData.get('philhealth_number') || '').trim(),
          bank_name: String(formData.get('bank_name') || '').trim(),
          bank_account_number: String(formData.get('bank_account_number') || '').trim(),
        }),
      });
    } else {
      const password = String(formData.get('password') || '').trim();
      if (!password || password.length < 6) {
        showAddUserFeedback('Password must be at least 6 characters.', true);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create User';
        return;
      }
      response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName, email, role, password }),
      });
    }

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to create user');

    showAddUserFeedback('User account created successfully.', false);
    window.pushNotification?.('User Created', `New ${role} account created for ${fullName}.`, 'success');
    await loadUsers();
    setTimeout(() => closeAddUserModal(), 500);
  } catch (error) {
    showAddUserFeedback(error.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create User';
  }
}

function showEditUserFeedback(message, isError = false) {
  const el = document.getElementById('edit-user-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

function openEditUserModal(userId) {
  const modal = document.getElementById('edit-user-modal');
  const form = document.getElementById('edit-user-form');
  const archiveBtn = document.getElementById('archive-user-button');
  if (!modal || !form || !archiveBtn) return;

  currentEditingUser = allUsers.find((u) => u.id === userId);
  if (!currentEditingUser) {
    window.alert('User record not found. Please refresh the list.');
    return;
  }

  const nameParts = splitFullName(currentEditingUser.full_name || '');

  form.elements.id.value = currentEditingUser.id;
  const midName = nameParts.middle_initial
    || (nameParts.second_name && nameParts.second_name !== nameParts.last_name ? nameParts.second_name : '');

  if (form.elements.first_name) form.elements.first_name.value = nameParts.first_name || '';
  if (form.elements.middle_initial) form.elements.middle_initial.value = midName;
  if (form.elements.last_name) form.elements.last_name.value = nameParts.last_name || '';
  if (form.elements.suffix) form.elements.suffix.value = nameParts.suffix || '';
  form.elements.email.value = currentEditingUser.email || '';
  form.elements.role.value = currentEditingUser.role || 'employee';
  if (form.elements.password) form.elements.password.value = '';

  const hasEmpProfile = Boolean(currentEditingUser.employee_id);
  form.querySelectorAll('.adm-edit-emp-fields').forEach((el) => {
    el.style.display = hasEmpProfile ? '' : 'none';
  });

  if (hasEmpProfile) {
    if (form.elements.employee_id) form.elements.employee_id.value = currentEditingUser.employee_id || '';
    if (form.elements.date_of_birth) form.elements.date_of_birth.value = currentEditingUser.date_of_birth || '';
    if (form.elements.employee_type) form.elements.employee_type.value = currentEditingUser.employee_type || 'Teaching';
    if (form.elements.position) form.elements.position.value = currentEditingUser.position || 'Employee';
    if (form.elements.employee_status) form.elements.employee_status.value = currentEditingUser.employee_status || 'Active';
    if (form.elements.basic_salary) form.elements.basic_salary.value = currentEditingUser.basic_salary || 0;
    if (form.elements.address) form.elements.address.value = currentEditingUser.address || '';
    if (form.elements.sss_number) form.elements.sss_number.value = currentEditingUser.sss_number || '';
    if (form.elements.pagibig_number) form.elements.pagibig_number.value = currentEditingUser.pagibig_number || '';
    if (form.elements.philhealth_number) form.elements.philhealth_number.value = currentEditingUser.philhealth_number || '';
    if (form.elements.bank_name) form.elements.bank_name.value = currentEditingUser.bank_name || '';
    if (form.elements.bank_account_number) form.elements.bank_account_number.value = currentEditingUser.bank_account_number || '';
  }

  archiveBtn.className = currentEditingUser.archived ? 'btn btn-green' : 'btn btn-red';
  archiveBtn.textContent = currentEditingUser.archived ? 'Restore User' : 'Archive User';

  showEditUserFeedback('');
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  modal.style.display = 'flex';
}

function closeEditUserModal() {
  const modal = document.getElementById('edit-user-modal');
  if (modal) modal.style.display = 'none';
}

async function toggleArchiveCurrentUser() {
  if (!currentEditingUser) return;
  const archiveBtn = document.getElementById('archive-user-button');
  if (!archiveBtn) return;

  const action = currentEditingUser.archived ? 'restore' : 'archive';
  const prompt = action === 'archive'
    ? 'archive this user account'
    : 'restore this user account';
  const detail = action === 'archive'
    ? 'Archived users cannot log in and will be hidden from active lists.'
    : 'This user account will be restored to active status.';

  if (window.confirmDestructiveAction && !(await window.confirmDestructiveAction(prompt, detail))) {
    return;
  }

  try {
    archiveBtn.disabled = true;
    archiveBtn.textContent = action === 'archive' ? 'Archiving...' : 'Restoring...';

    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentEditingUser.id, action }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to update user');

    showEditUserFeedback(action === 'archive' ? 'User archived.' : 'User restored.', false);
    window.pushNotification?.(
      action === 'archive' ? 'User Archived' : 'User Restored',
      action === 'archive' ? 'The user account has been archived.' : 'The user account has been restored.',
      'info',
    );
    await loadUsers();
    closeEditUserModal();
  } catch (error) {
    showEditUserFeedback(error.message, true);
  } finally {
    archiveBtn.disabled = false;
    archiveBtn.textContent = currentEditingUser?.archived ? 'Restore User' : 'Archive User';
  }
}

async function submitEditUser(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);

  const id = String(formData.get('id') || '').trim();
  const firstName = String(formData.get('first_name') || '').trim();
  const lastName = String(formData.get('last_name') || '').trim();
  const middleInitial = String(formData.get('middle_initial') || '').trim();
  const suffix = String(formData.get('suffix') || '').trim();
  const email = String(formData.get('email') || '').trim();
  const role = String(formData.get('role') || 'employee').trim();
  const password = String(formData.get('password') || '').trim();

  if (!id || !firstName || !lastName || !email) {
    showEditUserFeedback('First name, last name, and email are required.', true);
    return;
  }

  if (password && password.length < 6) {
    showEditUserFeedback('Password must be at least 6 characters.', true);
    return;
  }

  const fullName = composeFullName({ first_name: firstName, middle_initial: middleInitial, last_name: lastName, suffix });
  const hasEmpProfile = Boolean(currentEditingUser?.employee_id);

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    let response;
    if (hasEmpProfile) {
      const payload = {
        id,
        action: 'update',
        full_name: fullName,
        email,
        role,
        employee_type: String(formData.get('employee_type') || 'Teaching').trim(),
        position: String(formData.get('position') || '').trim(),
        basic_salary: Number(formData.get('basic_salary') || 0) || 0,
        date_of_birth: String(formData.get('date_of_birth') || '').trim(),
        employee_status: String(formData.get('employee_status') || 'Active').trim(),
        address: String(formData.get('address') || '').trim(),
        sss_number: String(formData.get('sss_number') || '').trim(),
        pagibig_number: String(formData.get('pagibig_number') || '').trim(),
        philhealth_number: String(formData.get('philhealth_number') || '').trim(),
        bank_name: String(formData.get('bank_name') || '').trim(),
        bank_account_number: String(formData.get('bank_account_number') || '').trim(),
      };
      if (password) payload.password = password;

      response = await fetch('/api/admin/employees', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const payload = { id, action: 'update', full_name: fullName, email, role };
      if (password) payload.password = password;

      response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to update user');

    showEditUserFeedback('User account updated.', false);
    window.pushNotification?.('User Updated', 'User account details have been saved.', 'success');
    await loadUsers();
    closeEditUserModal();
  } catch (error) {
    showEditUserFeedback(error.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Changes';
  }
}

/* ═══════════════════════════════════════
   SYSTEM MAINTENANCE
   ═══════════════════════════════════════ */

function renderSystemHealthPanels(data) {
  const dbStatus = document.getElementById('adm-sys-db-status');
  const attStatus = document.getElementById('adm-sys-att-status');
  const payStatus = document.getElementById('adm-sys-pay-status');
  const rfidCount = document.getElementById('adm-sys-rfid-count');
  const rfidHint = document.getElementById('adm-sys-rfid-hint');

  const dbOk = data?.database_status?.connection === 'ok';
  const attOk = data?.database_status?.attendance_logs === 'ok';
  const payOk = data?.database_status?.payroll_records === 'ok';

  if (dbStatus) {
    dbStatus.textContent = dbOk ? 'OK' : 'Error';
    dbStatus.className = `cv ${dbOk ? 'g' : 'r'}`;
  }
  if (attStatus) {
    attStatus.textContent = attOk ? 'OK' : 'Missing';
    attStatus.className = `cv ${attOk ? 'g' : 'a'}`;
  }
  if (payStatus) {
    payStatus.textContent = payOk ? 'OK' : 'Missing';
    payStatus.className = `cv ${payOk ? 'g' : 'a'}`;
  }
  const stats = data?.system_stats || {};
  if (rfidCount) rfidCount.textContent = String(stats.rfid_registered || 0);
  if (rfidHint) rfidHint.textContent = `Unregistered: ${stats.rfid_unregistered || 0}`;
}

function renderSecurityEvents(logs = []) {
  const tbody = document.getElementById('adm-security-events-body');
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--t3);">No recent security events.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.slice(0, 10).map((log) => {
    const timestamp = escapeHtml(formatDateTime(log.created_at));
    const moduleName = escapeHtml(String(log.module || '').replaceAll('_', ' '));
    const action = escapeHtml(String(log.action || '').replaceAll('_', ' '));
    const description = escapeHtml(log.description || 'No description.');
    const status = String(log.status || '').toLowerCase();
    const statusClass = status === 'success' ? 'bg' : status === 'failed' ? 'br' : 'ba';

    return `
      <tr>
        <td class="mn">${timestamp}</td>
        <td>${moduleName}</td>
        <td>${action}</td>
        <td>${description}</td>
        <td><span class="badge ${statusClass}"><span class="bd"></span>${escapeHtml(status)}</span></td>
      </tr>
    `;
  }).join('');
}

function getFilteredRfidDevices() {
  const search = rfidDeviceSearch.toLowerCase();
  if (!search) return allRfidDevices;
  return allRfidDevices.filter((device) => {
    const haystack = [device.full_name, device.employee_id, device.rfid_uid]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    return haystack.includes(search);
  });
}

function renderRfidDevices(devices) {
  const tbody = document.getElementById('adm-rfid-table-body');
  if (!tbody) return;

  if (!devices.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--t3);">No employees found.</td></tr>`;
    return;
  }

  tbody.innerHTML = devices.map((device) => {
    const safeName = escapeHtml(device.full_name);
    const safeEmpId = escapeHtml(device.employee_id || 'N/A');
    const safeType = escapeHtml(device.employee_type || 'Teaching');
    const typeBadge = safeType === 'Non-Teaching' ? 'ba' : 'bt2';
    const hasRfid = Boolean(String(device.rfid_uid || '').trim());
    const rfidDisplay = hasRfid ? escapeHtml(device.rfid_uid) : '—';
    const rfidBadge = hasRfid ? 'bg' : 'ba';
    const rfidStatus = hasRfid ? 'Assigned' : 'Unassigned';
    const deviceId = escapeHtml(device.id);
    const isArchived = device.archived;

    if (isArchived) return '';

    return `
      <tr>
        <td class="nm">${safeName}</td>
        <td class="mn">${safeEmpId}</td>
        <td><span class="badge ${typeBadge}">${safeType}</span></td>
        <td class="mn" style="font-family:var(--mono);font-size:12px;">${rfidDisplay}</td>
        <td><span class="badge ${rfidBadge}"><span class="bd"></span>${rfidStatus}</span></td>
        <td>
          <button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openRfidEditModal('${deviceId}')">
            ${hasRfid ? 'Update' : 'Assign'}
          </button>
          ${hasRfid ? `<button class="btn btn-red" style="font-size:11px;padding:5px 11px;margin-left:6px;" onclick="voidRfidCard('${deviceId}')">Void</button>` : ''}
        </td>
      </tr>
    `;
  }).filter(Boolean).join('');
}

function renderFilteredRfidDevices() {
  if (rfidPaginator) {
    rfidPaginator.setData(getFilteredRfidDevices().filter((d) => !d.archived));
  } else {
    renderRfidDevices(getFilteredRfidDevices().filter((d) => !d.archived));
  }
}

function setRfidDeviceSearch(value) {
  rfidDeviceSearch = String(value || '').trim();
  renderFilteredRfidDevices();
}

async function loadSystemData() {
  const rfidTbody = document.getElementById('adm-rfid-table-body');
  const securityTbody = document.getElementById('adm-security-events-body');

  if (rfidTbody) rfidTbody.innerHTML = skeletonRows(6);
  if (securityTbody) securityTbody.innerHTML = skeletonRows(5);

  try {
    const response = await fetch('/api/admin/system', { method: 'GET' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Failed to load system data');

    systemData = payload;
    allRfidDevices = payload.rfid_devices || [];

    renderSystemHealthPanels(payload);
    renderSecurityEvents(payload.recent_security_events || []);
    renderFilteredRfidDevices();
  } catch (error) {
    if (rfidTbody) {
      rfidTbody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
    if (securityTbody) {
      securityTbody.innerHTML = `<tr><td colspan="5" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function openRfidEditModal(employeeId) {
  const modal = document.getElementById('rfid-edit-modal');
  const form = document.getElementById('rfid-edit-form');
  if (!modal || !form) return;

  currentEditingRfid = allRfidDevices.find((d) => d.id === employeeId);
  if (!currentEditingRfid) {
    window.alert('Employee not found. Please refresh the list.');
    return;
  }

  form.elements.id.value = currentEditingRfid.id;
  form.elements.employee_display.value = `${currentEditingRfid.full_name} (${currentEditingRfid.employee_id || 'N/A'})`;
  form.elements.rfid_uid.value = currentEditingRfid.rfid_uid || '';

  const feedbackEl = document.getElementById('rfid-edit-feedback');
  if (feedbackEl) feedbackEl.textContent = '';

  modal.style.display = 'flex';

  // Auto-focus so a HID RFID reader's keystrokes land in the field immediately
  setTimeout(() => form.elements.rfid_uid?.select(), 0);
}

function closeRfidEditModal() {
  const modal = document.getElementById('rfid-edit-modal');
  if (modal) modal.style.display = 'none';
}

async function submitRfidUpdate(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  const feedbackEl = document.getElementById('rfid-edit-feedback');

  const payload = {
    id: String(formData.get('id') || '').trim(),
    rfid_uid: String(formData.get('rfid_uid') || '').trim(),
  };

  if (!payload.id) {
    if (feedbackEl) { feedbackEl.textContent = 'Employee ID is missing.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const response = await fetch('/api/admin/system', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to update RFID');

    if (feedbackEl) { feedbackEl.textContent = payload.rfid_uid ? 'RFID assigned successfully.' : 'RFID removed.'; feedbackEl.className = 'adm-feedback ok'; }
    window.pushNotification?.('RFID Updated', payload.rfid_uid ? 'RFID UID has been assigned to the employee.' : 'RFID UID has been removed.', 'success');
    await loadSystemData();
    setTimeout(() => closeRfidEditModal(), 500);
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save RFID';
  }
}

async function voidRfidCard(employeeId) {
  const device = allRfidDevices.find((d) => d.id === employeeId);
  if (!device) {
    window.alert('Employee not found. Please refresh the list.');
    return;
  }

  const confirmed = window.confirmDestructiveAction
    ? await window.confirmDestructiveAction(`void the RFID card for ${device.full_name}`, 'The employee will no longer be able to tap in with this card.')
    : window.confirm(`Void the RFID card for ${device.full_name}?`);
  if (!confirmed) return;

  try {
    const response = await fetch('/api/admin/system', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: employeeId, rfid_uid: '' }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to void RFID card.');

    window.pushNotification?.('RFID Voided', `RFID card for ${device.full_name} has been voided.`, 'success');
    await loadSystemData();
  } catch (error) {
    window.pushNotification?.('Error', error.message, 'error');
  }
}

/* ── INIT ── */
function initAdminPortal() {
  const currentRole = new URLSearchParams(window.location.search).get('role');
  if (String(currentRole || '').toLowerCase() !== 'admin') {
    return;
  }

  applyAdminIdentity();

  attachSidebarSpotlight(document.querySelector('#s-admin .sidebar'));

  attPaginator = window.createPaginator({ id: 'adm-att', pageSize: 15, renderFn: renderAttendanceTable });
  auditPaginator = window.createPaginator({ id: 'adm-audit', pageSize: 20, renderFn: renderAuditTable });
  usersPaginator = window.createPaginator({ id: 'adm-users', pageSize: 20, renderFn: renderUsers });
  rfidPaginator = window.createPaginator({ id: 'adm-rfid', pageSize: 15, renderFn: renderRfidDevices });
  branchPaginator = window.createPaginator({ id: 'ba', pageSize: 20, renderFn: renderBranchTable });

  attachRfidScannerInput();

  const addUserForm = document.getElementById('add-user-form');
  if (addUserForm?.elements?.role) {
    addUserForm.elements.role.addEventListener('change', (e) => onAddUserRoleChange(e.target.value));
  }

  setupNameFieldValidation();
  setupSalaryFieldValidation();
  setupGovIdBankFieldValidation();

  const savedPage = window.getPersistedRolePageState
    ? window.getPersistedRolePageState('admin')
    : '';
  const initialPage = ADMIN_PAGES[savedPage] ? savedPage : 'adm-dashboard';
  const initialNav = getAdminNavByPageId(initialPage);

  adminNav(initialPage, initialNav);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminPortal);
} else {
  initAdminPortal();
}

window.addEventListener('sacs-auth-context-changed', handleLegacyAuthContextChange);

/* ═══════════════════════════════════════
   BRANCH ASSIGNMENT
   ═══════════════════════════════════════ */

const BRANCH_CARD_COLORS = ['a', 'b', 't', 'g', 'r'];
const BRANCH_BADGE_COLORS = ['var(--amber)', 'var(--blue)', 'var(--teal)', 'var(--green)', 'var(--red)'];

function renderBranchFilterUI() {
  if (branchFilter !== 'all' && branchFilter !== 'unassigned' && !admAssignBranches.some((b) => b.id === branchFilter)) {
    branchFilter = 'all';
  }

  const cardsEl = document.getElementById('ba-branch-cards');
  if (cardsEl) {
    let html = `
      <div class="card"><div class="ct">Total Employees</div><div class="cv" id="ba-count-total">0</div><div class="cch">All active employees</div></div>
      <div class="card"><div class="ct">Unassigned</div><div class="cv r" id="ba-count-unassigned">0</div><div class="cch">Not yet in a branch</div></div>
    `;
    admAssignBranches.forEach((b, i) => {
      const colorClass = BRANCH_CARD_COLORS[i % BRANCH_CARD_COLORS.length];
      html += `<div class="card"><div class="ct">${escapeHtml(b.name)}</div><div class="cv ${colorClass}" id="ba-count-${escapeHtml(b.id)}">0</div><div class="cch">Branch campus</div></div>`;
    });
    cardsEl.innerHTML = html;
  }

  const chipsEl = document.getElementById('ba-filter-chips');
  if (!chipsEl) return;

  let chipsHtml = `
    <div class="chip ${branchFilter === 'all' ? 'active' : ''}" data-bf="all" onclick="setBranchFilter('all')">All (0)</div>
    <div class="chip ${branchFilter === 'unassigned' ? 'active' : ''}" data-bf="unassigned" onclick="setBranchFilter('unassigned')">Unassigned (0)</div>
  `;

  if (admAssignBranches.length) {
    admAssignBranches.forEach((b) => {
      const isActive = branchFilter === b.id;
      chipsHtml += `<div class="chip ${isActive ? 'active' : ''}" data-bf="${escapeHtml(b.id)}" onclick="setBranchFilter('${escapeJsString(b.id)}')">${escapeHtml(b.name)} (0)</div>`;
    });
  } else {
    chipsHtml += `<span style="font-size:12px;color:var(--t3);padding:4px 8px;align-self:center;">No active branches configured — add one in Branch Management first.</span>`;
  }

  chipsEl.innerHTML = chipsHtml;
}

function updateBranchSummary() {
  const total = branchAllEmployees.length;
  const unassigned = branchAllEmployees.filter((e) => !e.branch).length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  set('ba-count-total', total);
  set('ba-count-unassigned', unassigned);

  const countsByBranch = {};
  admAssignBranches.forEach((b) => {
    countsByBranch[b.id] = branchAllEmployees.filter((e) => e.branch === b.id).length;
    set(`ba-count-${b.id}`, countsByBranch[b.id]);
  });

  document.querySelectorAll('#ba-filter-chips .chip').forEach((chip) => {
    const bf = chip.getAttribute('data-bf');
    if (bf === 'all')             chip.textContent = `All (${total})`;
    else if (bf === 'unassigned') chip.textContent = `Unassigned (${unassigned})`;
    else {
      const branch = admAssignBranches.find((b) => b.id === bf);
      chip.textContent = `${branch ? branch.name : 'Branch'} (${countsByBranch[bf] ?? 0})`;
    }
  });
}

function getFilteredBranchEmployees() {
  const search = branchSearch.toLowerCase();
  return branchAllEmployees.filter((e) => {
    if (branchFilter === 'unassigned') { if (e.branch) return false; }
    else if (branchFilter !== 'all')   { if (e.branch !== branchFilter) return false; }
    if (!search) return true;
    const hay = [e.full_name, e.employee_id, e.email].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.includes(search);
  });
}

function renderBranchTable(employees) {
  const tbody = document.getElementById('ba-table-body');
  if (!tbody) return;

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--t3);">No employees found.</td></tr>`;
    return;
  }

  tbody.innerHTML = employees.map((emp) => {
    const initials = getInitials(emp.full_name);
    const avatarColor = getAvatarColor(emp.email || emp.id);
    const branchIdx = emp.branch ? admAssignBranches.findIndex((b) => b.id === emp.branch) : -1;
    const branchColor = branchIdx >= 0 ? BRANCH_BADGE_COLORS[branchIdx % BRANCH_BADGE_COLORS.length] : 'var(--t3)';
    const inactiveTag = emp.branch && emp.branch_status && emp.branch_status !== 'Active' ? ' (Inactive)' : '';
    const branchCell = emp.branch
      ? `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${branchColor}22;color:${branchColor};border:1px solid ${branchColor}55;">${escapeHtml((emp.branch_label || 'Unknown branch') + inactiveTag)}</span>`
      : `<span class="badge br"><span class="bd"></span>Unassigned</span>`;
    const assignedAt = emp.assigned_at ? formatDateTime(emp.assigned_at) : '—';
    const typeClass = emp.employee_type === 'Non-Teaching' ? 'ba' : 'bt2';
    const safeId = escapeJsString(emp.id);
    const actionBtn = emp.branch
      ? `<button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openBranchAssignModal('${safeId}')">Reassign</button>`
      : `<button class="btn btn-primary" style="font-size:11px;padding:5px 11px;" onclick="openBranchAssignModal('${safeId}')">Assign</button>`;

    return `
      <tr>
        <td class="nm">
          <div style="display:flex;align-items:center;gap:9px;">
            <div class="av" style="width:28px;height:28px;font-size:10px;background:${avatarColor};">${initials}</div>
            ${escapeHtml(emp.full_name)}
          </div>
        </td>
        <td class="mn">${escapeHtml(emp.employee_id || '—')}</td>
        <td><span class="badge ${typeClass}">${escapeHtml(emp.employee_type || 'Teaching')}</span></td>
        <td class="mn">${escapeHtml(emp.position || '—')}</td>
        <td>${branchCell}</td>
        <td class="mn" style="font-size:11px;">${escapeHtml(assignedAt)}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

function renderFilteredBranchEmployees() {
  updateBranchSummary();
  if (branchPaginator) {
    branchPaginator.setData(getFilteredBranchEmployees());
  } else {
    renderBranchTable(getFilteredBranchEmployees());
  }
}

function setBranchFilter(filter) {
  branchFilter = filter;
  document.querySelectorAll('#ba-filter-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.getAttribute('data-bf') === filter);
  });
  renderFilteredBranchEmployees();
}

function setBranchSearch(value) {
  branchSearch = String(value || '').trim();
  renderFilteredBranchEmployees();
}

async function loadBranchAssignment() {
  const tbody = document.getElementById('ba-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  try {
    const [branchRes] = await Promise.allSettled([fetch('/api/admin/branches')]);
    if (branchRes.status === 'fulfilled' && branchRes.value.ok) {
      const bd = await branchRes.value.json();
      admAssignBranches = (bd.branches || []).filter((b) => b.status === 'Active');
    }
    renderBranchFilterUI();

    const response = await fetch('/api/admin/branch-employees', { method: 'GET' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Failed to load branch assignments');

    branchAllEmployees = payload.employees || [];
    renderFilteredBranchEmployees();
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function openBranchAssignModal(userId) {
  const modal = document.getElementById('branch-assign-modal');
  const form = document.getElementById('branch-assign-form');
  if (!modal || !form) return;

  currentBranchEmployee = branchAllEmployees.find((e) => e.id === userId);
  if (!currentBranchEmployee) {
    window.alert('Employee not found. Please refresh.');
    return;
  }

  const titleEl = document.getElementById('ba-modal-title');
  if (titleEl) titleEl.textContent = currentBranchEmployee.branch ? 'Reassign Branch' : 'Assign Branch';

  form.elements.user_id.value = currentBranchEmployee.id;
  form.elements.employee_display.value = `${currentBranchEmployee.full_name} (${currentBranchEmployee.employee_id || 'N/A'})`;

  const branchSelect = form.elements.branch;
  if (branchSelect) {
    // Always offer active branches; also include the employee's current branch even if
    // it has since gone inactive, so reassigning away from it stays possible.
    const options = [...admAssignBranches];
    if (currentBranchEmployee.branch && !options.some((b) => b.id === currentBranchEmployee.branch)) {
      options.push({ id: currentBranchEmployee.branch, name: `${currentBranchEmployee.branch_label || 'Unknown branch'} (Inactive)` });
    }

    if (options.length) {
      branchSelect.innerHTML = options.map((b) =>
        `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`
      ).join('');
    } else {
      branchSelect.innerHTML = '<option value="" disabled>No branches configured yet.</option>';
    }
    if (currentBranchEmployee.branch) branchSelect.value = currentBranchEmployee.branch;
  }

  const feedbackEl = document.getElementById('ba-modal-feedback');
  if (feedbackEl) feedbackEl.textContent = '';

  modal.style.display = 'flex';
}

function closeBranchAssignModal() {
  const modal = document.getElementById('branch-assign-modal');
  if (modal) modal.style.display = 'none';
}

async function submitBranchAssign(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const feedbackEl = document.getElementById('ba-modal-feedback');
  const formData = new FormData(form);

  const userId = String(formData.get('user_id') || '').trim();
  const branchId = String(formData.get('branch') || '').trim();

  if (!userId || !branchId) {
    if (feedbackEl) { feedbackEl.textContent = 'Missing required fields.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const ctx = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const assignedBy = String(ctx?.full_name || ctx?.email || 'admin').trim();

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Assigning...';

    const response = await fetch('/api/admin/branch-employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, branch_id: branchId, assigned_by: assignedBy }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to assign branch');

    if (feedbackEl) { feedbackEl.textContent = `Employee assigned to ${result.branch_label}.`; feedbackEl.className = 'adm-feedback ok'; }
    window.pushNotification?.('Branch Assigned', `Employee assigned to ${result.branch_label}.`, 'success');
    await loadBranchAssignment();
    setTimeout(() => closeBranchAssignModal(), 600);
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm Assignment';
  }
}

/* ═══════════════════════════════════════
   ADMIN BRANCH MANAGEMENT
   ═══════════════════════════════════════ */

async function loadAdmBranches() {
  const grid = document.getElementById('adm-branch-grid');
  if (!grid) return;

  try {
    const [branchRes, staffRes] = await Promise.allSettled([
      fetch('/api/admin/branches'),
      fetch('/api/admin/dashboard'),
    ]);

    if (branchRes.status === 'fulfilled' && branchRes.value.ok) {
      const d = await branchRes.value.json();
      admBranches = d.branches || [];
    } else {
      admBranches = [];
    }

    const staffCountEl = document.getElementById('adm-branch-staff');
    if (staffRes.status === 'fulfilled' && staffRes.value.ok) {
      const d = await staffRes.value.json();
      if (staffCountEl) staffCountEl.textContent = d.total_employees ?? d.totalEmployees ?? '—';
    }
  } catch {}

  renderAdmBranchGrid();
}

function renderAdmBranchGrid() {
  const grid = document.getElementById('adm-branch-grid');
  if (!grid) return;

  const totalEl = document.getElementById('adm-branch-total');
  const activeEl = document.getElementById('adm-branch-active');
  if (totalEl) totalEl.textContent = admBranches.length;
  if (activeEl) activeEl.textContent = admBranches.filter((b) => b.status === 'Active').length;

  if (!admBranches.length) {
    grid.innerHTML = '<p style="color:var(--t3);grid-column:1/-1;">No branches configured yet.</p>';
    return;
  }

  grid.innerHTML = admBranches.map((b) => {
    const statusColor = b.status === 'Active' ? 'var(--green)' : 'var(--red)';
    return `<div class="branch-card">
      <div class="branch-name">${escapeHtml(b.name)}</div>
      <div class="branch-meta">${escapeHtml(b.location)}</div>
      <div class="branch-meta">Code: <code style="font-size:11px;">${escapeHtml(b.code || '—')}</code></div>
      <div style="margin-top:4px;"><span class="badge" style="color:${statusColor};background:${statusColor}20;border:1px solid ${statusColor}40;">${escapeHtml(b.status)}</span></div>
      <div class="branch-actions" style="margin-top:8px;">
        <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="openAdmBranchModal(${JSON.stringify(b).replace(/"/g,'&quot;')})">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function openAdmBranchModal(branch) {
  const modal = document.getElementById('adm-branch-modal');
  const form = document.getElementById('adm-branch-form');
  const title = document.getElementById('adm-branch-modal-title');
  const fb = document.getElementById('adm-branch-feedback');
  if (!modal || !form) return;

  if (fb) { fb.textContent = ''; fb.className = 'adm-feedback'; }

  const codeEl = form.querySelector('[name="code"]');

  if (branch && typeof branch === 'object') {
    if (title) title.textContent = 'Edit Branch';
    form.querySelector('[name="id"]').value = branch.id || '';
    form.querySelector('[name="name"]').value = branch.name || '';
    if (codeEl) {
      codeEl.value = branch.code || '';
      // Branch Code is the branch's identifier — locked once a branch exists.
      codeEl.readOnly = true;
      codeEl.style.background = 'var(--bg3)';
      codeEl.style.cursor = 'default';
    }
    const statusEl = form.querySelector('[name="status"]');
    if (statusEl) statusEl.value = branch.status || 'Active';
    populateAdmBranchLocationSelects(branch.location || '');
  } else {
    if (title) title.textContent = 'Add Branch';
    form.reset();
    form.querySelector('[name="id"]').value = '';
    if (codeEl) {
      codeEl.readOnly = false;
      codeEl.style.background = '';
      codeEl.style.cursor = '';
    }
    const regionEl = document.getElementById('adm-branch-region');
    const provinceEl = document.getElementById('adm-branch-province');
    const cityEl = document.getElementById('adm-branch-city');
    const barangayEl = document.getElementById('adm-branch-barangay');
    if (regionEl) regionEl.value = '';
    if (provinceEl) provinceEl.innerHTML = '<option value="">Select Province / District</option>';
    if (cityEl) cityEl.innerHTML = '<option value="">Select City / Municipality</option>';
    if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
  }

  modal.style.display = 'flex';
}

function closeAdmBranchModal() {
  const modal = document.getElementById('adm-branch-modal');
  if (modal) modal.style.display = 'none';
}

function onAdmBranchRegionChange() {
  const regionEl = document.getElementById('adm-branch-region');
  const provinceEl = document.getElementById('adm-branch-province');
  const cityEl = document.getElementById('adm-branch-city');
  const barangayEl = document.getElementById('adm-branch-barangay');
  if (!regionEl || !provinceEl) return;
  const provinces = PH_PROVINCES[regionEl.value] || [];
  provinceEl.innerHTML = '<option value="">Select Province / District</option>' +
    provinces.map((p) => `<option value="${p}">${p}</option>`).join('');
  if (cityEl) cityEl.innerHTML = '<option value="">Select City / Municipality</option>';
  if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
}

function onAdmBranchProvinceChange() {
  const provinceEl = document.getElementById('adm-branch-province');
  const cityEl = document.getElementById('adm-branch-city');
  const barangayEl = document.getElementById('adm-branch-barangay');
  if (!provinceEl || !cityEl) return;
  const cities = PH_CITIES[provinceEl.value] || [];
  cityEl.innerHTML = '<option value="">Select City / Municipality</option>' +
    cities.map((c) => `<option value="${c}">${c}</option>`).join('');
  if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
}

function onAdmBranchCityChange() {
  const cityEl = document.getElementById('adm-branch-city');
  const barangayEl = document.getElementById('adm-branch-barangay');
  if (!cityEl || !barangayEl) return;
  const barangays = PH_BARANGAYS[cityEl.value] || [];
  barangayEl.innerHTML = '<option value="">Select Barangay</option>' +
    barangays.map((b) => `<option value="${b}">${b}</option>`).join('');
}

function populateAdmBranchLocationSelects(locationStr) {
  const regionEl = document.getElementById('adm-branch-region');
  const provinceEl = document.getElementById('adm-branch-province');
  const cityEl = document.getElementById('adm-branch-city');
  const barangayEl = document.getElementById('adm-branch-barangay');
  if (!regionEl) return;

  const parts = locationStr.split(',').map((s) => s.trim()).filter(Boolean);
  const region = PH_REGIONS.find((r) => parts.includes(r)) ||
    PH_REGIONS.find((r) => locationStr.includes(r)) || '';
  regionEl.value = region;
  onAdmBranchRegionChange();

  if (region && provinceEl) {
    const province = (PH_PROVINCES[region] || []).find((p) => parts.includes(p)) ||
      (PH_PROVINCES[region] || []).find((p) => locationStr.includes(p)) || '';
    provinceEl.value = province;
    onAdmBranchProvinceChange();

    if (province && cityEl) {
      const city = (PH_CITIES[province] || []).find((c) => parts.includes(c)) ||
        (PH_CITIES[province] || []).find((c) => locationStr.includes(c)) || '';
      cityEl.value = city;
      onAdmBranchCityChange();

      if (city && barangayEl) {
        const barangays = PH_BARANGAYS[city] || [];
        const barangay = barangays.find((b) => parts.includes(b)) ||
          barangays.find((b) => locationStr.startsWith(b + ',')) || '';
        if (barangay) barangayEl.value = barangay;
      }
    }
  }
}

async function submitAdmBranch(event) {
  event.preventDefault();
  const form = event.target;
  const fb = document.getElementById('adm-branch-feedback');

  const id = form.querySelector('[name="id"]').value;
  const region = (document.getElementById('adm-branch-region')?.value || '').trim();
  const province = (document.getElementById('adm-branch-province')?.value || '').trim();
  const city = (document.getElementById('adm-branch-city')?.value || '').trim();
  const barangay = (document.getElementById('adm-branch-barangay')?.value || '').trim();
  const location = [barangay, city, province, region].filter(Boolean).join(', ');
  const payload = {
    name: form.querySelector('[name="name"]').value.trim(),
    location,
    code: form.querySelector('[name="code"]').value.trim(),
    status: form.querySelector('[name="status"]').value,
  };

  if (!payload.name || !city) {
    if (fb) { fb.textContent = 'Branch name and city / municipality are required.'; fb.style.color = 'var(--red)'; }
    return;
  }

  if (fb) { fb.textContent = 'Saving...'; fb.style.color = 'var(--t3)'; }

  try {
    const res = await fetch('/api/admin/branches', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id, ...payload } : payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save branch.');

    if (id) {
      const idx = admBranches.findIndex((b) => b.id === id);
      if (idx !== -1) admBranches[idx] = data.branch || { id, ...payload };
    } else {
      admBranches.push(data.branch || { id: `branch-${Date.now()}`, ...payload });
    }

    if (fb) { fb.textContent = 'Branch saved.'; fb.style.color = 'var(--green)'; }
    setTimeout(() => {
      closeAdmBranchModal();
      renderAdmBranchGrid();
    }, 600);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

const PH_REGIONS = [
  'NCR','Region I','CAR','Region II','Region III',
  'Region IV-A (CALABARZON)','Region IV-B (MIMAROPA)',
  'Region V','Region VI','Region VII','Region VIII',
  'Region IX','Region X','Region XI','Region XII',
  'Region XIII (CARAGA)','BARMM',
];

const PH_PROVINCES = {
  'NCR':['Metro Manila'],
  'Region I':['Ilocos Norte','Ilocos Sur','La Union','Pangasinan'],
  'CAR':['Abra','Apayao','Benguet','Ifugao','Kalinga','Mountain Province'],
  'Region II':['Batanes','Cagayan','Isabela','Nueva Vizcaya','Quirino'],
  'Region III':['Aurora','Bataan','Bulacan','Nueva Ecija','Pampanga','Tarlac','Zambales'],
  'Region IV-A (CALABARZON)':['Batangas','Cavite','Laguna','Quezon','Rizal'],
  'Region IV-B (MIMAROPA)':['Marinduque','Occidental Mindoro','Oriental Mindoro','Palawan','Romblon'],
  'Region V':['Albay','Camarines Norte','Camarines Sur','Catanduanes','Masbate','Sorsogon'],
  'Region VI':['Aklan','Antique','Capiz','Guimaras','Iloilo','Negros Occidental'],
  'Region VII':['Bohol','Cebu','Negros Oriental','Siquijor'],
  'Region VIII':['Biliran','Eastern Samar','Leyte','Northern Samar','Samar','Southern Leyte'],
  'Region IX':['Zamboanga del Norte','Zamboanga del Sur','Zamboanga Sibugay'],
  'Region X':['Bukidnon','Camiguin','Lanao del Norte','Misamis Occidental','Misamis Oriental'],
  'Region XI':['Davao de Oro','Davao del Norte','Davao del Sur','Davao Occidental','Davao Oriental'],
  'Region XII':['Cotabato','Sarangani','South Cotabato','Sultan Kudarat'],
  'Region XIII (CARAGA)':['Agusan del Norte','Agusan del Sur','Dinagat Islands','Surigao del Norte','Surigao del Sur'],
  'BARMM':['Basilan','Lanao del Sur','Maguindanao del Norte','Maguindanao del Sur','Sulu','Tawi-Tawi'],
};

const PH_CITIES = {
  'Metro Manila':['Caloocan','Las Piñas','Makati','Malabon','Mandaluyong','Manila','Marikina','Muntinlupa','Navotas','Parañaque','Pasay','Pasig','Pateros','Quezon City','San Juan','Taguig','Valenzuela'],
  'Ilocos Norte':['Adams','Bacarra','Badoc','Bangui','Banna','Burgos','Carasi','Currimao','Dingras','Dumalneg','Laoag City','Marcos','Nueva Era','Pagudpud','Paoay','Pasuquin','Piddig','Pinili','San Nicolas','Sarrat','Solsona','Vintar'],
  'Ilocos Sur':['Alilem','Banayoyo','Bantay','Burgos','Cabugao','Candon City','Caoayan','Cervantes','Galimuyod','Gregorio del Pilar','Lidlidda','Magsingal','Nagbukel','Narvacan','Quirino','Salcedo','San Emilio','San Esteban','San Ildefonso','San Juan','San Vicente','Santa','Santa Catalina','Santa Cruz','Santa Lucia','Santa Maria','Santiago','Sigay','Sinait','Sugpon','Suyo','Tagudin','Vigan City'],
  'La Union':['Agoo','Aringay','Bacnotan','Bagulin','Balaoan','Bangar','Bauang','Burgos','Caba','Luna','Naguilian','Pugo','Rosario','San Fernando City','San Gabriel','San Juan','Santo Tomas','Santol','Sudipen','Tubao'],
  'Pangasinan':['Agno','Aguilar','Alaminos City','Alcala','Anda','Asingan','Balungao','Bani','Basista','Bautista','Bayambang','Binalonan','Binmaley','Bolinao','Bugallon','Burgos','Calasiao','Dagupan City','Dasol','Infanta','Labrador','Laoac','Lingayen','Mabini','Malasiqui','Manaoag','Mangaldan','Mangatarem','Mapandan','Natividad','Pozzorubio','Rosales','San Carlos City','San Fabian','San Jacinto','San Manuel','San Nicolas','San Quintin','Santa Barbara','Santa Maria','Santo Tomas','Sison','Sual','Tayug','Umingan','Urbiztondo','Urdaneta City','Villasis'],
  'Abra':['Bangued','Boliney','Bucay','Bucloc','Daguioman','Danglas','Dolores','La Paz','Lacub','Lagangilang','Lagayan','Langiden','Licuan-Baay','Luba','Malibcong','Manabo','Penarrubia','Pidigan','Pilar','Sallapadan','San Isidro','San Juan','San Quintin','Tayum','Tineg','Tubo','Villaviciosa'],
  'Apayao':['Calanasan','Conner','Flora','Kabugao','Luna','Pudtol','Santa Marcela'],
  'Benguet':['Atok','Baguio City','Bakun','Bokod','Buguias','Itogon','Kabayan','Kapangan','Kibungan','La Trinidad','Mankayan','Sablan','Tuba','Tublay'],
  'Ifugao':['Aguinaldo','Alfonso Lista','Asipulo','Banaue','Hingyon','Hungduan','Kiangan','Lagawe','Lamut','Mayoyao','Tinoc'],
  'Kalinga':['Balbalan','Lubuagan','Pasil','Pinukpuk','Rizal','Tanudan','Tinglayan','Tabuk City'],
  'Mountain Province':['Barlig','Bauko','Besao','Bontoc','Natonin','Paracelis','Sabangan','Sadanga','Sagada','Tadian'],
  'Batanes':['Basco','Itbayat','Ivana','Mahatao','Sabtang','Uyugan'],
  'Cagayan':['Abulug','Alcala','Allacapan','Amulung','Aparri','Baggao','Ballesteros','Buguey','Calayan','Camalaniugan','Claveria','Enrile','Gattaran','Gonzaga','Iguig','Lal-lo','Lasam','Pamplona','Penablanca','Piat','Rizal','Sanchez-Mira','Santa Ana','Santa Praxedes','Santa Teresita','Santo Nino','Solana','Tuao','Tuguegarao City'],
  'Isabela':['Alicia','Angadanan','Aurora','Benito Soliven','Burgos','Cabagan','Cabatuan','Cauayan City','Cordon','Delfin Albano','Dinapigue','Divilacan','Echague','Gamu','Ilagan City','Jones','Luna','Maconacon','Mallig','Naguilian','Palanan','Quezon','Quirino','Ramon','Reina Mercedes','Roxas','San Agustin','San Guillermo','San Isidro','San Manuel','San Mariano','San Mateo','San Pablo','Santa Maria','Santiago City','Santo Tomas','Tumauini'],
  'Nueva Vizcaya':['Alfonso Castaneda','Ambaguio','Aritao','Bagabag','Bambang','Bayombong','Diadi','Dupax del Norte','Dupax del Sur','Kasibu','Kayapa','Quezon','Santa Fe','Solano','Villaverde'],
  'Quirino':['Aglipay','Cabarroguis','Diffun','Maddela','Nagtipunan','Saguday'],
  'Aurora':['Baler','Casiguran','Dilasag','Dinalungan','Dingalan','Dipaculao','Maria Aurora','San Luis'],
  'Bataan':['Abucay','Bagac','Balanga City','Dinalupihan','Hermosa','Limay','Mariveles','Morong','Orani','Orion','Pilar','Samal'],
  'Bulacan':['Angat','Balagtas','Baliuag','Bocaue','Bulacan','Bustos','Calumpit','Dona Remedios Trinidad','Guiguinto','Hagonoy','Malolos City','Marilao','Meycauayan City','Norzagaray','Obando','Pandi','Paombong','Plaridel','Pulilan','San Ildefonso','San Jose del Monte City','San Miguel','San Rafael','Santa Maria'],
  'Nueva Ecija':['Aliaga','Bongabon','Cabanatuan City','Cabiao','Carranglan','Cuyapo','Gabaldon','Gapan City','General Mamerto Natividad','General Tinio','Guimba','Jaen','Laur','Licab','Llanera','Lupao','Munoz City','Nampicuan','Palayan City','Pantabangan','Penaranda','Quezon','Rizal','San Antonio','San Isidro','San Jose City','San Leonardo','Santa Rosa','Santo Domingo','Talavera','Talugtug','Zaragoza'],
  'Pampanga':['Angeles City','Apalit','Arayat','Bacolor','Candaba','Floridablanca','Guagua','Lubao','Mabalacat City','Macabebe','Magalang','Masantol','Mexico','Minalin','Porac','San Fernando City','San Luis','San Simon','Santa Ana','Santa Rita','Santo Tomas','Sasmuan'],
  'Tarlac':['Anao','Bamban','Camiling','Capas','Concepcion','Gerona','La Paz','Mayantoc','Moncada','Paniqui','Pura','Ramos','San Clemente','San Jose','San Manuel','Santa Ignacia','Tarlac City','Victoria'],
  'Zambales':['Botolan','Cabangan','Candelaria','Castillejos','Iba','Masinloc','Olongapo City','Palauig','San Antonio','San Felipe','San Marcelino','San Narciso','Santa Cruz','Subic'],
  'Batangas':['Agoncillo','Alitagtag','Balayan','Balete','Batangas City','Bauan','Calaca','Calatagan','Cuenca','Ibaan','Laurel','Lemery','Lian','Lipa City','Lobo','Mabini','Malvar','Mataas na Kahoy','Nasugbu','Padre Garcia','Rosario','San Jose','San Juan','San Luis','San Nicolas','San Pascual','Santa Teresita','Santo Tomas','Taal','Talisay','Tanauan City','Taysan','Tingloy','Tuy'],
  'Cavite':['Alfonso','Amadeo','Bacoor City','Carmona','Cavite City','Dasmarinas City','General Emilio Aguinaldo','General Mariano Alvarez','General Trias City','Imus City','Indang','Kawit','Magallanes','Maragondon','Mendez','Naic','Noveleta','Rosario','Silang','Tagaytay City','Tanza','Ternate','Trece Martires City'],
  'Laguna':['Alaminos','Bay','Binan City','Cabuyao City','Calamba City','Calauan','Cavinti','Famy','Kalayaan','Liliw','Los Banos','Luisiana','Lumban','Mabitac','Magdalena','Majayjay','Nagcarlan','Paete','Pagsanjan','Pakil','Pangil','Pila','Rizal','San Pablo City','San Pedro City','Santa Cruz','Santa Maria','Santa Rosa City','Siniloan','Victoria'],
  'Quezon':['Agdangan','Alabat','Atimonan','Buenavista','Burdeos','Calauag','Candelaria','Catanauan','Dolores','General Luna','General Nakar','Guinayangan','Gumaca','Infanta','Jomalig','Lopez','Lucban','Lucena City','Macalelon','Mauban','Mulanay','Padre Burgos','Pagbilao','Panukulan','Patnanungan','Perez','Pitogo','Plaridel','Polillo','Real','Sampaloc','San Andres','San Antonio','San Francisco','San Narciso','Sariaya','Tagkawayan','Tayabas City','Tiaong','Unisan'],
  'Rizal':['Angono','Antipolo City','Baras','Binangonan','Cainta','Cardona','Jalajala','Morong','Pililla','Rodriguez','San Mateo','Tanay','Taytay','Teresa'],
  'Marinduque':['Boac','Buenavista','Gasan','Mogpog','Santa Cruz','Torrijos'],
  'Occidental Mindoro':['Abra de Ilog','Calintaan','Looc','Lubang','Magsaysay','Mamburao','Paluan','Rizal','Sablayan','San Jose','Santa Cruz'],
  'Oriental Mindoro':['Baco','Bansud','Bongabong','Bulalacao','Calapan City','Gloria','Mansalay','Naujan','Pinamalayan','Pola','Puerto Galera','Roxas','San Teodoro','Socorro','Victoria'],
  'Palawan':['Aborlan','Agutaya','Araceli','Balabac','Bataraza','Brookes Point','Busuanga','Cagayancillo','Coron','Culion','Cuyo','Dumaran','El Nido','Kalayaan','Linapacan','Magsaysay','Narra','Puerto Princesa City','Quezon','Rizal','Roxas','San Vicente','Sofronio Espanola','Taytay','Turtle Islands'],
  'Romblon':['Alcantara','Banton','Cajidiocan','Calatrava','Concepcion','Corcuera','Ferrol','Looc','Magdiwang','Odiongan','Romblon','San Agustin','San Andres','San Fernando','San Jose','Santa Fe','Santa Maria'],
  'Albay':['Bacacay','Camalig','Daraga','Guinobatan','Jovellar','Legazpi City','Libon','Ligao City','Malilipot','Malinao','Manito','Oas','Pio Duran','Polangui','Rapu-Rapu','Santo Domingo','Tiwi'],
  'Camarines Norte':['Basud','Capalonga','Daet','Jose Panganiban','Labo','Mercedes','Paracale','San Lorenzo Ruiz','San Vicente','Santa Elena','Talisay','Vinzons'],
  'Camarines Sur':['Baao','Balatan','Bato','Bombon','Buhi','Bula','Cabusao','Calabanga','Camaligan','Canaman','Caramoan','Del Gallego','Gainza','Garchitorena','Goa','Iriga City','Lagonoy','Libmanan','Lupi','Magarao','Milaor','Minalabac','Nabua','Naga City','Ocampo','Pamplona','Pasacao','Pili','Presentacion','Ragay','Sagnas','San Fernando','San Jose','Sipocot','Siruma','Tigaon','Tinambac'],
  'Catanduanes':['Bagamanoc','Baras','Bato','Caramoran','Gigmoto','Pandan','Panganiban','San Andres','San Miguel','Viga','Virac'],
  'Masbate':['Aroroy','Baleno','Balud','Batuan','Cataingan','Cawayan','Claveria','Dimasalang','Esperanza','Mandaon','Masbate City','Milagros','Mobo','Monreal','Palanas','Pio V. Corpuz','Placer','San Fernando','San Jacinto','San Pascual','Uson'],
  'Sorsogon':['Barcelona','Bulan','Bulusan','Casiguran','Castilla','Donsol','Gubat','Irosin','Juban','Magallanes','Matnog','Pilar','Prieto Diaz','Santa Magdalena','Sorsogon City'],
  'Aklan':['Altavas','Balete','Banga','Batan','Buruanga','Ibajay','Kalibo','Lezo','Libacao','Madalag','Makato','Malay','Malinao','Nabas','New Washington','Numancia','Tangalan'],
  'Antique':['Anini-y','Barbaza','Belison','Bugasong','Caluya','Culasi','Hamtic','Laua-an','Libertad','Pandan','Patnongon','San Jose de Buenavista','San Remigio','Sebaste','Sibalom','Tibiao','Tobias Fornier','Valderrama'],
  'Capiz':['Cuartero','Dao','Dumalag','Dumarao','Ivisan','Jamindan','Ma-ayon','Mambusao','Panay','Panitan','Pilar','Pontevedra','President Roxas','Roxas City','Sapi-an','Sigma','Tapaz'],
  'Guimaras':['Buenavista','Jordan','Nueva Valencia','San Lorenzo','Sibunag'],
  'Iloilo':['Ajuy','Alimodian','Anilao','Badiangan','Balasan','Banate','Barotac Nuevo','Barotac Viejo','Batad','Bingawan','Cabatuan','Calinog','Carles','Concepcion','Dingle','Duenas','Dumangas','Estancia','Guimbal','Igbaras','Iloilo City','Janiuay','Lambunao','Leganes','Lemery','Leon','Maasin','Miagao','Mina','New Lucena','Oton','Passi City','Pavia','Pototan','San Dionisio','San Enrique','San Joaquin','San Miguel','San Rafael','Santa Barbara','Sara','Tigbauan','Tubungan','Zarraga'],
  'Negros Occidental':['Bacolod City','Bago City','Binalbagan','Cadiz City','Calatrava','Candoni','Cauayan','Don Salvador Benedicto','Enrique B. Magalona','Escalante City','Himamaylan City','Hinigaran','Hinoba-an','Ilog','Isabela','Kabankalan City','La Carlota City','La Castellana','Manapla','Moises Padilla','Murcia','Pontevedra','Pulupandan','Sagay City','San Carlos City','San Enrique','Silay City','Sipalay City','Talisay City','Toboso','Valladolid','Victorias City'],
  'Bohol':['Alburquerque','Alicia','Anda','Antequera','Baclayon','Balilihan','Batuan','Bien Unido','Bilar','Buenavista','Calape','Candijay','Carmen','Catigbian','Clarin','Corella','Cortes','Dagohoy','Danao','Dauis','Dimiao','Duero','Garcia Hernandez','Getafe','Guindulman','Inabanga','Jagna','Lila','Loay','Loboc','Loon','Mabini','Maribojoc','Panglao','Pilar','Sagbayan','San Isidro','San Miguel','Sevilla','Sierra Bullones','Sikatuna','Tagbilaran City','Talibon','Trinidad','Tubigon','Ubay','Valencia'],
  'Cebu':['Alcantara','Alcoy','Alegria','Aloguinsan','Argao','Asturias','Badian','Balamban','Bantayan','Barili','Bogo City','Boljoon','Borbon','Carcar City','Carmen','Catmon','Cebu City','Compostela','Consolacion','Cordova','Daanbantayan','Dalaguete','Danao City','Dumanjug','Ginatilan','Lapu-Lapu City','Liloan','Madridejos','Malabuyoc','Mandaue City','Medellin','Minglanilla','Moalboal','Naga City','Oslob','Pilar','Pinamungajan','Poro','Ronda','Samboan','San Fernando','San Francisco','San Remigio','Santa Fe','Santander','Sibonga','Sogod','Tabogon','Tabuelan','Talisay City','Toledo City','Tuburan','Tudela'],
  'Negros Oriental':['Amlan','Ayungon','Bacong','Bais City','Basay','Bayawan City','Bindoy','Canlaon City','Dauin','Dumaguete City','Guihulngan City','Jimalalud','La Libertad','Mabinay','Manjuyod','Pamplona','San Jose','Santa Catalina','Siaton','Sibulan','Tanjay City','Tayasan','Valencia','Vallehermoso','Zamboanguita'],
  'Siquijor':['Enrique Villanueva','Larena','Lazi','Maria','San Juan','Siquijor'],
  'Biliran':['Almeria','Biliran','Cabucgayan','Caibiran','Culaba','Kawayan','Maripipi','Naval'],
  'Eastern Samar':['Arteche','Balangiga','Balangkayan','Borongan City','Can-avid','Dolores','General MacArthur','Giporlos','Guiuan','Hernani','Jipapad','Lawaan','Llorente','Maslog','Maydolong','Mercedes','Oras','Quinapondan','Salcedo','San Julian','San Policarpo','Sulat','Taft'],
  'Leyte':['Abuyog','Alangalang','Albuera','Babatngon','Barugo','Bato','Baybay City','Burauen','Calubian','Capoocan','Carigara','Dagami','Dulag','Hilongos','Hindang','Inopacan','Isabel','Jaro','Javier','Julita','Kananga','La Paz','Leyte','MacArthur','Mahaplag','Matag-ob','Matalom','Mayorga','Merida','Ormoc City','Palo','Palompon','Pastrana','San Isidro','San Miguel','Santa Fe','Tabango','Tabontabon','Tacloban City','Tanauan','Tolosa','Tunga','Villaba'],
  'Northern Samar':['Allen','Biri','Bobon','Capul','Catarman','Catubig','Gamay','Laoang','Lapinig','Las Navas','Lavezares','Lope de Vega','Mapanas','Mondragon','Palapag','Pambujan','Rosario','San Antonio','San Isidro','San Jose','San Roque','San Vicente','Silvino Lobos','Victoria'],
  'Samar':['Almagro','Basey','Calbayog City','Calbiga','Catbalogan City','Daram','Gandara','Hinabangan','Jiabong','Marabut','Matuguinao','Motiong','Pagsanghan','Paranas','Pinabacdao','San Jorge','San Jose de Buan','San Sebastian','Santa Margarita','Santa Rita','Santo Nino','Tagapul-an','Talalora','Tarangnan','Villareal','Zumarraga'],
  'Southern Leyte':['Anahawan','Bontoc','Hinunangan','Hinundayan','Libagon','Liloan','Limasawa','Maasin City','Macrohon','Malitbog','Padre Burgos','Pintuyan','Saint Bernard','San Francisco','San Juan','San Ricardo','Silago','Sogod','Tomas Oppus'],
  'Zamboanga del Norte':['Baliguian','Dapitan City','Dipolog City','Godod','Gutalac','Jose Dalman','Kalawit','Katipunan','La Libertad','Labason','Leon B. Postigo','Liloy','Manukan','Mutia','Pinan','Polanco','President Manuel A. Roxas','Rizal','Salug','San Miguel','San Pablo','Sergio Osmena Sr.','Siayan','Sibuco','Sibutad','Sindangan','Siocon','Sirawai','Tampilisan'],
  'Zamboanga del Sur':['Aurora','Bayog','Dimataling','Dinas','Dumalinao','Dumingag','Guipos','Josefina','Kumalarang','Labangan','Lakewood','Lapuyan','Mahayag','Margosatubig','Midsalip','Molave','Pagadian City','Pitogo','Ramon Magsaysay','San Miguel','San Pablo','Sominot','Tabina','Tambulig','Tigbao','Tukuran','Vincenzo A. Sagun','Zamboanga City'],
  'Zamboanga Sibugay':['Alicia','Buug','Diplahan','Imelda','Ipil','Kabasalan','Mabuhay','Malangas','Naga','Olutanga','Payao','Roseller Lim','Siay','Talusan','Titay','Tungawan'],
  'Bukidnon':['Baungon','Cabanglasan','Damulog','Dangcagan','Don Carlos','Impasug-ong','Kadingilan','Kalilangan','Kibawe','Kitaotao','Lantapan','Libona','Malitbog','Manolo Fortich','Maramag','Pangantucan','Quezon','San Fernando','Sumilao','Talakag','Valencia City','Malaybalay City'],
  'Camiguin':['Catarman','Guinsiliban','Mahinog','Mambajao','Sagay'],
  'Lanao del Norte':['Bacolod','Baloi','Baroy','Iligan City','Kapatagan','Kauswagan','Kolambugan','Lala','Linamon','Magsaysay','Maigo','Matungao','Munai','Nunungan','Pantao Ragat','Pantar','Poona Piagapo','Salvador','Sapad','Sultan Naga Dimaporo','Tangcal','Tubod'],
  'Misamis Occidental':['Aloran','Baliangao','Bonifacio','Calamba','Clarin','Concepcion','Don Victoriano Chiongbian','Jimenez','Lopez Jaena','Oroquieta City','Ozamiz City','Panaon','Plaridel','Sapang Dalaga','Sinacaban','Tangub City','Tudela'],
  'Misamis Oriental':['Alubijid','Balingasag','Balingoan','Binuangan','Cagayan de Oro City','Claveria','El Salvador City','Gingoog City','Gitagum','Initao','Jasaan','Kinoguitan','Lagonglong','Laguindingan','Libertad','Lugait','Magsaysay','Manticao','Medina','Naawan','Opol','Salay','Sugbongcogon','Tagoloan','Talisayan','Villanueva'],
  'Davao de Oro':['Compostela','Laak','Mabini','Maco','Maragusan','Mawab','Monkayo','Montevista','Nabunturan','New Bataan','Pantukan'],
  'Davao del Norte':['Asuncion','Braulio E. Dujali','Carmen','Kapalong','New Corella','Panabo City','Samal City','San Isidro','Santo Tomas','Tagum City','Talaingod'],
  'Davao del Sur':['Bansalan','Davao City','Digos City','Hagonoy','Jose Abad Santos','Kiblawan','Magsaysay','Malalag','Matanao','Padada','Santa Cruz','Sulop'],
  'Davao Occidental':['Don Marcelino','Jose Abad Santos','Malita','Santa Maria','Sarangani'],
  'Davao Oriental':['Baganga','Banaybanay','Boston','Caraga','Cateel','Gov. Generoso','Lupon','Manay','Mati City','San Isidro','Tarragona'],
  'Cotabato':['Alamada','Aleosan','Antipas','Arakan','Banisilan','Carmen','Kabacan','Kidapawan City','Libungan','Mlang','Magpet','Makilala','Matalam','Midsayap','Pigkawayan','Pikit','President Roxas','Tulunan'],
  'Sarangani':['Alabel','Glan','Kiamba','Maasim','Maitum','Malapatan','Malungon'],
  'South Cotabato':['Banga','General Santos City','Koronadal City','Lake Sebu','Norala','Polomolok','Santo Nino','Surallah','Tboli','Tampakan','Tantangan','Tupi'],
  'Sultan Kudarat':['Bagumbayan','Columbio','Esperanza','Isulan','Kalamansig','Lambayong','Lebak','Lutayan','Palimbang','President Quirino','Senator Ninoy Aquino','Tacurong City'],
  'Agusan del Norte':['Buenavista','Butuan City','Cabadbaran City','Carmen','Jabonga','Kitcharao','Las Nieves','Magallanes','Nasipit','Remedios T. Romualdez','Santiago','Tubay'],
  'Agusan del Sur':['Bayugan City','Bunawan','Esperanza','La Paz','Loreto','Prosperidad','Rosario','San Francisco','San Luis','Santa Josefa','Sibagat','Talacogon','Trento','Veruela'],
  'Dinagat Islands':['Basilisa','Cagdianao','Dinagat','Libjo','Loreto','San Jose','Tubajon'],
  'Surigao del Norte':['Alegria','Bacuag','Burgos','Claver','Dapa','Del Carmen','General Luna','Gigaquit','Mainit','Malimono','Pilar','Placer','San Benito','San Francisco','San Isidro','Santa Monica','Sison','Socorro','Surigao City','Tagana-an','Tubod'],
  'Surigao del Sur':['Barobo','Bayabas','Bislig City','Cagwait','Cantilan','Carmen','Carrascal','Cortes','Hinatuan','Lanuza','Lianga','Lingig','Madrid','Marihatag','San Agustin','San Miguel','Tagbina','Tago','Tandag City'],
  'Basilan':['Akbar','Al-Barka','Hadji Mohammad Ajul','Hadji Muhtamad','Isabela City','Lamitan City','Lantawan','Maluso','Sumisip','Tabuan-Lasa','Tipo-Tipo','Tuburan','Ungkaya Pukan'],
  'Lanao del Sur':['Amai Manabilang','Bacolod-Kalawi','Balabagan','Balindong','Bayang','Binidayan','Buadiposo-Buntong','Bubong','Bumbaran','Butig','Calanogas','Ditsaan-Ramain','Ganassi','Kapai','Kapatagan','Lumba-Bayabao','Lumbaca-Unayan','Lumbatan','Lumbayanague','Madalum','Madamba','Maguing','Malabang','Marantao','Marawi City','Marogong','Masiu','Molundo','Mulondo','Pagayawan','Piagapo','Picong','Poona Bayabao','Pualas','Saguiaran','Sultan Dumalondong','Sultan Gumander','Tagoloan II','Tamparan','Taraka','Tubaran','Tugaya','Wao'],
  'Maguindanao del Norte':['Barira','Buldon','Datu Blah T. Sinsuat','Datu Odin Sinsuat','Kabuntalan','Matanog','Northern Kabuntalan','Parang','Sultan Kudarat','Sultan Mastura','Upi'],
  'Maguindanao del Sur':['Ampatuan','Buluan','Datu Abdullah Sangki','Datu Anggal Midtimbang','Datu Hoffer Ampatuan','Datu Montawal','Datu Paglas','Datu Piang','Datu Saudi-Ampatuan','Datu Unsay','General Salipada K. Pendatun','Guindulungan','Mamasapano','Mangudadatu','Pagalungan','Paglat','Pandag','Rajah Buayan','Shariff Aguak','Shariff Saydona Mustapha','South Upi','Sultan sa Barongis','Talayan','Talitay'],
  'Sulu':['Banguingui','Hadji Panglima Tahil','Indanan','Jolo','Kalingalan Caluang','Languyan','Lugus','Luuk','Maimbung','Old Panamao','Omar','Pandami','Panglima Estino','Pangutaran','Parang','Pata','Patikul','Siasi','Talipao','Tapul','Tongkil'],
  'Tawi-Tawi':['Bongao','Languyan','Mapun','Panglima Sugala','Sibutu','Simunul','Sapa-Sapa','South Ubian','Tandubas','Turtle Islands'],
};

const PH_BARANGAYS = {
  'Caloocan':['Bagumbong','Baesa','Camarin','Culiat','Deparo','Bagong Silang','Grace Park East','Grace Park West','Llano','Maypajo','Parada','Sangandaan','Tala','Bagal','Boyon','Calachuchi','Karuhatan','Lourdes','Malaria','Paso de Blas','Sta. Quiteria','Tinajeros','University Hills'],
  'Las Piñas':['Almanza Uno','Almanza Dos','BF Resort','Daniel Fajardo','Elias Aldana','Ilaya','Manuyo Uno','Manuyo Dos','Pamplona Uno','Pamplona Dos','Pamplona Tres','Pilar','Pulang Lupa Uno','Pulang Lupa Dos','Talon Uno','Talon Dos','Talon Tres','Talon Kuatro','Talon Singko','Zapote'],
  'Makati':['Bel-Air','Carmona','Cembo','Comembo','Dasmarinas','East Rembo','Forbes Park','Guadalupe Nuevo','Guadalupe Viejo','Kasilawan','La Paz','Legazpi Village','Magallanes','Olympia','Palanan','Pembo','Pinagkaisahan','Pio del Pilar','Pitogo','Poblacion','Post Proper Northside','Post Proper Southside','Rizal','Rockwell','San Antonio','San Isidro','San Lorenzo','Santa Cruz','Singkamas','South Cembo','Tejeros','Urdaneta','Valenzuela','West Rembo'],
  'Malabon':['Acungan','Baritan','Bayan-bayanan','Catmon','Dampalit','Flores','Hulong Duhat','Ibaba','Longos','Maysilo','Muzon','Niugan','Panghulo','Potrero','San Agustin','Santolan','Tabing Ilog','Tanong','Tinajeros','Tonsuya','Tugatog'],
  'Mandaluyong':['Addition Hills','Bagong Silang','Barangka Drive','Barangka Ibaba','Barangka Ilaya','Barangka Itaas','Buayang Bato','Burol','Daang Bakal','Hagdang Bato Itaas','Hagdang Bato Libis','Harapin ang Bukas','Highway Hills','Hulo','Mabini-J. Rizal','Malamig','Mauway','Namayan','New Zaniga','Old Zaniga','Pag-asa','Plainview','Pleasant Hills','Poblacion','San Jose','Vergara','Wack-Wack Greenhills'],
  'Manila':['Binondo','Ermita','Intramuros','Malate','Paco','Pandacan','Port Area','Quiapo','Sampaloc','San Andres Bukid','San Miguel','San Nicolas','Santa Ana','Santa Cruz','Santa Mesa','Tondo'],
  'Marikina':['Barangka','Calumpang','Concepcion Uno','Concepcion Dos','Fortune','Industrial Valley','Jesus de la Pena','Kalumpang','Malanday','Marikina Heights','Nangka','Parang','San Roque','Santa Elena','Santo Nino','Tanong','Tumana'],
  'Muntinlupa':['Alabang','Ayala Alabang','Bayanan','Buli','Cupang','New Alabang','Poblacion','Putatan','Sucat','Tunasan'],
  'Navotas':['Bagumbayan North','Bagumbayan South','Bangculasi','Daanghari','Navotas East','Navotas West','North Bay Boulevard South','San Jose Patag','San Roque','Sipac-Almacen','Tanza Norte','Tanza Sur'],
  'Parañaque':['BF Homes','Baclaran','Don Bosco','Don Galo','La Huerta','Marcelo Green','Merville','Moonshine','San Dionisio','San Isidro','San Martin de Porres','Santa Rita','Santo Nino','Sun Valley','Tambo','Vitalez'],
  'Pasay':['Baclaran','Bagong Lipunan ng Crame','Libertad','Merville','Malibay','Maricaban','Pinaglabanan','San Isidro','Villamor'],
  'Pasig':['Bagong Ilog','Bagong Katipunan','Bambang','Buting','Caniogan','Dela Paz','Kalawaan','Kapasigan','Kapitolyo','Karangalan','Ligid-Tipas','Malinao','Manggahan','Maybunga','Oranbo','Palatiw','Pinagbuhatan','Pineda','Rosario','Sagad','San Antonio','San Joaquin','San Jose','San Nicolas','Santa Lucia','Santa Rosa','Santo Tomas','Sumilang','Ugong'],
  'Pateros':['Aguho','Magtanggol','Martires del 96','Poblacion','San Pedro','San Roque','Santa Ana','Santo Rosario-Kanluran','Santo Rosario-Silangan','Tabacalera'],
  'Quezon City':['Alicia','Amihan','Apolonio Samson','Bagbag','Bagong Lipunan ng Crame','Bagong Pag-asa','Bagong Silangan','Bagumbuhay','Bagumbayan','Balintawak','Balong Bato','Batasan Hills','Bayanihan','Blue Ridge A','Blue Ridge B','Botocan','Capri','Central','Commonwealth','Culiat','Damar','Damayan','Damayan Lagi','Del Monte','Don Manuel','Dona Aurora','Dona Imelda','Dona Josefa','Duyan-Duyan','E. Rodriguez','East Kamias','Escopa I','Escopa II','Escopa III','Escopa IV','Fairview','Greater Lagro','Gulod','Holy Spirit','Horseshoe','Immaculate Concepcion','Kaligayahan','Kalusugan','Kamuning','Katipunan','Kaunlaran','Kristong Hari','Krus na Ligas','Laging Handa','Libis','Lourdes','Loyola Heights','Maharlika','Malaya','Mangga','Manresa','Mariana','Masagana','Masambong','Matandang Balara','Milagrosa','N.S. Amoranto','Nagkaisang Nayon','New Era','Novaliches Proper','Obrero','Old Capitol Site','Pag-ibig sa Nayon','Paligsahan','Paraiso','Pasong Putik','Pasong Tamo','Payatas','Philam','Pinagkaisahan','Pinyahan','Project 6','Project 7','Project 8','Quirino 2-A','Quirino 2-B','Quirino 2-C','Quirino 3-A','Ramon Magsaysay','Roxas','Sacred Heart','Saint Ignatius','Saint Peter','Salvacion','San Agustin','San Antonio','San Bartolome','San Isidro Labrador I','San Isidro Labrador II','San Jose','San Martin de Porres','San Roque','San Vicente','Sangandaan','Santa Cruz','Santa Lucia','Santa Monica','Santa Teresita','Silangan','Socorro','South Triangle','Tagumpay','Talipapa','Tandang Sora','Tatalon','Teachers Village East','Teachers Village West','Ugong Norte','Vasra','Veterans Village','Villa Maria Clara','West Kamias','West Triangle','White Plains'],
  'San Juan':['Addition Hills','Balong-Bato','Batis','Corazon de Jesus','Ermitano','Greenhills','Isabelita','Kabayanan','Little Baguio','Maytunas','Onse','Pasadena','Pedro Cruz','Progreso','Rivera','Salapan','San Perfecto','Santa Lucia','Tibagan','West Crame'],
  'Taguig':['Bagumbayan','Bambang','Calzada','Central Bicutan','Central Signal Village','Fort Bonifacio','Hagonoy','Ibayo-Tipas','Katuparan','Ligid-Tipas','Lower Bicutan','Maharlika Village','Napindan','New Lower Bicutan','North Daang Hari','North Signal Village','Palingon-Tipas','Pinagsama','San Miguel','Santa Ana','South Daang Hari','South Signal Village','Tanyag','Tuktukan','Upper Bicutan','Ususan','Wawa','Western Bicutan'],
  'Valenzuela':['Arkong Bato','Bagbaguin','Balangkas','Bignay','Bisig','Canumay East','Canumay West','Coloong','Dalandanan','Gen. T. De Leon','Isla','Karuhatan','Lawang Bato','Lingunan','Mabolo','Malanday','Malinta','Mapulang Lupa','Marulas','Maysan','Palasan','Parada','Pasolo','Poblacion','Pulo','Punturin','Rincon','Tagalag','Ugong','Viente Reales','Wawang Pulo'],
  'Cebu City':['Adlaon','Agsungot','Apas','Babag','Bacayan','Banilad','Basak Pardo','Basak San Nicolas','Binaliw','Bonbon','Budlaan','Bulacao','Busay','Calamba','Cambinocot','Capitol Site','Carreta','Central Pardo','Cogon Pardo','Cogon Ramos','Cubacub','Guadalupe','Guba','Inayawan','Kalunasan','Kamagayan','Kasambagan','Kinasang-an','Labangon','Lahug','Lorega-San Miguel','Lusaran','Luz','Mabini','Mabolo','Malubog','Mambaling','Nivel Hills','Pardo','Pari-an','Paril','Pasil','Pit-os','Pulangbato','Punta Princesa','Sambag I','Sambag II','San Antonio','San Jose','San Nicolas Central','San Nicolas Proper','San Roque','Santa Cruz','Santo Nino','Suba','Sudlon I','Sudlon II','T. Padilla','Talamban','Taptap','Tejero','Tinago','Tisa','Zapatera'],
  'Davao City':['Agdao','Alambre','Angalan','Bago Aplaya','Bago Gallera','Bago Oshiro','Baguio','Balengaeng','Baliok','Bangkas Heights','Bantol','Baracatan','Biao Escuela','Biao Guianga','Biao Joaquin','Binugao','Buhangin Proper','Bunawan Proper','Cabantian','Calinan Proper','Callawa','Camansi','Carmen','Catalunan Grande','Catalunan Pequeno','Catitipan','Dacudao','Dalag','Datu Salumay','Dominga','Dumoy','Eden','Fatima','Gatungan','Gov. Paciano Bangoy','Gov. Vicente Duterte','Ilang','Inayangan','Indangan','Lacson','Lamanan','Langub','Lapu-lapu','Lasang','Leon Garcia Sr.','Lizada','Los Amigos','Lubogan','Lumiad','Ma-a','Mabuhay','Malagos','Malamba','Manambulan','Manuel Guianga','Mapula','Marapangi','Marilog Proper','Matina Aplaya','Matina Crossing','Matina Pangi','Mintal','Mudiang','Mulig','New Carmen','New Valencia','Pampanga','Panacan','Poblacion','Rafael Castillo','Riverside','Salapawan','Salaysay','San Antonio','San Isidro','Santa Ana','Santo Nino','Sasa','Sirib','Sirawan','Tagluno','Talomo Proper','Taminco','Tigatto','Toril Proper','Tugbok Proper','Ukip','Ula','Vicente Hizon Sr.','Waan','Wangan','Wines'],
  'Cagayan de Oro City':['Agusan','Balubal','Bulua','Camaman-an','Consolacion','Cugman','Dansolihon','F.S. Catanico','Gusa','Iponan','Kauswagan','Lapasan','Lumbia','Macabalan','Macasandig','Mambuaya','Nazareth','Pagalungan','Patag','Pagatpat','Pigsag-an','Puerto','Puntod','San Simon','Tablon','Taglimao','Tignapoloan','Tumpagon','Wao','Poblacion 1','Poblacion 2','Poblacion 3','Poblacion 4','Poblacion 5','Poblacion 6','Poblacion 7','Poblacion 8','Poblacion 9','Poblacion 10'],
  'Baguio City':['Abanao-Zandueta-Kayong-Chugum-Otek','Alfonso Tabora','Ambiong','Andres Bonifacio','Apugan-Loakan','Asin Road','Aurora Hill Proper','Aurora Hill North Central','Aurora Hill South Central','Bakakeng Central','Bakakeng North','Balsigan','Bayan Park East','Bayan Park Village','Bayan Park West','BGH Compound','Brookside','Buol','Cabinet Hill-Teacher\'s Camp','Camp 7','Camp 8','Camp Allen','Campo Filipino','City Camp Central','City Camp Proper','Country Club Village','Dagsian Lower','Dagsian Upper','Dominican Hill-Mirador','Dontogan','DPS Area','Fairview Village','Ferdinand','Fort del Pilar','Gabriela Silang','General Luna','Greenwater Village','Guisad Central','Guisad Sorong','Happy Hollow','Harrison-Claudio Carantes','Holy Ghost Extension','Holy Ghost Proper','Irisan','Kayang-Hilltop','Kayang-Kayang','Kias','Lourdes Subdivision Extension','Lourdes Subdivision Proper','Lower Bakakeng','Lower Dagsian','Lower General Luna Road','Lower Magsaysay','Lower Quirino Hill','Lucnab','Magsaysay Private Road','Manuel Roxas','Market Subdivision Upper','Military Cut-off','Mines View Park','Modern Site East','Modern Site West','MRR-Queen of Peace','New Lucban','Outlook Drive','Pacdal','Padre Burgos','Padre Zamora','Palma-Urbano','Peter\'s Rock','Phil-Am','Pinget','Pinsao Pilot Project','Pinsao Proper','Poliwes','Pucsusan','Quirino Hill East','Quirino Hill Lower','Quirino Hill Middle','Quirino Hill West','Quirino-Magsaysay','Rock Quarry Lower','Rock Quarry Middle','Rock Quarry Upper','Saint Joseph Village','Salud Mitra','San Antonio Village','San Luis Village','San Vicente','Santa Escolastica','Santo Rosario-Yangco','Santos-Kagalkan','Santuario','Scout Barrio','Session Road Area','Slaughter House Area','South Drive','Teodora Alonzo','Trancoville','Upper Dagsian','Upper General Luna','Upper Magsaysay','Upper Market Subdivision','Upper Quirino Hill','Upper Rock Quarry','Victoria Village'],
  // Rizal Province
  'Antipolo City':['Bagong Nayon','Beverly Hills','Calawis','Cupang','Dalig','Dela Paz','Inarawan','Mambugan','Mayamot','Mina-Bago','Muntingdilaw','Niogan','San Isidro','San Jose','San Juan','San Luis','San Roque','Santa Cruz','Santo Nino'],
  'Angono':['Bagumbayan','Kalayaan','Mahabang Lupa','Makane','Mugay','Pag-asa','San Isidro','San Pedro'],
  'Baras':['Concepcion','Evangelista','Laiban','Mababoy','Maguasawang Ilat','Minuyan','Pinugay','Puting Kahoy','San Juan','San Marcos','San Miguel','San Rafael','Santa Cruz'],
  'Binangonan':['Batingan','Calumpang','Habay','Hulo','Janosa','Layunan','Lunsad','Mabolo','Macamot','Mahabang Lupa','Malakaban','Pantok','Pag-asa','San Carlos','San Pedro','Tagpos','Tatala','Wawa'],
  'Cainta':['San Andres','San Isidro','San Juan','Sto. Domingo','Sto. Tomas','Sta. Rosa'],
  'Cardona':['Balibago','Calumpang','Looc','Mabalo','Real','Sampad','San Roque','Sumilang','Wawa'],
  'Jalajala':['Bagumbong','Halayhayin','Paaralang Bago','Pagkalinawan','Poblacion','San Isidro','Sipsipin'],
  'Morong':['Bombongan','Can-Cal-Lan','Lagundi','Maybancal','Poblacion'],
  'Pililla':['Halayhayin','Hulo','Imatong','Malaya','Niogan','Quisao','Takungan','Wawa'],
  'Rodriguez':['Balite','Burgos','Geronimo','Macabud','Manggahan','Mascap','Puray','Rosario','San Isidro','San Jose','San Rafael','San Andres'],
  'San Mateo':['Ampid I','Ampid II','Banaba','Dulong Bayan','Guitnang Bayan I','Guitnang Bayan II','Guinayang','Malanday','Nangka','Pintong Bukawe','Sta. Ana','San Roque','Silangan'],
  'Tanay':['Cuyambay','Daraitan','Katipunan','Kaybuto','Laiban','Lano','Mag-ampon','Mamuyao','Pinagkamaligan','Sampalok','San Andres','San Isidro','Tanay Proper','Tandang','Wawa'],
  'Taytay':['Dolores','Muzon','San Juan','Santa Ana','Sta. Cruz'],
  'Teresa':['Poblacion','San Gabriel','San Roque','Santiago'],
  // Cavite Province
  'Bacoor City':['Aniban I','Aniban II','Aniban III','Aniban IV','Aniban V','Banalo','Bayanan','Campo Santo','Digman','Dulong Bayan','Habay I','Habay II','Kaingin','Ligas I','Ligas II','Ligas III','Mabolo I','Mabolo II','Mabolo III','Maliksi I','Maliksi II','Maliksi III','Mambog I','Mambog II','Mambog III','Mambog IV','Mambog V','Molino I','Molino II','Molino III','Molino IV','Molino V','Molino VI','Niog I','Niog II','Niog III','P.F. Espiritu I','P.F. Espiritu II','P.F. Espiritu III','P.F. Espiritu IV','P.F. Espiritu V','P.F. Espiritu VI','P.F. Espiritu VII','Panapaan I','Panapaan II','Panapaan III','Panapaan IV','Panapaan V','Panapaan VI','Panapaan VII','Panapaan VIII','Queens Row Central','Queens Row East','Queens Row West','Real I','Real II','Salinas I','Salinas II','Salinas III','Salinas IV','San Nicolas I','San Nicolas II','San Nicolas III','Sineguelasan','Talaba I','Talaba II','Talaba III','Talaba IV','Talaba V','Talaba VI','Talaba VII','Zapote I','Zapote II','Zapote III','Zapote IV','Zapote V'],
  'Cavite City':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Caridad','Dalahican','Domicilio','Karsada','Lallana','Lelong','Marcelo','Molo','San Antonio','Santa Cruz','Urduja','Wakas'],
  'Dasmarinas City':['Burol I','Burol II','Burol III','Emmanuel Bergado I','Emmanuel Bergado II','Habay I','Habay II','Langkaan I','Langkaan II','Luzviminda I','Luzviminda II','Maharlika I','Maharlika II','Paliparan I','Paliparan II','Paliparan III','Sabang','Salawag','Salitran I','Salitran II','Salitran III','Salitran IV','Sampaloc I','Sampaloc II','Sampaloc III','Sampaloc IV','San Agustin I','San Agustin II','San Agustin III','San Andres I','San Andres II','San Jose','San Luis I','San Luis II','San Manuel I','San Manuel II','San Miguel I','San Miguel II','San Miguel III','San Simon','Santa Cristina I','Santa Cristina II','Santa Cruz I','Santa Cruz II','Santa Fe I','Santa Fe II','Santa Maria','Santa Sophia','Santo Cristo I','Santo Cristo II','Santo Nino I','Santo Nino II','Victoria Reyes','Zone I','Zone II','Zone III','Zone IV'],
  'General Emilio Aguinaldo':['Bano','Biluso','Buck Estate','Buho','Ipilan','Kalayaan','Kaymisas','Kayrilaw','Lalaan I','Lalaan II','Lantic','Liwanag','Loma','Lucsuhin','Luzviminda','Maguyam','Maitim 2nd','Malagasang I','Malagasang II','Naic','Panungyanan','Pasong Camachile I','Pasong Camachile II','Pasong Kawayan I','Pasong Kawayan II','Poblacion I','Poblacion II','Poblacion III','San Francisco I','San Francisco II','San Juan I','San Juan II','Santiago','Tapia','Tejero','Vibora'],
  'General Mariano Alvarez':['Aldiano Olaes','Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Benjamin Tirona','Eduardo Camerino','Francisco De Castro','General Lim','Maharlika','Marigondon','Tejero'],
  'General Trias City':['Alingaro','Arnaldo','Bacao I','Bacao II','Bagumbayan','Biclatan','Buenavista I','Buenavista II','Buenavista III','Corregidor','Dulong Bayan','Gov. Ferrer Poblacion I','Gov. Ferrer Poblacion II','Gov. Ferrer Poblacion III','Javalera','Manggahan','Navarro','Ninety Sixth','Panungyanan','Pasong Camachile I','Pasong Camachile II','Pasong Kawayan I','Pasong Kawayan II','Pinagtipunan','Prinza','San Francisco I','San Francisco II','San Juan I','San Juan II','Santiago','Tapia','Tejero','Vibora'],
  'Imus City':['Alapan I','Alapan II','Anabu I','Anabu II','Bagong Silang','Bayan Luma I','Bayan Luma II','Bayan Luma III','Bayan Luma IV','Bayan Luma V','Bayan Luma VI','Bayan Luma VII','Bayan Luma VIII','Bayan Luma IX','Carsadang Bago I','Carsadang Bago II','Magdalo','Malagasang I','Malagasang II','Mariana I','Mariana II','Medicion I','Medicion II','Palico I','Palico II','Palico III','Palico IV','Pasong Buaya I','Pasong Buaya II','Poblacion I','Poblacion II','Poblacion III','Poblacion IV','Poblacion V','Poblacion VI','Poblacion VII','Poblacion VIII','Tanzang Luma I','Tanzang Luma II','Tanzang Luma III','Tanzang Luma IV','Tanzang Luma V','Tanzang Luma VI','Toclong I','Toclong II','Toclong III'],
  'Tagaytay City':['Asisan','Bagong Tubig','Calabuso','Dapdap East','Dapdap West','Francisco','Guinhawa North','Guinhawa South','Iruhin Central','Iruhin East','Iruhin West','Kaybagal Central','Kaybagal East','Kaybagal North','Kaybagal South','Mag-asawang Ilat','Maharlika East','Maharlika West','Maitim 2nd Central','Maitim 2nd East','Maitim 2nd West','Mendez Crossing East','Mendez Crossing West','Neogan','Patutong Malaki North','Patutong Malaki South','Sambong','San Jose','Silang Junction North','Silang Junction South','Sungay East','Sungay West','Tolentino East','Tolentino West','Zambal'],
  'Trece Martires City':['Aguado','Cabezas','Cabuco','De Ocampo','Gregorio','Hugo Perez','Inocencio','Lapidario','Luciano','Perez','Poblacion I','Poblacion II','Poblacion III','San Agustin','Conchu'],
  'Alfonso':['Amayong','Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Buck Estate','Kayquit I','Kayquit II','Kayquit III','Luksuhin','Luksuhin Ilaya','Mangas I','Mangas II','Pajo','Poblacion I','Poblacion II','Poblacion III','Sikat','Sulsugin','Taywanak Ibaba','Taywanak Ilaya','Upli'],
  'Amadeo':['Banaybanay','Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Barangay XII','Barangay XIII','Barangay XIV','Barangay XV','Dagatan','Halang','Loma','Maitim','Manggahan','Poblacion','Talon','Tanggalan'],
  'Carmona':['Bancal','Jose Abad Santos','Lantic','Maduya','Mambog','Milagrosa','Poblacion','Salazar','San Roque'],
  'Indang':['Agus-os','Alulod','Banaba Cerca','Banaba Lejos','Bancod','Buna Cerca','Buna Lejos I','Buna Lejos II','Calumpang Cerca','Calumpang Lejos','Carasuchi','Daine I','Daine II','Guyam Malaki','Guyam Munti','Harasan','Kayquit','Limbon','Lumampong Balagbag','Lumampong Halayhay','Mahabang Kahoy Cerca','Mahabang Kahoy Lejos','Mataas na Lupa','Pulo','Tambo Balagbag','Tambo Kulit','Tambo Malaki','Tambo Munti','Toclong','Wakas I','Wakas II'],
  'Kawit':['Balsahan-Bisita','Batong Dalig','Binakayan-Aplaya','Binakayan-Kanluran','Congbalay-Lerma','Gahak','Kaingen','Magdalo','Manggahan','Marulas','Pulvorista','Putol','Recodo','Sagsakay','San Sebastian','Santa Isabel','Tabon I','Tabon II','Tabon III','Toclong','Tramo-Bantayan','Wakas I','Wakas II'],
  'Magallanes':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI'],
  'Maragondon':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Barangay XII','Barangay XIII','Barangay XIV','Barangay XV'],
  'Mendez':['Anuling Lejos I','Anuling Lejos II','Anuling Cerca I','Anuling Cerca II','Avenida Rizal','Bangkay','Bucal I','Bucal II','Bucal III','Bucal IV','Carasuchi','Cayungan','Galicia I','Galicia II','Janagdag','Punta I','Punta II','San Isidro I','San Isidro II','San Jose','San Juan','San Pedro I','San Pedro II','Tanay I','Tanay II','Tanay III'],
  'Naic':['Bagong Kalsada','Halang','Humbac','Ibayo Estacion','Ibayo Silangan','Kanluran','Labac','Labac Uno','Mabolo','Makina','Malindong','Mataas na Lupa','Muzon','Navotas','Palangue I','Palangue II','Palangue III','Sabang','San Roque','Santulan','Sapa','Timalan Balsahan','Timalan Concepcion'],
  'Noveleta':['Magdiwang','Poblacion','San Antonio I','San Antonio II','San Jose I','San Jose II','San Juan I','San Juan II','San Rafael I','San Rafael II','Santa Rosa I','Santa Rosa II'],
  'Rosario':['Bagbag I','Bagbag II','Kanluran','Ligtong I','Ligtong II','Ligtong III','Ligtong IV','Muzon I','Muzon II','Poblacion I','Poblacion II','Sapa I','Sapa II','Sapa III','Sapa IV','Tejero','Wawa I','Wawa II','Wawa III'],
  'Silang':['Acacia','Anuling Lejos I','Anuling Lejos II','Anuling Cerca','Aranez','Batas','Biga I','Biga II','Biluso','Buho','Burol','Citin','Consolacion','Crossroads','Dalacan','Don Emilio Perez','Don Ernesto Perez','Don Pablo Perez','Esteban Cafe','General Lim','Inchican','Ipilan','Janaojanao','Lalaan I','Lalaan II','Litlit','Lucsuhin','Lumil','Maguyam','Malabag','Mataas na Lupa','Munting Ilog','Narra I','Narra II','Narra III','Paligawan','Pasong Langka','Pooc I','Pooc II','Puting Kahoy','Sabutan','San Miguel I','San Miguel II','San Vicente I','San Vicente II','Santa Rosa I','Santa Rosa II','Santol','Sulit','Sulsugin','Talon','Tibig','Tulos','Tungkod'],
  'Tanza':['Bagtas','Biga','Biwas','Bucal','Bunga','Calibuyo','Capipisa','Daang Amaya I','Daang Amaya II','Daang Amaya III','Julugan I','Julugan II','Julugan III','Julugan IV','Julugan V','Julugan VI','Julugan VII','Julugan VIII','Lambingan','Luyos','Mabiga','Makina','Mulawin','Punta I','Punta II','Sahud Ulan','Sanja Mayor','Santol','Sinala','Tres Cruses'],
  'Ternate':['Bucana','Poblacion I','Poblacion II','Poblacion III','San Jose'],
  // Laguna Province
  'Calamba City':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Bagong Kalsada','Batino','Bubuyan','Bucal','Bunggo','Burol','Came','Canlubang','Halang','Hornalan','Laguerta','Lawa','Lecheria','Lingga','Looc','Maitim','Majada Labas','Majada Out','Makiling','Mapagong','Masili','Maunong','Mayapa','Milagrosa','Paciano Rizal','Palingon','Palo-Alto','Pansol','Parian','Pittland','Putho Tuntungin','Real','Saimsim','Salamba','Sampaloc','San Cristobal','San Juan','Sirang Lupa','Sucol','Turbina','Ulango','Uno'],
  'Santa Rosa City':['Aplaya','Balibago','Caingin','Dila','Dita','Don Jose','Ibaba','Kanluran','Labas','Macabling','Malitlit','Malusak','Market Area','Pooc','Sinalhan','Tagapo'],
  'Binan City':['Binan','Canlalay','Casile','De La Paz','Ganado','Langkiwa','Loma','Malaban','Nangka','Platero','Poblacion','San Antonio','San Francisco','San Jose','San Vicente','Santo Tomas','Soro-soro','Timbao','Tubigan','Zapote'],
  'Cabuyao City':['Baclaran','Banay-banay','Banlic','Bigaa','Butong','Casile','Diezmo','Gulod','Mamatid','Marinig','Niugan','Pittland','Pulo','San Isidro','Sala','Sampiruhan'],
  'San Pablo City':['Bagong Buhay I','Bagong Buhay II','Bagong Buhay III','Del Remedio','Dolores','San Bartolome','San Buenaventura','San Crispin','San Cristobal','San Diego','San Francisco','San Gabriel I','San Gabriel II','San Gregorio','San Ignacio','San Isidro','San Jose','San Juan','San Lorenzo','San Lucas I','San Lucas II','San Marcos','San Mateo','San Miguel','San Nicolas I','San Nicolas II','San Pedro','San Roque','San Salvador','Santa Catalina Norte','Santa Catalina Sur','Santa Elena','Santa Filomena','Santa Isabel','Santa Maria','Santa Monica','Santa Veronica','Santiago I','Santiago II','Santo Angel Central','Santo Angel Norte','Santo Angel Sur','Santo Cristo Norte','Santo Cristo Sur','Santo Nino Norte','Santo Nino Sur'],
  'San Pedro City':['Bagong Silang','Calendola','Cuyab','Estrella','Langgam','Laram','Magsaysay','Narra','New San Pedro','Pacita I','Pacita II','Poblacion','Riverside','Sampaguita','San Antonio','Unidos','Unitown'],
  'Los Banos':['Anos','Bagong Silang','Bambang','Batong Malake','Baybayin','Bayog','Lalakay','Maahas','Malinta','Mayondon','Putho-Tuntungin','San Antonio','San Jose','Santo Tomas','Tadlak','Timugan'],
  'Santa Cruz':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Bubukal','Calios','Duhat','Gatid','Ibaba','Kanluran','Labuin','Malinao','Pagsawitan','Palayan','Poblacion','San Juan','Santisima Cruz','Santo Angel','Santo Cristo','Taytay','Wawa'],
  'Alaminos':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X'],
  'Calauan':['Bangyas','Dayap','Hanggan','Imok','Mabacan','Masiit','May-It','Pansol','Prinza','San Isidro','San Miguel','Turbina'],
  // Batangas Province
  'Batangas City':['Alangilan','Bagong Tubig','Balagtas','Balete','Banaba Center','Banaba East','Banaba Ibaba','Banaba West','Birinayan','Bolbok','Bukal','Calicanto','Conde Labak','Cumba','Cuta','Dalig','Dela Paz','Dela Paz Pulot Center','Dela Paz Pulot Itaas','Domoclay','Gulod Itaas','Gulod Labak','Ilijan','Kumintang Ibaba','Kumintang Ilaya','Libjo','Liponpon','Lon-oh','Luquin','Maapas','Mabacong','Malibayo','Malitam','Maruclap','Malalim','Natunuan North','Natunuan South','Pallocan East','Pallocan West','Pinamucan','Pinamucan East','Pinamucan West','Punta','San Agapito','San Agustin Kanluran','San Agustin Silangan','San Andres','San Antonio','San Isidro','San Jose Sico','San Miguel','San Pedro','Santo Domingo','Santo Tomas','Simlong','Sirang Lupa','Sta. Clara','Sta. Rita Aplaya','Sta. Rita Karsada','Sto. Nino','Sto. Tomas','Tabangao Aplaya','Tabangao Dao','Tabangao-Ambulong','Talahib Pandayan','Talahib Payapa','Talumpok East','Talumpok West','Tingga Itaas','Tingga Labak','Tulo','Wawa'],
  'Lipa City':['Adya','Anilao-Labac','Anilao-Taytay','Balintawak','Banaybanay','Bolbok','Buli','Dagatan','Duhatan','Halang','Inosluban','Kayumanggi','Landayan','Langgaan','Luyos','Mabini','Malagonlong','Malitlit','Marawoy','Mataas na Lupa','Munting Pulo','Pagolingin Bata','Pagolingin East','Pagolingin West','Pangao','Pinagkawitan','Pinagtongulan','Plaridel','Poblacion Balagtas','Poblacion Bigaa','Poblacion Ibaba','Poblacion Ilaya','Poblacion Kayumanggi','Poblacion Mabini','Poblacion Malitlit','Poblacion San Carlos','Poblacion Sampaguita','Pulong Anahao','Pusil','Quezon','Rizal','Sabang','Sampaguita','San Benito','San Carlos','San Celestino','San Francisco','San Guillermo','San Jose','San Lucas','San Pablo','San Pedro','Santiago','Santo Tomas','Sico','Talisay','Tambo','Tibig','Tipacan'],
  'Tanauan City':['Altura Bata','Altura Matanda','Anastacia','Bagbag','Bagumbayan','Balele','Banjo East','Banjo West','Bilog-Bilog','Boot','Cale','Calsada','Cubamba','Darasa','Gonzales','Hidalgo','Janopol','Janopol Oriental','Laurel','Leynes','Lodlod','Luyos','Mabini','Malaking Pulo','Maria Paz','Mataas Na Kahoy','Matingain I','Matingain II','Nangkaan','Pagaspas','Pantay Matanda','Pantay Bata','Paragahan','Pinagtungulan','Poblacion I','Poblacion II','Poblacion III','Putol','Raf-Raf','Randang Pala','Sambat','San Jose','Santor','Ulango','Wawa'],
  'Santo Tomas':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Barangay XII','Barangay XIII','Barangay XIV','Barangay XV','Barangay XVI','Barangay XVII','Barangay XVIII','Barangay XIX','Barangay XX'],
  'Balayan':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Barangay XII','Barangay XIII','Barangay XIV','Barangay XV','Barangay XVI','Barangay XVII','Barangay XVIII'],
  'Nasugbu':['Bilaran','Bucana','Bunducan','Butucan','Calayo','Catandaan','Cogunan','Dayap Itaas','Dayap Calauit','Labac','Looc','Lumbangan','Malapad na Bato','Maugat East','Maugat West','Munting Indan','Natipuan','Papaya','Poblacion','Reparo','Tumalim','Utod','Wawa'],
  // Quezon Province
  'Lucena City':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Dalahican','Domoit Kanluran','Domoit Silangan','Gulang-Gulang','Ibabang Dupay','Ibabang Iyam','Ibabang Talim','Ilayang Dupay','Ilayang Iyam','Ilayang Talim','Isabang','Market Area','Mayao Castillo','Mayao Crossing','Mayao Kanluran','Mayao Parada','Mayao Silangan','Ransohan','Salinas','Talao-Talao'],
  'Tayabas City':['Alitao','Alsam Ibaba','Alsam Ilaya','Amontay','Anos','Ayusan I','Ayusan II','Baguio','Banilad','Bukal Ibaba','Bukal Ilaya','Bulo','Bungoy','Cagacag','Cagsiay I','Cagsiay II','Cagsiay III','Camaysa','Dapdap','Domoit','Gibanga','Ibas','Ilasan','Ipilan','Isabang','Katimo','Kinatakutan','Kulawit','Lakawan','Lalo','Lammac','Lapolapo I','Lapolapo II','Lapolapo III','Lita','Maglipad','Magsaysay','Maguibuay','Mahuwag','Malaoa','Masin Norte','Masin Sur','Mateuna','Mayowe','Opias','Palale','Pook','Potol','San Diego Ibaba','San Diego Ilaya','San Francisco','San Isidro','Tiaong','Tiburcio Hillario','Tinagpan','Tinugtogan','Tuhian','Ulango'],
  'Candelaria':['Buenavista','Bukal Norte','Bukal Sur','Kinatakutan','Masin Norte','Masin Sur','Pansol','Poblacion Ilaya','Poblacion Ibaba','San Andres','San Isidro Norte','San Isidro Sur','San Jose','San Roque','Santa Catalina Norte','Santa Catalina Sur','Sta. Cruz','Sto. Cristo'],
  // Bulacan Province
  'Malolos City':['Anilao','Atlag','Babatnin','Bagna','Balayong','Balite','Bangkal','Barihan','Bulihan','Bungahan','Caingin','Calero','Calizon','Canate','Catmon','Cofradia','Dakila','Guinhawa','Ligas','Liyang','Longos','Look 1st','Look 2nd','Lugam','Mabolo','Malusak','Masile','Matimbo','Mojon','Namtutan','Niugan','Pamarawan','Panasahan','Pinagbakahan','San Agustin','San Gabriel','San Juan','San Pablo','Santa Ines','Santiago','Santo Nino','Santo Rosario','Santol','Sumapang Bata','Sumapang Matanda','Taal','Tikay'],
  'Meycauayan City':['Bagbaguin','Bahay Pare','Bancal','Banga','Bayugo','Caingin','Calvario','Camalig','Gasak','Hulo','Iba','Langka','Lawa','Libtong','Liputan','Longos','Malhacan','Pajo','Pantoc','Perez','Poblacion','Saluysoy','St. Francis','Tugatog','Ubihan','Zamora'],
  'San Jose del Monte City':['Bagong Buhay I','Bagong Buhay II','Bagong Buhay III','Citrus','Dulong Bayan','Francisco Homes I','Francisco Homes II','Francisco Homes III','Fatima I','Fatima II','Fatima III','Fatima IV','Fatima V','Gaya-gaya','Graceville','Gumaoc Central','Gumaoc East','Gumaoc West','Kaybanban','Kaypian','Lawang Pari','Maharlika','Minuyan I','Minuyan II','Minuyan III','Minuyan IV','Minuyan V','Minuyan Proper','Paradise III','Poblacion','Sapang Palay','Sapang Palay Proper','St. Martin I','St. Martin II','St. Martin III','St. Martin IV','Sto. Cristo','Sto. Nino I','Sto. Nino II','Sto. Nino III','Sto. Nino IV','Tungkong Mangga'],
  'Marilao':['Abangan Norte','Abangan Sur','Ibayo','Lambakin','Lias','Loma de Gato','Nagbalon','Patubig','Poblacion I','Poblacion II','Saog','Tabing Ilog'],
  'Bocaue':['Antipona','Bagumbayan','Batia','Binuangan','Bukid','Calvario','Canalate','Caret','Catmon','Diliman I','Diliman II','Kinalaglagan','Lolomboy','Poblacion','Pulong Bayabas','Sapang Baho','Sulucan','Turo'],
  'Balagtas':['Balagtas Proper','Buko','Burol','Gatbuca','Guinhawa','Longos','Palanas','Santol','Wawa'],
  'Baliuag':['Bagong Nayon','Barangca','Calantipay','Catulinan','Concepcion','Hinukay','Makinabang','Pagala','Paitan','Piel','Pinagbarilan','Poblacion','San Jose','San Roque','Santa Barbara','Santo Cristo','Subic','Sulivan','Tangos','Tarcan','Tiaong','Tibag','Tibagan','Virgoneza'],
  'Bulacan':['Balagtas','Balasing','Bambang','Matungao','Maysantol','Perez','Poblacion','San Francisco','San Jose','Santa Ines'],
  'Bustos':['Camachile','Kapalangan','Lepanto','Meyto','Panginay','Palahanan I','Palahanan II','San Juan','Santa Catalina','Talampas'],
  'Calumpit':['Balite','Balungao','Calizon','Corazon','Gatbuca','Guiginto','Iba Este','Iba Ote','Lambakin','Longos','Poblacion','Pungo','San Jose Norte','San Jose Sur','San Pedro','Santo Nino','Sapang Bayan','Wakas Norte','Wakas Sur'],
  'Guiguinto':['Cutcut','Daungan','General Baldomero Lim','Malis','Panginay','Poblacion','Santa Cruz','Santo Cristo','Tabing Ilog','Tiaong'],
  'Hagonoy':['Iba','Iba-Ibayo','Palimbo-Caguisitan','Palimbo-Proper','Pinalagdan','Sagrada Familia','San Agustin','San Antonio','San Isidro','San Jose','San Juan','San Pascual','San Pedro','Santiagopoblacion','Santo Cristo','Santo Rosario','Subic'],
  'Norzagaray':['Bangkal','Bigte','Friendship','Minuyan','Partida','Poblacion','San Lorenzo','San Mateo'],
  'Obando':['Binuangan','Catanghalan','Hulo','Paco','Paliwas','Panghulo','Salambao','San Pascual','Tawiran'],
  'Pandi':['Bagong Buhay','Baka-Bakahan','Bunsuran I','Bunsuran II','Bunsuran III','Cacarong Bata','Cacarong Matanda','Cupang','Malibong Bata','Malibong Matanda','Manatal','Mapulang Lupa','Masagana','Mawaklat','Poblacion','San Roque','Santa Cruz','Santo Nino','Siling Bata','Siling Matanda'],
  'Plaridel':['Agnaya','Bangkal','Banga I','Banga II','Bintog','Culianin','Dampol I','Dampol II A','Dampol II B','Gandus','Lumang Bayan','Parulan','Poblacion','Pungo','San Juan','Santa Ines','Santol','Sumaging','Talacsan','Talapitan','Tali','Toril'],
  'Pulilan':['Balatong A','Balatong B','Cutcot','Dampol','Dulong Malabon','Inaon','Longos','Lumbac','Paltao','Penabatan','Poblacion','Santo Cristo','Taal','Tabon','Tibag','Tinejero'],
  'San Ildefonso':['Akle','Alagao','Anyatam','Bagong Buhay','Bagong Sikat','Basuit','Bulac','Burol','Capipis','Caratagan','Divisoria','Kapalangan','Lictingan','Malabon','Malipampang','Mataas na Parang','Pugad','Pulong Tamo','San Juan','Santo Cristo','Sapang Bulak','Sapang Palay','Sibul','Tartaro','Tibag'],
  'San Miguel':['Alagao','Alcala','Bagong Buhay','Bahay Pare','Biclat','Buga','Buliran Norte','Buliran Sur','Calabuyan','Camangyanan','Camias','Ibd Site','Kayang','Labi','Lagundi','Lico','Mabuhay','Manigang','Mapangpang','Masapang','Pacalag','Paliwasan','Pantoc','Penaranda','Pinambaran','Pulong Bayabas','Sacdalan','Sapang Baluktot','Sapang Buho','Sibul','Siling Bata','Siling Matanda','Siling Norte','Siling Sur','Solar','Tigpalas'],
  'San Rafael':['Cabiangan','Camias','Liciada','Maasim','Mabalas-balas','Maguinao','Maronquillo','Paco','Paombong','Pasong Bangkal','Poblacion','San Agustin','San Jose','Santo Cristo','Ulingao'],
  'Santa Maria':['Balasing','Buenavista','Bulac','Catmon','Cay Pombo','Caysio','Guyong','Lalakhan','Mag-asawang Sapa','Mahabang Parang','Manggahan','Parada','Poblacion','Pulong Buhangin','San Gabriel','San Jose','Santo Cristo','Santo Nino','Silangan','Tumana'],
  // Pampanga Province
  'Angeles City':['Agapito del Rosario','Anunas','Balibago','Capaya','Claro M. Recto','Cuayan','Cutcut','Cutud','Lourdes Norte','Lourdes Sur','Lourdes Sur East','Malabanias','Margot','Mining','Ninoy Aquino','Pampang','Pandan','Pulung Cacutud','Pulung Maragul','Salapungan','San Jose','San Nicolas','Santa Teresita','Santa Trinidad','Santo Cristo','Santo Domingo','Santo Rosario','Sapalibutad','Sapangbato','Tabun','Virgen Delos Remedios'],
  'San Fernando City':['Alasas','Baliti','Bulaon','Calulut','Dela Paz Norte','Dela Paz Sur','Del Carmen','Del Pilar','Del Rosario','Dolores','Juliana','Lara','Lourdes','Magliman','Maimpis','Malino','Malpitic','Pandaras','Panipuan','Pulung Bulu','Quebiawan','Saguin','San Agustin','San Felipe','San Isidro','San Jose','San Juan','San Nicolas','San Pedro','Santa Lucia','Santa Teresita','Santo Nino','Santo Rosario','Sindalan','Telabastagan'],
  'Mabalacat City':['Atlu-Bola','Bical','Bundagul','Cacutud','Calumpang','Camachiles','Capitangan','Caruncho','Dau','Dolores','Duquit','Lakandula','Mabiga','Mabulac','Magalang','Mamatitang','Mangalit','Marcos Village','Mawaque','Paralayunan','Poblacion','San Francisco','San Joaquin','Santa Ines','Santa Maria','Santo Rosario','Sapang Balen','Sapang Biabas','Tabun'],
  'Apalit':['Balucuc','Calantipe','Cansinala','Capalangan','Colgante','Paligui','Sampaloc','San Juan','San Vicente','Sucad','Sulipan','Tabuyuc'],
  'Arayat':['Arenas','Baliti','Batasan','Buensuceso','Candating','Gatiawin','Guemasan','La Paz','Lacquios','Mangalit','Maniago','Namulandayan','Palinlang','Paralaya','Poblacion','San Agustin Norte','San Agustin Sur','San Antonio','San Jose Norte','San Jose Sur','San Matias','San Nicolas','San Roque Arenas','San Roque Bitas','Santa Ana','Santa Catalina','Santa Cruz','Santa Maria','Santo Rosario Poblacion','Santo Rosario Tabuan','Suclayin','Telapayong'],
  'Candaba':['Bahay Pare','Balas','Balsik','Bamban','Bangkal','Bulaon','Bulsa','Camba','Capalangan','Colgante','Gulap','Lanang','Lourdes','Mabiga','Mandasig','Mangilag Norte','Mangilag Sur','Masapocan','Niugan','Palimpe','Pando','Paralaya','Poblacion','San Agustin','San Antonio','San Isidro Norte','San Isidro Sur','San Jose','San Pedro','San Roque','San Vicente','Santa Monica','Santo Rosario','Tagulod','Talang','Tenejero','Tigbe','Vizal San Pablo','Vizal Santo Cristo'],
  'Guagua':['Ascomo','Bancal','Ban-ban','Betis','Brgy. 1','Brgy. 2','Brgy. 3','Brgy. 4','Brgy. 5','Brgy. 6','Brgy. 7','Brgy. 8','Imas I','Imas II','Kaming','Lambac','Malusac','Moras de la Paz','Murla','Natividad','Palimpe','Pias','Pitombayog','Pulungbulo','Pulungmasle','Rizal','San Agustin','San Antonio','San Isidro','San Jose','San Juan','San Matias','San Miguel','San Nicolas','San Pablo Libutad','San Pablo Proper','San Pedro','San Vicente','Santa Filomena','Santa Ines','Santa Ursula','Santo Nino','Santo Rosario'],
  'Floridablanca':['Anon','Apalit','Bodega','Cabangcalan','Calantas','Carmencita','Consuelo','Dampe','Del Carmen','Dolores','San Antonio','San Carlos','San Isidro','San Jose','San Nicolas','San Pedro','San Ramon','San Roque','Santa Monica','Santo Rosario','Solib','Valdez'],
  // Tarlac Province
  'Tarlac City':['Aguso','Alvindia Segundo','Amucao','Armenia','Asturias','Atioc','Balete','Balibago I','Balibago II','Banaba','Bantog','Baras-baras','Batang-batang','Binauganan','Bora','Buenavista','Burot','Calingcuan','Capehan','Carangian','Care','Central','Culipat','Cut-cut I','Cut-cut II','Dalayap','Dela Paz','Dolores','Lara','Ligtasan','Lourdes','Mabilog','Mabini','Maliwalo','Mapalacsiao','Mapalad','Namnama','Navotas','Paraiso','Pinian','Poblacion','Salapungan','San Carlos','San Francisco','San Isidro','San Jose','San Luis','San Manuel','San Miguel','San Nicolas','San Pablo','San Rafael','San Roque','San Sebastian','San Vicente','Santa Cruz','Santa Maria','Santo Cristo','Santo Nino','Sapang Maragul','Sapang Tagalog','Sepung Calzada','Sinait','Suizo','Tariji','Trinidad','Ungot','Victoria'],
  'Capas':['Aranguren','Bueno','Cristo Rey','Cubcub','Cutcut II','Dolores','Estrada','Lawy','Lingo','Manga','Maruglu','Nueva Era','O\'Donnell','Sto. Domingo I','Sto. Domingo II','Talaga','Versalles','Villa Militar','Sta. Juliana','Sta. Lucia','Sta. Rita'],
  // Zambales Province
  'Olongapo City':['Asinan','Bajac-Bajac','Balangkas','Banicain','Barreto','East Bajac-Bajac','Gordon Heights','Kalaklan','Mabayuan','New Cabalan','New Ilalim','New Kababae','New Kalalake','Old Cabalan','Pag-asa','Santa Rita','West Bajac-Bajac'],
  'Subic':['Aningway Sacatihan','Asinan','Baraca-Camachile','Batiawan','Calapacuan','Calubian','Cawag','Ilwas','Mangan-Vaca','Matain','Naugsol','Pamatawan','San Isidro','Santo Tomas','Wawandue'],
  // Nueva Ecija
  'Cabanatuan City':['Aduas Centro','Aduas Norte','Aduas Sur','Bagong Buhay I','Bagong Buhay II','Bagong Buhay III','Bakero','Bakod Bayan','Balite','Bangad','Bantug Norte','Bantug Sur','Barlis','Barrera District','Bibiclat','Bonifacio District','Bungad','Cabu','Campo','Caridad','Communal','Cruz Roja','Daang Sarile','Dalampang','Dicarma','Dionisio S. Garcia','Fatima','General Luna','Ibabao-Bungad','Imelda District','Isla','Kapitan Pepe','Kalikid Norte','Kalikid Sur','Magsaysay District','Mabini Extension','Mabini Homesite','Maharlika','Maliwalo','Manggahan','Maot','Mapayapa Village I','Mapayapa Village II','Maria Theresa','Matadero','Meiling','Obrero','Pag-asa','Pagas','Pantoc','Plaridel','Pula','Puto Bumbong','Quezon District','Rizal','Saranay','Sumacab Este','Sumacab Norte','Sumacab Sur','Valle Cruz','Valdefuente','Valle'],
  'Gapan City':['Baloc','Bayanihan','Buliran','Bungo','Burnay','Camba','Cuyapo','Mahipon','Pias','Poblacion Norte','Poblacion Sur','San Isidro','San Roque','San Vicente'],
  // Ilocos Region
  'Laoag City':['Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Barangay XII','Barangay XIII','Barangay XIV','Barangay XV','Barangay XVI','Barangay XVII','Barangay XVIII','Barangay XIX','Barangay XX','Barangay XXI','Barangay XXII','Barangay XXIII','Barangay XXIV','Barangay XXV','Barangay XXVI','Barangay XXVII','Barangay XXVIII','Barangay XXIX','Barangay XXX','Barangay XXXI','Barangay XXXII','Barangay XXXIII','Barangay XXXIV','Barangay XXXV','Barangay XXXVI','Barangay XXXVII','Barangay XXXVIII','Barangay XXXIX','Barangay XL'],
  'Vigan City':['Ayusan Norte','Ayusan Sur','Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Cabalangegan','Cabaroan Daya','Cabaroan Laud','Camangaan','Capangpangan','Mindoro','Nagsangalan','Pantay Daya','Pantay Fatima','Pantay Laud','Paoa','Paratong','Pong-ol','Purok-a-Bassit','Purok-a-Dackel','Raois','Rugsuanan','Salindeg','San Jose','San Julian Norte','San Julian Sur','San Pedro','Tamag'],
  'Candon City':['Allangigan Primero','Allangigan Segundo','Amguid','Ayaoan','Bagani Camposanto','Bagani Gabor','Bagani Halog','Bagani Tocgo','Bagani Ubbog','Bagar','Balingaoan','Baliw','Bayubay Norte','Bayubay Sur','Bobon Caoayan','Bobon Capangpangan','Bobon Lourdes','Bobon San Antonio','Bobon Uno','Bungro','Cabaroan','Cabugao','Caburao','Cabuloan','Camandingan','Camangaan','Caparacadan','Caterman','Cato','Cervantes','Collago','Crugna','Damacuag','Ducob','Gayusan','Lintic','Looney','Lussoc','Manga','Nalsian Norte','Nalsian Sur','Palacapac','Pang-pang','Paratong Norte','Paratong Tres','Paratong Uno','Paratong Quatro','San Agustin','San Andres','San Antonio','San Isidro Norte','San Isidro Sur','San Jose Norte','San Jose Sur','San Juan','San Nicolas','San Pedro','Santa Cruz','Santa Lucia','Santo Tomas','Tablac','Talogtog','Tamurong','Tonoton'],
  // Region VII - Additional Cebu Cities
  'Lapu-Lapu City':['Agus','Babag','Bankal','Baring','Basak','Buaya','Canjulao','Caubian','Caw-oy','Cordova','Gun-ob','Ibo','Looc','Mactan','Maribago','Marigondon','Pajac','Pajo','Punta Engano','Pusok','Sabang','Santa Rosa','Subabasbas','Talima','Tingo','Tungasan'],
  'Mandaue City':['Alang-Alang','Bakilid','Banilad','Basak','Cambaro','Canduman','Casili','Casuntingan','Centro','Cubacub','Guizo','Ibabao-Estancia','Jagobiao','Labogon','Looc','Maguikay','Mantuyong','Opao','Pakna-an','Pagsabungan','Pokuna','Subangdaku','Tabok','Tawason','Tingub','Tipolo','Umapad'],
  'Talisay City':['Biasong','Bulacao','Cadulawan','Cansojong','Dumlog','Jaclupan','Lagtang','Lawaan I','Lawaan II','Lawaan III','Linao','Maghaway','Manipis','Mohon','Poblacion','Pooc','San Isidro','San Roque','Tabunok','Tangke'],
  'Toledo City':['Awihao','Bagakay','Balonga','Basak','Bunga','Cabitoonan','Calongcalong','Cambang-ug','Camp 8','Canlumampao','Cantabaco','Capitan Lorenzo','Daanglungsod','Don Andres Soriano','Dumlog','Ilihan','Juan Climaco Sr.','Landahan','Loay','Luray II','Matab-ang','Media Once','Pangamihan','Poblacion','Poog','Putlongon','Sagay','Sam-ang','Sangi','Santo Nino','Subayon','Talavera','Tilod','Tuburan'],
  'Danao City':['Baliang','Binaliw','Cabungahan','Cagat-Lamac','Cahumayan','Cambanay','Cambubho','Cogon-Cruz','Danasan','Dunggo','Dungo-an','Guinsay','Ibo','Langosig','Lawaan','Licos','Looc','Lugo','Managase','Marcos','Pagsabungan','Patag','Poblacion','Sabang','Suba','Sulangan','Sungay','Taytay','Trinidad','Tuburan','Uling'],
  // Region XI - Davao
  'Tagum City':['Apokon','Bincungan','Busaon','Canocotan','Cuambogan','La Filipina','Liboganon','Madaum','Magdum','Magugpo East','Magugpo North','Magugpo Poblacion','Magugpo South','Magugpo West','Mankilam','New Balamban','Nueva Fuerza','Pagsabangan','Pandaitan','Quezon','San Agustin','San Isidro','San Miguel','Santo Nino','Visayan Village'],
  'Panabo City':['A.O. Florentino','Buenavista','Datu Abdul Dadia','Gredu','J.P. Laurel','Kakar','Katipunan','Langcoan','Mabunao','Maduao','Malativas','Manay','Nanyo','New Malaga','New Pandan','New Visayas','Quezon','Salvacion','San Francisco','San Nicolas','San Pedro','San Roque','San Vicente','Santo Nino','Sto. Tomas','Tibungol'],
  'General Santos City':['Apopong','Baluan','Batomelong','Buayan','Bula','Calumpang','City Heights','Conel','Dadiangas East','Dadiangas North','Dadiangas South','Dadiangas West','Fatima','Katangawan','Labangal','Lagao','Ligaya','Mabuhay','Olympog','San Isidro','San Jose','Sinawal','Tambler','Tinagacan','Upper Labay'],
  'Digos City':['Aplaya','Balabag','Binaton','Cogon','Colorado','Ruparan','San Agustin','San Jose','San Miguel','San Roque','Santa Cruz','Santa Maria','Sinawilan','Soong','Tiguman'],
  // Region XII
  'Koronadal City':['Assumption','Avanceña','Cacub','Caloocan','Carpenter Hill','Concepcion','General Paulino Santos','Mabini','Magsaysay','Namnama','New Pangasinan','Paraiso','Poblacion','San Isidro','San Jose','Saravia','Zone I','Zone II','Zone III'],
  'Tacurong City':['Baras','Buenaflor','Calean','F. Cajelo','Griño','Imao','Kakar','Katinon','Lancheta','Lapu','Lower Katungal','Magon','Matin-ao','New Isabela','New Lagao','New Passi','Rajah Muda','San Emmanuel','San Mateo','San Pablo','Santo Nino','Sudapin','Upper Katungal'],
  // CARAGA
  'Butuan City':['Agao','Ambago','Amparo','Ampayon','Anticala','Antongalon','Aupagan','Baan KM 3','Baan Riverside','Babag','Bading','Bancasi','Banza','Baobaoan','Basag','Bayanihan','Bilay','Bit-os','Bitan-ag','Bobon','Bonbon','Bugabus','Bugsukan','Buhangin','Cabcabon','Camayahan','Dagohoy','Dankias','De Oro','Diego Silang','Don Francisco','Doongan','Dulag','Dumalagan','Florida','Kinamlutan','Lemon','Libertad','Limaha','Los Angeles','Lumbocan','Maguinda','Mahay','Mahogany','Maibu','Mandamo','Maon','Masao','Maug','Montivista','Ong Yiu','Pagatpatan','Pangabugan','Pinamanculan','Port Poyohon','Rajah Soliman','Salvacion','San Ignacio','San Mateo','San Vicente','Sikatuna','Silongan','Sumilihon','Tagabaca','Taguibo','Taligaman','Tiniwisan','Tungao','Urduja','Villa Kananga'],
  'Cabadbaran City':['Calibunan','Caasinan','Colonia','Compostela','Corocotan','Corongcoron','Datu','Doña Carmen','Katugasan','Lagtang','Mahaba','Poblacion I','Poblacion II','Poblacion III','Poblacion IV','Poblacion V','Poblacion VI','Poblacion VII','Poblacion VIII','Poblacion IX','Poblacion X','Poblacion XI','Poblacion XII','Poblacion XIII'],
  'Surigao City':['Anomar','Bilabid','Buenavista','Canlanipa','Canlasid','Dao','Ipil','Lisondra','Luna','Mat-i','Sabang','San Juan','San Roque','Taft','Togbongon','Tugas','Washington'],
  'Tandag City':['Awasian','Bag-ong Lungsod','Barangay I','Barangay II','Barangay III','Barangay IV','Barangay V','Barangay VI','Barangay VII','Barangay VIII','Barangay IX','Barangay X','Barangay XI','Bagong Silang','Bongtod','Buenavista','Dao','Mabua','Mabuhay','Mahanub','Salvacion'],
  // Mindanao - Region X
  'Iligan City':['Abuno','Acmac','Bagong Silang','Bonbonon','Bunawan','Buru-un','Dalipuga','Del Carmen','Digkilaan','Ditucalan','Dulag','Hinaplanon','Hindang','Kabacsanan','Kalilangan','Kiwalan','Lanipao','Luinab','Mahayahay','Mainit','Mandulog','Maria Cristina','Palao','Panoroganan','Poblacion','Puga-an','Rogongon','San Miguel','San Roque','Santiago','Santo Rosario','Saray','Suarez','Tambacan','Tibanga','Tipanoy','Tominobo Ibaba','Tominobo Ilaya','Tubod','Ubaldo Laya','Upper Hinaplanon','Villa Verde'],
  'Valencia City':['Bagontaas','Banlag','Batangan','Catumbalon','Colonia','Concepcion','Dagat-Dagatan','Guinoyuran','Kahapunan','Laligan','Lilingayon','Linabo','Lumbo','Maapag','Manalog','Matingao','Merangeran','Mt. Nebo','Nabago','Paitan','Palacapao','Pinatilan','Poblacion','San Carlos','San Isidro','Sugod','Tankulan','Tongantongan'],
  'Ozamiz City':['Bacolod','Bagakay','Baybay Santa Cruz','Baybay Triunfo','Bongbong','Calabayan','Capucao C.','Capucao P.','Catadman','Cavinte','Cogon','Corrales','Dalapang','Doña Consuelo','Doongan','Kinuman Norte','Kinuman Sur','Lam-an','Lapasan','Liposong','Litapan','Malaubang','Manaka','Maningcol','Maranat','Molicay','Naga','Ozamiz City Proper','Pines','Pulot','San Antonio','San Jose','Tinago','Triunfo'],
  // Region IX
  'Zamboanga City':['Arena Blanco','Ayala','Baliwasan','Baluno','Boalan','Bolong','Buenavista','Bunguiao','Busay','Cabaluay','Cabatangan','Cacao','Calabasa','Calarian','Camino Nuevo','Campo Islam','Campo Uno','Campo Dos','Campo Tres','Carmen','Cawit','Cob-Cob','Colon','Coneha','Culianan','Dita','Divisoria','Dumagat','Dulian Lower','Dulian Upper','Guiwan','Kagay','Kalonong','Kasanyangan','La Paz','Labuan','Lacasanao','Limpapa','Lubigan','Lumayang','Lumbangan','Lunzuran','Maasin','Malagutay','Mampang','Manalipa','Mariki','Mazauer','Mercedes','Moret','Muti','Pag-asa','Pamucutan','Pangpang','Panubigan','Pasilmanta','Pasobolong','Patalon','Penancula','Pettit Barracks','Putik','Recodo','Rio Hondo','Sacol','Salaan','San Jose Cawa-cawa','San Jose Gusu','San Roque','San Vicente','Sangali','Santa Barbara','Santa Catalina','Santa Maria','Santo Nino','Sinunoc','Sta. Catalina','Talon-talon','Taluksangay','Tetuan','Tictapul','Tigbalabag','Tigtabon','Tolosa','Tugbungan','Tumaga','Tumalutab','Tuminobo','Victoria','Vitali','Waling-waling','Zambowood'],
  // Bicol Region
  'Naga City':['Abella','Bagumbayan Norte','Bagumbayan Sur','Balatas','Calauag','Cararayan','Carolina','Concepcion Grande','Concepcion Pequena','Dinaga','Igualdad Interior','Lerma','Liboton','Mabolo','Pacol','Panicuason','Penaranda','Sabang','San Felipe','San Francisco','San Isidro','Santa Cruz','Tabuco','Tinago','Triangulo'],
  'Legazpi City':['Arimbay','Bagacay','Banquerohan','Barangay 1','Barangay 2','Barangay 3','Barangay 4','Barangay 5','Barangay 6','Barangay 7','Barangay 8','Barangay 9','Barangay 10','Barangay 11','Barangay 12','Barangay 13','Barangay 14','Barangay 15','Barangay 16','Barangay 17','Barangay 18','Barangay 19','Barangay 20','Barangay 21','Bitano','Bonot','Buyuan','Cabagaan','Bonga','Cruzada','Dap-dap','Estanza','Gogon','Homapon','Ilaor Norte','Ilaor Sur','Imalnod','Kapantawan','Kilikao','Padang','Pawa','Rawis','Sagpon','Saluday','San Joaquin','San Miguel','San Pedro','Pinaric','Tagas','Tinago','Tulas','Tulapos'],
  'Iloilo City':['Adgao','Aguinaldo','Alabang','Arevalo','Balantang','Baldoza','Batiano','Bito-on','Bolilao','Bonifacio','Buhang','Buntatala','Burgos-Mabini-Plaza','Camalig','City Proper','Compania','Costa Sur','Cubay Norte','Cubay Sur','Cuartero','Daldalon','Democracia','Desamparados','Dungon','Dungon A','Dungon B','East Baluarte','East Timawa','Edganzon','El 98','Fajardo','Gustilo','Hibao-an Norte','Hibao-an Sur','Hinactacan','Hipodromo','Inday','Ingore','Jibao-an','La Paz','Laguda','Lapuz Norte','Lapuz Sur','Leganes','Libertad','Libertad Weste','Loboc','Lopez Jaena Norte','Lopez Jaena Sur','Luna','Maasin','Macasandig','Mansaya-Lapuz','Navais','Nonoy','North Avanceña','North Fundidor','North San Jose','Oñate de Leon','Osmena','Pale Benedicto Rizal','Phhc Block 17','Phhc Block 22','Quintin Salas','Rizal Palapala I','Rizal Palapala II','Rizal Estanzuela','San Isidro Norte','San Isidro Sur','San Jose','San Pedro','Santa Cruz','Taal','Tabuc Suba','Tanza Norte','Tanza Sur','Tico','Timawa Tay-tay','West Habog-habog','West Timawa','Yulo Drive','Zone I Sur','Zone II Norte'],
  'Bacolod City':['Alangilan','Alijis','Bacolod City Proper','Bata','Cabug','Estefania','Felisa','Granada','Handumanan','Mandalagan','Mansilingan','Montevista','Pahanocoy','Punta Taytay','Singcang-Airport','Sum-ag','Taculing','Tangub','Taytay','Vista Alegre'],
  'Dumaguete City':['Bagacay','Bajumpandan','Balugo','Banilad','Bantayan','Batinguel','Bunao','Cadawinonan','Calindagan','Camanjac','Candau-ay','Cantil-e','Daro','Junob','Looc','Mangnao-Canal','Motong','Piapi','Poblacion No. 1','Poblacion No. 2','Poblacion No. 3','Poblacion No. 4','Poblacion No. 5','Poblacion No. 6','Poblacion No. 7','Poblacion No. 8','Pulantubig','Tabuctubig','Taclobo','Talay'],
  'Tacloban City':['Anibong','Bagacay','Balon Anito','Barangay 1','Barangay 2','Barangay 3','Barangay 4','Barangay 5','Barangay 6','Barangay 7','Barangay 8','Barangay 9','Barangay 10','Barangay 11','Barangay 12','Barangay 13','Barangay 14','Barangay 15','Barangay 16','Barangay 17','Barangay 18','Barangay 19','Barangay 20','Barangay 21','Barangay 22','Barangay 23','Barangay 24','Barangay 25','Barangay 26','Barangay 27','Barangay 28','Barangay 29','Barangay 30','Barangay 31','Barangay 32','Barangay 33','Barangay 34','Barangay 35','Barangay 36','Barangay 37','Barangay 38','Barangay 39','Barangay 40','Barangay 41','Barangay 42','Barangay 43','Barangay 44','Barangay 45','Barangay 46','Barangay 47','Barangay 48','Barangay 49','Barangay 50','Barangay 51','Barangay 52','Barangay 53','Barangay 54','Barangay 55','Barangay 56','Barangay 57','Barangay 58','Barangay 59','Barangay 60','Barangay 61','Barangay 62','Barangay 63','Barangay 64','Barangay 65','Barangay 66','Barangay 67','Barangay 68','Barangay 69','Barangay 70','Barangay 71','Barangay 72','Barangay 73','Barangay 74','Barangay 75','Barangay 76','Barangay 77','Barangay 78','Barangay 79','Barangay 80','Barangay 81','Barangay 82','Barangay 83','Barangay 84','Barangay 85','Barangay 86','Barangay 87','Barangay 88','Barangay 89','Barangay 90','Barangay 91','Barangay 92'],
};
