/* ═══════════════════════════════════════
   employee.js — Employee portal logic
   Handles: payslip switching, print
   Edit this file for employee features
   ═══════════════════════════════════════ */

'use strict';

const payslipState = { list: [] };

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

  const topRole = document.getElementById('emp-top-role');
  if (topRole) topRole.textContent = rolePosition || 'Employee';

  const avatar = document.getElementById('emp-avatar');
  if (avatar) avatar.textContent = getInitials(displayName);

  const helloTitle = document.getElementById('emp-hello-title');
  if (helloTitle) helloTitle.textContent = `${displayName} 👋`;

  const helloMeta = document.getElementById('emp-hello-meta');
  if (helloMeta) {
    const pieces = [rolePosition];
    if (staffLabel) pieces.push(staffLabel);
    pieces.push(employeeId || 'N/A');
    helloMeta.textContent = pieces.join(' · ');
  }
}

function formatPhTime(isoString) {
  if (!isoString) return null;
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(isoString)).toUpperCase();
  } catch {
    return null;
  }
}

function renderAttendanceCalendar(records, monthLabel, todayKey) {
  const titleEl = document.getElementById('emp-att-month-title');
  if (titleEl) titleEl.textContent = `My Attendance — ${monthLabel}`;

  const grid = document.getElementById('emp-att-grid');
  if (!grid) return;

  const statusMap = {};
  for (const rec of records) {
    statusMap[rec.date] = rec.status;
  }

  const [year, month] = todayKey.split('-').map(Number);
  const todayDay = Number(todayKey.split('-')[2]);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay();

  let html = '<div class="adh">Su</div><div class="adh">Mo</div><div class="adh">Tu</div>' +
             '<div class="adh">We</div><div class="adh">Th</div><div class="adh">Fr</div><div class="adh">Sa</div>';

  // Spacer cells — truly empty, `em` keeps them invisible
  for (let i = 0; i < firstDayOfWeek; i++) {
    html += '<div class="ad em"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isToday = dateKey === todayKey;
    const isFuture = day > todayDay;
    const status = statusMap[dateKey];

    let cls = 'ad';
    if (status === 'Present') cls += ' pr';
    else if (status === 'Late') cls += ' lt';
    else if (status === 'Absent') cls += ' ab';
    else if (isFuture) cls += ' future';  // upcoming — faded number
    else cls += ' no-rec';               // past with no record — muted number

    if (isToday) cls += ' td';

    html += `<div class="${cls}">${day}</div>`;
  }

  grid.innerHTML = html;
}

function updateTodayLog(today) {
  const timeInEl = document.getElementById('emp-today-timein');
  const timeOutEl = document.getElementById('emp-today-timeout');
  const statusWrap = document.getElementById('emp-today-status-wrap');

  if (!today || !today.time_in) {
    if (timeInEl) { timeInEl.textContent = '— : —'; timeInEl.style.color = 'var(--t3)'; }
    if (timeOutEl) { timeOutEl.textContent = '— : —'; timeOutEl.style.color = 'var(--t3)'; }
    if (statusWrap) statusWrap.innerHTML = '<span class="badge ba"><span class="bd"></span>No data</span>';
    return;
  }

  const timeIn = formatPhTime(today.time_in);
  const timeOut = today.time_out ? formatPhTime(today.time_out) : null;
  const statusLower = String(today.status || '').toLowerCase();

  if (timeInEl) {
    timeInEl.textContent = timeIn || '— : —';
    timeInEl.style.color = timeIn ? 'var(--green)' : 'var(--t3)';
  }
  if (timeOutEl) {
    timeOutEl.textContent = timeOut || '— : —';
    timeOutEl.style.color = timeOut ? 'var(--teal)' : 'var(--t3)';
  }
  if (statusWrap) {
    const badgeCls = statusLower === 'present' ? 'bg' : statusLower === 'late' ? 'ba' : 'br';
    statusWrap.innerHTML = `<span class="badge ${badgeCls}"><span class="bd"></span>${today.status || 'Absent'}</span>`;
  }
}

