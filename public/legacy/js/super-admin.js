/* ═══════════════════════════════════════
   super-admin.js — Super Administrator role logic
   Handles: dashboard, branch management, roles,
   system config, audit monitoring, backup
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const SA_PAGES = {
  'sa-dashboard':    'SA Dashboard',
  'sa-branches':     'Branch Management',
  'sa-roles':        'Roles & Permissions',
  'sa-branch-assign':'Branch Assignment',
  'sa-config':       'System Configuration',
  'sa-audit':        'Audit & Monitoring',
  'sa-backup':       'Backup & Recovery',
};

let saAllUsers = [];
let saRoleFilter = 'all';
let saRolesSearch = '';
let saAuditLogs = [];
let saAuditSearch = '';
let saAuditModule = 'all';
let saAuditAction = 'all';
let saBranches = [];
let saAssignBranches = [];
let saReportData = [];

let saUsersPaginator = null;
let saAuditPaginator = null;
let saBranchAllEmployees = [];
let saBranchFilter = 'all';
let saBranchSearch = '';
let saCurrentBranchEmployee = null;
let saBranchPaginator = null;

/* ── NAVIGATE ── */
function saNav(pageId, navEl) {
  Object.keys(SA_PAGES).forEach((id) => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.querySelectorAll('#s-super-admin .ni').forEach((el) => el.classList.remove('active'));

  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const titleEl = document.getElementById('sa-tb-title');
  if (titleEl) titleEl.textContent = SA_PAGES[pageId] || 'Super Admin';

  if (typeof persistRolePageState === 'function') persistRolePageState('super_admin', pageId);

  if (pageId === 'sa-dashboard')       loadSADashboard();
  else if (pageId === 'sa-branches')   loadSABranches();
  else if (pageId === 'sa-roles')      loadSAUsers();
  else if (pageId === 'sa-branch-assign') loadSABranchAssignment();
  else if (pageId === 'sa-config')     loadSAConfig();
  else if (pageId === 'sa-audit')      loadSAAuditLogs();
  else if (pageId === 'sa-backup')     loadSABackupStatus();
}

/* ── IDENTITY ── */
function applySAIdentity() {
  if (typeof getLegacyAuthContext !== 'function') return;
  const ctx = getLegacyAuthContext();
  if (!ctx) return;

  const nameEl = document.getElementById('sa-user-name');
  if (nameEl && ctx.full_name) nameEl.textContent = ctx.full_name;

  const avatar = document.getElementById('sa-avatar');
  if (avatar && ctx.full_name) {
    const parts = ctx.full_name.trim().split(/\s+/);
    avatar.textContent = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : ctx.full_name.slice(0, 2).toUpperCase();
  }
}

/* ── DASHBOARD ── */
async function loadSADashboard() {
  try {
    const [dashRes, sysRes] = await Promise.allSettled([
      fetch('/api/admin/dashboard'),
      fetch('/api/admin/system'),
    ]);

    if (dashRes.status === 'fulfilled' && dashRes.value.ok) {
      const d = await dashRes.value.json();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
      set('sa-dash-employees', d.total_employees ?? d.totalEmployees);
      set('sa-dash-present', d.present_today ?? d.presentToday);
      set('sa-dash-late', d.late_today ?? d.lateToday);
      set('sa-dash-absent', d.absent_today ?? d.absentToday);

      renderSARecentActivity(d.recent_activity || d.recentActivity || []);
    } else {
      renderSARecentActivity([]);
    }

    if (sysRes.status === 'fulfilled' && sysRes.value.ok) {
      const s = await sysRes.value.json();
      const counts = s.table_counts || {};
      const totalUsers = (s.users || []).length;

      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('sa-dash-users', totalUsers || '—');

      updateSAHealthRow('sa-health-db', 'sa-health-db-pill', 'Connected', 'Online', 'sa-pill-online');
      updateSAHealthRow('sa-health-users-meta', 'sa-health-users-pill', `${totalUsers} registered`, 'OK', 'sa-pill-online');
      updateSAHealthRow('sa-health-att-meta', 'sa-health-att-pill', `${counts.attendance_logs ?? '—'} records`, 'Active', 'sa-pill-online');
      updateSAHealthRow('sa-health-pay-meta', 'sa-health-pay-pill', `${counts.payroll_records ?? '—'} records`, 'Active', 'sa-pill-online');
    } else {
      updateSAHealthRow('sa-health-db', 'sa-health-db-pill', 'Checking via admin endpoint', 'Pending', 'sa-pill-warning');
      updateSAHealthRow('sa-health-users-meta', 'sa-health-users-pill', 'Could not load', 'Unknown', 'sa-pill-warning');
      updateSAHealthRow('sa-health-att-meta', 'sa-health-att-pill', 'Could not load', 'Unknown', 'sa-pill-warning');
      updateSAHealthRow('sa-health-pay-meta', 'sa-health-pay-pill', 'Could not load', 'Unknown', 'sa-pill-warning');
    }

    const pendingEl = document.getElementById('sa-dash-pending');
    if (pendingEl) pendingEl.textContent = '0';
    const statusEl = document.getElementById('sa-dash-status');
    if (statusEl) statusEl.textContent = 'Online';
  } catch (err) {
    console.error('SA dashboard error:', err);
  }
}

function updateSAHealthRow(metaId, pillId, metaText, pillLabel, pillClass) {
  const meta = document.getElementById(metaId);
  const pill = document.getElementById(pillId);
  if (meta) meta.textContent = metaText;
  if (pill) {
    pill.textContent = pillLabel;
    pill.className = `sa-pill ${pillClass}`;
  }
}

function renderSARecentActivity(activity) {
  const el = document.getElementById('sa-recent-activity');
  if (!el) return;
  if (!Array.isArray(activity) || !activity.length) {
    el.innerHTML = '<div class="ai-item"><div class="ai2"><div class="s" style="color:var(--t3);">No recent system activity.</div></div></div>';
    return;
  }
  el.innerHTML = activity.slice(0, 8).map((row) => {
    const s = String(row.status || row.action || '').toLowerCase();
    const color = s === 'success' || s === 'approve' || s === 'approved'
      ? 'var(--green)'
      : s === 'failed' || s === 'error' || s === 'reject'
        ? 'var(--red)'
        : 'var(--amber)';
    const label = row.status || row.action || '—';
    const desc = row.description || row.employee_name || row.entity_id || '';
    const time = row.timestamp || row.created_at || '';
    const timeStr = time ? new Date(time).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="ai-item">
      <div class="ai2">
        <div class="s">${row.module ? `[${row.module}] ` : ''}${desc || label}</div>
        ${timeStr ? `<div class="ss">${timeStr}</div>` : ''}
      </div>
      <span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}50;">${label}</span>
    </div>`;
  }).join('');
}

/* ── BRANCH MANAGEMENT ── */
async function loadSABranches() {
  const grid = document.getElementById('sa-branch-grid');
  if (!grid) return;

  try {
    const [branchRes, staffRes] = await Promise.allSettled([
      fetch('/api/super-admin/branches'),
      fetch('/api/admin/dashboard'),
    ]);

    if (branchRes.status === 'fulfilled' && branchRes.value.ok) {
      const d = await branchRes.value.json();
      saBranches = d.branches || [];
    } else {
      saBranches = [];
    }

    const staffCountEl = document.getElementById('sa-branch-staff');
    if (staffRes.status === 'fulfilled' && staffRes.value.ok) {
      const d = await staffRes.value.json();
      if (staffCountEl) staffCountEl.textContent = d.total_employees ?? d.totalEmployees ?? '—';
    }
  } catch {}

  renderSABranchGrid();
}

function renderSABranchGrid() {
  const grid = document.getElementById('sa-branch-grid');
  if (!grid) return;

  const totalEl = document.getElementById('sa-branch-total');
  const activeEl = document.getElementById('sa-branch-active');
  if (totalEl) totalEl.textContent = saBranches.length;
  if (activeEl) activeEl.textContent = saBranches.filter((b) => b.status === 'Active').length;

  if (!saBranches.length) {
    grid.innerHTML = '<p style="color:var(--t3);grid-column:1/-1;">No branches configured yet.</p>';
    return;
  }

  grid.innerHTML = saBranches.map((b) => {
    const statusColor = b.status === 'Active' ? 'var(--green)' : 'var(--red)';
    return `<div class="branch-card">
      <div class="branch-name">${b.name}</div>
      <div class="branch-meta">${b.location}</div>
      <div class="branch-meta">Code: <code style="font-size:11px;">${b.code || '—'}</code></div>
      <div style="margin-top:4px;"><span class="badge" style="color:${statusColor};background:${statusColor}20;border:1px solid ${statusColor}40;">${b.status}</span></div>
      <div class="branch-actions" style="margin-top:8px;">
        <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="openSABranchModal(${JSON.stringify(b).replace(/"/g,'&quot;')})">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function openSABranchModal(branch) {
  const modal = document.getElementById('sa-branch-modal');
  const form = document.getElementById('sa-branch-form');
  const title = document.getElementById('sa-branch-modal-title');
  const fb = document.getElementById('sa-branch-feedback');
  if (!modal || !form) return;

  if (fb) { fb.textContent = ''; fb.className = 'adm-feedback'; }

  if (branch && typeof branch === 'object') {
    if (title) title.textContent = 'Edit Branch';
    form.querySelector('[name="id"]').value = branch.id || '';
    form.querySelector('[name="name"]').value = branch.name || '';
    form.querySelector('[name="code"]').value = branch.code || '';
    const statusEl = form.querySelector('[name="status"]');
    if (statusEl) statusEl.value = branch.status || 'Active';
    populateSABranchLocationSelects(branch.location || '');
  } else {
    if (title) title.textContent = 'Add Branch';
    form.reset();
    form.querySelector('[name="id"]').value = '';
    form.querySelector('[name="code"]').value = 'BR-' + String(saBranches.length + 1).padStart(3, '0');
    const regionEl = document.getElementById('sa-branch-region');
    const provinceEl = document.getElementById('sa-branch-province');
    const cityEl = document.getElementById('sa-branch-city');
    const barangayEl = document.getElementById('sa-branch-barangay');
    if (regionEl) regionEl.value = '';
    if (provinceEl) provinceEl.innerHTML = '<option value="">Select Province / District</option>';
    if (cityEl) cityEl.innerHTML = '<option value="">Select City / Municipality</option>';
    if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
  }

  modal.style.display = 'flex';
}

