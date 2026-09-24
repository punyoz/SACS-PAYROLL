/* ═══════════════════════════════════════
   hr.js — Human Resources role logic
   Handles: HR dashboard, employee records,
   attendance, leave management, reports
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const HR_PAGES = {
  'hr-dashboard':     'HR Dashboard',
  'hr-employees':     'User Management',
  'hr-transfers':     'Transfer Requests',
  'hr-attendance':    'Attendance Monitoring',
  'hr-leaves':        'Leave Approval',
  'hr-reports':       'HR Reports',
  'hr-profile':       'Profile',
};

let hrAllEmployees = [];
let hrEmployeeFilter = 'all';
let hrEmployeeBranchFilter = 'all';
let hrEmployeeSearch = '';
let hrAttendanceLogs = [];
let hrLeaveRequests = [];
let hrLeaveHistory = [];
let hrReportData = [];
let hrReportType = 'attendance';
let hrCurrentEditEmployee = null;

let hrBranchAllEmployees = [];
let hrBranchFilter = 'all';
let hrBranchSearch = '';
let hrCurrentBranchEmployee = null;
let hrBranchPaginator = null;
let hrTransferHistory = [];
let hrTransferHistoryPaginator = null;

let hrBranches = [];

let hrEmpPaginator = null;
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
  else if (pageId === 'hr-transfers') loadHrBranchAssignment();
  else if (pageId === 'hr-attendance') loadHRAttendance();
  else if (pageId === 'hr-leaves') loadHRLeaves();
  else if (pageId === 'hr-reports') { /* user clicks Generate */ }
  else if (pageId === 'hr-profile') loadHRProfile();
}

/* Navigate by page id, highlighting the matching sidebar row whichever way
   the sidebar was rendered. */
function hrGo(pageId) {
  const navEl = document.querySelector(`#s-hr .ni[data-page="${pageId}"]`)
    || document.querySelector(`#s-hr .ni[onclick*="'${pageId}'"]`);
  hrNav(pageId, navEl);
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
    <button class="btn btn-outline" onclick="hrGo('hr-leaves')">Review Now</button>
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
    const dateLabel = row.date
      ? new Date(row.date).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const timeIn = formatTimeOnly(row.time_in);
    const timeOut = row.time_out ? formatTimeOnly(row.time_out) : 'Still clocked in';
    return `<div class="ai-item">
      <div class="ai2">
        <div class="s">${escapeHtml(row.employee_name || row.employee_id || 'Unknown')}</div>
        <div class="ss">${dateLabel} · Time In ${timeIn} · Time Out ${timeOut}</div>
      </div>
      <span class="badge" style="background:color-mix(in srgb, ${color} 12%, transparent);color:${color};border:1px solid color-mix(in srgb, ${color} 31%, transparent);">${escapeHtml(row.status || '—')}</span>
    </div>`;
  }).join('');
}

