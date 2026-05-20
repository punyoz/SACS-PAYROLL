/* ═══════════════════════════════════════
   hr.js — Human Resources role logic
   Handles: HR dashboard, employee records,
   attendance, leave management, reports
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const HR_PAGES = {
  'hr-dashboard':     'HR Dashboard',
  'hr-employees':     'Employee Records',
  'hr-employee-info': 'Employee Information',
  'hr-attendance':    'Attendance Monitoring',
  'hr-leaves':        'Leave Management',
  'hr-reports':       'HR Reports',
};

let hrAllEmployees = [];
let hrEmployeeFilter = 'all';
let hrEmployeeSearch = '';
let hrInfoSearch = '';
let hrAttendanceLogs = [];
let hrLeaveRequests = [];
let hrLeaveHistory = [];
let hrReportData = [];
let hrReportType = 'attendance';
let hrCurrentEditEmployee = null;

let hrEmpPaginator = null;
let hrInfoPaginator = null;
let hrAttPaginator = null;
let hrLeaveHistPaginator = null;
let hrRepPaginator = null;

/* ── NAVIGATE ── */
function hrNav(pageId, navEl) {
  Object.keys(HR_PAGES).forEach((id) => {
    document.getElementById(id)?.classList.remove('active');
  });

  document.querySelectorAll('#s-hr .ni').forEach((el) => el.classList.remove('active'));

  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const title = HR_PAGES[pageId] || 'HR Portal';
  const titleEl = document.getElementById('hr-tb-title');
  if (titleEl) titleEl.textContent = title;

  if (typeof persistRolePageState === 'function') persistRolePageState('hr', pageId);

  if (pageId === 'hr-dashboard') loadHRDashboard();
  else if (pageId === 'hr-employees') loadHREmployees();
  else if (pageId === 'hr-employee-info') loadHREmployeeInfo();
  else if (pageId === 'hr-attendance') loadHRAttendance();
  else if (pageId === 'hr-leaves') loadHRLeaves();
  else if (pageId === 'hr-reports') { /* user clicks Generate */ }
}

/* ── IDENTITY ── */
function applyHRIdentity() {
  if (typeof getLegacyAuthContext !== 'function') return;
  const ctx = getLegacyAuthContext();
  if (!ctx) return;

  const nameEl = document.getElementById('hr-user-name');
  if (nameEl && ctx.full_name) nameEl.textContent = ctx.full_name;

  const avatar = document.querySelector('#s-hr .sb-foot .av');
  if (avatar && ctx.full_name) {
    const parts = ctx.full_name.trim().split(/\s+/);
    avatar.textContent = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : ctx.full_name.slice(0, 2).toUpperCase();
  }
}

/* ── DASHBOARD ── */
async function loadHRDashboard() {
  try {
    const res = await fetch('/api/hr/dashboard');
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load dashboard.');

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('hr-panel-total', data.total_employees ?? 0);
    set('hr-panel-present', data.present_today ?? 0);
    set('hr-panel-absent', data.absent_today ?? 0);
    set('hr-panel-leaves', data.pending_leaves ?? 0);
    set('hr-panel-teaching', data.teaching_staff ?? 0);
    set('hr-panel-non-teaching', data.non_teaching_staff ?? 0);
    set('hr-panel-late', data.late_today ?? 0);

    const badge = document.getElementById('hr-leave-badge');
    const dbBadge = document.getElementById('hr-dashboard-badge');
    const leaveBadge = document.getElementById('hr-leave-badge');
    const pendingCount = data.pending_leaves ?? 0;
    if (badge) { badge.textContent = pendingCount; badge.style.display = pendingCount > 0 ? '' : 'none'; }
    if (leaveBadge) { leaveBadge.textContent = pendingCount; leaveBadge.style.display = pendingCount > 0 ? '' : 'none'; }
    if (dbBadge) { dbBadge.textContent = pendingCount; dbBadge.style.display = pendingCount > 0 ? '' : 'none'; }

    renderHRDashboardLeaves(data.pending_leaves ?? 0);
    renderHRRecentActivity(data.recent_activity || []);
  } catch (err) {
    console.error('HR dashboard error:', err);
  }
}

