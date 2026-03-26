/* ═══════════════════════════════════════
   accountant.js — Accountant role logic
   Handles: page nav, payroll computation,
   draft submission to admin
   Edit this file for accountant features
   ═══════════════════════════════════════ */

'use strict';

/* ── PAGE MAP ── */
const ACCT_PAGES = {
  'ac-process':    'Process Payroll',
  'ac-records':    'Payroll Records',
  'ac-payslips':   'Payslips',
  'ac-attendance': 'View Attendance',
  'ac-pending':    'Pending Submissions',
};

/* ── NAVIGATE ── */
function acctNav(pageId, navEl) {
  Object.keys(ACCT_PAGES).forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById(pageId)?.classList.add('active');

  document.querySelectorAll('#s-accountant .ni').forEach(n => n.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  const titleEl = document.getElementById('ac-tb-title');
  if (titleEl) titleEl.textContent = ACCT_PAGES[pageId] || '';
}

/* ── PAYROLL COMPUTATION ── */
function recalc() {
  // Read form values
  const get = id => parseFloat(document.getElementById(id)?.value || 0);

  const basic       = get('pc-basic');
  const transport   = get('pc-transport');
  const rice        = get('pc-rice');
  const overtime    = get('pc-overtime');
  const bonus       = get('pc-bonus');
  const sss         = get('pc-sss');
  const philhealth  = get('pc-philhealth');
  const pagibig     = get('pc-pagibig');
  const tax         = get('pc-tax');
  const absenceDays = get('pc-absences');
  const cashAdv     = get('pc-cashadvance');

  // Compute absence deduction (daily rate = basic / 22 working days)
  const dailyRate      = basic / 22;
  const absenceDeduct  = dailyRate * absenceDays;
  const grossPay       = basic + transport + rice + overtime + bonus;
  const totalDeductions = sss + philhealth + pagibig + tax + absenceDeduct + cashAdv;
  const netPay         = grossPay - totalDeductions;

  // Update summary display
  const fmt = n => '₱ ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const updates = {
    'sum-basic':       fmt(basic),
    'sum-transport':   fmt(transport),
    'sum-rice':        fmt(rice),
    'sum-overtime':    fmt(overtime),
    'sum-bonus':       fmt(bonus),
    'sum-gross':       fmt(grossPay),
    'sum-sss':         '- ' + fmt(sss),
    'sum-philhealth':  '- ' + fmt(philhealth),
    'sum-pagibig':     '- ' + fmt(pagibig),
    'sum-tax':         '- ' + fmt(tax),
    'sum-absences':    '- ' + fmt(absenceDeduct),
    'sum-cashadvance': '- ' + fmt(cashAdv),
    'sum-net':         fmt(netPay),
  };

  Object.entries(updates).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

/* ── SUBMIT FOR APPROVAL ── */
function submitForApproval() {
  // In production: POST draft to /api/payroll/submit
  // For now: show pending banner and navigate to pending page
  const banner = document.getElementById('ac-pending-banner');
  if (banner) {
    banner.style.display = 'flex';
    banner.innerHTML = '⏳ Your submission for <strong id="pending-name">the selected employee</strong> is pending admin approval.';
  }
  const pendingNavEl = document.querySelector('#s-accountant .ni:last-of-type');
  acctNav('ac-pending', pendingNavEl);
}

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  // Set up live recalc on all payroll input fields
  const inputIds = [
    'pc-basic','pc-transport','pc-rice','pc-overtime','pc-bonus',
    'pc-sss','pc-philhealth','pc-pagibig','pc-tax','pc-absences','pc-cashadvance'
  ];
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalc);
  });
});
