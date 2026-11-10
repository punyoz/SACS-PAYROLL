/**
 * "My Requests" (2026-11-09 Part E): the caller's OWN loans, cash advances,
 * incentives and overload, subsidy requests and 13th month pay, in one call
 * for the tabbed page. Read-only: these are filed and processed by the
 * Accountant and decided by HR; the page only shows where each one stands.
 *
 * Every query is pinned to the session user (guard.userId); /api/me/* is
 * open to HR, Accountant and Employee only (my_account), never Admin or
 * Super Admin. No other person's record can be asked for: there is no id
 * parameter at all.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { compute13thMonthFromEntries } from "@/lib/payroll/thirteenth-month";
import { manilaDateKey } from "@/lib/payroll/periods";

const LIMIT = 200;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "my_account", "read");
    if (guard.denied) return guard.denied;
    const me = guard.userId;
    const supabase = getServiceClient();
    const [loans, advances, incentives, subsidy, thirteenth] = await Promise.all([
      supabase.from("payroll_loans").select("id,loan_type,description,date_granted,principal,interest_amount,total_payable,number_of_payrolls,amortization,start_period,remaining_balance,status,approval_status,decided_by_name,decided_at,decision_note,created_at")
        .eq("employee_id", me).order("created_at", { ascending: false }).limit(LIMIT),
      supabase.from("payroll_cash_advances").select("id,date_granted,principal,installment_amount,deduct_on,start_date,status,description,status_reason,created_at")
        .eq("employee_id", me).order("created_at", { ascending: false }).limit(LIMIT),
      supabase.from("payroll_monthly_incentives").select("id,item_date,kind,description,amount,hours,archived,approval_status,decided_by_name,decided_at,decision_note,created_at")
        .eq("employee_id", me).eq("archived", false).order("item_date", { ascending: false }).limit(LIMIT),
      supabase.from("payroll_subsidy_requests").select("id,kind,status,amount,reason,requested_at,processed_by_name,processed_at,decided_by_name,decided_at,decision_note,applied_at")
        .eq("employee_id", me).order("requested_at", { ascending: false }).limit(LIMIT),
      supabase.from("payroll_thirteenth_month").select("id,year,basic_earned,amount,processed_by_name,processed_at,breakdown")
        .eq("employee_id", me).order("year", { ascending: false }).limit(LIMIT),
    ]);
    const list = (result) => (result.error ? [] : result.data || []);
    // The projected 13th month (2026-11-09 item 6): this year's paid payslips so
    // far, through the same formula as the December run; never a processed figure.
    const today = manilaDateKey();
    const year = Number(today.slice(0, 4));
    const own = await supabase.from("payroll_entries").select("pay_period,status,payroll").eq("employee_id", me).eq("status", "paid").like("pay_period", `%, ${year}`);
    const computed = compute13thMonthFromEntries(own.data || [], year);
    const processedThisYear = list(thirteenth).find((row) => Number(row.year) === year) || null;
    const projected = processedThisYear ? null : {
      year, amount: computed.amount, basic_earned: computed.total_basic_earned, payslips: computed.periods.length,
      opens: `${year}-12-01`, label: "Projected, not yet processed",
    };
    // Cash advances are also kept as loans of type cash_advance (20261009020000).
    const allLoans = list(loans);
    return NextResponse.json({
      loans: allLoans.filter((row) => row.loan_type !== "cash_advance"),
      cash_advances: [...allLoans.filter((row) => row.loan_type === "cash_advance"), ...list(advances).map((row) => ({ ...row, legacy: true }))],
      incentives: list(incentives),
      subsidy: list(subsidy),
      thirteenth_month: list(thirteenth).map((row) => ({ ...row, label: row.breakdown?.label || (row.breakdown?.final_pay ? "Paid in Final Pay" : "Processed"), pay_date: row.breakdown?.pay_date || null, breakdown: undefined })),
      thirteenth_projected: projected,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