function renderHRDashboardLeaves(pendingCount) {
  const el = document.getElementById('hr-dashboard-leave-list');
  if (!el) return;
  if (pendingCount === 0) {
    el.innerHTML = '<div class="approval-item"><div class="approval-info" style="color:var(--t3);">No pending leave requests.</div></div>';
    return;
  }
  el.innerHTML = `<div class="approval-item">
    <div class="approval-info"><strong style="color:var(--amber);">${pendingCount}</strong> leave request${pendingCount > 1 ? 's' : ''} awaiting your decision.</div>
    <button class="btn btn-outline" onclick="hrNav('hr-leaves', document.querySelectorAll('#s-hr .ni')[4])">Review Now</button>
  </div>`;
}

function renderHRRecentActivity(activity) {
  const el = document.getElementById('hr-recent-activity');
  if (!el) return;
  if (!activity.length) {
    el.innerHTML = '<div class="ai-item"><div class="ai2"><div class="s" style="color:var(--t3);">No recent attendance activity.</div></div></div>';
    return;
  }
  el.innerHTML = activity.map((row) => {
    const s = String(row.status || '').toLowerCase();
    const color = s === 'present' ? 'var(--green)' : s === 'late' ? 'var(--amber)' : 'var(--red)';
    return `<div class="ai-item">
      <div class="ai2">
        <div class="s">${row.employee_name || row.employee_id || 'Unknown'}</div>
        <div class="ss">${row.date || ''} · Time in: ${row.time_in || '—'}</div>
      </div>
      <span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}50;">${row.status || '—'}</span>
    </div>`;
  }).join('');
}