async function loadEmployeeStats() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const email = String(context?.email || '').trim();
  if (!email) return;

  try {
    const resp = await fetch(`/api/employee/stats?email=${encodeURIComponent(email)}`);
    if (!resp.ok) return;
    const data = await resp.json();

    const presentEl = document.getElementById('emp-stat-present');
    if (presentEl) presentEl.textContent = data.present ?? '—';

    const lateEl = document.getElementById('emp-stat-late');
    if (lateEl) lateEl.textContent = data.late ?? '—';

    const absentEl = document.getElementById('emp-stat-absent');
    if (absentEl) absentEl.textContent = data.absent ?? '—';

    const netpayEl = document.getElementById('emp-stat-netpay');
    if (netpayEl) netpayEl.textContent = data.basic_salary || '—';

    if (data.today_key && data.month_label) {
      renderAttendanceCalendar(data.records || [], data.month_label, data.today_key);
    }
    updateTodayLog(data.today || null);
  } catch {
    // Stats are supplementary — fail silently
  }
}

function handleLegacyAuthContextChange() {
  applyEmployeeIdentity();
  loadMyLeaveRequests();
  loadEmployeeStats();
  loadPayslips();
}

function fmtPeso(amount) {
  const n = Number(amount || 0);
  return '₱ ' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPesoShort(amount) {
  const n = Number(amount || 0);
  return '₱ ' + n.toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

function renderPayslipCard(payslip) {
  const periodLabel = document.getElementById('ps-period-label');
  const psRows = document.getElementById('ps-rows');
  const psNet = document.getElementById('ps-net');
  const psNetLabel = document.getElementById('ps-net-label');
  const psNetAmount = document.getElementById('ps-net-amount');

  if (!psRows) return;

  if (!payslip) {
    if (periodLabel) periodLabel.textContent = 'No payslip available';
    psRows.innerHTML = '<div class="ps-row" style="color:var(--t3);font-style:italic;justify-content:center;padding:16px;">No payslip data available.</div>';
    if (psNet) psNet.style.display = 'none';
    return;
  }

  const issuedDate = payslip.processed_at
    ? new Intl.DateTimeFormat('en-PH', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(payslip.processed_at))
    : '';
  if (periodLabel) periodLabel.textContent = issuedDate ? `${payslip.period_label} · Issued ${issuedDate}` : payslip.period_label;

  let rows = '';
  if (payslip.has_breakdown) {
    rows += `<div class="ps-row"><span>Basic Salary</span><span class="mn">${fmtPeso(payslip.basic_salary)}</span></div>`;
    if (payslip.transportation) rows += `<div class="ps-row"><span>Transportation</span><span class="mn">${fmtPeso(payslip.transportation)}</span></div>`;
    if (payslip.rice) rows += `<div class="ps-row"><span>Rice Allowance</span><span class="mn">${fmtPeso(payslip.rice)}</span></div>`;
    if (payslip.overtime) rows += `<div class="ps-row"><span>Overtime</span><span class="mn">${fmtPeso(payslip.overtime)}</span></div>`;
    if (payslip.bonus) rows += `<div class="ps-row"><span>Bonus</span><span class="mn">${fmtPeso(payslip.bonus)}</span></div>`;
    rows += `<div class="ps-row tot"><span>Gross Pay</span><span class="mn" style="color:var(--teal);">${fmtPeso(payslip.gross_pay)}</span></div>`;
    if (payslip.sss) rows += `<div class="ps-row" style="color:var(--red);"><span>SSS</span><span class="mn">- ${fmtPeso(payslip.sss)}</span></div>`;
    if (payslip.philhealth) rows += `<div class="ps-row" style="color:var(--red);"><span>PhilHealth</span><span class="mn">- ${fmtPeso(payslip.philhealth)}</span></div>`;
    if (payslip.pagibig) rows += `<div class="ps-row" style="color:var(--red);"><span>Pag-IBIG</span><span class="mn">- ${fmtPeso(payslip.pagibig)}</span></div>`;
    if (payslip.withholding_tax) rows += `<div class="ps-row" style="color:var(--red);"><span>Withholding Tax</span><span class="mn">- ${fmtPeso(payslip.withholding_tax)}</span></div>`;
    if (payslip.absence_deduction) rows += `<div class="ps-row" style="color:var(--red);"><span>Absences (${payslip.absences_days}d)</span><span class="mn">- ${fmtPeso(payslip.absence_deduction)}</span></div>`;
    if (payslip.cash_advance) rows += `<div class="ps-row" style="color:var(--red);"><span>Cash Advance</span><span class="mn">- ${fmtPeso(payslip.cash_advance)}</span></div>`;
  } else {
    rows += `<div class="ps-row tot"><span>Gross Pay</span><span class="mn" style="color:var(--teal);">${fmtPeso(payslip.gross_pay)}</span></div>`;
    rows += `<div class="ps-row" style="color:var(--red);"><span>Total Deductions</span><span class="mn">- ${fmtPeso(payslip.total_deductions)}</span></div>`;
  }

  psRows.innerHTML = rows;
  if (psNet) psNet.style.display = '';
  if (psNetLabel) psNetLabel.textContent = `Net Pay — ${payslip.period_label}`;
  if (psNetAmount) psNetAmount.textContent = fmtPeso(payslip.net_pay);
}

function renderPrevPayslips(payslips, startIdx) {
  const container = document.getElementById('emp-prev-payslips');
  if (!container) return;

  if (!payslips.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--t3);">No previous payslips.</div>';
    return;
  }

  container.innerHTML = payslips.map((ps, i) => {
    const globalIdx = startIdx + i;
    const issuedDate = ps.processed_at
      ? new Intl.DateTimeFormat('en-PH', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(ps.processed_at))
      : '';
    return `
      <div class="past-ps-item">
        <div>
          <div class="ppi-name">${ps.period_label}</div>
          ${issuedDate ? `<div class="ppi-date">Issued ${issuedDate}</div>` : ''}
        </div>
        <div class="ppi-right">
          <span class="ppi-amt">${fmtPesoShort(ps.net_pay)}</span>
          <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="viewPayslip(${globalIdx})">View</button>
        </div>
      </div>
    `;
  }).join('');
}

function viewPayslip(idx) {
  const payslip = payslipState.list[idx];
  if (payslip) renderPayslipCard(payslip);
}

async function loadPayslips() {
  const context = window.getLegacyAuthContext ? window.getLegacyAuthContext() : null;
  const email = String(context?.email || '').trim();
  if (!email) return;

  try {
    const resp = await fetch(`/api/employee/payslips?email=${encodeURIComponent(email)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const list = Array.isArray(data.payslips) ? data.payslips : [];
    payslipState.list = list;

    renderPayslipCard(list[0] || null);
    renderPrevPayslips(list.slice(1), 1);
  } catch {
    // fail silently
  }
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

    showLeaveFeedback('Leave request submitted successfully.', false);
    window.pushNotification?.(
      'Leave Request Submitted',
      `${leaveType} · ${startDate} to ${endDate} · Awaiting admin approval.`,
      'success'
    );
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

/* ── INIT ── */
function initEmployeePortal() {
  const currentRole = new URLSearchParams(window.location.search).get('role');
  if (String(currentRole || '').toLowerCase() !== 'employee') {
    return;
  }

  applyEmployeeIdentity();
  loadMyLeaveRequests();
  loadEmployeeStats();
  loadPayslips();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEmployeePortal);
} else {
  initEmployeePortal();
}

window.addEventListener('bncs-auth-context-changed', handleLegacyAuthContextChange);

window.submitLeaveRequest = submitLeaveRequest;
window.submitChangePassword = submitChangePassword;
window.viewPayslip = viewPayslip;