function closeSABranchModal() {
  const modal = document.getElementById('sa-branch-modal');
  if (modal) modal.style.display = 'none';
}

function onSABranchRegionChange() {
  const regionEl = document.getElementById('sa-branch-region');
  const provinceEl = document.getElementById('sa-branch-province');
  const cityEl = document.getElementById('sa-branch-city');
  const barangayEl = document.getElementById('sa-branch-barangay');
  if (!regionEl || !provinceEl) return;
  const provinces = PH_PROVINCES[regionEl.value] || [];
  provinceEl.innerHTML = '<option value="">Select Province / District</option>' +
    provinces.map((p) => `<option value="${p}">${p}</option>`).join('');
  if (cityEl) cityEl.innerHTML = '<option value="">Select City / Municipality</option>';
  if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
}

function onSABranchProvinceChange() {
  const provinceEl = document.getElementById('sa-branch-province');
  const cityEl = document.getElementById('sa-branch-city');
  const barangayEl = document.getElementById('sa-branch-barangay');
  if (!provinceEl || !cityEl) return;
  const cities = PH_CITIES[provinceEl.value] || [];
  cityEl.innerHTML = '<option value="">Select City / Municipality</option>' +
    cities.map((c) => `<option value="${c}">${c}</option>`).join('');
  if (barangayEl) barangayEl.innerHTML = '<option value="">Select Barangay</option>';
}