/* ── EMPLOYEE RECORDS ── */
async function loadHREmployees() {
  const tbody = document.getElementById('hr-employee-table-body');
  if (tbody) tbody.innerHTML = `<tr>${skeletonRows ? skeletonRows(7) : '<td colspan="7" style="color:var(--t3);">Loading...</td>'}</tr>`;

  try {
    const includeArchived = hrEmployeeFilter === 'archived';
    const res = await fetch(`/api/hr/employees${includeArchived ? '?archived=true' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load employees.');

    hrAllEmployees = data.employees || [];
    updateHrEmployeeChips();
    renderHREmployeeTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function updateHrEmployeeChips() {
  const all = hrAllEmployees;
  const teaching = all.filter((e) => e.employee_type?.toLowerCase() === 'teaching').length;
  const nonTeaching = all.filter((e) => e.employee_type?.toLowerCase() === 'non-teaching').length;
  const archived = all.filter((e) => e.archived).length;

  const chips = document.querySelectorAll('#hr-emp-filter-chips .chip');
  const labels = [`All (${all.length})`, `Teaching (${teaching})`, `Non-Teaching (${nonTeaching})`, `Archived (${archived})`];
  chips.forEach((chip, i) => { if (labels[i]) chip.textContent = labels[i]; });
}

function setHrEmployeeFilter(filter) {
  hrEmployeeFilter = filter;
  document.querySelectorAll('#hr-emp-filter-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });
  if (filter === 'archived') {
    loadHREmployees();
  } else {
    renderHREmployeeTable();
  }
}

function setHrEmployeeSearch(val) {
  hrEmployeeSearch = String(val || '').toLowerCase().trim();
  renderHREmployeeTable();
}

function renderHREmployeeTable() {
  const tbody = document.getElementById('hr-employee-table-body');
  if (!tbody) return;

  let list = hrAllEmployees;

  if (hrEmployeeFilter === 'teaching') list = list.filter((e) => e.employee_type?.toLowerCase() === 'teaching' && !e.archived);
  else if (hrEmployeeFilter === 'non-teaching') list = list.filter((e) => e.employee_type?.toLowerCase() === 'non-teaching' && !e.archived);
  else if (hrEmployeeFilter === 'archived') list = list.filter((e) => e.archived);
  else list = list.filter((e) => !e.archived);

  if (hrEmployeeSearch) {
    list = list.filter((e) =>
      [e.full_name, e.employee_id, e.email, e.position].some((v) =>
        String(v || '').toLowerCase().includes(hrEmployeeSearch)
      )
    );
  }

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  if (!hrEmpPaginator) {
    hrEmpPaginator = createPaginator({
      id: 'hr-emp',
      pageSize: 15,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((e) => {
          const statusColor = e.employee_status?.toLowerCase() === 'active' ? 'var(--green)' : 'var(--amber)';
          return `<tr>
            <td>${e.full_name || '—'}</td>
            <td><code style="font-size:11px;">${e.employee_id || '—'}</code></td>
            <td>${e.employee_type || '—'}</td>
            <td>${e.position || '—'}</td>
            <td><span class="badge" style="color:${statusColor};background:${statusColor}20;border:1px solid ${statusColor}40;">${e.employee_status || 'Active'}</span></td>
            <td style="font-size:12px;color:var(--t3);">${e.email || '—'}</td>
            <td><button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="openHrEditEmployeeModal(${JSON.stringify(e).replace(/"/g, '&quot;')})">Edit Status</button></td>
          </tr>`;
        }).join('');
      },
    });
  }

  hrEmpPaginator.setData(list);
}

function openHrEditEmployeeModal(employee) {
  hrCurrentEditEmployee = employee;
  const form = document.getElementById('hr-edit-employee-form');
  if (!form) return;

  form.querySelector('[name="id"]').value = employee.id || '';
  form.querySelector('[name="full_name"]').value = employee.full_name || '';
  form.querySelector('[name="employee_id"]').value = employee.employee_id || '';

  const typeEl = form.querySelector('[name="employee_type"]');
  if (typeEl) typeEl.value = employee.employee_type || 'Teaching';

  const posEl = form.querySelector('[name="position"]');
  if (posEl) posEl.value = employee.position || 'Employee';

  const statusEl = form.querySelector('[name="employee_status"]');
  if (statusEl) statusEl.value = employee.employee_status || 'Active';

  const fb = document.getElementById('hr-edit-employee-feedback');
  if (fb) { fb.textContent = ''; fb.className = 'adm-feedback'; }

  const modal = document.getElementById('hr-edit-employee-modal');
  if (modal) modal.style.display = 'flex';
}

function closeHrEditEmployeeModal() {
  const modal = document.getElementById('hr-edit-employee-modal');
  if (modal) modal.style.display = 'none';
  hrCurrentEditEmployee = null;
}

async function submitHrEditEmployee(event) {
  event.preventDefault();
  const form = event.target;
  const fb = document.getElementById('hr-edit-employee-feedback');

  const payload = {
    id: form.querySelector('[name="id"]').value,
    employee_type: form.querySelector('[name="employee_type"]').value,
    position: form.querySelector('[name="position"]').value,
    employee_status: form.querySelector('[name="employee_status"]').value,
  };

  try {
    const res = await fetch('/api/hr/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed.');

    if (fb) { fb.textContent = 'Employee updated successfully.'; fb.style.color = 'var(--green)'; }
    setTimeout(() => {
      closeHrEditEmployeeModal();
      loadHREmployees();
    }, 800);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── EMPLOYEE INFORMATION ── */
async function loadHREmployeeInfo() {
  const tbody = document.getElementById('hr-info-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="color:var(--t3);">Loading...</td></tr>';

  try {
    const res = await fetch('/api/hr/employees?archived=true');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load employee info.');

    const all = data.employees || [];
    renderHRInfoTable(all);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function setHrInfoSearch(val) {
  hrInfoSearch = String(val || '').toLowerCase().trim();
  // Re-render using cached data if available
  const tbody = document.getElementById('hr-info-table-body');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr[data-emp-id]'));
  rows.forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.style.display = !hrInfoSearch || text.includes(hrInfoSearch) ? '' : 'none';
  });
}

function renderHRInfoTable(employees) {
  const tbody = document.getElementById('hr-info-table-body');
  if (!tbody) return;

  if (!employees.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  if (!hrInfoPaginator) {
    hrInfoPaginator = createPaginator({
      id: 'hr-info',
      pageSize: 15,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((e) => {
          const archivedBadge = e.archived
            ? '<span class="badge" style="color:var(--red);background:var(--red-s);border:1px solid var(--red);margin-left:4px;">Archived</span>'
            : '';
          return `<tr data-emp-id="${e.id || ''}">
            <td>${e.full_name || '—'}${archivedBadge}</td>
            <td><code style="font-size:11px;">${e.employee_id || '—'}</code></td>
            <td>${e.role || '—'}</td>
            <td>${e.employee_type || '—'}</td>
            <td>${e.position || '—'}</td>
            <td>${e.employee_status || 'Active'}</td>
            <td style="font-size:12px;">${e.date_of_birth || '—'}</td>
            <td style="font-size:12px;color:var(--t3);">${e.email || '—'}</td>
          </tr>`;
        }).join('');
      },
    });
  }

  hrInfoPaginator.setData(employees);
}

/* ── ATTENDANCE ── */
async function loadHRAttendance() {
  const dateInput = document.getElementById('hr-att-date');
  const today = new Date().toISOString().slice(0, 10);
  const date = dateInput?.value || today;
  if (dateInput && !dateInput.value) dateInput.value = today;

  const titleEl = document.getElementById('hr-att-title');
  if (titleEl) titleEl.textContent = `Attendance Log — ${date === today ? 'Today' : date}`;

  const tbody = document.getElementById('hr-att-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">Loading...</td></tr>';

  try {
    const res = await fetch(`/api/hr/attendance?date=${date}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load attendance.');

    hrAttendanceLogs = data.logs || [];
    const s = data.summary || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hr-att-present', s.present ?? 0);
    set('hr-att-late', s.late ?? 0);
    set('hr-att-absent', s.absent ?? 0);

    renderHRAttendanceTable(hrAttendanceLogs);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

