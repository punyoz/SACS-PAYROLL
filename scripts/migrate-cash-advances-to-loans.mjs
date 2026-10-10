/**
 * Moves active cash advances into Loans (docs/payroll-schedule-loans-awol.md §4,
 * decision 5: one loan system). Run once, after
 * 20261009010000_payslip_schedule_loans_awol_subsidy.sql and BEFORE
 * 20261009030000_cash_advances_read_only.sql locks the old table.
 *
 * For each payroll_cash_advances row that is active or on hold:
 *   repaid  = its lines on Final payslips (payroll_entries.payroll.cash_advances,
 *             the same rule as src/lib/payroll/cash-advance.js)
 *   balance = principal − repaid; skipped when nothing is left
 *   → a payroll_loans row: type cash_advance, 0% interest, same principal,
 *     amortization = installment × 2 when it was deducted from both halves
 *     (loans come off the 16–end payslip only, so the monthly pace stays the
 *     same), capped at the balance; first deduction the next 16–end payslip;
 *     on_hold → suspended; legacy_cash_advance_id links back
 *   → a 'manual' payroll_loan_payments row for what was already repaid, so
 *     the loan's balance equals the old one exactly.
 *
 * Idempotent: an advance already linked by legacy_cash_advance_id is skipped.
 * Dry run by default; pass --apply to write.
 *
 *   node scripts/migrate-cash-advances-to-loans.mjs           # report only
 *   node scripts/migrate-cash-advances-to-loans.mjs --apply   # write
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!projectUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const supabase = createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;

function manilaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

/** This month's 16th if today is on or before it, else next month's. */
function nextSecondHalf(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (d <= 16) return `${y}-${String(m).padStart(2, "0")}-16`;
  const next = new Date(Date.UTC(y, m, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-16`;
}

async function main() {
  const advances = await supabase.from("payroll_cash_advances").select("*").in("status", ["active", "on_hold"]);
  if (advances.error) throw new Error(advances.error.message);
  const linked = await supabase.from("payroll_loans").select("legacy_cash_advance_id").not("legacy_cash_advance_id", "is", null);
  if (linked.error) throw new Error(`payroll_loans not found — apply 20261009010000 first (${linked.error.message})`);
  const done = new Set((linked.data || []).map((row) => row.legacy_cash_advance_id));

  const borrowers = [...new Set((advances.data || []).map((a) => a.employee_id))];
  const entries = borrowers.length
    ? await supabase.from("payroll_entries").select("employee_id,pay_period,status,payroll").eq("status", "paid").in("employee_id", borrowers)
    : { data: [], error: null };
  if (entries.error) throw new Error(entries.error.message);
  const repaid = new Map();
  (entries.data || []).forEach((entry) => {
    (entry.payroll?.cash_advances || []).forEach((line) => {
      const id = String(line.advance_id || "");
      if (id) repaid.set(id, peso((repaid.get(id) || 0) + Number(line.amount || 0)));
    });
  });

  const start = nextSecondHalf(manilaToday());
  let moved = 0;
  for (const advance of advances.data || []) {
    if (done.has(advance.id)) { console.log(`skip   ${advance.id}: already moved`); continue; }
    const already = repaid.get(String(advance.id)) || 0;
    const balance = peso(Number(advance.principal) - already);
    if (balance <= 0) { console.log(`skip   ${advance.id}: fully repaid`); continue; }
    const amortization = Math.min(balance, peso(Number(advance.installment_amount) * (advance.deduct_on === "both" ? 2 : 1)));
    const payrolls = Math.max(1, Math.ceil(balance / amortization));
    console.log(`${APPLY ? "move  " : "would "} ${advance.id}: principal ${advance.principal}, repaid ${already}, balance ${balance}, ${amortization} × ${payrolls} from ${start}${advance.status === "on_hold" ? " (suspended)" : ""}`);
    if (!APPLY) continue;

    const loan = await supabase.from("payroll_loans").insert({
      employee_id: advance.employee_id,
      branch_id: advance.branch_id || null,
      loan_type: "cash_advance",
      description: advance.description || "Cash advance (moved from Cash Advances)",
      date_granted: advance.date_granted,
      principal: peso(advance.principal),
      interest_pct: 0,
      number_of_payrolls: Math.min(120, payrolls + Math.ceil(already / amortization)),
      amortization,
      start_period: start,
      legacy_cash_advance_id: advance.id,
      created_by_name: "System (cash advances → loans)",
    }).select("id").single();
    if (loan.error) throw new Error(`advance ${advance.id}: ${loan.error.message}`);

    if (already > 0) {
      const paid = await supabase.from("payroll_loan_payments").insert({
        loan_id: loan.data.id, employee_id: advance.employee_id, kind: "manual", amount: already, amount_due: already,
        note: "Repaid on payslips before the move to Loans", created_by_name: "System (cash advances → loans)",
      });
      if (paid.error) throw new Error(`advance ${advance.id} repayment: ${paid.error.message}`);
    }
    if (advance.status === "on_hold") {
      const held = await supabase.from("payroll_loans").update({ status: "suspended", status_reason: "On hold in Cash Advances" }).eq("id", loan.data.id);
      if (held.error) throw new Error(`advance ${advance.id} hold: ${held.error.message}`);
    }
    moved += 1;
  }
  console.log(APPLY ? `\nMoved ${moved} cash advance(s) into Loans.` : "\nDry run. Pass --apply to write.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