/* ── USER MANAGEMENT (employee records, every branch) ── */
async function loadHREmployees() {
  const tbody = document.getElementById('hr-employee-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(10);

  try {
    // Archived rows are always loaded (the table filters them per chip) so the
    // "Archived (n)" count is right before that chip is opened.
    const [res, branches] = await Promise.all([
      fetch('/api/hr/employees?archived=true'),
      fetchBranchesCached({ activeOnly: false }).catch(() => hrBranches),
    ]);
    hrBranches = branches;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load employees.');

    hrAllEmployees = data.employees || [];
    renderHrEmployeeBranchFilter();
    updateHrEmployeeChips();
    renderHREmployeeTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
  }
}

function hrBranchName(branchId) {
  if (!branchId) return '';
  return hrBranches.find((b) => String(b.id) === String(branchId))?.name || 'Unknown branch';
}

function renderHrEmployeeBranchFilter() {
  const select = document.getElementById('hr-emp-branch-filter');
  if (!select) return;
  const current = hrEmployeeBranchFilter;
  select.innerHTML = '<option value="all">All branches</option><option value="unassigned">Unassigned</option>'
    + hrBranches.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('');
  select.value = [...select.options].some((o) => o.value === current) ? current : 'all';
  hrEmployeeBranchFilter = select.value;
}

function setHrEmployeeBranchFilter(value) {
  hrEmployeeBranchFilter = String(value || 'all');
  updateHrEmployeeChips();
  renderHREmployeeTable();
}

function hrEmployeesInBranchFilter(list) {
  if (hrEmployeeBranchFilter === 'all') return list;
  if (hrEmployeeBranchFilter === 'unassigned') return list.filter((e) => !e.branch_id);
  return list.filter((e) => String(e.branch_id || '') === hrEmployeeBranchFilter);
}

function updateHrEmployeeChips() {
  const all = hrEmployeesInBranchFilter(hrAllEmployees);
  const active = all.filter((e) => !e.archived);
  const teaching = active.filter((e) => e.employee_type?.toLowerCase() === 'teaching').length;
  const nonTeaching = active.filter((e) => e.employee_type?.toLowerCase() === 'non-teaching').length;
  const archived = all.filter((e) => e.archived).length;

  const labels = {
    all: `All (${active.length})`,
    teaching: `Teaching (${teaching})`,
    'non-teaching': `Non-Teaching (${nonTeaching})`,
    archived: `Archived (${archived})`,
  };
  document.querySelectorAll('#hr-emp-filter-chips .chip').forEach((chip) => {
    if (labels[chip.dataset.filter]) chip.textContent = labels[chip.dataset.filter];
  });
}

function setHrEmployeeFilter(filter) {
  hrEmployeeFilter = filter;
  document.querySelectorAll('#hr-emp-filter-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });
  renderHREmployeeTable();
}

function setHrEmployeeSearch(val) {
  hrEmployeeSearch = String(val || '').toLowerCase().trim();
  renderHREmployeeTable();
}

function renderHREmployeeTable() {
  const tbody = document.getElementById('hr-employee-table-body');
  if (!tbody) return;

  let list = hrEmployeesInBranchFilter(hrAllEmployees);

  if (hrEmployeeFilter === 'teaching') list = list.filter((e) => e.employee_type?.toLowerCase() === 'teaching' && !e.archived);
  else if (hrEmployeeFilter === 'non-teaching') list = list.filter((e) => e.employee_type?.toLowerCase() === 'non-teaching' && !e.archived);
  else if (hrEmployeeFilter === 'archived') list = list.filter((e) => e.archived);
  else list = list.filter((e) => !e.archived);

  if (hrEmployeeSearch) {
    list = list.filter((e) =>
      [e.full_name, e.employee_id, e.email, e.position, hrBranchName(e.branch_id)].some((v) =>
        String(v || '').toLowerCase().includes(hrEmployeeSearch)
      )
    );
  }

  if (!hrEmpPaginator) {
    hrEmpPaginator = createPaginator({
      id: 'hr-emp',
      pageSize: 15,
      renderFn: (rows) => {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="10" style="color:var(--t3);">No employees found.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map((e) => {
          const statusColor = e.archived
            ? 'var(--red)'
            : e.employee_status?.toLowerCase() === 'active' ? 'var(--green)' : 'var(--amber)';
          const statusLabel = e.archived ? 'Archived' : (e.employee_status || 'Active');
          const cpNumber = e.cp_number
            ? formatDigitGroups(digitsOnly(e.cp_number), DIGIT_FIELD_SPECS.cp_number.groups, DIGIT_FIELD_SPECS.cp_number.separator)
            : '—';
          return `<tr>
            <td>${escapeHtml(e.full_name || '—')}</td>
            <td><code style="font-size:11px;">${escapeHtml(e.employee_id || '—')}</code></td>
            <td>${escapeHtml(e.employee_type || '—')}</td>
            <td>${escapeHtml(e.position || '—')}</td>
            <td>${escapeHtml(cpNumber)}</td>
            <td style="font-size:12px;">${escapeHtml(hrBranchName(e.branch_id) || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(e.date_hired || '—')}</td>
            <td><span class="badge" style="color:${statusColor};background:color-mix(in srgb, ${statusColor} 12%, transparent);border:1px solid color-mix(in srgb, ${statusColor} 25%, transparent);">${escapeHtml(statusLabel)}</span></td>
            <td style="font-size:12px;color:var(--t3);">${escapeHtml(e.email || '—')}</td>
            <td><button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="openHrEditEmployeeModal('${escapeHtml(e.id)}')">Edit</button></td>
          </tr>`;
        }).join('');
      },
    });
  }

  hrEmpPaginator.setData(list);
}

/* ── EMPLOYEE FORM: required fields + formats ──
   Mirrors src/lib/employees/record.js so problems show before submitting;
   the server applies the same rules and has the final say. */
const HR_MIN_WORKING_AGE = 15;
const HR_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hrParseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function hrYearsBetween(earlier, later) {
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  if (later.getUTCMonth() < earlier.getUTCMonth()
    || (later.getUTCMonth() === earlier.getUTCMonth() && later.getUTCDate() < earlier.getUTCDate())) {
    years -= 1;
  }
  return years;
}

function hrFieldLabel(control) {
  const label = control.closest('.fg')?.querySelector('label');
  return label ? label.textContent.replace('*', '').trim() : control.name;
}

function hrMarkInvalid(control, message) {
  control.classList.add('field-invalid');
  control.setAttribute('aria-invalid', 'true');
  const error = control.closest('.fg')?.querySelector('.field-error');
  if (error && message) error.textContent = message;
}

function hrClearFormErrors(form) {
  form.querySelectorAll('.field-invalid').forEach((el) => {
    el.classList.remove('field-invalid');
    el.removeAttribute('aria-invalid');
  });
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
}

/**
 * Validate an employee form. Returns the payload to send, or null after
 * marking every problem field and writing a summary into `feedbackEl`.
 */
function collectHrEmployeeForm(form, feedbackEl, { creating }) {
  hrClearFormErrors(form);
  const value = (name) => String(form.elements[name]?.value ?? '').trim();

  const missing = [];
  form.querySelectorAll('[required]').forEach((control) => {
    if (!String(control.value ?? '').trim()) {
      missing.push(control);
      hrMarkInvalid(control, 'This field is required.');
    }
  });

  const fail = (control, message) => {
    if (control) {
      hrMarkInvalid(control, message);
      control.focus();
    }
    if (feedbackEl) { feedbackEl.textContent = message; feedbackEl.className = 'adm-feedback err'; }
    return null;
  };

  if (missing.length) {
    const labels = missing.map(hrFieldLabel);
    missing[0].focus();
    if (feedbackEl) {
      feedbackEl.textContent = `Please complete the required field${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}.`;
      feedbackEl.className = 'adm-feedback err';
    }
    return null;
  }

  const el = (name) => form.elements[name];
  const namePattern = /^[A-Za-z\s]+$/;
  if (!namePattern.test(value('first_name'))) return fail(el('first_name'), 'First name must contain letters and spaces only.');
  if (value('middle_initial') && !namePattern.test(value('middle_initial'))) return fail(el('middle_initial'), 'Middle name must contain letters and spaces only.');
  if (!namePattern.test(value('last_name'))) return fail(el('last_name'), 'Last name must contain letters and spaces only.');
  if (!HR_EMAIL_PATTERN.test(value('email'))) return fail(el('email'), 'Enter a valid email address.');

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const birth = hrParseDate(value('date_of_birth'));
  if (!birth) return fail(el('date_of_birth'), 'Date of birth is not a valid date.');
  if (birth >= todayUtc) return fail(el('date_of_birth'), 'Date of birth must be in the past.');
  if (hrYearsBetween(birth, todayUtc) < HR_MIN_WORKING_AGE) return fail(el('date_of_birth'), `The employee must be at least ${HR_MIN_WORKING_AGE} years old.`);

  const hired = hrParseDate(value('date_hired'));
  if (!hired) return fail(el('date_hired'), 'Date hired is not a valid date.');
  if (hrYearsBetween(birth, hired) < HR_MIN_WORKING_AGE) return fail(el('date_hired'), `Date hired must be on or after the employee's ${HR_MIN_WORKING_AGE}th birthday.`);

  let basicSalary;
  if (creating) {
    basicSalary = Number(value('basic_salary'));
    if (!(basicSalary > 0) || basicSalary > 9999999.99) return fail(el('basic_salary'), 'Basic salary must be greater than 0 and at most ₱9,999,999.99.');
  }

  if (value('address').length < 5) return fail(el('address'), 'Enter the complete home address.');

  const cp = digitsOnly(value('cp_number'));
  if (!/^09\d{9}$/.test(cp)) return fail(el('cp_number'), 'Contact number must be an 11-digit PH mobile number starting with 09.');
  const sss = digitsOnly(value('sss_number'));
  if (sss.length !== 10) return fail(el('sss_number'), 'SSS number must be exactly 10 digits.');
  const philhealth = digitsOnly(value('philhealth_number'));
  if (philhealth.length !== 12) return fail(el('philhealth_number'), 'PhilHealth number must be exactly 12 digits.');
  const pagibig = digitsOnly(value('pagibig_number'));
  if (pagibig.length !== 12) return fail(el('pagibig_number'), 'Pag-IBIG number must be exactly 12 digits.');
  const tin = digitsOnly(value('tin_number'));
  if (tin.length !== 9 && tin.length !== 12) return fail(el('tin_number'), 'TIN must be 9 digits, or 12 digits including the branch code.');
  const bankAccount = digitsOnly(value('bank_account_number'));
  if (bankAccount.length < 6 || bankAccount.length > 20) return fail(el('bank_account_number'), 'Bank account number must be 6 to 20 digits.');

  const payload = {
    first_name: value('first_name'),
    middle_initial: value('middle_initial'),
    last_name: value('last_name'),
    suffix: value('suffix'),
    email: value('email'),
    date_of_birth: value('date_of_birth'),
    sex: value('sex'),
    civil_status: value('civil_status'),
    employee_type: value('employee_type'),
    position: value('position'),
    employment_type: value('employment_type'),
    employment_status: value('employment_status'),
    employee_status: value('employee_status'),
    date_hired: value('date_hired'),
    address: value('address'),
    cp_number: cp,
    sss_number: sss,
    philhealth_number: philhealth,
    pagibig_number: pagibig,
    tin_number: tin,
    bank_name: value('bank_name'),
    bank_account_number: bankAccount,
  };
  if (creating) {
    payload.role = value('role');
    payload.branch_id = value('branch_id');
    payload.basic_salary = basicSalary;
  }
  return payload;
}

function hrPositionForRole(role) {
  return String(role || '').toLowerCase() === 'accountant' ? 'Accountant' : 'Employee';
}

function setHrSelectValue(select, value) {
  if (!select) return;
  const wanted = String(value || '');
  const match = [...select.options].find((o) => o.value.toLowerCase() === wanted.toLowerCase() && o.value !== '');
  select.value = match ? match.value : '';
  // A blank value on a select whose placeholder is disabled shows nothing;
  // select the placeholder explicitly so the field reads "Select ...".
  if (!match && select.options[0]?.value === '') select.selectedIndex = 0;
}

function openHrEditEmployeeModal(employeeId) {
  const employee = hrAllEmployees.find((e) => e.id === employeeId);
  const form = document.getElementById('hr-edit-employee-form');
  if (!employee || !form) {
    window.alert('Employee not found. Please refresh the list.');
    return;
  }
  hrCurrentEditEmployee = employee;
  form.reset();
  hrClearFormErrors(form);

  const set = (name, val) => { if (form.elements[name]) form.elements[name].value = val ?? ''; };

  set('id', employee.id);
  set('employee_id', employee.employee_id || '—');
  set('role_label', employee.role === 'accountant' ? 'Accountant' : 'Employee');
  set('branch_label', hrBranchName(employee.branch_id) || 'Unassigned');

  // Use the name parts exactly as last saved. Only a record that predates
  // them (just a composed full_name) falls back to a best-effort split.
  if (employee.first_name || employee.last_name) {
    set('first_name', employee.first_name || '');
    set('middle_initial', employee.middle_name || '');
    set('last_name', employee.last_name || '');
    setHrSelectValue(form.elements.suffix, employee.suffix);
  } else {
    const nameParts = splitFullName(employee.full_name || '');
    const midName = nameParts.middle_initial
      || (nameParts.second_name && nameParts.second_name !== nameParts.last_name ? nameParts.second_name : '');
    set('first_name', nameParts.first_name || '');
    set('middle_initial', midName);
    set('last_name', nameParts.last_name || '');
    setHrSelectValue(form.elements.suffix, nameParts.suffix);
  }

  set('email', employee.email);
  set('date_of_birth', employee.date_of_birth);
  setHrSelectValue(form.elements.sex, employee.sex);
  setHrSelectValue(form.elements.civil_status, employee.civil_status);
  setHrSelectValue(form.elements.employee_type, employee.employee_type);
  set('position', employee.position || hrPositionForRole(employee.role));
  setHrSelectValue(form.elements.employment_type, employee.employment_type);
  setHrSelectValue(form.elements.employment_status, employee.employment_status);
  setHrSelectValue(form.elements.employee_status, employee.employee_status || 'Active');
  set('date_hired', employee.date_hired);
  set('address', employee.address);
  set('bank_name', employee.bank_name);

  bindDigitFieldsIn(form);
  populateDigitFieldsIn(form, employee);

  const archiveBtn = document.getElementById('hr-edit-employee-archive-btn');
  if (archiveBtn) {
    archiveBtn.disabled = false;
    archiveBtn.className = employee.archived ? 'btn btn-green' : 'btn btn-red';
    archiveBtn.textContent = employee.archived ? 'Restore Employee' : 'Archive Employee';
  }

  const fb = document.getElementById('hr-edit-employee-feedback');
  const missing = [...form.querySelectorAll('[required]')].filter((c) => !String(c.value || '').trim());
  if (fb) {
    fb.textContent = missing.length
      ? `This record is incomplete: ${missing.map(hrFieldLabel).join(', ')}. Fill these in to save.`
      : '';
    fb.className = missing.length ? 'adm-feedback loading' : 'adm-feedback';
  }

  const modal = document.getElementById('hr-edit-employee-modal');
  if (modal) modal.style.display = 'flex';
}

// Archive is a soft delete: the account can no longer sign in or clock in by
// RFID, drops out of the active lists, and keeps its payroll and attendance
// history. Restore undoes it. The server (/api/admin/employees PATCH) writes
// both the auth flag and profiles.archived.
async function toggleArchiveHrEmployee() {
  const employee = hrCurrentEditEmployee;
  const archiveBtn = document.getElementById('hr-edit-employee-archive-btn');
  const fb = document.getElementById('hr-edit-employee-feedback');
  if (!employee || !archiveBtn) return;

  const action = employee.archived ? 'restore' : 'archive';
  const name = employee.full_name || 'this employee';
  const detail = action === 'archive'
    ? `${name} will be signed out, will not be able to sign in or tap RFID, and will move to the Archived list. Payroll and attendance history is kept.`
    : `${name} will be able to sign in and tap RFID again.`;
  const confirmFn = action === 'restore'
    ? (window.confirmApproveAction
        && ((p, d) => window.confirmApproveAction(p, d, { title: 'Confirm Restore', confirmLabel: 'Restore' })))
    : window.confirmDestructiveAction;
  if (confirmFn && !(await confirmFn(`${action} this employee`, detail))) return;

  try {
    archiveBtn.disabled = true;
    archiveBtn.textContent = action === 'archive' ? 'Archiving...' : 'Restoring...';

    const res = await fetch('/api/admin/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: employee.id, action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to ${action} employee.`);

    pushNotification(
      action === 'archive' ? 'Employee Archived' : 'Employee Restored',
      action === 'archive' ? `${name} was moved to Archived.` : `${name} is active again.`,
      action === 'archive' ? 'info' : 'success',
    );
    closeHrEditEmployeeModal();
    loadHREmployees();
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.className = 'adm-feedback err'; }
    archiveBtn.disabled = false;
    archiveBtn.textContent = employee.archived ? 'Restore Employee' : 'Archive Employee';
  }
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
  const submitBtn = form.querySelector('button[type="submit"]');

  const payload = collectHrEmployeeForm(form, fb, { creating: false });
  if (!payload) return;
  payload.id = form.elements.id.value;

  try {
    submitBtn.disabled = true;
    if (fb) { fb.textContent = 'Saving...'; fb.className = 'adm-feedback loading'; }

    const res = await fetch('/api/hr/employees', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Update failed.');

    if (fb) { fb.textContent = 'Employee updated successfully.'; fb.className = 'adm-feedback ok'; }
    pushNotification('Employee Updated', `${payload.first_name} ${payload.last_name}'s record was saved.`, 'success');
    setTimeout(() => {
      closeHrEditEmployeeModal();
      loadHREmployees();
    }, 700);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
  }
}

/* ── ATTENDANCE ── */
// Both loaders below fill the same table. Changing the date (or switching to
// All Records) while an earlier request is still out let the slower, older
// response land last and overwrite the newer one; only the latest request's
// response is rendered now.
let hrAttendanceRequestSeq = 0;

async function loadHRAttendance() {
  const dateInput = document.getElementById('hr-att-date');
  const today = localDateKey();
  const date = dateInput?.value || today;
  if (dateInput && !dateInput.value) dateInput.value = today;

  const titleEl = document.getElementById('hr-att-title');
  if (titleEl) titleEl.textContent = `Attendance Log — ${date === today ? 'Today' : date}`;

  const tbody = document.getElementById('hr-att-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  const seq = ++hrAttendanceRequestSeq;
  try {
    const res = await fetch(`/api/hr/attendance?date=${date}`);
    const data = await res.json();
    if (seq !== hrAttendanceRequestSeq) return;
    if (!res.ok) throw new Error(data.error || 'Failed to load attendance.');

    hrAttendanceLogs = data.logs || [];
    const s = data.summary || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hr-att-present', s.present ?? 0);
    set('hr-att-late', s.late ?? 0);
    set('hr-att-absent', s.absent ?? 0);

    renderHRAttendanceTable(hrAttendanceLogs);
  } catch (err) {
    if (seq !== hrAttendanceRequestSeq) return;
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadHRAllAttendance() {
  const titleEl = document.getElementById('hr-att-title');
  if (titleEl) titleEl.textContent = 'Attendance Log — All Records';

  const tbody = document.getElementById('hr-att-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  const seq = ++hrAttendanceRequestSeq;
  try {
    const res = await fetch('/api/hr/attendance?view=all');
    const data = await res.json();
    if (seq !== hrAttendanceRequestSeq) return;
    if (!res.ok) throw new Error(data.error || 'Failed to load attendance.');

    hrAttendanceLogs = data.logs || [];
    const s = data.summary || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hr-att-present', s.present ?? 0);
    set('hr-att-late', s.late ?? 0);
    set('hr-att-absent', s.absent ?? 0);

    renderHRAttendanceTable(hrAttendanceLogs);
  } catch (err) {
    if (seq !== hrAttendanceRequestSeq) return;
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
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
            <td>${escapeHtml(row.employee_name || row.employee_id || '—')}</td>
            <td>${escapeHtml(row.employee_type || '—')}</td>
            <td>${escapeHtml(row.date || '—')}</td>
            <td>${row.time_in ? escapeHtml(formatTimeOnly(row.time_in)) : '—'}</td>
            <td>${row.time_out ? escapeHtml(formatTimeOnly(row.time_out)) : '—'}</td>
            <td>${row.time_out ? Number(row.total_hours || 0).toFixed(2) + 'h' : '—'}</td>
            <td><span class="badge" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent);border:1px solid color-mix(in srgb, ${color} 25%, transparent);">${escapeHtml(row.status || '—')}</span></td>
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
    r.time_in ? formatTimeOnly(r.time_in) : '',
    r.time_out ? formatTimeOnly(r.time_out) : '',
    r.time_out ? Number(r.total_hours || 0).toFixed(2) : '',
    r.status || '',
  ]);

  downloadCsv([headers, ...rows], `sacs-hr-attendance-${localDateKey()}.csv`);
}

/* ── LEAVE MANAGEMENT ── */
async function loadHRLeaves() {
  const listEl = document.getElementById('hr-leave-list');
  if (listEl) listEl.innerHTML = skeletonCards(3);

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
    if (listEl) listEl.innerHTML = `<div class="approval-card"><div class="approval-card-body"><div class="approval-card-meta" style="color:var(--red);">${escapeHtml(err.message)}</div></div></div>`;
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
    const payStatusLabel = req.pay_status === 'without_pay' ? 'Without Pay' : 'With Pay';

    // The proof URL is employee-supplied and may be a very long data: URL, so it
    // is passed by lookup key rather than interpolated into the onclick — the
    // same approach accountant.js already uses for this button. Interpolating it
    // directly let a crafted proof_url close the JS string and run script in the
    // HR reviewer's session.
    const safeId = escapeHtml(String(req.id || ''));
    if (!window._hrProofUrls) window._hrProofUrls = {};
    window._hrProofUrls[String(req.id || '')] = proof;

    return `<div class="approval-card">
      <div class="approval-card-body">
        <div class="approval-card-name">${escapeHtml(req.employee_name || req.employee_id || 'Unknown')}</div>
        <div class="approval-card-meta">
          <strong>${escapeHtml(req.leave_type || 'Leave')}</strong> · ${payStatusLabel} · ${escapeHtml(String(days))} day${days !== 1 ? 's' : ''} · ${escapeHtml(from)} to ${escapeHtml(to)}
        </div>
        <div class="approval-card-meta" style="margin-top:4px;">${escapeHtml(req.reason || '—')}</div>
        ${proof ? `<button class="btn btn-outline" style="font-size:11px;padding:3px 9px;margin-top:6px;" onclick="openProofDocument(window._hrProofUrls['${safeId}'])">View Proof</button>` : ''}
      </div>
      <div class="approval-card-actions">
        <button class="btn btn-primary" style="background:var(--green);border-color:var(--green);" onclick="hrLeaveAction('${safeId}','approve')">Approve</button>
        <button class="btn btn-red" onclick="hrLeaveAction('${safeId}','reject')">Reject</button>
      </div>
    </div>`;
  }).join('');
}

async function hrLeaveAction(id, action) {
  // Approving is a positive decision, so it uses the green approval dialog
  // (same as the accountant's approve). Only rejecting gets the red warning.
  const confirmed = action === 'approve'
    ? await confirmApproveAction('approve this leave request', 'The employee will be notified of the approval.')
    : await confirmDestructiveAction('reject this leave request', 'This decision cannot be undone.');
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
          const safeId = escapeHtml(String(req.id || ''));
          if (!window._hrProofUrls) window._hrProofUrls = {};
          window._hrProofUrls[String(req.id || '')] = proof;
          const decided = req.decided_at ? new Date(req.decided_at).toLocaleDateString('en-PH') : '—';
          const submitted = req.submitted_at || req.created_at
            ? new Date(req.submitted_at || req.created_at).toLocaleDateString('en-PH')
            : '—';

          return `<tr>
            <td>${escapeHtml(req.employee_name || req.employee_id || '—')}</td>
            <td>${escapeHtml(req.leave_type || '—')}</td>
            <td>${escapeHtml(String(days))}d · ${escapeHtml(from)} – ${escapeHtml(to)}</td>
            <td style="font-size:12px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(req.reason || '—')}</td>
            <td>${proof ? `<button class="btn btn-outline" style="font-size:10px;padding:2px 8px;" onclick="openProofDocument(window._hrProofUrls['${safeId}'])">View</button>` : '—'}</td>
            <td><span class="badge" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent);border:1px solid color-mix(in srgb, ${color} 25%, transparent);">${escapeHtml(req.status || '—')}</span></td>
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
  const to = document.getElementById('hr-report-to')?.value || localDateKey();

  const thead = document.getElementById('hr-rep-thead');
  const tbody = document.getElementById('hr-rep-table-body');
  const summary = document.getElementById('hr-reports-summary');
  const titleEl = document.getElementById('hr-rep-table-title');

  if (tbody) tbody.innerHTML = skeletonRows(6);
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
              <td>${escapeHtml(r.employee_name || '—')}</td>
              <td>${escapeHtml(r.employee_type || '—')}</td>
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
                <td>${escapeHtml(r.full_name || '—')}${archived}</td>
                <td><code style="font-size:11px;">${escapeHtml(r.employee_id || '—')}</code></td>
                <td>${escapeHtml(r.employee_type || '—')}</td>
                <td>${escapeHtml(r.position || '—')}</td>
                <td>${escapeHtml(r.employee_status || 'Active')}</td>
                <td style="font-size:12px;color:var(--t3);">${escapeHtml(r.email || '—')}</td>
              </tr>`;
            }).join('');
          },
        });
      }
      hrRepPaginator.setData(hrReportData);
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
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

  downloadCsv([headers, ...rows], `sacs-hr-${hrReportType}-report-${localDateKey()}.csv`);
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
// The previous version reported success without ever changing the password.
function submitHrChangePassword() {
  return submitAccountPasswordChange('hr');
}