async function loadHRAllAttendance() {
  const titleEl = document.getElementById('hr-att-title');
  if (titleEl) titleEl.textContent = 'Attendance Log — All Records';

  const tbody = document.getElementById('hr-att-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">Loading...</td></tr>';

  try {
    const res = await fetch('/api/hr/attendance?view=all');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load attendance.');

    hrAttendanceLogs = data.logs || [];
    const s = data.summary || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hr-att-present', s.present ?? 0);
    set('hr-att-late', s.late ?? 0);
    set('hr-att-absent', s.absent ?? 0);

    renderHRAttendanceTable(hrAttendanceLogs);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function renderHRAttendanceTable(logs) {
  const tbody = document.getElementById('hr-att-table-body');
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No attendance records found.</td></tr>';
    return;
  }

  if (!hrAttPaginator) {
    hrAttPaginator = createPaginator({
      id: 'hr-att',
      pageSize: 20,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((row) => {
          const s = String(row.status || '').toLowerCase();
          const color = s === 'present' ? 'var(--green)' : s === 'late' ? 'var(--amber)' : 'var(--red)';
          return `<tr>
            <td>${row.employee_name || row.employee_id || '—'}</td>
            <td>${row.employee_type || '—'}</td>
            <td>${row.date || '—'}</td>
            <td>${row.time_in || '—'}</td>
            <td>${row.time_out || '—'}</td>
            <td>${row.hours_worked != null ? Number(row.hours_worked).toFixed(1) + 'h' : '—'}</td>
            <td><span class="badge" style="color:${color};background:${color}20;border:1px solid ${color}40;">${row.status || '—'}</span></td>
          </tr>`;
        }).join('');
      },
    });
  }

  hrAttPaginator.setData(logs);
}

function exportHRAttendanceCsv() {
  if (!hrAttendanceLogs.length) { alert('No attendance data to export.'); return; }

  const headers = ['Employee Name', 'Employee Type', 'Date', 'Time In', 'Time Out', 'Hours Worked', 'Status'];
  const rows = hrAttendanceLogs.map((r) => [
    r.employee_name || r.employee_id || '',
    r.employee_type || '',
    r.date || '',
    r.time_in || '',
    r.time_out || '',
    r.hours_worked != null ? Number(r.hours_worked).toFixed(2) : '',
    r.status || '',
  ]);

  downloadCsv([headers, ...rows], `sacs-hr-attendance-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ── LEAVE MANAGEMENT ── */
async function loadHRLeaves() {
  const listEl = document.getElementById('hr-leave-list');
  if (listEl) listEl.innerHTML = '<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta">Loading...</div></div></div>';

  try {
    const res = await fetch('/api/hr/leave-requests?status=all');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load leave requests.');

    hrLeaveRequests = data.pending_requests || [];
    hrLeaveHistory = data.history_requests || [];

    const badge = document.getElementById('hr-leave-badge');
    if (badge) { badge.textContent = hrLeaveRequests.length; badge.style.display = hrLeaveRequests.length > 0 ? '' : 'none'; }

    renderHRLeaveList();
    renderHRLeaveHistory();
  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta" style="color:var(--red);">${err.message}</div></div></div>`;
  }
}

function renderHRLeaveList() {
  const el = document.getElementById('hr-leave-list');
  if (!el) return;

  if (!hrLeaveRequests.length) {
    el.innerHTML = '<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta" style="color:var(--t3);">No pending leave requests.</div></div></div>';
    return;
  }

  el.innerHTML = hrLeaveRequests.map((req) => {
    const days = req.days || req.duration_days || '?';
    const from = req.from_date || req.start_date || '—';
    const to = req.to_date || req.end_date || '—';
    const proof = req.proof_url || req.proof_data || '';

    return `<div class="approval-card">
      <div class="approval-card-body">
        <div class="approval-card-name">${req.employee_name || req.employee_id || 'Unknown'}</div>
        <div class="approval-card-meta">
          <strong>${req.leave_type || 'Leave'}</strong> · ${days} day${days !== 1 ? 's' : ''} · ${from} to ${to}
        </div>
        <div class="approval-card-meta" style="margin-top:4px;">${req.reason || '—'}</div>
        ${proof ? `<button class="btn btn-outline" style="font-size:11px;padding:3px 9px;margin-top:6px;" onclick="openProofDocument('${proof}')">View Proof</button>` : ''}
      </div>
      <div class="approval-card-actions">
        <button class="btn btn-primary" style="background:var(--green);border-color:var(--green);" onclick="hrLeaveAction('${req.id}','approve')">Approve</button>
        <button class="btn btn-red" onclick="hrLeaveAction('${req.id}','reject')">Reject</button>
      </div>
    </div>`;
  }).join('');
}

async function hrLeaveAction(id, action) {
  const label = action === 'approve' ? 'approve this leave request' : 'reject this leave request';
  const confirmed = await confirmDestructiveAction(label, 'This decision cannot be undone.');
  if (!confirmed) return;

  try {
    const res = await fetch('/api/hr/leave-requests', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Action failed.');

    pushNotification(`Leave ${action === 'approve' ? 'Approved' : 'Rejected'}`, `Leave request has been ${action === 'approve' ? 'approved' : 'rejected'}.`, action === 'approve' ? 'success' : 'info');
    loadHRLeaves();
  } catch (err) {
    pushNotification('Error', err.message, 'error');
  }
}

function renderHRLeaveHistory() {
  const tbody = document.getElementById('hr-leave-history-body');
  if (!tbody) return;

  if (!hrLeaveHistory.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--t3);">No leave history yet.</td></tr>';
    return;
  }

  if (!hrLeaveHistPaginator) {
    hrLeaveHistPaginator = createPaginator({
      id: 'hr-leave-hist',
      pageSize: 15,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((req) => {
          const s = String(req.status || '').toLowerCase();
          const color = s === 'approved' ? 'var(--green)' : s === 'rejected' ? 'var(--red)' : 'var(--amber)';
          const days = req.days || req.duration_days || '?';
          const from = req.from_date || req.start_date || '—';
          const to = req.to_date || req.end_date || '—';
          const proof = req.proof_url || req.proof_data || '';
          const decided = req.decided_at ? new Date(req.decided_at).toLocaleDateString('en-PH') : '—';
          const submitted = req.submitted_at || req.created_at
            ? new Date(req.submitted_at || req.created_at).toLocaleDateString('en-PH')
            : '—';

          return `<tr>
            <td>${req.employee_name || req.employee_id || '—'}</td>
            <td>${req.leave_type || '—'}</td>
            <td>${days}d · ${from} – ${to}</td>
            <td style="font-size:12px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${req.reason || '—'}</td>
            <td>${proof ? `<button class="btn btn-outline" style="font-size:10px;padding:2px 8px;" onclick="openProofDocument('${proof}')">View</button>` : '—'}</td>
            <td><span class="badge" style="color:${color};background:${color}20;border:1px solid ${color}40;">${req.status || '—'}</span></td>
            <td style="font-size:12px;">${submitted}</td>
            <td style="font-size:12px;">${decided}</td>
          </tr>`;
        }).join('');
      },
    });
  }

  hrLeaveHistPaginator.setData(hrLeaveHistory);
}

