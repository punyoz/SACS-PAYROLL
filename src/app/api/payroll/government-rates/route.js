/**
 * Government deduction tables, read-only (2026-10-26).
 *
 *   GET  the SSS / PhilHealth / Pag-IBIG rates and limits, the SSS salary
 *        credit table and the withholding tax table: the version in force now
 *        and next period, every version, and every change (who, when,
 *        old → new). src/lib/payroll/government-rates.js.
 *
 * government_rates "read": the Super Admin, the Accountant and HR. Admin and
 * Employee get 403 (an employee sees only its own deductions, on its
 * payslip). There is no write here: the Super Admin changes these in System
 * Configuration (/api/admin/payroll-rates, /api/admin/payroll-settings), and
 * the database refuses anyone else's change (20261026030000).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { buildGovernmentRates } from "@/lib/payroll/government-rates";
import { loadRateConfigs } from "@/lib/payroll/rates";
import { loadSssMscRows } from "@/lib/payroll/sss-msc";
import { manilaDateKey, nextPeriod, periodForDateKey } from "@/lib/payroll/periods";

const TAX_COLUMNS = "id,version_id,effective_date,bracket_over,base_tax,rate_pct,note,created_by_name,created_at";

export async function GET(request) {
  const guard = await requirePermission(request, "government_rates", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const today = manilaDateKey();
    const [rateResult, taxResult, msc] = await Promise.all([
      loadRateConfigs(supabase),
      supabase.from("payroll_tax_brackets").select(TAX_COLUMNS).order("effective_date", { ascending: false }),
      loadSssMscRows(supabase),
    ]);
    if (!rateResult.available || taxResult.error) {
      return NextResponse.json({ available: false, error: "Government rates are not set up yet." });
    }
    return NextResponse.json({
      available: true,
      can_edit: false,
      ...buildGovernmentRates({
        configs: rateResult.configs,
        taxRows: taxResult.data || [],
        mscRows: msc.rows,
        mscAvailable: msc.available,
        current: periodForDateKey(today),
        upcoming: nextPeriod(today),
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** No writes here, for any role: the Super Admin edits in System Configuration. */
function readOnly() {
  return NextResponse.json({ error: "Government rates are read-only here. Only the Super Admin changes them, in System Configuration." }, { status: 405 });
}
export const POST = readOnly;
export const PUT = readOnly;
export const PATCH = readOnly;
export const DELETE = readOnly;
