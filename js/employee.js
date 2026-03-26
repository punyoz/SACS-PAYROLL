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

function calcNet(data) {
  const gross = data.basic + data.transport + data.rice + data.overtime + data.bonus;
  const deductions = data.sss + data.philhealth + data.pagibig + data.tax + data.absences + data.cashAdv;
  return { gross, deductions, net: gross - deductions };
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
document.addEventListener('DOMContentLoaded', () => {
  // Nothing needed on load for employee portal
  // Data is static; replace with fetch() calls in production
});
