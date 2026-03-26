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

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Start on dashboard when admin logs in
  // Called from app.js login() via adminNav
});
