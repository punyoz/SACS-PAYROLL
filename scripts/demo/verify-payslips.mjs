// Hand check of demo payslips (G7: at least 3 per branch). Read-only.
// For October 2026 (the percentage government rates): for each person the
// 2nd-half payslip is recomputed by hand from the stored inputs and compared:
//   SSS EE = 5% of the salary credit; PhilHealth = 2.5% of basic (floor
//   10,000, ceiling 100,000); Pag-IBIG = 2% of basic up to 10,000;
//   withholding tax = TRAIN monthly table on (October gross - contributions),
//   less the tax withheld on the 1st half; net = gross - deductions.
//   node scripts/demo/verify-payslips.mjs [--target=production]
import { chooseTarget, lit } from "./db.mjs";

const db = await chooseTarget(process.argv.slice(2));
const round = (n) => Math.round(n * 100) / 100;
function train(monthly) {
  const bands = [[666667, 183541.8, 0.35], [166667, 33541.8, 0.3], [66667, 8541.8, 0.25], [33333, 1875, 0.2], [20833, 0, 0.15]];
  for (const [over, base, rate] of bands) if (monthly > over) return round(base + (monthly - over) * rate);
  return 0;
}
const people = await db.rows(`select distinct on (b.code, e.employee_id) b.code, e.employee_id, e.employee_name, p.role
  from payroll_entries e join branches b on b.id = e.branch_id join profiles p on p.id = e.employee_id
  where p.is_demo and e.pay_period = 'October 16-31, 2026' and e.status <> 'draft' order by b.code, e.employee_id`);
const pick = [];
for (const code of [...new Set(people.map((p) => p.code))]) pick.push(...people.filter((p) => p.code === code).sort((a, b) => (a.role === "employee") - (b.role === "employee")).slice(0, 3));
let bad = 0;
const lines = [];
for (const person of pick) {
  const [first, second] = await db.rows(`select pay_period, payroll from payroll_entries where employee_id = ${lit(person.employee_id)} and pay_period in ('October 1-15, 2026', 'October 16-31, 2026') order by pay_period`);
  if (!second) continue;
  const p2 = second.payroll; const d = p2.deductions || {}; const t = p2.totals || {};
  const basic = Number(p2.basic_salary);
  const msc = Number(p2.employer_contributions?.rates?.sss_msc || Math.min(35000, Math.max(5000, Math.round(basic / 500) * 500)));
  const sss = round(msc * 0.05);
  const ph = round(Math.min(100000, Math.max(10000, basic)) * 0.025);
  const pi = round(Math.min(10000, basic) * 0.02);
  const gross1 = Number(first?.payroll?.totals?.gross_pay || 0);
  const tax1 = Number(first?.payroll?.deductions?.withholding_tax || 0);
  // Attendance deductions lower taxable pay (loans and cash advances do not).
  const attendance = (tt = {}) => ["absence_deduction", "late_deduction", "undertime_deduction", "half_day_deduction", "leave_without_pay_deduction"].reduce((sum, k) => sum + Number(tt[k] || 0), 0);
  const taxable = gross1 - attendance(first?.payroll?.totals) + Number(t.gross_pay) - attendance(t) - sss - ph - pi;
  const tax = Math.max(0, round(train(taxable) - tax1));
  const otherDeductions = Number(t.total_deductions) - Number(d.sss) - Number(d.philhealth) - Number(d.pagibig) - Number(d.withholding_tax);
  const net = round(Number(t.gross_pay) - Number(t.total_deductions));
  const checks = [["SSS", sss, d.sss], ["PhilHealth", ph, d.philhealth], ["Pag-IBIG", pi, d.pagibig], ["Tax", tax, d.withholding_tax], ["Net", net, t.net_pay]];
  const diffs = checks.filter(([, hand, sys]) => Math.abs(hand - Number(sys)) > 0.05);
  if (diffs.length) bad += 1;
  lines.push(`${person.code} ${person.employee_name.padEnd(36)} basic ${basic.toFixed(2).padStart(9)} gross ${Number(t.gross_pay).toFixed(2).padStart(9)} | `
    + checks.map(([n, hand, sys]) => `${n} ${Number(sys).toFixed(2)}${Math.abs(hand - Number(sys)) > 0.05 ? ` (hand ${hand.toFixed(2)})` : " ✓"}`).join("  ")
    + ` | other deductions ${round(otherDeductions).toFixed(2)}`);
}
console.log(lines.join("\n"));
console.log(`${pick.length} payslips checked by hand, ${bad} with a difference`);