/* ── PROFILE ── */
function loadHRProfile() {
  const ctx = typeof getLegacyAuthContext === 'function' ? getLegacyAuthContext() : null;
  if (!ctx) return;

  const initials = (String(ctx.full_name || '').trim()
    .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('') || 'HR').toUpperCase();

  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };

  setTxt('hr-ep-avatar',    initials);
  setTxt('hr-ep-name',      ctx.full_name    || 'HR Officer');
  setTxt('hr-ep-pos',       ctx.position     || ctx.employee_type || '');
  setTxt('hr-ep-role-tag',  ctx.role         || 'HR');
  setTxt('hr-ep-info-name',    ctx.full_name);
  setTxt('hr-ep-info-id',     ctx.employee_id);
  setTxt('hr-ep-info-pos',    ctx.position);
  setTxt('hr-ep-info-type',   ctx.employee_type);
  setTxt('hr-ep-info-email',  ctx.email);
  setTxt('hr-ep-info-role',   ctx.role);
  setTxt('hr-ep-bank-name',   ctx.bank_name);
  setTxt('hr-ep-bank-account',ctx.bank_account_number);
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
  if (attDate && !attDate.value) attDate.value = localDateKey();

  // Set today's date in report to field
  const repTo = document.getElementById('hr-report-to');
  if (repTo && !repTo.value) repTo.value = localDateKey();

  setupHrEmployeeForms();
}

