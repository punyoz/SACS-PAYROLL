/* ═══════════════════════════════════════
   admin.js — Administrator role logic
   Handles: page navigation, approvals
   Edit this file for admin-specific features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const ADMIN_PAGES = {
  'adm-dashboard':  'Dashboard',
  'adm-employees':  'Manage Employees',
  'adm-attendance': 'Attendance',
  'adm-approvals':  'Salary Approvals',
  'adm-reports':    'Summary Reports',
  'adm-audit-logs': 'Audit Logs',
};

const AVATAR_COLORS = ['#3EC97A', '#F5A623', '#1DB8A0', '#E85555', '#7F77DD'];
let allEmployees = [];
let employeeTypeFilter = 'all';
let employeeSearch = '';
let currentEditingEmployee = null;
let dashboardData = null;
let salaryApprovalsData = [];
let salaryApprovalHistoryData = [];
let salaryApprovalsCanPersist = true;
let summaryReportsData = null;
let attendanceData = null;
let auditLogsData = [];
let auditSummary = { total: 0, success: 0, failed: 0 };
let auditSearch = '';
let auditModuleFilter = 'all';
let auditActionFilter = 'all';

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

  if (pageId === 'adm-employees') {
    loadEmployees();
  }

  if (pageId === 'adm-dashboard') {
    loadDashboard();
  }

  if (pageId === 'adm-approvals') {
    loadSalaryApprovals();
  }

  if (pageId === 'adm-reports') {
    loadSummaryReports();
  }

  if (pageId === 'adm-attendance') {
    loadAttendanceData();
  }

  if (pageId === 'adm-audit-logs') {
    loadAuditLogs();
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

/* ── APPROVAL ACTIONS ── */
async function approveChange(approvalId) {
  await updateApprovalStatus(approvalId, 'approve');
}

async function rejectChange(approvalId) {
  await updateApprovalStatus(approvalId, 'reject');
}

function updateApprovalBadge(pendingCount) {
  const count = Number(pendingCount || 0);
  const badges = document.querySelectorAll('#s-admin .nib');
  badges.forEach(b => {
    b.textContent = String(count);
    b.style.display = count > 0 ? '' : 'none';
  });
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'NA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
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
  const pendingApprovalsEl = document.getElementById('adm-panel-pending-approvals');
  const absentTodayEl = document.getElementById('adm-panel-absent-today');

  if (totalEmployeesEl) totalEmployeesEl.textContent = String(panels.total_employees || 0);
  if (totalPayrollEl) totalPayrollEl.textContent = formatMoney(panels.total_payroll_month || 0);
  if (pendingApprovalsEl) pendingApprovalsEl.textContent = String(panels.pending_approvals || 0);
  if (absentTodayEl) absentTodayEl.textContent = String(panels.absent_today || 0);

  updateApprovalBadge(panels.pending_approvals || 0);
}

