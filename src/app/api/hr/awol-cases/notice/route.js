/**
 * The AWOL 1st notice as a PDF (Part D, 2026-11-22), from the editable
 * template hr.awol_first_notice_template ({employee_name}, {employee_code},
 * {branch}, {first_absent_on}, {reply_by}, {today}).
 *
 *   GET ?id=<case id>   HR (its branches) and the Super Admin
 */

import { NextResponse } from "next/server";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/api-error";
import { renderLetterDocument } from "@/lib/export/pdf-doc";
import { manilaDateKey } from "@/lib/payroll/periods";
import { fillNotice } from "@/lib/awol/cases";

const UUID = /^[0-9a-f-]{36}$/i;
const longDate = (key) => (key ? new Date(`${String(key).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "read");
    if (guard.denied) return guard.denied;
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a case." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: row } = await supabase.from("employee_awol_cases").select("*").eq("id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    const foreign = denyForeignBranch(guard, row.branch_id);
    if (foreign) return foreign;
    if (!row.first_notice_sent_on) return NextResponse.json({ error: "No 1st notice on this case yet." }, { status: 409 });
    const [{ data: person }, { data: branch }, { data: tpl }] = await Promise.all([
      supabase.from("profiles").select("full_name,employee_id").eq("id", row.employee_id).maybeSingle(),
      row.branch_id ? supabase.from("branches").select("name").eq("id", row.branch_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("system_config").select("value").eq("section", "hr").eq("key", "awol_first_notice_template").maybeSingle(),
    ]);
    const text = fillNotice(tpl?.value || "", {
      employee_name: person?.full_name || "Employee", employee_code: person?.employee_id || "", branch: branch?.name || "",
      first_absent_on: longDate(row.first_absent_on), reply_by: longDate(row.first_notice_reply_by), today: longDate(manilaDateKey()),
    });
    const [title, ...rest] = text.split(/\n\s*\n/);
    const file = await renderLetterDocument({ title: title.trim() || "Notice", paragraphs: rest.map((p) => p.trim()).filter(Boolean), footerText: `AWOL case · 1st notice issued ${longDate(row.first_notice_sent_on)}` });
    return new NextResponse(file, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="awol-first-notice-${(person?.employee_id || "employee").replace(/[^\w-]+/g, "-")}.pdf"`, "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