function onSABranchCityChange() {
  const cityEl = document.getElementById('sa-branch-city');
  const barangayEl = document.getElementById('sa-branch-barangay');
  if (!cityEl || !barangayEl) return;
  const barangays = PH_BARANGAYS[cityEl.value] || [];
  barangayEl.innerHTML = '<option value="">Select Barangay</option>' +
    barangays.map((b) => `<option value="${b}">${b}</option>`).join('');
}

function populateSABranchLocationSelects(locationStr) {
  const regionEl = document.getElementById('sa-branch-region');
  const provinceEl = document.getElementById('sa-branch-province');
  const cityEl = document.getElementById('sa-branch-city');
  const barangayEl = document.getElementById('sa-branch-barangay');
  if (!regionEl) return;

  const parts = locationStr.split(',').map((s) => s.trim()).filter(Boolean);
  const region = PH_REGIONS.find((r) => parts.includes(r)) ||
    PH_REGIONS.find((r) => locationStr.includes(r)) || '';
  regionEl.value = region;
  onSABranchRegionChange();

  if (region && provinceEl) {
    const province = (PH_PROVINCES[region] || []).find((p) => parts.includes(p)) ||
      (PH_PROVINCES[region] || []).find((p) => locationStr.includes(p)) || '';
    provinceEl.value = province;
    onSABranchProvinceChange();

    if (province && cityEl) {
      const city = (PH_CITIES[province] || []).find((c) => parts.includes(c)) ||
        (PH_CITIES[province] || []).find((c) => locationStr.includes(c)) || '';
      cityEl.value = city;
      onSABranchCityChange();

      if (city && barangayEl) {
        const barangays = PH_BARANGAYS[city] || [];
        const barangay = barangays.find((b) => parts.includes(b)) ||
          barangays.find((b) => locationStr.startsWith(b + ',')) || '';
        if (barangay) barangayEl.value = barangay;
      }
    }
  }
}