function renderPendingSalaryApprovals(approvals = []) {
  const container = document.getElementById('adm-dashboard-pending-list');
  if (!container) return;

  if (!approvals.length) {
    container.innerHTML = `
      <div class="approval-item">
        <div class="approval-info" style="color:var(--t3);">No pending salary approvals.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = approvals.slice(0, 3).map((approval) => {
    const approvalId = escapeJsString(approval.id);
    const currentSalary = Number(approval.current_salary || 0);
    const proposedSalary = Number(approval.proposed_salary || 0);
    const employeeName = escapeHtml(approval.employee_name);
    const submittedBy = escapeHtml(approval.submitted_by || 'Accountant');
    const submittedAt = escapeHtml(formatDateTime(approval.submitted_at));

    return `
      <div class="approval-item">
        <div class="approval-icon">📝</div>
        <div class="approval-info">
          <div class="ai-name">${employeeName}</div>
          <div class="ai-sub">Submitted by ${submittedBy} · ${submittedAt}</div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;color:var(--t3);">${formatMoney(currentSalary)}</span>
            <span style="color:var(--t3);">→</span>
            <span class="approval-change">${formatMoney(proposedSalary)}</span>
          </div>
        </div>
        <div class="acts">
          <button class="btn btn-green" style="font-size:11px;padding:6px 12px;" onclick="approveChange('${approvalId}')">Approve</button>
          <button class="btn btn-red" style="font-size:11px;padding:6px 12px;" onclick="rejectChange('${approvalId}')">Reject</button>
        </div>
      </div>
    `;
  }).join('');
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
    const status = String(item.status || 'Paid').toLowerCase();
    const statusClass = status === 'pending' ? 'ba' : 'bg';
    const statusText = status === 'pending' ? 'Pending' : 'Paid';

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

function renderSalaryApprovalCards(approvals = [], canPersist = true) {
  const container = document.getElementById('adm-approvals-list');
  if (!container) return;

  const notice = canPersist
    ? ''
    : '<div class="banner banner-amber" style="margin-bottom:12px;">Demo mode: salary approvals are simulated because salary_approvals table is not yet available.</div>';

  if (!approvals.length) {
    container.innerHTML = `${notice}<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta">No pending salary approvals.</div></div></div>`;
    return;
  }

  container.innerHTML = `${notice}${approvals.map((approval) => {
    const approvalId = escapeJsString(approval.id);
    const name = escapeHtml(approval.employee_name);
    const employeeCode = escapeHtml(approval.employee_code || 'N/A');
    const employeeType = escapeHtml(approval.employee_type || 'Teaching');
    const position = escapeHtml(approval.position || 'Staff');
    const submittedBy = escapeHtml(approval.submitted_by || 'Accountant');
    const submittedAt = escapeHtml(formatDateTime(approval.submitted_at));
    const reason = escapeHtml(approval.reason || 'No reason provided.');
    const currentSalary = Number(approval.current_salary || 0);
    const proposedSalary = Number(approval.proposed_salary || 0);
    const difference = proposedSalary - currentSalary;
    const diffPrefix = difference >= 0 ? '+' : '-';

    return `
      <div class="approval-card" style="margin-bottom:14px;">
        <div class="approval-card-icon">📝</div>
        <div class="approval-card-body">
          <div class="approval-card-name">${name}</div>
          <div class="approval-card-meta">${employeeCode} · ${employeeType} · ${position}</div>
          <div class="approval-card-meta">Submitted by: ${submittedBy} · ${submittedAt}</div>
          <div class="salary-compare">
            <div class="sc-box"><label>Current Salary</label><div class="sc-val">${formatMoney(currentSalary)}</div></div>
            <span class="sc-arrow">→</span>
            <div class="sc-box proposed"><label>Proposed</label><div class="sc-val">${formatMoney(proposedSalary)}</div></div>
            <div class="sc-box diff"><label>Difference</label><div class="sc-val">${diffPrefix} ${formatMoney(Math.abs(difference))}</div></div>
          </div>
          <div class="approval-reason"><strong>Reason:</strong> ${reason}</div>
        </div>
        <div class="approval-card-actions">
          <button class="btn btn-green" onclick="approveChange('${approvalId}')">✓ Approve</button>
          <button class="btn btn-red" onclick="rejectChange('${approvalId}')">✕ Reject</button>
        </div>
      </div>
    `;
  }).join('')}`;
}

