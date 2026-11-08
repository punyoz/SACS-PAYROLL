/**
 * Pay rates, read-only (2026-11-08).
 *
 *   GET  the default daily rate and its hourly rate (always daily ÷ 8), now
 *        and next period, with their history (same dates), and the daily /
 *        hourly rate of each branch ("uses the system default" when the
 *        branch has none of its own).
 *
 * pay_rates "read": HR and the Super Admin see every branch; the Accountant
 * and the branch Admin see only their own branch's row (never another
 * branch's rate). Employees: 403. Nothing is written here, for any role:
 * the Super Admin changes rates in System Configuration
 * (/api/admin/payroll-rates), and the database refuses any typed hourly rate.
 *
 * Note: from Oct 1, 2026 an employee with a salary on file is paid on
 * monthly salary × 12 ÷ working days per year (hourly = that ÷ 8); these
 * values apply to an employee with no salary on file.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { branchPayRates, derivedHourly, derivedHourlyHistory, loadRateConfigs, rateHistory, resolveRate } from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey } from "@/lib/payroll/periods";

export async function GET(request) {
  const guard = await requirePermission(request, "pay_rates", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    let branchQuery = supabase.from("branches").select("id,name,status").order("name", { ascending: true });
    // A branch-scoped reader gets its own branch only.
    if (!guard.branchExempt) branchQuery = branchQuery.eq("id", guard.branchId);
    const [{ configs, available }, branchResult] = await Promise.all([loadRateConfigs(supabase), branchQuery]);
    if (!available) return NextResponse.json({ available: false, error: "Payroll rates are not set up yet." });

    const today = manilaDateKey();
    const current = periodForDateKey(today);
    const upcoming = nextPeriod(today);
    const dailyNow = resolveRate(configs, "daily", {}, current.start_key);
    const dailyNext = resolveRate(configs, "daily", {}, upcoming.start_key);
    return NextResponse.json({
      available: true,
      can_edit: false,
      all_branches: guard.branchExempt,
      current_period: current,
      next_period: upcoming,
      default: {
        daily: { current: dailyNow, next_period: dailyNext, history: rateHistory(configs, "daily", "global") },
        hourly: { current: derivedHourly(dailyNow), next_period: derivedHourly(dailyNext), history: derivedHourlyHistory(configs, "global") },
      },
      branches: branchPayRates(configs, branchResult.error ? [] : branchResult.data || [], current.start_key, upcoming.start_key),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** No writes here, for any role: the Super Admin edits rates in System Configuration. */
function readOnly() {
  return NextResponse.json({ error: "Pay rates are read-only here. Only the Super Admin changes them, in System Configuration." }, { status: 405 });
}
export const POST = readOnly;
export const PUT = readOnly;
export const PATCH = readOnly;
export const DELETE = readOnly;
