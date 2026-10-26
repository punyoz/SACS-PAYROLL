/**
 * Government remittance report for one payroll month (2026-10-26):
 * per employee, the employee share, the employer share (and SSS EC) and the
 * total the school remits to SSS, PhilHealth and Pag-IBIG, plus the
 * withholding tax it remits to the BIR. src/lib/payroll/remittance.js.
 *
 *   GET ?month=YYYY-MM[&format=csv]
 *
 * payroll_records "read": the Accountant (its branch) and HR (every branch).
 * Not the Employee (it sees only its own deductions, on its payslip), not the
 * Admin, and not the Super Admin (no payroll data since the 2026-10-20 role
 * separation).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { manilaDateKey } from "@/lib/payroll/periods";
import { monthInfo } from "@/lib/payroll/semi-monthly";
import { REMITTANCE_COLUMNS, buildRemittance } from "@/lib/payroll/remittance";

function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(request) {
  const guard = await requirePermission(request, "payroll_records", "read");
  if (guard.denied) return guard.denied;
  try {
    const url = new URL(request.url);
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : manilaDateKey().slice(0, 7);
    const info = monthInfo(month);
    const supabase = getAdminClient();
    const branchId = guard.branchExempt ? null : (guard.branchId || "00000000-0000-0000-0000-000000000000");

    const [entries, branches] = await Promise.all([
      fetchAllRows(() => {
        let query = supabase.from("payroll_entries")
          .select("id,employee_id,employee_name,employee_code,branch_id,pay_period,status,payslip_no,payroll")
          .in("pay_period", [info.first_half_label, info.second_half_label])
          .order("id", { ascending: true });
        if (branchId) query = query.eq("branch_id", branchId);
        return query;
      }),
      supabase.from("branches").select("id,name"),
    ]);
    if (entries.error) throw new Error(entries.error.message);
    const report = buildRemittance(entries.data || [], new Map((branches.data || []).map((b) => [b.id, b.name])));

    if (String(url.searchParams.get("format") || "").toLowerCase() === "csv") {
      const head = ["Employee", "Employee ID", "Branch", "Status", ...REMITTANCE_COLUMNS.map(([, label]) => label), "Employer share recorded"];
      const lines = [
        head,
        ...report.rows.map((row) => [row.employee_name, row.employee_code, row.branch_name, row.status, ...REMITTANCE_COLUMNS.map(([key]) => row[key].toFixed(2)), row.employer_recorded ? "Yes" : "No — check by hand"]),
        ["TOTAL", "", "", "", ...REMITTANCE_COLUMNS.map(([key]) => report.totals[key].toFixed(2)), ""],
      ];
      return new NextResponse(`${lines.map((line) => line.map(csvCell).join(",")).join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="remittance-${month}.csv"`, "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json({ month, label: info.label, ...report });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