function renderSalaryApprovalHistory(history = []) {
  const tbody = document.getElementById('adm-approval-history-body');
  if (!tbody) return;

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">No approval history yet.</td></tr>';
    return;
  }

  tbody.innerHTML = history.map((item) => {
    const name = escapeHtml(item.employee_name || 'Unknown Employee');
    const type = escapeHtml(item.employee_type || 'Teaching');
    const typeBadgeClass = type === 'Non-Teaching' ? 'ba' : 'bt2';
    const currentSalary = Number(item.current_salary || 0);
    const proposedSalary = Number(item.proposed_salary || 0);
    const diff = proposedSalary - currentSalary;
    const diffPrefix = diff >= 0 ? '+' : '-';
    const status = String(item.status || 'approved').toLowerCase();
    const statusClass = status === 'rejected' ? 'br' : 'bg';
    const decidedAt = item.decided_at || item.updated_at || item.submitted_at;

    return `
      <tr>
        <td class="nm">${name}</td>
        <td><span class="badge ${typeBadgeClass}">${type}</span></td>
        <td class="mn">${formatMoney(currentSalary)} → ${formatMoney(proposedSalary)} <span style="color:var(--t3);">(${diffPrefix}${formatMoney(Math.abs(diff))})</span></td>
        <td><span class="badge ${statusClass}"><span class="bd"></span>${escapeHtml(status)}</span></td>
        <td class="mn">${escapeHtml(formatDateTime(item.submitted_at))}</td>
        <td class="mn">${escapeHtml(formatDateTime(decidedAt))}</td>
      </tr>
    `;
  }).join('');
}

function renderSummaryPanels(summary = {}) {
  const panels = summary?.panels || {};
  const periodLabel = summary?.period_label || 'Current Period';

  const totalRecordsEl = document.getElementById('adm-reports-total-records');
  const totalGrossEl = document.getElementById('adm-reports-total-gross');
  const totalDeductionsEl = document.getElementById('adm-reports-total-deductions');
  const totalNetPayEl = document.getElementById('adm-reports-total-net-pay');
  const periodNoteEl = document.getElementById('adm-reports-period-note');
  const tableTitleEl = document.getElementById('adm-reports-table-title');

  if (totalRecordsEl) totalRecordsEl.textContent = String(panels.total_records || 0);
  if (totalGrossEl) totalGrossEl.textContent = formatMoney(panels.total_gross || 0);
  if (totalDeductionsEl) totalDeductionsEl.textContent = formatMoney(panels.total_deductions || 0);
  if (totalNetPayEl) totalNetPayEl.textContent = formatMoney(panels.total_net_pay || 0);
  if (periodNoteEl) periodNoteEl.textContent = periodLabel;
  if (tableTitleEl) tableTitleEl.textContent = `Payroll by Employee — ${periodLabel}`;
}

