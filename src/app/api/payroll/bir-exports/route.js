/**
 * BIR files already generated (payroll_bir_exports, 20261029010000):
 * read-only. The Accountant sees its branch's; the Super Admin, for
 * oversight, every branch's (src/lib/payroll/bir-access.js, decision
 * 2026-10-29). Nothing is computed or generated here: a file is shown as it
 * was generated (TINs read again from the encrypted profiles).
 *
 *   GET ?year=YYYY     the files generated for that tax year (newest first)
 *   GET ?id=…          that file (PDF, Excel or CSV)
 *
 * No POST / PATCH / DELETE: files are generated through /api/payroll/bir-forms
 * (the Accountant only) and never changed or deleted.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { fetchProfilesPii } from "@/lib/employees/pii";
import { describeYearEndError, requireBirReader } from "@/lib/payroll/bir-access";
import { buildBirFile, exportRows } from "@/lib/payroll/bir-exports";
import { manilaDateKey } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_COLUMNS = "id,kind,tax_year,format,scope,branch_id,employee_id,employee_count,totals,generated_by_name,generated_at";

export async function GET(request) {
  const supabase = getAdminClient();
  const guard = await requireBirReader(request, supabase);
  if (guard.denied) return guard.denied;
  try {
    const url = new URL(request.url);
    const scope = guard.birScope;
    const id = url.searchParams.get("id");

    if (id) {
      if (!UUID.test(id)) return NextResponse.json({ error: "No such file." }, { status: 404 });
      let query = supabase.from("payroll_bir_exports").select("*").eq("id", id);
      if (scope.branch_id) query = query.eq("branch_id", scope.branch_id);
      const found = await query.maybeSingle();
      if (found.error) {
        const failure = describeYearEndError(found.error);
        return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
      }
      if (!found.data) return NextResponse.json({ error: "No such file, or not your branch's." }, { status: 404 });
      const stored = found.data;
      const pii = await fetchProfilesPii(supabase, (stored.rows || []).map((r) => r.employee_id));
      const rows = exportRows(stored, new Map([...pii.entries()].map(([key, value]) => [key, value.tin_number])));
      const built = buildBirFile({
        kind: stored.kind, format: stored.format, rows, employer: stored.employer || {}, year: stored.tax_year,
        employeeCode: stored.employee_id ? rows[0]?.employee_code || "employee" : "",
      });
      await appendAuditLog({
        actor: guard, module: "payroll", action: "bir_export_viewed", entity_type: "bir_export", entity_id: stored.id,
        description: `${stored.kind === "alphalist" ? "1604-C alphalist" : "BIR Form 2316"} ${stored.tax_year} (generated ${String(stored.generated_at).slice(0, 10)} by ${stored.generated_by_name || "—"}) viewed${scope.read_only ? " (read-only oversight)" : ""}.`,
        status: "success", source: "api", metadata: { id: stored.id, kind: stored.kind, year: stored.tax_year, read_only: scope.read_only },
      });
      return new NextResponse(built.buffer, {
        status: 200,
        headers: { "Content-Type": built.type, "Content-Disposition": `attachment; filename="${built.name}"`, "Cache-Control": "no-store" },
      });
    }

    const thisYear = Number(manilaDateKey().slice(0, 4));
    const year = /^\d{4}$/.test(url.searchParams.get("year") || "") ? Number(url.searchParams.get("year")) : thisYear;
    let query = supabase.from("payroll_bir_exports").select(LIST_COLUMNS).eq("tax_year", year).order("generated_at", { ascending: false }).limit(500);
    if (scope.branch_id) query = query.eq("branch_id", scope.branch_id);
    const [list, branches] = await Promise.all([query, supabase.from("branches").select("id,name")]);
    if (list.error) {
      const failure = describeYearEndError(list.error);
      return NextResponse.json({ available: false, error: failure.error, year, exports: [] }, { status: failure.status === 503 ? 200 : failure.status });
    }
    const branchName = new Map((branches.data || []).map((b) => [b.id, b.name]));
    return NextResponse.json({
      available: true,
      year,
      read_only: scope.read_only,
      exports: (list.data || []).map((row) => ({
        ...row,
        branch_name: row.scope === "school" ? "All branches" : branchName.get(row.branch_id) || "—",
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