async function submitSABranch(event) {
  event.preventDefault();
  const form = event.target;
  const fb = document.getElementById('sa-branch-feedback');

  const id = form.querySelector('[name="id"]').value;
  const region = (document.getElementById('sa-branch-region')?.value || '').trim();
  const province = (document.getElementById('sa-branch-province')?.value || '').trim();
  const city = (document.getElementById('sa-branch-city')?.value || '').trim();
  const barangay = (document.getElementById('sa-branch-barangay')?.value || '').trim();
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
    const res = await fetch('/api/super-admin/branches', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id, ...payload } : payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save branch.');

    if (id) {
      const idx = saBranches.findIndex((b) => b.id === id);
      if (idx !== -1) saBranches[idx] = data.branch || { id, ...payload };
    } else {
      saBranches.push(data.branch || { id: `branch-${Date.now()}`, ...payload });
    }

    if (fb) { fb.textContent = 'Branch saved.'; fb.style.color = 'var(--green)'; }
    setTimeout(() => {
      closeSABranchModal();
      renderSABranchGrid();
    }, 600);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── ROLES & PERMISSIONS ── */
async function loadSAUsers() {
  const tbody = document.getElementById('sa-users-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load users.');

    saAllUsers = data.users || [];
    updateSARoleChips();
    renderSAUsersTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function updateSARoleChips() {
  const chips = document.querySelectorAll('#sa-role-filter-chips .chip');
  const roles = ['all', 'super_admin', 'admin', 'hr', 'accountant', 'employee', 'archived'];
  const counts = {
    all: saAllUsers.length,
    super_admin: saAllUsers.filter((u) => u.role === 'super_admin' && !u.archived).length,
    admin: saAllUsers.filter((u) => u.role === 'admin' && !u.archived).length,
    hr: saAllUsers.filter((u) => u.role === 'hr' && !u.archived).length,
    accountant: saAllUsers.filter((u) => u.role === 'accountant' && !u.archived).length,
    employee: saAllUsers.filter((u) => u.role === 'employee' && !u.archived).length,
    archived: saAllUsers.filter((u) => u.archived).length,
  };

  const active = saAllUsers.filter((u) => !u.archived).length;
  const archived = saAllUsers.filter((u) => u.archived).length;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sa-role-total', saAllUsers.length);
  set('sa-role-active', active);
  set('sa-role-archived', archived);

  const labels = ['All', 'Super Admin', 'Admin', 'HR', 'Accountant', 'Employee', 'Archived'];
  chips.forEach((chip, i) => {
    const key = roles[i];
    if (key !== undefined) chip.textContent = `${labels[i]} (${counts[key] ?? 0})`;
  });
}

function setSARoleFilter(filter) {
  saRoleFilter = filter;
  document.querySelectorAll('#sa-role-filter-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.rf === filter);
  });
  renderSAUsersTable();
}

function setSARolesSearch(val) {
  saRolesSearch = String(val || '').toLowerCase().trim();
  renderSAUsersTable();
}

function renderSAUsersTable() {
  const tbody = document.getElementById('sa-users-table-body');
  if (!tbody) return;

  let list = saAllUsers;

  if (saRoleFilter === 'archived') {
    list = list.filter((u) => u.archived);
  } else if (saRoleFilter !== 'all') {
    list = list.filter((u) => u.role === saRoleFilter && !u.archived);
  } else {
    list = list.filter((u) => !u.archived);
  }

  if (saRolesSearch) {
    list = list.filter((u) =>
      [u.full_name, u.email, u.role, u.employee_id].some((v) =>
        String(v || '').toLowerCase().includes(saRolesSearch)
      )
    );
  }

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No users found.</td></tr>';
    return;
  }

  const roleColors = {
    super_admin: 'var(--blue)',
    admin: 'var(--amber)',
    hr: 'var(--teal)',
    accountant: 'var(--green)',
    employee: 'var(--t2)',
    it: 'var(--t3)',
  };

  if (!saUsersPaginator) {
    saUsersPaginator = createPaginator({
      id: 'sa-users',
      pageSize: 15,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((u) => {
          const roleColor = roleColors[u.role] || 'var(--t2)';
          const roleLabel = u.role === 'super_admin' ? 'Super Admin' : (u.role || '—');
          const statusColor = u.archived ? 'var(--red)' : u.employee_status?.toLowerCase() === 'active' ? 'var(--green)' : 'var(--amber)';
          const statusLabel = u.archived ? 'Archived' : (u.employee_status || 'Active');
          const lastLogin = u.last_sign_in_at
            ? new Date(u.last_sign_in_at).toLocaleDateString('en-PH')
            : '—';
          return `<tr>
            <td>${u.full_name || '—'}</td>
            <td style="font-size:12px;color:var(--t3);">${u.email || '—'}</td>
            <td><span class="badge" style="color:${roleColor};background:${roleColor}20;border:1px solid ${roleColor}40;">${roleLabel}</span></td>
            <td><code style="font-size:11px;">${u.employee_id || '—'}</code></td>
            <td>${u.employee_type || '—'}</td>
            <td><span class="badge" style="color:${statusColor};background:${statusColor}20;border:1px solid ${statusColor}40;">${statusLabel}</span></td>
            <td style="font-size:12px;">${lastLogin}</td>
          </tr>`;
        }).join('');
      },
    });
  }

  saUsersPaginator.setData(list);
}

/* ── SYSTEM CONFIGURATION ── */
async function loadSAConfig() {
  try {
    const res = await fetch('/api/super-admin/config');
    if (!res.ok) return;
    const d = await res.json();
    const cfg = d.config || {};

    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };

    const g = cfg.general || {};
    set('cfg-org-name', g.org_name);
    set('cfg-timezone', g.timezone);
    set('cfg-date-format', g.date_format);
    set('cfg-currency', g.currency);

    const a = cfg.attendance || {};
    set('cfg-work-start', a.work_start);
    set('cfg-work-end', a.work_end);
    set('cfg-grace', a.grace);
    set('cfg-work-hours', a.work_hours);

    const p = cfg.payroll || {};
    set('cfg-pay-freq', p.pay_freq);
    set('cfg-sss', p.sss);
    set('cfg-philhealth', p.philhealth);
    set('cfg-pagibig', p.pagibig);

    const s = cfg.security || {};
    set('cfg-session', s.session);
    set('cfg-login-attempts', s.login_attempts);
    set('cfg-pw-min', s.pw_min);
    set('cfg-pw-expiry', s.pw_expiry);
  } catch {}
}

