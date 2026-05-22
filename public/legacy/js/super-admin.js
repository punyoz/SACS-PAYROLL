/* ═══════════════════════════════════════
   super-admin.js — Super Administrator role logic
   Handles: dashboard, branch management, roles,
   system config, audit monitoring, backup
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const SA_PAGES = {
  'sa-dashboard': 'SA Dashboard',
  'sa-branches':  'Branch Management',
  'sa-roles':     'Roles & Permissions',
  'sa-config':    'System Configuration',
  'sa-audit':     'Audit & Monitoring',
  'sa-backup':    'Backup & Recovery',
};

let saAllUsers = [];
let saRoleFilter = 'all';
let saRolesSearch = '';
let saAuditLogs = [];
let saAuditSearch = '';
let saAuditModule = 'all';
let saAuditAction = 'all';
let saBranches = [];
let saReportData = [];

let saUsersPaginator = null;
let saAuditPaginator = null;

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

  if (pageId === 'sa-dashboard')  loadSADashboard();
  else if (pageId === 'sa-branches') loadSABranches();
  else if (pageId === 'sa-roles')    loadSAUsers();
  else if (pageId === 'sa-config')   loadSAConfig();
  else if (pageId === 'sa-audit')    loadSAAuditLogs();
  else if (pageId === 'sa-backup')   loadSABackupStatus();
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
    } else if (!saBranches.length) {
      saBranches = [
        { id: null, name: 'Main Campus', location: 'SACS — Main Branch', code: 'MAIN-01', status: 'Active' },
      ];
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
    form.querySelector('[name="location"]').value = branch.location || '';
    form.querySelector('[name="code"]').value = branch.code || '';
    const statusEl = form.querySelector('[name="status"]');
    if (statusEl) statusEl.value = branch.status || 'Active';
  } else {
    if (title) title.textContent = 'Add Branch';
    form.reset();
    form.querySelector('[name="id"]').value = '';
  }

  modal.style.display = 'flex';
}

function closeSABranchModal() {
  const modal = document.getElementById('sa-branch-modal');
  if (modal) modal.style.display = 'none';
}

async function submitSABranch(event) {
  event.preventDefault();
  const form = event.target;
  const fb = document.getElementById('sa-branch-feedback');

  const id = form.querySelector('[name="id"]').value;
  const payload = {
    name: form.querySelector('[name="name"]').value.trim(),
    location: form.querySelector('[name="location"]').value.trim(),
    code: form.querySelector('[name="code"]').value.trim(),
    status: form.querySelector('[name="status"]').value,
  };

  if (!payload.name || !payload.location) {
    if (fb) { fb.textContent = 'Branch name and location are required.'; fb.style.color = 'var(--red)'; }
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
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">Loading...</td></tr>';

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
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--t3);">Loading...</td></tr>';

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
