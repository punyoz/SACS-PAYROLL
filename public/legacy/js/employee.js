/* ═══════════════════════════════════════
   employee.js — Employee portal logic
   Handles: payslip switching, print
   Edit this file for employee features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAYSLIP DATA ── */
// In production: fetch from /api/payslips?employeeId=...
const PAYSLIP_DATA = {
  'Mar 2026': { basic: 18500, transport: 2000, rice: 1500, overtime: 0, bonus: 0, sss: 800, philhealth: 450, pagibig: 200, tax: 320, absences: 0, cashAdv: 0 },
  'Feb 2026': { basic: 18500, transport: 2000, rice: 1500, overtime: 0, bonus: 0, sss: 800, philhealth: 450, pagibig: 200, tax: 320, absences: 1 * (18500/22), cashAdv: 0 },
  'Jan 2026': { basic: 18500, transport: 2000, rice: 1500, overtime: 500, bonus: 0, sss: 800, philhealth: 450, pagibig: 200, tax: 320, absences: 0, cashAdv: 0 },
};

const leaveState = {
  requests: [],
};

function normalizePortalPosition(positionValue, roleValue) {
  const role = String(roleValue || '').trim().toLowerCase();
  const position = String(positionValue || '').trim().toLowerCase();

  if (role === 'accountant' || position === 'accountant' || position.includes('account')) {
    return 'Accountant';
  }

  return 'Employee';
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'EM';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function applyEmployeeIdentity() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;

  const fullName = String(context?.full_name || '').trim();
  const rolePosition = context ? normalizePortalPosition(context.position, context.role) : 'Employee';
  const employeeType = String(context?.employee_type || '').trim();
  const positionLabel = String(context?.position || '').trim();
  const employeeId = String(context?.employee_id || '').trim();
  const displayName = fullName || rolePosition || 'Employee';

  const staffLabel = employeeType ? `${employeeType} Staff` : positionLabel;

  const topName = document.getElementById('emp-top-name');
  if (topName) topName.textContent = `Welcome, ${displayName}`;

  const avatar = document.getElementById('emp-avatar');
  if (avatar) avatar.textContent = getInitials(displayName);

  const helloTitle = document.getElementById('emp-hello-title');
  if (helloTitle) helloTitle.textContent = `Good morning, ${displayName} 👋`;

  const helloMeta = document.getElementById('emp-hello-meta');
  if (helloMeta) {
    const pieces = [rolePosition];
    if (staffLabel) pieces.push(staffLabel);
    pieces.push(employeeId || 'N/A');
    helloMeta.textContent = pieces.join(' · ');
  }
}

function handleLegacyAuthContextChange() {
  applyEmployeeIdentity();
  loadMyLeaveRequests();
}

function calcNet(data) {
  const gross = data.basic + data.transport + data.rice + data.overtime + data.bonus;
  const deductions = data.sss + data.philhealth + data.pagibig + data.tax + data.absences + data.cashAdv;
  return { gross, deductions, net: gross - deductions };
}