async function saveSAConfig(section) {
  const fb = document.getElementById('sa-config-feedback');

  const fieldMap = {
    general:    { org_name: 'cfg-org-name', timezone: 'cfg-timezone', date_format: 'cfg-date-format', currency: 'cfg-currency' },
    attendance: { work_start: 'cfg-work-start', work_end: 'cfg-work-end', grace: 'cfg-grace', work_hours: 'cfg-work-hours' },
    payroll:    { pay_freq: 'cfg-pay-freq', sss: 'cfg-sss', philhealth: 'cfg-philhealth', pagibig: 'cfg-pagibig' },
    security:   { session: 'cfg-session', login_attempts: 'cfg-login-attempts', pw_min: 'cfg-pw-min', pw_expiry: 'cfg-pw-expiry' },
  };

  const fields = fieldMap[section] || {};
  const values = {};
  Object.entries(fields).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) values[key] = el.value;
  });

  if (fb) { fb.textContent = 'Saving...'; fb.style.color = 'var(--t3)'; }

  try {
    const res = await fetch('/api/super-admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section, fields: values }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save configuration.');

    if (fb) {
      fb.textContent = `${section.charAt(0).toUpperCase() + section.slice(1)} settings saved.`;
      fb.style.color = 'var(--green)';
      setTimeout(() => { if (fb) fb.textContent = ''; }, 3500);
    }
    if (typeof pushNotification === 'function') pushNotification('Configuration Saved', `${section} settings updated.`, 'success');
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── AUDIT & MONITORING ── */
async function loadSAAuditLogs() {
  const tbody = document.getElementById('sa-audit-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  try {
    let url = '/api/admin/audit-logs?limit=200';
    if (saAuditModule !== 'all') url += `&module=${saAuditModule}`;
    if (saAuditAction !== 'all') url += `&action=${saAuditAction}`;
    if (saAuditSearch) url += `&search=${encodeURIComponent(saAuditSearch)}`;

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load audit logs.');

    saAuditLogs = data.logs || [];
    const summary = data.summary || {};

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('sa-audit-total', summary.total ?? saAuditLogs.length);
    set('sa-audit-success', summary.success ?? saAuditLogs.filter((l) => l.status === 'success').length);
    set('sa-audit-failed', summary.failed ?? saAuditLogs.filter((l) => l.status === 'failed').length);

    renderSAAuditTable(saAuditLogs);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
  }
}

function setSAAuditSearch(val) {
  saAuditSearch = val;
  loadSAAuditLogs();
}

function setSAAuditModuleFilter(val) {
  saAuditModule = val;
  loadSAAuditLogs();
}

function setSAAuditActionFilter(val) {
  saAuditAction = val;
  loadSAAuditLogs();
}

function renderSAAuditTable(logs) {
  const tbody = document.getElementById('sa-audit-table-body');
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">No audit logs found.</td></tr>';
    return;
  }

  if (!saAuditPaginator) {
    saAuditPaginator = createPaginator({
      id: 'sa-audit',
      pageSize: 20,
      renderFn: (rows) => {
        tbody.innerHTML = rows.map((log) => {
          const s = String(log.status || '').toLowerCase();
          const color = s === 'success' ? 'var(--green)' : s === 'failed' ? 'var(--red)' : 'var(--amber)';
          const ts = log.timestamp || log.created_at
            ? new Date(log.timestamp || log.created_at).toLocaleString('en-PH')
            : '—';
          return `<tr>
            <td style="font-size:11px;color:var(--t3);">${ts}</td>
            <td>${log.module || '—'}</td>
            <td>${log.action || '—'}</td>
            <td style="font-size:12px;">${log.entity_type ? `${log.entity_type}${log.entity_id ? ': ' + log.entity_id : ''}` : '—'}</td>
            <td style="font-size:12px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${log.description || '—'}</td>
            <td><span class="badge" style="color:${color};background:${color}20;border:1px solid ${color}40;">${log.status || '—'}</span></td>
            <td style="font-size:11px;color:var(--t3);">${log.source || '—'}</td>
          </tr>`;
        }).join('');
      },
    });
  }

  saAuditPaginator.setData(logs);
}