window.addEventListener('sacs-auth-context-changed', (event) => {
  const ctx = event?.detail;
  if (ctx?.role === 'hr') applyHRIdentity();
});

// Auto-init when HR screen becomes active
/* ═══════════════════════════════════════
   HR TRANSFER REQUESTS
   HR sees every branch's roster and moves employees between branches. A
   transfer is recorded in public.transfer_requests and applied at once.
   ═══════════════════════════════════════ */

const HR_BRANCH_COLORS = ['var(--amber)', 'var(--blue)', 'var(--teal)', 'var(--green)', 'var(--red)'];

function hrRenderBranchFilterUI() {
  const CARD_COLORS = ['a', 'b', 't', 'g', 'r'];

  // Reset filter to 'all' if the selected branch no longer exists
  if (hrBranchFilter !== 'all' && hrBranchFilter !== 'unassigned' && !hrBranches.some((b) => b.id === hrBranchFilter)) {
    hrBranchFilter = 'all';
  }

  const cardsEl = document.getElementById('hr-ba-branch-cards');
  if (cardsEl) {
    let html = `
      <div class="card"><div class="ct">Total Employees</div><div class="cv" id="hr-ba-count-total">0</div><div class="cch">All active employees</div></div>
      <div class="card"><div class="ct">Unassigned</div><div class="cv r" id="hr-ba-count-unassigned">0</div><div class="cch">Not yet in a branch</div></div>
    `;
    hrBranches.forEach((b, i) => {
      const colorClass = CARD_COLORS[i % CARD_COLORS.length];
      html += `<div class="card"><div class="ct">${escapeHtml(b.name)}</div><div class="cv ${colorClass}" id="hr-ba-count-${escapeHtml(b.id)}">0</div><div class="cch">Branch campus</div></div>`;
    });
    cardsEl.innerHTML = html;
  }

  const chipsEl = document.getElementById('hr-ba-filter-chips');
  if (!chipsEl) return;

  let chipsHtml = `
    <div class="chip ${hrBranchFilter === 'all' ? 'active' : ''}" data-hbf="all" onclick="setHrBranchFilter('all')">All (0)</div>
    <div class="chip ${hrBranchFilter === 'unassigned' ? 'active' : ''}" data-hbf="unassigned" onclick="setHrBranchFilter('unassigned')">Unassigned (0)</div>
  `;

  if (hrBranches.length) {
    hrBranches.forEach((b) => {
      chipsHtml += `<div class="chip ${hrBranchFilter === b.id ? 'active' : ''}" data-hbf="${escapeHtml(b.id)}" onclick="setHrBranchFilter('${escapeHtml(b.id)}')">${escapeHtml(b.name)} (0)</div>`;
    });
  } else {
    chipsHtml += '<span style="font-size:12px;color:var(--t3);padding:4px 8px;align-self:center;">No branches configured — ask the Super Admin to add branches first.</span>';
  }

  chipsEl.innerHTML = chipsHtml;
}

