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
};

const AVATAR_COLORS = ['#3EC97A', '#F5A623', '#1DB8A0', '#E85555', '#7F77DD'];
let allEmployees = [];
let employeeTypeFilter = 'all';
let employeeSearch = '';
let currentEditingEmployee = null;

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
}

/* ── APPROVAL ACTIONS ── */
function approveChange(employeeId, card) {
  // In production: POST to /api/approvals/{id}/approve
  const badge = card.querySelector('.pending-status');
  if (badge) {
    badge.className = 'badge bg';
    badge.innerHTML = '<span class="bd"></span> Approved';
  }
  const actionsEl = card.querySelector('.approval-card-actions');
  if (actionsEl) {
    actionsEl.innerHTML = '<span class="badge bg" style="padding:8px 16px;">✓ Approved</span>';
  }
  updateApprovalBadge();
}

function rejectChange(employeeId, reason, card) {
  // In production: POST to /api/approvals/{id}/reject with reason
  const actionsEl = card.querySelector('.approval-card-actions');
  if (actionsEl) {
    actionsEl.innerHTML = '<span class="badge br" style="padding:8px 16px;">✕ Rejected</span>';
  }
  updateApprovalBadge();
}

function updateApprovalBadge() {
  // Count remaining pending approvals and update nav badge
  const badges = document.querySelectorAll('#s-admin .nib');
  badges.forEach(b => {
    const current = parseInt(b.textContent) || 0;
    if (current > 0) b.textContent = current - 1;
    if (b.textContent === '0') b.style.display = 'none';
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
    const statusBadgeClass = employee.archived ? 'br' : (employee.rfid_status === 'Pending' ? 'ba' : 'bg');
    const employmentBadgeClass = employee.archived ? 'br' : (employee.employment_status === 'Probationary' ? 'ba' : 'bg');
    const rfidText = employee.archived ? 'Archived' : escapeHtml(employee.rfid_status);
    const statusText = employee.archived ? 'Archived' : escapeHtml(employee.employment_status);
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
    await loadEmployees();
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
    await loadEmployees();

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
    await loadEmployees();
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

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Start on dashboard when admin logs in
  // Called from app.js login() via adminNav
  loadEmployees();
});