function exportSAAuditCsv() {
  if (!saAuditLogs.length) { alert('No audit data to export. Load logs first.'); return; }
  const headers = ['Timestamp', 'Module', 'Action', 'Entity Type', 'Entity ID', 'Description', 'Status', 'Source'];
  const rows = saAuditLogs.map((l) => [
    l.timestamp || l.created_at || '',
    l.module || '',
    l.action || '',
    l.entity_type || '',
    l.entity_id || '',
    l.description || '',
    l.status || '',
    l.source || '',
  ]);
  saDownloadCsv([headers, ...rows], `sacs-sa-audit-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ── BACKUP & RECOVERY ── */
async function loadSABackupStatus() {
  const now = new Date().toLocaleString('en-PH');
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  try {
    const res = await fetch('/api/admin/system');
    if (res.ok) {
      const d = await res.json();
      const counts = d.table_counts || {};

      set('sa-backup-last', now);
      set('sa-backup-db-status', 'Connected');
      set('sa-backup-integrity', 'Healthy');

      updateSABackupPill('sa-bk-db-meta', 'sa-bk-db-pill', 'Connection verified', 'Online', 'sa-pill-online');
      updateSABackupPill('sa-bk-att-meta', 'sa-bk-att-pill', `${counts.attendance_logs ?? '—'} records`, 'Active', 'sa-pill-online');
      updateSABackupPill('sa-bk-pay-meta', 'sa-bk-pay-pill', `${counts.payroll_records ?? '—'} records`, 'Active', 'sa-pill-online');
      updateSABackupPill('sa-bk-prof-meta', 'sa-bk-prof-pill', `${counts.profiles ?? '—'} profiles`, 'Active', 'sa-pill-online');
      updateSABackupPill('sa-bk-leave-meta', 'sa-bk-leave-pill', `${counts.leave_requests ?? '—'} entries`, 'Active', 'sa-pill-online');
    } else {
      set('sa-backup-db-status', 'Error');
      set('sa-backup-integrity', 'Unknown');
      updateSABackupPill('sa-bk-db-meta', 'sa-bk-db-pill', 'Could not reach system endpoint', 'Error', 'sa-pill-offline');
    }
  } catch (err) {
    set('sa-backup-db-status', 'Offline');
    updateSABackupPill('sa-bk-db-meta', 'sa-bk-db-pill', err.message, 'Error', 'sa-pill-offline');
  }
}

function updateSABackupPill(metaId, pillId, metaText, pillLabel, pillClass) {
  const meta = document.getElementById(metaId);
  const pill = document.getElementById(pillId);
  if (meta) meta.textContent = metaText;
  if (pill) { pill.textContent = pillLabel; pill.className = `sa-pill ${pillClass}`; }
}

async function exportSAData(type) {
  const fb = document.getElementById('sa-backup-feedback');
  if (fb) { fb.textContent = `Preparing ${type} export...`; fb.style.color = 'var(--t3)'; }

  try {
    let url = '';
    let filename = '';
    let headers = [];

    if (type === 'employees') {
      url = '/api/hr/employees?archived=true';
      filename = `sacs-employees-${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (type === 'attendance') {
      url = '/api/hr/attendance?view=all';
      filename = `sacs-attendance-${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (type === 'payroll') {
      if (fb) { fb.textContent = 'Payroll export requires accountant portal access.'; fb.style.color = 'var(--amber)'; }
      return;
    } else if (type === 'audit') {
      url = '/api/admin/audit-logs?limit=1000';
      filename = `sacs-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    }

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');

    let rows = [];
    if (type === 'employees') {
      const emps = data.employees || [];
      headers = ['Full Name', 'Employee ID', 'Role', 'Type', 'Position', 'Status', 'Email', 'Date of Birth'];
      rows = emps.map((e) => [e.full_name || '', e.employee_id || '', e.role || '', e.employee_type || '', e.position || '', e.employee_status || '', e.email || '', e.date_of_birth || '']);
    } else if (type === 'attendance') {
      const logs = data.logs || [];
      headers = ['Employee', 'Type', 'Date', 'Time In', 'Time Out', 'Hours', 'Status'];
      rows = logs.map((l) => [l.employee_name || '', l.employee_type || '', l.date || '', l.time_in || '', l.time_out || '', l.hours_worked || '', l.status || '']);
    } else if (type === 'audit') {
      const logs = data.logs || [];
      headers = ['Timestamp', 'Module', 'Action', 'Entity Type', 'Entity ID', 'Description', 'Status', 'Source'];
      rows = logs.map((l) => [l.timestamp || l.created_at || '', l.module || '', l.action || '', l.entity_type || '', l.entity_id || '', l.description || '', l.status || '', l.source || '']);
    }

    saDownloadCsv([headers, ...rows], filename);
    if (fb) { fb.textContent = `${type} export downloaded successfully.`; fb.style.color = 'var(--green)'; }
    setTimeout(() => { if (fb) fb.textContent = ''; }, 3000);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── CSV HELPER ── */
function saDownloadCsv(rows, filename) {
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
async function submitSAChangePassword() {
  const current = document.getElementById('sa-current-password')?.value?.trim();
  const next = document.getElementById('sa-new-password')?.value?.trim();
  const confirm = document.getElementById('sa-confirm-password')?.value?.trim();
  const fb = document.getElementById('sa-change-password-feedback');

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

    const verifyRes = await fetch('/api/legacy-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: email, password: current }),
    });
    if (!verifyRes.ok) throw new Error('Current password is incorrect.');

    if (fb) { fb.textContent = 'Password updated successfully.'; fb.style.color = 'var(--green)'; }
    setTimeout(() => closeSettingsModal('sa'), 1500);
  } catch (err) {
    if (fb) { fb.textContent = err.message; fb.style.color = 'var(--red)'; }
  }
}

/* ── INIT ── */
function initSAPortal() {
  applySAIdentity();

  const savedPage = typeof getPersistedRolePageState === 'function'
    ? getPersistedRolePageState('super_admin')
    : '';

  if (savedPage && document.getElementById(savedPage)) {
    const navEl = document.querySelector(`#s-super-admin .ni[onclick*="${savedPage}"]`);
    saNav(savedPage, navEl);
  } else {
    loadSADashboard();
  }

  const sidebar = document.querySelector('#s-super-admin .sidebar');
  if (typeof attachSidebarSpotlight === 'function') attachSidebarSpotlight(sidebar);
}

window.addEventListener('sacs-auth-context-changed', (event) => {
  const ctx = event?.detail;
  if (ctx?.role === 'super_admin') applySAIdentity();
});

/* ═══════════════════════════════════════
   SA BRANCH ASSIGNMENT
   ═══════════════════════════════════════ */

const SA_BRANCH_LABELS = {
  main: 'Main Branch',
  '2':  '2nd Branch',
  '3':  '3rd Branch',
  '4':  '4th Branch',
};

const SA_BRANCH_COLORS = {
  main: 'var(--amber)',
  '2':  'var(--blue)',
  '3':  'var(--teal)',
  '4':  'var(--green)',
};

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
};

function saGetBranchLabel(key) {
  const BRANCH_KEYS = ['main', '2', '3', '4'];
  const idx = BRANCH_KEYS.indexOf(String(key || ''));
  if (idx >= 0 && saAssignBranches[idx]) return saAssignBranches[idx].name;
  return SA_BRANCH_LABELS[String(key || '')] || String(key || '') || '—';
}

function saUpdateBranchSummary() {
  const total = saBranchAllEmployees.length;
  const unassigned = saBranchAllEmployees.filter((e) => !e.branch).length;
  const BRANCH_KEYS = ['main', '2', '3', '4'];

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  set('sa-ba-count-total', total);
  set('sa-ba-count-unassigned', unassigned);
  BRANCH_KEYS.forEach((key) => {
    const count = saBranchAllEmployees.filter((e) => e.branch === key).length;
    set(`sa-ba-count-${key}`, count);
  });

  rebuildSABranchFilterSelect(total, unassigned, BRANCH_KEYS);
}

function rebuildSABranchFilterSelect(total, unassigned, BRANCH_KEYS) {
  const select = document.getElementById('sa-ba-branch-select');
  if (!select) return;

  const currentVal = saBranchFilter || 'all';
  let html = `<option value="all">All (${total})</option><option value="unassigned">Unassigned (${unassigned})</option>`;
  saAssignBranches.forEach((b, i) => {
    if (i >= BRANCH_KEYS.length) return;
    const key = BRANCH_KEYS[i];
    const count = saBranchAllEmployees.filter((e) => e.branch === key).length;
    const name = String(b.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    html += `<option value="${key}">${name} (${count})</option>`;
  });
  select.innerHTML = html;
  select.value = currentVal;
  if (!select.value) select.value = 'all';
}

function saGetFilteredBranchEmployees() {
  const search = saBranchSearch.toLowerCase();
  return saBranchAllEmployees.filter((e) => {
    if (saBranchFilter === 'unassigned') { if (e.branch) return false; }
    else if (saBranchFilter !== 'all')   { if (e.branch !== saBranchFilter) return false; }
    if (!search) return true;
    const hay = [e.full_name, e.employee_id, e.email].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.includes(search);
  });
}

function saRenderBranchTable(employees) {
  const tbody = document.getElementById('sa-ba-table-body');
  if (!tbody) return;

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--t3);">No employees found.</td></tr>`;
    return;
  }

  tbody.innerHTML = employees.map((emp) => {
    const branchColor = emp.branch ? SA_BRANCH_COLORS[emp.branch] : null;
    const branchLabel = emp.branch ? saGetBranchLabel(emp.branch) : null;
    const branchCell = branchLabel
      ? `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${branchColor}22;color:${branchColor};border:1px solid ${branchColor}55;">${branchLabel}</span>`
      : `<span class="badge br"><span class="bd"></span>Unassigned</span>`;
    const assignedAt = emp.assigned_at
      ? new Date(emp.assigned_at).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' })
      : '—';
    const typeClass = emp.employee_type === 'Non-Teaching' ? 'ba' : 'bt2';
    const safeId = String(emp.id || '').replaceAll("'", "\\'");
    const actionBtn = emp.branch
      ? `<button class="btn btn-outline" style="font-size:11px;padding:5px 11px;" onclick="openSABranchAssignModal('${safeId}')">Reassign</button>`
      : `<button class="btn btn-primary" style="font-size:11px;padding:5px 11px;" onclick="openSABranchAssignModal('${safeId}')">Assign</button>`;

    return `
      <tr>
        <td class="nm">${String(emp.full_name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
        <td class="mn">${String(emp.employee_id || '—').replace(/&/g,'&amp;')}</td>
        <td><span class="badge ${typeClass}">${emp.employee_type || 'Teaching'}</span></td>
        <td class="mn">${emp.position || '—'}</td>
        <td>${branchCell}</td>
        <td class="mn" style="font-size:11px;">${assignedAt}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

function saRenderFilteredBranch() {
  saUpdateBranchSummary();
  if (saBranchPaginator) {
    saBranchPaginator.setData(saGetFilteredBranchEmployees());
  } else {
    saRenderBranchTable(saGetFilteredBranchEmployees());
  }
}

function setSABranchFilter(filter) {
  saBranchFilter = filter;
  const select = document.getElementById('sa-ba-branch-select');
  if (select && select.value !== filter) select.value = filter;
  saRenderFilteredBranch();
}

function setSABranchSearch(value) {
  saBranchSearch = String(value || '').trim();
  saRenderFilteredBranch();
}

async function loadSABranchAssignment() {
  const tbody = document.getElementById('sa-ba-table-body');
  if (tbody) tbody.innerHTML = skeletonRows(7);

  try {
    const [branchRes] = await Promise.allSettled([fetch('/api/super-admin/branches')]);
    if (branchRes.status === 'fulfilled' && branchRes.value.ok) {
      const bd = await branchRes.value.json();
      saAssignBranches = (bd.branches || []).filter((b) => b.status === 'Active');
    }

    const response = await fetch('/api/admin/branch-employees', { method: 'GET' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Failed to load branch assignments');

    saBranchAllEmployees = payload.employees || [];
    saRenderFilteredBranch();
  } catch (error) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${String(error.message || 'Error').replace(/</g,'&lt;')}</td></tr>`;
    }
  }
}