function hrUpdateBranchSummary() {
  const total = hrBranchAllEmployees.length;
  const unassigned = hrBranchAllEmployees.filter((e) => !e.branch).length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  set('hr-ba-count-total', total);
  set('hr-ba-count-unassigned', unassigned);

  const countsByBranch = {};
  hrBranches.forEach((b) => {
    countsByBranch[b.id] = hrBranchAllEmployees.filter((e) => e.branch === b.id).length;
    set(`hr-ba-count-${b.id}`, countsByBranch[b.id]);
  });

  document.querySelectorAll('#hr-ba-filter-chips .chip').forEach((chip) => {
    const bf = chip.getAttribute('data-hbf');
    if (bf === 'all') chip.textContent = `All (${total})`;
    else if (bf === 'unassigned') chip.textContent = `Unassigned (${unassigned})`;
    else {
      const branch = hrBranches.find((b) => b.id === bf);
      chip.textContent = `${branch ? branch.name : 'Branch'} (${countsByBranch[bf] ?? 0})`;
    }
  });
}

function hrGetFilteredBranchEmployees() {
  const search = hrBranchSearch.toLowerCase();
  return hrBranchAllEmployees.filter((e) => {
    if (hrBranchFilter === 'unassigned') { if (e.branch) return false; }
    else if (hrBranchFilter !== 'all') { if (e.branch !== hrBranchFilter) return false; }
    if (!search) return true;
    const hay = [e.full_name, e.employee_id, e.email].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.includes(search);
  });
}

