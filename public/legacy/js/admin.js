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
  'adm-maintenance':  'System Maintenance',
  'adm-branch-reports':'Branch Reports',
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
  }

  if (pageId === 'adm-audit-logs') {
    loadAuditLogs();
  }

  if (pageId === 'adm-maintenance') {
    loadSystemData();
    // Auto-focus the scan field so a HID RFID reader's keystrokes land there
    // immediately without an extra click.
    setTimeout(() => document.getElementById('adm-rfid-input')?.focus(), 0);
  }

  if (pageId === 'adm-branch-reports') {
    loadBranchReports();
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
  if (typeof loadOwnEmergencyContact === 'function') loadOwnEmergencyContact('adm-ep-ec');
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

/* ── BRANCH REPORTS ──
   View-only branch summary: attendance, headcount and payroll status for the
   Admin's own branch. Every figure comes from /api/admin/branch-reports, which
   scopes itself to the caller's branch_id from their session — this screen has
   no edit affordance because payroll figures belong to the Accountant. */
async function loadBranchReports() {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const payrollBody = document.getElementById('adm-br-payroll-body');
  if (payrollBody) payrollBody.innerHTML = skeletonRows(2, 3);

  try {
    const response = await fetch('/api/admin/branch-reports', { method: 'GET' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load branch reports.');

    setText('adm-br-branch', data.branch?.label || '—');
    setText('adm-br-generated', data.branch?.all_branches
      ? 'All branches — view-only summary'
      : 'View-only summary');

    setText('adm-br-headcount', data.headcount?.total ?? 0);
    const byRole = data.headcount?.by_role || {};
    const roleParts = Object.keys(byRole)
      .sort()
      .map((role) => `${byRole[role]} ${role.replace('_', ' ')}`);
    setText('adm-br-headcount-breakdown', roleParts.length
      ? roleParts.join(' · ')
      : 'Staff assigned to this branch');

    setText('adm-br-unassigned', data.unassigned_staff ?? 0);
    setText('adm-br-present', data.attendance?.present ?? 0);
    setText('adm-br-late', data.attendance?.late ?? 0);
    setText('adm-br-absent', data.attendance?.absent ?? 0);
    setText('adm-br-date', data.attendance?.date || '—');

    if (payrollBody) {
      const payroll = data.payroll || {};
      const rows = [
        ['Latest pay period', payroll.latest_period || 'None processed yet'],
        ['Employees processed this period', payroll.processed_this_period ?? 0],
        ['Awaiting processing', payroll.awaiting_processing ?? 0],
        ['Pending payroll entries', payroll.pending_entries ?? 0],
        ['Total net pay this period', formatMoney(payroll.total_net_pay_this_period)],
      ];
      payrollBody.innerHTML = rows
        .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(value))}</td></tr>`)
        .join('');
    }
  } catch (error) {
    if (payrollBody) {
      payrollBody.innerHTML = `<tr><td colspan="2">${escapeHtml(error.message || 'Unable to load branch reports.')}</td></tr>`;
    }
  }
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '₱ 0';
  return `₱ ${amount.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

/* ALLOWED_SUFFIXES and splitFullName now live in app.js — HR needs them too. */

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

function composeFullName({ first_name = '', middle_initial = '', last_name = '', suffix = '' }) {
  const first = toTitleCaseWords(first_name);
  const middle = toTitleCaseWords(middle_initial);
  const last = toTitleCaseWords(last_name);
  const resolvedSuffix = normalizeSuffix(suffix);

  const parts = [first, middle, last].filter(Boolean);
  return [parts.join(' '), resolvedSuffix].filter(Boolean).join(' ');
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

function renderDashboardPanels(panels = {}) {
  const totalEmployeesEl = document.getElementById('adm-panel-total-employees');
  const absentTodayEl = document.getElementById('adm-panel-absent-today');

  if (totalEmployeesEl) totalEmployeesEl.textContent = String(panels.total_employees || 0);
  if (absentTodayEl) absentTodayEl.textContent = String(panels.absent_today || 0);

  // There is no #adm-panel-total-payroll card in pages/admin.html — the matrix
  // gives Admin view-only access to payroll records, and no total-payroll tile
  // was ever added to this dashboard. The line that wrote to it has been
  // removed rather than left as a permanently-false null check.

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
    const payload = await fetchAttendanceCached();

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

function formatRfidScanFeedback(record, tap) {
  if (!record) return '';
  const name = record.employee_name || 'Employee';
  if (tap === 'duplicate') {
    return `${name}: repeated tap ignored — only the first and last tap of the day count.`;
  }
  if (record.time_out) {
    return `${name}: Time Out recorded at ${formatTimeOnly(record.time_out)} (Time In ${formatTimeOnly(record.time_in)}).`;
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
  // Waits for at least 6 digits so a paused manual entry of a short
  // number never auto-fires mid-typing.
  let idleTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(idleTimer);
    // Numbers only: drop anything else typed or pasted.
    const digits = input.value.replace(/\D/g, '');
    if (digits !== input.value) input.value = digits;
    if (!/^\d{6,}$/.test(digits)) return;
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
    showRfidFeedback(formatRfidScanFeedback(payload.record, payload.tap) || payload.message || 'RFID scan recorded.', false);
    logAuditMovement({
      module: 'ui',
      action: 'rfid_scan',
      entity_type: 'attendance',
      entity_id: rfidCode,
      description: 'Admin submitted RFID attendance scan.',
      source: 'ui',
      metadata: { persisted: Boolean(payload.persisted) },
    });
    // A scan changes present/absent/late counts, which fetchDashboardCached()
    // may still be serving from its 20s cache — invalidate so the next
    // dashboard view reflects this scan immediately.
    invalidateDashboardCache();
    // Same for the attendance payload this scan just changed — drop it first so
    // the reload below re-fetches instead of replaying the pre-scan rows.
    invalidateAttendanceCache();
    if (document.getElementById('adm-attendance')?.classList.contains('active')) await loadAttendanceData();
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

const debouncedLoadAuditLogs = debounce(loadAuditLogs, 300);

function setAuditSearch(value) {
  auditSearch = String(value || '').trim();
  debouncedLoadAuditLogs();
}

function setAuditModuleFilter(value) {
  auditModuleFilter = String(value || 'all').trim().toLowerCase();
  loadAuditLogs();
}

function setAuditActionFilter(value) {
  auditActionFilter = String(value || 'all').trim().toLowerCase();
  loadAuditLogs();
}

// Filters and the debounced search all call loadAuditLogs(); a slower, older
// query landing after a newer one used to show the previous filter's rows.
let auditRequestSeq = 0;

async function loadAuditLogs() {
  const seq = ++auditRequestSeq;
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
    if (seq !== auditRequestSeq) return;

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
    if (seq !== auditRequestSeq) return;
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
    const payload = await fetchDashboardCached();
    renderDashboard(payload);
  } catch (error) {
    console.error('Dashboard load error:', error.message);
  }
}

window.openRfidEditModal = openRfidEditModal;
window.closeRfidEditModal = closeRfidEditModal;
window.submitRfidUpdate = submitRfidUpdate;
window.voidRfidCard = voidRfidCard;
window.setRfidDeviceSearch = setRfidDeviceSearch;
window.loadSystemData = loadSystemData;
// A popup can be silently blocked by the browser (most reliably on origins
// like http://localhost that have never been granted "always allow popups"),
// which leaves window.open() returning null with no visible sign anything
// happened. Navigating the tab itself always works. rfid-terminal.html's own
// Exit Terminal flow (terminal.js) already returns to /admin afterwards.
function openRfidTerminal() {
  window.top.location.href = '/rfid-terminal';
}

window.openRfidTerminal = openRfidTerminal;
window.submitRfidAttendanceScan = submitRfidAttendanceScan;
window.exportAttendanceCsv = exportAttendanceCsv;
window.setAuditSearch = setAuditSearch;
window.setAuditModuleFilter = setAuditModuleFilter;
window.setAuditActionFilter = setAuditActionFilter;
window.exportAuditLogsCsv = exportAuditLogsCsv;
window.loadAdminProfile = loadAdminProfile;

/* ── CHANGE PASSWORD ── */
function submitAdminChangePassword() {
  return submitAccountPasswordChange('adm', {
    current: 'adm-cur-password',
    next: 'adm-new-password',
    confirm: 'adm-confirm-password',
  });
}

window.submitAdminChangePassword = submitAdminChangePassword;

/* ═══════════════════════════════════════
   SYSTEM MAINTENANCE
   ═══════════════════════════════════════ */

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
  if (rfidTbody) rfidTbody.innerHTML = skeletonRows(6);

  try {
    const payload = await fetchSystemCached();

    systemData = payload;
    allRfidDevices = payload.rfid_devices || [];

    renderFilteredRfidDevices();
  } catch (error) {
    if (rfidTbody) {
      rfidTbody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
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
    // Drop the cached system payload first, or the reload below replays the
    // device list from before this edit.
    invalidateSystemCache();
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
    invalidateSystemCache();
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
  rfidPaginator = window.createPaginator({ id: 'adm-rfid', pageSize: 15, renderFn: renderRfidDevices });

  attachRfidScannerInput();


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