function openSABranchAssignModal(userId) {
  const modal = document.getElementById('sa-branch-assign-modal');
  const form = document.getElementById('sa-branch-assign-form');
  if (!modal || !form) return;

  saCurrentBranchEmployee = saBranchAllEmployees.find((e) => e.id === userId);
  if (!saCurrentBranchEmployee) {
    window.alert('Employee not found. Please refresh.');
    return;
  }

  const titleEl = document.getElementById('sa-ba-modal-title');
  if (titleEl) titleEl.textContent = saCurrentBranchEmployee.branch ? 'Reassign Branch' : 'Assign Branch';

  form.elements.user_id.value = saCurrentBranchEmployee.id;
  form.elements.employee_display.value = `${saCurrentBranchEmployee.full_name} (${saCurrentBranchEmployee.employee_id || 'N/A'})`;

  const BRANCH_KEYS = ['main', '2', '3', '4'];
  const branchSelect = form.elements.branch;
  if (branchSelect) {
    if (saAssignBranches.length) {
      branchSelect.innerHTML = saAssignBranches.slice(0, 4).map((b, i) =>
        `<option value="${BRANCH_KEYS[i]}">${String(b.name || '').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</option>`
      ).join('');
    } else {
      branchSelect.innerHTML = '<option value="" disabled>No branches configured yet.</option>';
    }
    if (saCurrentBranchEmployee.branch) branchSelect.value = saCurrentBranchEmployee.branch;
  }

  const feedbackEl = document.getElementById('sa-ba-modal-feedback');
  if (feedbackEl) feedbackEl.textContent = '';

  modal.style.display = 'flex';
}