function renderSummaryTable(rows = []) {
  const tbody = document.getElementById('adm-reports-table-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">No payroll records found for this period.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((row) => {
    const name = escapeHtml(row.employee_name || 'Unknown Employee');
    const type = escapeHtml(row.employee_type || 'Teaching');
    const typeBadgeClass = type === 'Non-Teaching' ? 'ba' : 'bt2';

    return `
      <tr>
        <td class="nm">${name}</td>
        <td><span class="badge ${typeBadgeClass}">${type}</span></td>
        <td class="mn">${Number(row.total_records || 0)}</td>
        <td class="mn">${formatMoney(row.total_gross || 0)}</td>
        <td class="mn">${formatMoney(row.total_deductions || 0)}</td>
        <td class="mn">${formatMoney(row.total_net_pay || 0)}</td>
      </tr>
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
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">Loading attendance records...</td></tr>';
  }

  try {
    const response = await fetch('/api/admin/attendance', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load attendance data');
    }

    attendanceData = payload;
    renderAttendancePanels(payload);
    renderAttendanceTable(payload.attendance_logs || []);
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

async function submitRfidAttendanceScan() {
  const input = document.getElementById('adm-rfid-input');
  if (!input) return;

  const rfidCode = String(input.value || '').trim();
  if (!rfidCode) {
    showRfidFeedback('Enter RFID or employee ID first.', true);
    return;
  }

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
    showRfidFeedback(payload.message || 'RFID scan recorded.', false);
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
  anchor.download = `bncs-attendance-${dateKey}.csv`;
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
    const status = String(log.status || 'success').toLowerCase();
    const statusClass = status === 'failed' ? 'br' : 'bg';
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
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">Loading audit logs...</td></tr>';
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
    renderAuditTable(auditLogsData);
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
  anchor.download = 'bncs-audit-logs.csv';
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

function exportSummaryReportsCsv() {
  const rows = summaryReportsData?.payroll_by_employee || [];
  if (!rows.length) {
    window.alert('No payroll report data available to export.');
    return;
  }

  const headers = ['Employee', 'Type', 'Records', 'Total Gross', 'Total Deductions', 'Total Net Pay'];
  const lines = [headers.join(',')];

  rows.forEach((row) => {
    lines.push([
      toCsvValue(row.employee_name || ''),
      toCsvValue(row.employee_type || ''),
      toCsvValue(Number(row.total_records || 0)),
      toCsvValue(Number(row.total_gross || 0).toFixed(2)),
      toCsvValue(Number(row.total_deductions || 0).toFixed(2)),
      toCsvValue(Number(row.total_net_pay || 0).toFixed(2)),
    ].join(','));
  });

  const csvContent = `\uFEFF${lines.join('\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const period = String(summaryReportsData?.period_label || 'report').replaceAll(' ', '-').toLowerCase();

  anchor.href = url;
  anchor.download = `bncs-summary-reports-${period}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  logAuditMovement({
    module: 'ui',
    action: 'export_csv',
    entity_type: 'summary_reports',
    entity_id: period,
    description: 'Admin exported summary reports CSV.',
    source: 'ui',
    metadata: { row_count: rows.length },
  });
}

async function loadSummaryReports() {
  const tbody = document.getElementById('adm-reports-table-body');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">Loading payroll summary...</td></tr>';
  }

  try {
    const response = await fetch('/api/admin/reports', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load summary reports');
    }

    summaryReportsData = payload;
    renderSummaryPanels(payload);
    renderSummaryTable(payload.payroll_by_employee || []);
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function renderDashboard(data) {
  dashboardData = data || null;
  const panels = data?.panels || {};
  const approvals = data?.pending_approvals || [];

  renderDashboardPanels(panels);
  renderPendingSalaryApprovals(approvals);
  renderMonthlyPayrollChart(data?.monthly_payroll || []);
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
    const pendingContainer = document.getElementById('adm-dashboard-pending-list');
    if (pendingContainer) {
      pendingContainer.innerHTML = `<div class="approval-item"><div class="approval-info" style="color:#E85555;">${escapeHtml(error.message)}</div></div>`;
    }
  }
}

async function loadSalaryApprovals() {
  const approvalsContainer = document.getElementById('adm-approvals-list');
  const historyBody = document.getElementById('adm-approval-history-body');

  if (historyBody) {
    historyBody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">Loading approval history...</td></tr>';
  }

  try {
    const response = await fetch('/api/admin/salary-approvals?status=all', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load salary approvals');
    }

    salaryApprovalsData = payload.pending_requests || payload.requests || [];
    salaryApprovalHistoryData = payload.history_requests || [];
    salaryApprovalsCanPersist = Boolean(payload.can_persist);
    updateApprovalBadge(salaryApprovalsData.length);
    renderSalaryApprovalCards(salaryApprovalsData, salaryApprovalsCanPersist);
    renderSalaryApprovalHistory(salaryApprovalHistoryData);
  } catch (error) {
    if (!approvalsContainer) return;
    approvalsContainer.innerHTML = `<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta" style="color:#E85555;">${escapeHtml(error.message)}</div></div></div>`;
    if (historyBody) {
      historyBody.innerHTML = `<tr><td colspan="6" style="color:#E85555;">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

async function updateApprovalStatus(approvalId, action) {
  const id = String(approvalId || '').trim();
  if (!id) return;

  try {
    const response = await fetch('/api/admin/salary-approvals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to update approval status');
    }

    await Promise.all([loadDashboard(), loadSalaryApprovals(), loadAuditLogs()]);
  } catch (error) {
    window.alert(error.message);
  }
}

function updateFilterChipCounts() {
  const allCount = allEmployees.filter((employee) => !employee.archived).length;
  const teachingCount = allEmployees.filter((employee) => !employee.archived && employee.employee_type === 'Teaching').length;
  const nonTeachingCount = allEmployees.filter((employee) => !employee.archived && employee.employee_type === 'Non-Teaching').length;
  const archivedCount = allEmployees.filter((employee) => employee.archived).length;

  document.querySelectorAll('#adm-filter-chips .chip').forEach((chip) => {
    const filter = chip.getAttribute('data-filter');
    if (filter === 'all') chip.textContent = `All (${allCount})`;
    if (filter === 'teaching') chip.textContent = `Teaching (${teachingCount})`;
    if (filter === 'non-teaching') chip.textContent = `Non-Teaching (${nonTeachingCount})`;
    if (filter === 'archived') chip.textContent = `Archived (${archivedCount})`;
  });
}

function getFilteredEmployees() {
  const search = employeeSearch.toLowerCase();
  return allEmployees.filter((employee) => {
    if (employeeTypeFilter === 'all' && employee.archived) return false;
    if (employeeTypeFilter === 'teaching' && (employee.archived || employee.employee_type !== 'Teaching')) return false;
    if (employeeTypeFilter === 'non-teaching' && (employee.archived || employee.employee_type !== 'Non-Teaching')) return false;
    if (employeeTypeFilter === 'archived' && !employee.archived) return false;

    if (!search) return true;

    const haystack = [employee.full_name, employee.email, employee.employee_id, employee.position]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');

    return haystack.includes(search);
  });
}

function renderEmployees(employees) {
  const tbody = document.getElementById('adm-employee-table-body');
  if (!tbody) return;

  if (!employees.length) {
    const emptyMessage = employeeTypeFilter === 'archived'
      ? 'No archived employees found.'
      : 'No employees found. Add your first employee.';
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--t3);">${emptyMessage}</td></tr>`;
    return;
  }

  const rows = employees.map((employee) => {
    const initials = getInitials(employee.full_name);
    const avatarColor = getAvatarColor(employee.email || employee.id);
    const typeBadgeClass = employee.employee_type === 'Teaching' ? 'bt2' : 'ba';
    const normalizedStatus = String(employee.employee_status || employee.rfid_status || 'Active').toLowerCase();
    const statusBadgeClass = employee.archived ? 'br' : (normalizedStatus === 'pending' ? 'ba' : 'bg');
    const employmentBadgeClass = employee.archived ? 'br' : (employee.employment_status === 'Probationary' ? 'ba' : 'bg');
    const rfidText = employee.archived ? 'Archived' : escapeHtml(employee.rfid_status);
    const statusText = employee.archived ? 'Archived' : escapeHtml(employee.employee_status || employee.rfid_status || 'Active');
    const safeName = escapeHtml(employee.full_name);
    const safeId = escapeHtml(employee.employee_id);
    const safeType = escapeHtml(employee.employee_type);
    const safePosition = escapeHtml(employee.position);
    const safeEmployeeId = escapeHtml(employee.id);

    return `
      <tr>
        <td class="nm">
          <div style="display:flex;align-items:center;gap:9px;">
            <div class="av" style="width:28px;height:28px;font-size:10px;background:${avatarColor};">${initials}</div>
            ${safeName}
          </div>
        </td>
        <td class="mn">${safeId}</td>
        <td><span class="badge ${typeBadgeClass}">${safeType}</span></td>
        <td>${safePosition}</td>
        <td class="mn">${formatMoney(employee.basic_salary)}</td>
        <td><span class="badge ${statusBadgeClass}"><span class="bd"></span>${rfidText}</span></td>
        <td><span class="badge ${employmentBadgeClass}">${statusText}</span></td>
        <td><button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openEditEmployeeModal('${safeEmployeeId}')">Edit</button></td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rows;
}

function renderFilteredEmployees() {
  updateFilterChipCounts();
  renderEmployees(getFilteredEmployees());
}

function setEmployeeTypeFilter(filter) {
  employeeTypeFilter = filter;
  document.querySelectorAll('#adm-filter-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.getAttribute('data-filter') === filter);
  });
  renderFilteredEmployees();
}

function setEmployeeSearch(value) {
  employeeSearch = String(value || '').trim();
  renderFilteredEmployees();
}

async function loadEmployees() {
  const tbody = document.getElementById('adm-employee-table-body');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="8" style="color:var(--t3);">Loading employees...</td></tr>';

  try {
    const response = await fetch('/api/admin/employees', { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load employees');
    }

    allEmployees = payload.employees || [];
    renderFilteredEmployees();
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:#E85555;">${error.message}</td></tr>`;
  }
}

function showEmployeeFeedback(message, isError = false) {
  const el = document.getElementById('add-employee-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError);
}

function openAddEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  const form = document.getElementById('add-employee-form');
  if (!modal || !form) return;

  form.reset();
  showEmployeeFeedback('');
  modal.style.display = 'flex';
}

function closeAddEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  if (!modal) return;
  modal.style.display = 'none';
}

function showEditFeedback(message, isError = false) {
  const el = document.getElementById('edit-employee-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError);
}

function openEditEmployeeModal(employeeId) {
  const modal = document.getElementById('edit-employee-modal');
  const form = document.getElementById('edit-employee-form');
  const archiveButton = document.getElementById('archive-employee-button');
  if (!modal || !form || !archiveButton) return;

  currentEditingEmployee = allEmployees.find((employee) => employee.id === employeeId);
  if (!currentEditingEmployee) {
    window.alert('Employee record not found. Please refresh the list.');
    return;
  }

  form.elements.id.value = currentEditingEmployee.id;
  form.elements.full_name.value = currentEditingEmployee.full_name || '';
  form.elements.role.value = currentEditingEmployee.role || 'employee';
  form.elements.email.value = currentEditingEmployee.email || '';
  form.elements.employee_id.value = currentEditingEmployee.employee_id || '';
  form.elements.employee_type.value = currentEditingEmployee.employee_type || 'Teaching';
  form.elements.position.value = currentEditingEmployee.position || '';
  form.elements.employee_status.value = currentEditingEmployee.employee_status || currentEditingEmployee.rfid_status || 'Active';
  form.elements.basic_salary.value = Number(currentEditingEmployee.basic_salary || 0);
  form.elements.password.value = '';

  archiveButton.className = currentEditingEmployee.archived ? 'btn btn-green' : 'btn btn-red';
  archiveButton.textContent = currentEditingEmployee.archived ? 'Restore Employee' : 'Archive Employee';

  showEditFeedback('');
  modal.style.display = 'flex';
}

function closeEditEmployeeModal() {
  const modal = document.getElementById('edit-employee-modal');
  if (!modal) return;
  modal.style.display = 'none';
}

async function toggleArchiveCurrentEmployee() {
  if (!currentEditingEmployee) return;
  const archiveButton = document.getElementById('archive-employee-button');
  if (!archiveButton) return;

  const action = currentEditingEmployee.archived ? 'restore' : 'archive';

  try {
    archiveButton.disabled = true;
    archiveButton.textContent = action === 'archive' ? 'Archiving...' : 'Restoring...';

    const response = await fetch('/api/admin/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentEditingEmployee.id, action }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to update archive status');
    }

    showEditFeedback(action === 'archive' ? 'Employee archived from active list.' : 'Employee restored to active list.', false);
    await Promise.all([loadEmployees(), loadDashboard(), loadSummaryReports(), loadAttendanceData(), loadAuditLogs()]);
    closeEditEmployeeModal();
  } catch (error) {
    showEditFeedback(error.message, true);
  } finally {
    archiveButton.disabled = false;
    archiveButton.textContent = currentEditingEmployee.archived ? 'Restore Employee' : 'Archive Employee';
  }
}

async function submitAddEmployee(event) {
  event.preventDefault();

  const form = event.target;
  const submitButton = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  const payload = {
    full_name: String(formData.get('full_name') || '').trim(),
    role: String(formData.get('role') || 'employee').trim().toLowerCase(),
    email: String(formData.get('email') || '').trim(),
    password: String(formData.get('password') || '').trim(),
    employee_type: String(formData.get('employee_type') || 'Teaching').trim(),
    position: String(formData.get('position') || '').trim(),
    employee_status: String(formData.get('employee_status') || 'Active').trim(),
    basic_salary: Number(formData.get('basic_salary') || 0),
  };

  if (!payload.full_name || !payload.email || !payload.password) {
    showEmployeeFeedback('Full name, email, and password are required.', true);
    return;
  }

  try {
    submitButton.disabled = true;
    submitButton.textContent = 'Creating...';

    const response = await fetch('/api/admin/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to create employee');
    }

    const createdId = result.employee?.employee_id || '';
    showEmployeeFeedback(`Employee created with ID ${createdId}.`, false);
    await Promise.all([loadEmployees(), loadDashboard(), loadSummaryReports(), loadAttendanceData(), loadAuditLogs()]);

    setTimeout(() => {
      closeAddEmployeeModal();
    }, 500);
  } catch (error) {
    showEmployeeFeedback(error.message, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Create Employee';
  }
}

async function submitEditEmployee(event) {
  event.preventDefault();

  const form = event.target;
  const submitButton = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);

  const payload = {
    id: String(formData.get('id') || '').trim(),
    action: 'update',
    full_name: String(formData.get('full_name') || '').trim(),
    role: String(formData.get('role') || 'employee').trim().toLowerCase(),
    email: String(formData.get('email') || '').trim(),
    employee_id: String(formData.get('employee_id') || '').trim(),
    employee_type: String(formData.get('employee_type') || 'Teaching').trim(),
    position: String(formData.get('position') || '').trim(),
    employee_status: String(formData.get('employee_status') || 'Active').trim(),
    basic_salary: Number(formData.get('basic_salary') || 0),
    password: String(formData.get('password') || '').trim(),
  };

  if (!payload.id || !payload.full_name || !payload.email || !payload.employee_id) {
    showEditFeedback('ID, full name, email, and employee ID are required.', true);
    return;
  }

  if (!payload.password) {
    delete payload.password;
  }

  try {
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    const response = await fetch('/api/admin/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to update employee');
    }

    showEditFeedback('Employee details updated.', false);
    await Promise.all([loadEmployees(), loadDashboard(), loadSummaryReports(), loadAttendanceData(), loadAuditLogs()]);
    closeEditEmployeeModal();
  } catch (error) {
    showEditFeedback(error.message, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Save Changes';
  }
}

window.openAddEmployeeModal = openAddEmployeeModal;
window.closeAddEmployeeModal = closeAddEmployeeModal;
window.submitAddEmployee = submitAddEmployee;
window.openEditEmployeeModal = openEditEmployeeModal;
window.closeEditEmployeeModal = closeEditEmployeeModal;
window.submitEditEmployee = submitEditEmployee;
window.toggleArchiveCurrentEmployee = toggleArchiveCurrentEmployee;
window.setEmployeeTypeFilter = setEmployeeTypeFilter;
window.setEmployeeSearch = setEmployeeSearch;
window.approveChange = approveChange;
window.rejectChange = rejectChange;
window.exportSummaryReportsCsv = exportSummaryReportsCsv;
window.submitRfidAttendanceScan = submitRfidAttendanceScan;
window.exportAttendanceCsv = exportAttendanceCsv;
window.setAuditSearch = setAuditSearch;
window.setAuditModuleFilter = setAuditModuleFilter;
window.setAuditActionFilter = setAuditActionFilter;
window.exportAuditLogsCsv = exportAuditLogsCsv;

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Start on dashboard when admin logs in
  // Called from app.js login() via adminNav
  loadDashboard();
  loadAttendanceData();
  loadSalaryApprovals();
  loadSummaryReports();
  loadAuditLogs();
  loadEmployees();
});
