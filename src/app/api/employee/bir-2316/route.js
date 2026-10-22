/**
 * The signed-in employee's own BIR Form 2316 (scenario AC-11, 2026-10-22),
 * for a finished calendar year only: the year's payslips are all in by then.
 *
 *   GET                         the years there is one for
 *   GET ?year=YYYY&format=pdf   that year's 2316
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { build2316Pdf } from "@/lib/payroll/bir-2316-pdf";
import { birYears, loadBirYear } from "@/lib/payroll/bir-forms";
import { manilaDateKey } from "@/lib/payroll/periods";

export async function GET(request) {
  const guard = await requirePermission(request, "payslips", "read");
  if (guard.denied) return guard.denied;
  try {
    const supabase = getAdminClient();
    const thisYear = Number(manilaDateKey().slice(0, 4));
    const url = new URL(request.url);
    const yearParam = url.searchParams.get("year");

    if (!yearParam) {
      const years = (await birYears(supabase, { employeeId: guard.userId })).filter((y) => y < thisYear);
      return NextResponse.json({ years, current_year: thisYear });
    }
    const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : 0;
    if (!year || year >= thisYear) {
      return NextResponse.json({ error: "Your BIR 2316 for a year is available once that year has ended.", code: "year_not_finished" }, { status: 400 });
    }
    const data = await loadBirYear(supabase, { year, employeeId: guard.userId });
    if (!data.rows.length) return NextResponse.json({ error: `No paid payslips in ${year}.` }, { status: 404 });

    await appendAuditLog({
      actor: guard, module: "payroll", action: "bir_2316_download", entity_type: "bir_forms", entity_id: String(year),
      description: `Own BIR Form 2316 for ${year} downloaded.`, status: "success", source: "api", metadata: { year },
    });
    return new NextResponse(build2316Pdf(data.rows, { employer: data.employer, year }), {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="BIR-2316-${year}.pdf"`, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