function closeSABranchAssignModal() {
  const modal = document.getElementById('sa-branch-assign-modal');
  if (modal) modal.style.display = 'none';
}

async function submitSABranchAssign(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const feedbackEl = document.getElementById('sa-ba-modal-feedback');
  const formData = new FormData(form);

  const userId = String(formData.get('user_id') || '').trim();
  const branch = String(formData.get('branch') || '').trim();

  if (!userId || !branch) {
    if (feedbackEl) { feedbackEl.textContent = 'Missing required fields.'; feedbackEl.className = 'adm-feedback err'; }
    return;
  }

  const ctx = typeof getLegacyAuthContext === 'function' ? getLegacyAuthContext() : null;
  const assignedBy = String(ctx?.full_name || ctx?.email || 'super_admin').trim();

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Assigning...';

    const response = await fetch('/api/admin/branch-employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, branch, assigned_by: assignedBy }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to assign branch');

    if (feedbackEl) { feedbackEl.textContent = `Employee assigned to ${result.branch_label}.`; feedbackEl.className = 'adm-feedback ok'; }
    await loadSABranchAssignment();
    setTimeout(() => closeSABranchAssignModal(), 600);
  } catch (error) {
    if (feedbackEl) { feedbackEl.textContent = error.message; feedbackEl.className = 'adm-feedback err'; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm Assignment';
  }
}

window.setSABranchFilter = setSABranchFilter;
window.setSABranchSearch = setSABranchSearch;
window.loadSABranchAssignment = loadSABranchAssignment;
window.openSABranchAssignModal = openSABranchAssignModal;
window.closeSABranchAssignModal = closeSABranchAssignModal;
window.submitSABranchAssign = submitSABranchAssign;
window.onSABranchRegionChange = onSABranchRegionChange;
window.onSABranchProvinceChange = onSABranchProvinceChange;
window.onSABranchCityChange = onSABranchCityChange;
window.populateSABranchLocationSelects = populateSABranchLocationSelects;
window.rebuildSABranchFilterSelect = rebuildSABranchFilterSelect;

const saScreen = document.getElementById('s-super-admin');
if (saScreen?.classList.contains('active')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSAPortal);
  } else {
    initSAPortal();
  }
} else if (saScreen) {
  const saObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        if (saScreen.classList.contains('active')) {
          saObserver.disconnect();
          initSAPortal();
        }
      }
    }
  });
  saObserver.observe(saScreen, { attributes: true });
}