function hrRenderBranchTable(employees) {
  const tbody = document.getElementById('hr-ba-table-body');
  if (!tbody) return;

  if (!employees.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No employees found.</td></tr>';
    return;
  }

  tbody.innerHTML = employees.map((emp) => {
    const branchIdx = emp.branch ? hrBranches.findIndex((b) => b.id === emp.branch) : -1;
    const branchColor = branchIdx >= 0 ? HR_BRANCH_COLORS[branchIdx % HR_BRANCH_COLORS.length] : 'var(--t3)';
    const inactiveTag = emp.branch && emp.branch_status && emp.branch_status !== 'Active' ? ' (Inactive)' : '';
    const branchLabel = emp.branch ? `${emp.branch_label || 'Unknown branch'}${inactiveTag}` : null;
    const branchCell = branchLabel
      ? `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:color-mix(in srgb, ${branchColor} 13%, transparent);color:${branchColor};border:1px solid color-mix(in srgb, ${branchColor} 33%, transparent);">${escapeHtml(branchLabel)}</span>`
      : '<span class="badge br"><span class="bd"></span>Unassigned</span>';
    const assignedAt = emp.assigned_at
      ? new Date(emp.assigned_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
      : '—';
    const typeClass = emp.employee_type === 'Non-Teaching' ? 'ba' : 'bt2';
    const actionBtn = emp.branch
      ? `<button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openHrBranchAssignModal('${escapeHtml(emp.id)}')">Transfer</button>`
      : `<button class="btn btn-primary" style="font-size:11px;padding:5px 11px;" onclick="openHrBranchAssignModal('${escapeHtml(emp.id)}')">Assign</button>`;

    return `
      <tr>
        <td class="nm">${escapeHtml(emp.full_name || '')}</td>
        <td class="mn">${escapeHtml(emp.employee_id || '—')}</td>
        <td><span class="badge ${typeClass}">${escapeHtml(emp.employee_type || 'Teaching')}</span></td>
        <td class="mn">${escapeHtml(emp.position || '—')}</td>
        <td>${branchCell}</td>
        <td class="mn" style="font-size:11px;">${assignedAt}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

function hrRenderFilteredBranch() {
  hrUpdateBranchSummary();
  if (hrBranchPaginator) {
    hrBranchPaginator.setData(hrGetFilteredBranchEmployees());
  } else {
    hrRenderBranchTable(hrGetFilteredBranchEmployees());
  }
}

function setHrBranchFilter(filter) {
  hrBranchFilter = filter;
  document.querySelectorAll('#hr-ba-filter-chips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.getAttribute('data-hbf') === filter);
  });
  hrRenderFilteredBranch();
}

function setHrBranchSearch(value) {
  hrBranchSearch = String(value || '').trim();
  hrRenderFilteredBranch();
}

async function loadHrBranchAssignment() {
  const tbody = document.getElementById('hr-ba-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  try {
    hrBranches = await fetchBranchesCached({ activeOnly: false }).catch(() => hrBranches);
    hrRenderBranchFilterUI();

    const [rosterRes] = await Promise.all([
      fetch('/api/admin/branch-employees', { method: 'GET' }),
      loadHrTransferHistory(),
    ]);
    const payload = await rosterRes.json().catch(() => ({}));
    if (!rosterRes.ok) throw new Error(payload.error || 'Failed to load branch assignments');

    // HR manages Employee and Accountant accounts only.
    hrBranchAllEmployees = (payload.employees || []).filter((e) => e.role === 'employee' || e.role === 'accountant');
    if (!hrBranchPaginator) {
      hrBranchPaginator = createPaginator({ id: 'hr-ba', pageSize: 20, renderFn: hrRenderBranchTable });
    }
    hrRenderFilteredBranch();
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${escapeHtml(error.message || 'Error')}</td></tr>`;
    }
  }
}

async function loadHrTransferHistory() {
  const tbody = document.getElementById('hr-transfer-history-body');
  if (tbody) tbody.innerHTML = skeletonRows(7, 3);

  try {
    const res = await fetch('/api/admin/transfer-requests');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load transfer history.');
    hrTransferHistory = data.requests || [];

    if (!hrTransferHistoryPaginator) {
      hrTransferHistoryPaginator = createPaginator({ id: 'hr-transfer-hist', pageSize: 10, renderFn: renderHrTransferHistory });
    }
    hrTransferHistoryPaginator.setData(hrTransferHistory);
  } catch (error) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderHrTransferHistory(rows) {
  const tbody = document.getElementById('hr-transfer-history-body');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No transfers yet.</td></tr>';
    return;
  }

  const fmt = (value) => (value ? new Date(value).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  tbody.innerHTML = rows.map((r) => {
    const status = String(r.status || '').toLowerCase();
    const color = status === 'approved' ? 'var(--green)' : status === 'rejected' ? 'var(--red)' : 'var(--amber)';
    const label = status === 'approved' ? 'Transferred' : status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
    return `<tr>
      <td>${escapeHtml(r.employee_name || '—')}</td>
      <td style="font-size:12px;">${escapeHtml(r.from_branch_name || (r.from_branch_id ? 'Unknown branch' : 'Unassigned'))}</td>
      <td style="font-size:12px;">${escapeHtml(r.to_branch_name || 'Unknown branch')}</td>
      <td><span class="badge" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent);border:1px solid color-mix(in srgb, ${color} 25%, transparent);">${escapeHtml(label)}</span></td>
      <td style="font-size:12px;max-width:220px;white-space:normal;">${escapeHtml(r.remarks || '—')}</td>
      <td style="font-size:12px;">${fmt(r.created_at)}</td>
      <td style="font-size:12px;">${fmt(r.reviewed_at)}</td>
    </tr>`;
  }).join('');
}

function openHrBranchAssignModal(userId) {
  const modal = document.getElementById('hr-branch-assign-modal');
  const form = document.getElementById('hr-branch-assign-form');
  if (!modal || !form) return;

  hrCurrentBranchEmployee = hrBranchAllEmployees.find((e) => e.id === userId);
  if (!hrCurrentBranchEmployee) {
    window.alert('Employee not found. Please refresh.');
    return;
  }

  form.reset();
  hrClearFormErrors(form);
  const current = hrCurrentBranchEmployee;

  const titleEl = document.getElementById('hr-ba-modal-title');
  if (titleEl) titleEl.textContent = current.branch ? 'Transfer Employee' : 'Assign Branch';

  form.elements.user_id.value = current.id;
  form.elements.employee_display.value = `${current.full_name} (${current.employee_id || 'N/A'})`;
  form.elements.current_branch.value = current.branch ? (current.branch_label || 'Unknown branch') : 'Unassigned';

  // Active branches other than the one the employee is already in.
  const destinations = hrBranches.filter((b) =>
    String(b.status || 'Active').toLowerCase() === 'active' && b.id !== current.branch);
  const branchSelect = form.elements.branch;
  branchSelect.innerHTML = destinations.length
    ? '<option value="" disabled selected>Select destination branch</option>'
      + destinations.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')
    : '<option value="" disabled selected>No other active branch available</option>';

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = current.branch ? 'Transfer Now' : 'Assign Now';

  const feedbackEl = document.getElementById('hr-ba-modal-feedback');
  if (feedbackEl) { feedbackEl.textContent = ''; feedbackEl.className = 'adm-feedback'; }

  modal.style.display = 'flex';
}

function closeHrBranchAssignModal() {
  const modal = document.getElementById('hr-branch-assign-modal');
  if (modal) modal.style.display = 'none';
}

async function submitHrBranchAssign(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const feedbackEl = document.getElementById('hr-ba-modal-feedback');

  const userId = String(form.elements.user_id.value || '').trim();
  const branchId = String(form.elements.branch.value || '').trim();
  const remarks = String(form.elements.remarks.value || '').trim();

  hrClearFormErrors(form);
  if (!userId) {
    if (feedbackEl) { feedbackEl.textContent = 'Employee is missing. Please close and try again.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }
  if (!branchId) {
    hrMarkInvalid(form.elements.branch, 'Choose the destination branch.');
    if (feedbackEl) { feedbackEl.textContent = 'Choose the destination branch.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const destination = hrBranches.find((b) => b.id === branchId);
  const employee = hrCurrentBranchEmployee;
  const confirmed = await confirmApproveAction(
    `${employee?.branch ? 'transfer' : 'assign'} ${employee?.full_name || 'this employee'} to ${destination?.name || 'the selected branch'}`,
    'The change applies immediately and is recorded in Transfer History.',
    { title: 'Confirm Transfer', confirmLabel: employee?.branch ? 'Transfer' : 'Assign' },
  );
  if (!confirmed) return;

  const originalLabel = submitBtn.textContent;
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const response = await fetch('/api/admin/transfer-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: userId, to_branch_id: branchId, remarks }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Failed to transfer employee.');

    const branchName = result.to_branch_name || destination?.name || 'the new branch';
    if (feedbackEl) { feedbackEl.textContent = `Moved to ${branchName}.`; feedbackEl.className = 'adm-feedback ok'; }
    pushNotification('Employee Transferred', `${employee?.full_name || 'Employee'} now belongs to ${branchName}.`, 'success');
    await loadHrBranchAssignment();
    setTimeout(() => closeHrBranchAssignModal(), 600);
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

window.setHrBranchFilter = setHrBranchFilter;
window.setHrBranchSearch = setHrBranchSearch;
window.loadHrBranchAssignment = loadHrBranchAssignment;
window.openHrBranchAssignModal = openHrBranchAssignModal;
window.closeHrBranchAssignModal = closeHrBranchAssignModal;
window.submitHrBranchAssign = submitHrBranchAssign;
window.loadHRProfile = loadHRProfile;
window.hrGo = hrGo;
window.setHrEmployeeBranchFilter = setHrEmployeeBranchFilter;
window.openHrEditEmployeeModal = openHrEditEmployeeModal;
window.toggleArchiveHrEmployee = toggleArchiveHrEmployee;
window.openHrAddEmployeeModal = openHrAddEmployeeModal;
window.submitHrChangePassword = submitHrChangePassword;

/* ═══════════════════════════════════════
   HR ADD EMPLOYEE
   ═══════════════════════════════════════ */

async function openHrAddEmployeeModal() {
  const modal = document.getElementById('hr-add-employee-modal');
  const form = document.getElementById('hr-add-employee-form');
  if (!modal || !form) return;

  form.reset();
  hrClearFormErrors(form);
  bindDigitFieldsIn(form);
  form.elements.position.value = hrPositionForRole(form.elements.role.value);

  const fb = document.getElementById('hr-add-employee-feedback');
  if (fb) { fb.textContent = ''; fb.className = 'adm-feedback'; }

  modal.style.display = 'flex';

  // HR places new staff in any branch; only active branches accept new staff.
  const branchSelect = form.elements.branch_id;
  try {
    hrBranches = await fetchBranchesCached({ activeOnly: false });
  } catch {
    // keep whatever list is already loaded
  }
  const active = hrBranches.filter((b) => String(b.status || 'Active').toLowerCase() === 'active');
  branchSelect.innerHTML = active.length
    ? '<option value="" disabled selected>Select branch</option>'
      + active.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')
    : '<option value="" disabled selected>No active branches — ask the Super Admin to add one</option>';
  if (hrEmployeeBranchFilter !== 'all' && active.some((b) => b.id === hrEmployeeBranchFilter)) {
    branchSelect.value = hrEmployeeBranchFilter;
  }

  setTimeout(() => form.elements.first_name?.focus(), 0);
}

function closeHrAddEmployeeModal() {
  const modal = document.getElementById('hr-add-employee-modal');
  if (modal) modal.style.display = 'none';
}

async function submitHrAddEmployee(event) {
  event.preventDefault();
  const form = event.target;
  const fb = document.getElementById('hr-add-employee-feedback');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.elements.position.value = hrPositionForRole(form.elements.role.value);
  const payload = collectHrEmployeeForm(form, fb, { creating: true });
  if (!payload) return;

  try {
    submitBtn.disabled = true;
    if (fb) { fb.textContent = 'Creating employee...'; fb.className = 'adm-feedback loading'; }

    const res = await fetch('/api/admin/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to create employee.');

    const created = data.employee || {};
    if (fb) {
      fb.textContent = `${created.full_name || 'Employee'} created (${created.employee_id || 'ID pending'}). They will be asked to change their default password on first sign-in.`;
      fb.className = 'adm-feedback ok';
    }
    pushNotification('Employee Created', `${created.full_name || 'New employee'} has been added.`, 'success');
    setTimeout(() => {
      closeHrAddEmployeeModal();
      loadHREmployees();
    }, 1200);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
  }
}

/* Letters-only name inputs and the salary ceiling, for both employee forms. */
function setupHrEmployeeForms() {
  const INVALID_NAME_CHARS = /[^A-Za-z\s]/g;

  ['hr-add-employee-form', 'hr-edit-employee-form'].forEach((formId) => {
    const form = document.getElementById(formId);
    if (!form || form.dataset.hrBound === '1') return;
    form.dataset.hrBound = '1';

    form.querySelectorAll('.name-input').forEach((input) => {
      input.addEventListener('input', () => {
        const original = input.value;
        const cleaned = original.replace(INVALID_NAME_CHARS, '');
        const errorSpan = input.closest('.fg')?.querySelector('.field-error');
        if (cleaned !== original) {
          const pos = Math.max(0, (input.selectionStart || 0) - (original.length - cleaned.length));
          input.value = cleaned;
          input.setSelectionRange(pos, pos);
          if (errorSpan) errorSpan.textContent = 'Only letters and spaces are allowed.';
        } else if (errorSpan && !input.classList.contains('field-invalid')) {
          errorSpan.textContent = '';
        }
      });
    });

    // Clear a field's error as soon as it is corrected.
    form.addEventListener('input', (event) => {
      const control = event.target;
      if (!control.classList?.contains('field-invalid')) return;
      if (String(control.value || '').trim()) {
        control.classList.remove('field-invalid');
        control.removeAttribute('aria-invalid');
        const errorSpan = control.closest('.fg')?.querySelector('.field-error');
        if (errorSpan) errorSpan.textContent = '';
      }
    });
    form.addEventListener('change', (event) => {
      const control = event.target;
      if (control.tagName === 'SELECT' && control.classList.contains('field-invalid') && control.value) {
        control.classList.remove('field-invalid');
        control.removeAttribute('aria-invalid');
        const errorSpan = control.closest('.fg')?.querySelector('.field-error');
        if (errorSpan) errorSpan.textContent = '';
      }
    });

    if (form.elements.role && form.elements.position) {
      form.elements.role.addEventListener('change', () => {
        form.elements.position.value = hrPositionForRole(form.elements.role.value);
      });
    }

    enforceNumericInputs(form);
  });
}

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