function showLeaveFeedback(message, isError = false) {
  const el = document.getElementById('emp-leave-feedback');
  if (!el) return;

  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

function renderLeaveRequests() {
  const container = document.getElementById('emp-leave-list');
  if (!container) return;

  if (!leaveState.requests.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--t3);">No leave requests submitted yet.</div>';
    return;
  }

  container.innerHTML = leaveState.requests.map((request) => {
    const status = String(request.status || 'pending').toLowerCase();
    const badgeClass = status === 'approved' ? 'bg' : status === 'rejected' ? 'br' : 'ba';
    const submittedAt = request.submitted_at ? new Date(request.submitted_at).toLocaleString('en-PH', {
      month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : 'Unknown date';

    return `
      <div style="border:1px solid var(--border);border-radius:10px;padding:10px 11px;background:var(--bg3);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="font-size:12px;font-weight:600;color:var(--t1);">${request.leave_type}</div>
          <span class="badge ${badgeClass}"><span class="bd"></span>${status}</span>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--t2);">${request.start_date} to ${request.end_date}</div>
        <div style="margin-top:6px;font-size:11px;color:var(--t3);line-height:1.45;">${request.reason}</div>
        <div style="margin-top:7px;font-size:10px;color:var(--t3);">Submitted: ${submittedAt}</div>
      </div>
    `;
  }).join('');
}

async function loadMyLeaveRequests() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const employeeId = String(context?.employee_id || '').trim();
  const fullName = String(context?.full_name || '').trim();

  if (!employeeId && !fullName) {
    leaveState.requests = [];
    renderLeaveRequests();
    return;
  }

  const container = document.getElementById('emp-leave-list');
  if (container && window.skeletonCards) container.innerHTML = window.skeletonCards(3);

  try {
    const params = new URLSearchParams();
    if (employeeId) params.set('employee_id', employeeId);
    if (fullName) params.set('employee_name', fullName);

    const response = await fetch(`/api/employee/leave-requests?${params.toString()}`, { method: 'GET' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load leave requests.');
    }

    leaveState.requests = Array.isArray(payload.requests) ? payload.requests : [];
    renderLeaveRequests();
  } catch (error) {
    showLeaveFeedback(error.message, true);
  }
}

async function submitLeaveRequest() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const employeeId = String(context?.employee_id || '').trim();
  const employeeName = String(context?.full_name || '').trim();
  const position = String(context?.position || '').trim();

  const leaveType = String(document.getElementById('emp-leave-type')?.value || '').trim();
  const startDate = String(document.getElementById('emp-leave-start')?.value || '').trim();
  const endDate = String(document.getElementById('emp-leave-end')?.value || '').trim();
  const reason = String(document.getElementById('emp-leave-reason')?.value || '').trim();
  const proofFile = document.getElementById('emp-leave-proof')?.files?.[0];

  if (!leaveType || !startDate || !endDate || !reason) {
    showLeaveFeedback('Leave type, date range, and reason are required.', true);
    return;
  }

  if (startDate > endDate) {
    showLeaveFeedback('Start date must not be after end date.', true);
    return;
  }

  if (!employeeName) {
    showLeaveFeedback('Unable to resolve employee profile. Please sign in again.', true);
    return;
  }

  try {
    showLeaveFeedback('Submitting leave request...', false);

    let proofUrl = '';
    if (proofFile) {
      if (proofFile.size > 2 * 1024 * 1024) throw new Error('Proof file must be less than 2MB.');
      proofUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(proofFile);
      });
    }

    const response = await fetch('/api/employee/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: employeeId,
        employee_name: employeeName,
        position,
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate,
        reason,
        proof_url: proofUrl,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to submit leave request.');
    }

    document.getElementById('emp-leave-type').value = '';
    document.getElementById('emp-leave-start').value = '';
    document.getElementById('emp-leave-end').value = '';
    document.getElementById('emp-leave-reason').value = '';
    if (document.getElementById('emp-leave-proof')) {
      document.getElementById('emp-leave-proof').value = '';
    }

    showLeaveFeedback('Leave request submitted for admin approval.', false);
    window.pushNotification?.('Leave Request Submitted', 'Your leave request has been submitted and is awaiting admin approval.', 'success');
    await loadMyLeaveRequests();
  } catch (error) {
    showLeaveFeedback(error.message, true);
  }
}

/* ── CHANGE PASSWORD ── */
function showChangePasswordFeedback(message, isError = false) {
  const el = document.getElementById('emp-change-password-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.toggle('ok', !isError && Boolean(message));
}

async function submitChangePassword() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const email = String(context?.email || '').trim();

  const currentPassword = String(document.getElementById('emp-cur-password')?.value || '').trim();
  const newPassword = String(document.getElementById('emp-new-password')?.value || '').trim();
  const confirmPassword = String(document.getElementById('emp-confirm-password')?.value || '').trim();

  if (!email) {
    showChangePasswordFeedback('Unable to identify account. Please sign in again.', true);
    return;
  }

  if (!currentPassword || !newPassword || !confirmPassword) {
    showChangePasswordFeedback('All password fields are required.', true);
    return;
  }

  if (newPassword !== confirmPassword) {
    showChangePasswordFeedback('New passwords do not match.', true);
    return;
  }

  if (newPassword.length < 8) {
    showChangePasswordFeedback('New password must be at least 8 characters.', true);
    return;
  }

  try {
    showChangePasswordFeedback('Updating password...', false);

    const response = await fetch('/api/legacy-auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, current_password: currentPassword, new_password: newPassword }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'Failed to update password.');
    }

    document.getElementById('emp-cur-password').value = '';
    document.getElementById('emp-new-password').value = '';
    document.getElementById('emp-confirm-password').value = '';

    showChangePasswordFeedback('Password updated successfully.', false);
    window.pushNotification?.('Password Changed', 'Your account password has been updated successfully.', 'success');
    setTimeout(() => window.closeSettingsModal?.('emp'), 1200);
  } catch (error) {
    showChangePasswordFeedback(error.message, true);
  }
}

/* ── PAYSLIP PRINT ── */
function printPayslip() {
  window.print();
}

/* ── PAST PAYSLIP VIEW ── */
function viewPastPayslip(period) {
  const data = PAYSLIP_DATA[period];
  if (!data) return;
  const { gross, deductions, net } = calcNet(data);

  const fmt = n => '₱ ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Update mini payslip with selected period data
  const headPeriod = document.getElementById('ps-period-label');
  if (headPeriod) headPeriod.textContent = period;

  const netEl = document.getElementById('ps-net-amount');
  if (netEl) netEl.textContent = fmt(net);
}

/* ── INIT ── */
function initEmployeePortal() {
  const currentRole = new URLSearchParams(window.location.search).get('role');
  if (String(currentRole || '').toLowerCase() !== 'employee') {
    return;
  }

  applyEmployeeIdentity();
  loadMyLeaveRequests();

  // Nothing needed on load for employee portal
  // Data is static; replace with fetch() calls in production
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEmployeePortal);
} else {
  initEmployeePortal();
}

window.addEventListener('bncs-auth-context-changed', handleLegacyAuthContextChange);

window.submitLeaveRequest = submitLeaveRequest;
window.submitChangePassword = submitChangePassword;