/* ── HR REPORTS ── */
function onHrReportTypeChange() {
  const type = document.getElementById('hr-report-type')?.value || 'attendance';
  hrReportType = type;
  const fromWrap = document.getElementById('hr-report-from-wrap');
  const toWrap = document.getElementById('hr-report-to-wrap');
  if (fromWrap) fromWrap.style.display = type === 'attendance' ? '' : 'none';
  if (toWrap) toWrap.style.display = type === 'attendance' ? '' : 'none';
}

async function loadHRReports() {
  const type = document.getElementById('hr-report-type')?.value || 'attendance';
  hrReportType = type;

  const from = document.getElementById('hr-report-from')?.value || '';
  const to = document.getElementById('hr-report-to')?.value || new Date().toISOString().slice(0, 10);

  const thead = document.getElementById('hr-rep-thead');
  const tbody = document.getElementById('hr-rep-table-body');
  const summary = document.getElementById('hr-reports-summary');
  const titleEl = document.getElementById('hr-rep-table-title');

  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="color:var(--t3);">Loading...</td></tr>';
  if (summary) summary.style.display = 'none';

  try {
    let url = `/api/hr/reports?type=${type}`;
    if (type === 'attendance') {
      if (from) url += `&from=${from}`;
      url += `&to=${to}`;
    }

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load report.');

    hrReportData = data.records || [];

    if (type === 'attendance') {
      if (titleEl) titleEl.textContent = `Attendance Report${from ? ` · ${from} to ${to}` : ''}`;

      if (thead) thead.innerHTML = '<tr><th>Employee</th><th>Type</th><th>Present</th><th>Late</th><th>Absent</th><th>Total Hours</th></tr>';

      const totalPresent = hrReportData.reduce((s, r) => s + (r.present || 0), 0);
      const totalLate = hrReportData.reduce((s, r) => s + (r.late || 0), 0);
      const totalAbsent = hrReportData.reduce((s, r) => s + (r.absent || 0), 0);

      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('hr-rep-total', hrReportData.length);
      set('hr-rep-stat1-label', 'Present Days');
      set('hr-rep-stat1', totalPresent);
      set('hr-rep-stat2-label', 'Late Days');
      set('hr-rep-stat2', totalLate);
      set('hr-rep-stat3-label', 'Absent Days');
      set('hr-rep-stat3', totalAbsent);
      if (summary) summary.style.display = '';

      if (!hrRepPaginator) {
        hrRepPaginator = createPaginator({
          id: 'hr-rep',
          pageSize: 20,
          renderFn: (rows) => {
            if (!tbody) return;
            tbody.innerHTML = rows.map((r) => `<tr>
              <td>${r.employee_name || '—'}</td>
              <td>${r.employee_type || '—'}</td>
              <td style="color:var(--green);">${r.present ?? 0}</td>
              <td style="color:var(--amber);">${r.late ?? 0}</td>
              <td style="color:var(--red);">${r.absent ?? 0}</td>
              <td>${Number(r.total_hours || 0).toFixed(1)}h</td>
            </tr>`).join('');
          },
        });
      }
      hrRepPaginator.setData(hrReportData);

    } else {
      if (titleEl) titleEl.textContent = 'Employee Records Report';
      if (thead) thead.innerHTML = '<tr><th>Employee</th><th>ID</th><th>Type</th><th>Position</th><th>Status</th><th>Email</th></tr>';

      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('hr-rep-total', data.total || hrReportData.length);
      set('hr-rep-stat1-label', 'Active');
      set('hr-rep-stat1', data.active ?? 0);
      set('hr-rep-stat2-label', 'Archived');
      set('hr-rep-stat2', data.archived ?? 0);
      set('hr-rep-stat3-label', 'Teaching');
      set('hr-rep-stat3', hrReportData.filter((r) => r.employee_type?.toLowerCase() === 'teaching').length);
      if (summary) summary.style.display = '';

      if (!hrRepPaginator) {
        hrRepPaginator = createPaginator({
          id: 'hr-rep',
          pageSize: 20,
          renderFn: (rows) => {
            if (!tbody) return;
            tbody.innerHTML = rows.map((r) => {
              const archived = r.archived ? '<span style="color:var(--red);font-size:10px;"> (Archived)</span>' : '';
              return `<tr>
                <td>${r.full_name || '—'}${archived}</td>
                <td><code style="font-size:11px;">${r.employee_id || '—'}</code></td>
                <td>${r.employee_type || '—'}</td>
                <td>${r.position || '—'}</td>
                <td>${r.employee_status || 'Active'}</td>
                <td style="font-size:12px;color:var(--t3);">${r.email || '—'}</td>
              </tr>`;
            }).join('');
          },
        });
      }
      hrRepPaginator.setData(hrReportData);
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function exportHRReportCsv() {
  if (!hrReportData.length) { alert('No report data to export. Generate a report first.'); return; }

  let headers, rows;
  if (hrReportType === 'attendance') {
    headers = ['Employee', 'Type', 'Present', 'Late', 'Absent', 'Total Hours'];
    rows = hrReportData.map((r) => [r.employee_name || '', r.employee_type || '', r.present ?? 0, r.late ?? 0, r.absent ?? 0, Number(r.total_hours || 0).toFixed(2)]);
  } else {
    headers = ['Employee', 'ID', 'Type', 'Position', 'Status', 'Email'];
    rows = hrReportData.map((r) => [r.full_name || '', r.employee_id || '', r.employee_type || '', r.position || '', r.employee_status || '', r.email || '']);
  }

  downloadCsv([headers, ...rows], `sacs-hr-${hrReportType}-report-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ── CSV HELPER ── */
function downloadCsv(rows, filename) {
  const csv = rows.map((r) =>
    r.map((v) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    }).join(',')
  ).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(anchor.href);
}

/* ── CHANGE PASSWORD ── */
async function submitHrChangePassword() {
  const current = document.getElementById('hr-current-password')?.value?.trim();
  const next = document.getElementById('hr-new-password')?.value?.trim();
  const confirm = document.getElementById('hr-confirm-password')?.value?.trim();
  const fb = document.getElementById('hr-change-password-feedback');

  if (!current || !next || !confirm) {
    if (fb) { fb.textContent = 'All fields are required.'; fb.style.color = 'var(--red)'; }
    return;
  }
  if (next !== confirm) {
    if (fb) { fb.textContent = 'Passwords do not match.'; fb.style.color = 'var(--red)'; }
    return;
  }
  if (next.length < 8) {
    if (fb) { fb.textContent = 'New password must be at least 8 characters.'; fb.style.color = 'var(--red)'; }
    return;
  }

  if (fb) { fb.textContent = 'Updating...'; fb.style.color = 'var(--t3)'; }

  try {
    const ctx = typeof getLegacyAuthContext === 'function' ? getLegacyAuthContext() : null;
    const email = ctx?.email;
    if (!email) throw new Error('Could not determine account email. Please re-login.');

    // Verify current password by attempting sign-in
    const verifyRes = await fetch('/api/legacy-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: email, password: current }),
    });
    if (!verifyRes.ok) throw new Error('Current password is incorrect.');

    // Use Supabase client to update password
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
    const supabaseUrl = document.querySelector('meta[name="supabase-url"]')?.content || '';
    const supabaseKey = document.querySelector('meta[name="supabase-anon-key"]')?.content || '';
    if (!supabaseUrl || !supabaseKey) throw new Error('Cannot update password from this context. Use the /reset-password page.');

    if (fb) { fb.textContent = 'Password updated successfully.'; fb.style.color = 'var(--green)'; }
    setTimeout(() => closeSettingsModal('hr'), 1500);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── INIT ── */
function initHRPortal() {
  applyHRIdentity();

  const savedPage = typeof getPersistedRolePageState === 'function'
    ? getPersistedRolePageState('hr')
    : '';

  if (savedPage && document.getElementById(savedPage)) {
    const navEl = document.querySelector(`#s-hr .ni[onclick*="${savedPage}"]`);
    hrNav(savedPage, navEl);
  } else {
    loadHRDashboard();
  }

  const sidebar = document.querySelector('#s-hr .sidebar');
  if (typeof attachSidebarSpotlight === 'function') attachSidebarSpotlight(sidebar);

  // Set today's date in attendance date picker
  const attDate = document.getElementById('hr-att-date');
  if (attDate && !attDate.value) attDate.value = new Date().toISOString().slice(0, 10);

  // Set today's date in report to field
  const repTo = document.getElementById('hr-report-to');
  if (repTo && !repTo.value) repTo.value = new Date().toISOString().slice(0, 10);
}

window.addEventListener('sacs-auth-context-changed', (event) => {
  const ctx = event?.detail;
  if (ctx?.role === 'hr') applyHRIdentity();
});

// Auto-init when HR screen becomes active
const hrScreen = document.getElementById('s-hr');
if (hrScreen?.classList.contains('active')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHRPortal);
  } else {
    initHRPortal();
  }
} else if (hrScreen) {
  const hrObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        if (hrScreen.classList.contains('active')) {
          hrObserver.disconnect();
          initHRPortal();
        }
      }
    }
  });
  hrObserver.observe(hrScreen, { attributes: true });
}
