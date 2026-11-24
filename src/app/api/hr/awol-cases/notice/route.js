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
import { noticePdf } from "@/lib/awol/notice-pdf";

const UUID = /^[0-9a-f-]{36}$/i;
const longDate = (key) => (key ? new Date(`${String(key).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "read");
    if (guard.denied) return guard.denied;
    // 2026-11-24: a notice that was SENT (awol_notices): its stored PDF, or rendered from the text kept with it.
    // A reply's attachment (2026-11-24): HR and the Super Admin, for the branches they cover.
    const replyFile = new URL(request.url).searchParams.get("reply_file") || "";
    if (replyFile) {
      const supabase = getServiceClient();
      const caseId = replyFile.split("/")[0];
      if (!UUID.test(caseId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const { data: kase } = await supabase.from("employee_awol_cases").select("branch_id").eq("id", caseId).maybeSingle();
      if (!kase) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const foreign = denyForeignBranch(guard, kase.branch_id);
      if (foreign) return foreign;
      const { data } = await supabase.storage.from("awol-replies").download(replyFile);
      if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return new NextResponse(Buffer.from(await data.arrayBuffer()), { status: 200, headers: { "Content-Type": data.type || "application/octet-stream", "Cache-Control": "no-store" } });
    }
    const noticeId = new URL(request.url).searchParams.get("notice") || "";
    if (UUID.test(noticeId)) {
      const supabase = getServiceClient();
      const { data: notice } = await supabase.from("awol_notices").select("id,case_id,kind,title,body,sent_on,pdf_path").eq("id", noticeId).maybeSingle();
      if (!notice) return NextResponse.json({ error: "Notice not found." }, { status: 404 });
      const { data: kase } = await supabase.from("employee_awol_cases").select("branch_id").eq("id", notice.case_id).maybeSingle();
      const foreign = denyForeignBranch(guard, kase?.branch_id);
      if (foreign) return foreign;
      const file = await noticePdf(supabase, notice);
      return new NextResponse(file, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="awol-${notice.kind}-notice-${notice.sent_on}.pdf"`, "Cache-Control": "no-store" } });
    }
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a case." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: row } = await supabase.from("employee_awol_cases").select("*").eq("id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    const foreign = denyForeignBranch(guard, row.branch_id);
    if (foreign) return foreign;
    const [{ data: person }, { data: branch }, { data: tpl }] = await Promise.all([
      supabase.from("profiles").select("full_name,employee_id").eq("id", row.employee_id).maybeSingle(),
      row.branch_id ? supabase.from("branches").select("name").eq("id", row.branch_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("system_config").select("value").eq("section", "hr").eq("key", "awol_first_notice_template").maybeSingle(),
    ]);
    // Prepared, not sent yet: the reply date if HR sends it today.
    const { data: replySetting } = await supabase.from("system_config").select("value").eq("section", "hr").eq("key", "awol_reply_days").maybeSingle();
    const replyDays = Math.max(1, Number(replySetting?.value) || 5);
    const replyBy = row.first_notice_reply_by || new Date(Date.parse(`${manilaDateKey()}T00:00:00Z`) + replyDays * 864e5).toISOString().slice(0, 10);
    const text = fillNotice(tpl?.value || "", {
      employee_name: person?.full_name || "Employee", employee_code: person?.employee_id || "", branch: branch?.name || "",
      first_absent_on: longDate(row.first_absent_on), reply_by: longDate(replyBy), today: longDate(row.first_notice_sent_on || manilaDateKey()),
    });
    const [title, ...rest] = text.split(/\n\s*\n/);
    const file = await renderLetterDocument({ title: title.trim() || "Notice", paragraphs: rest.map((p) => p.trim()).filter(Boolean), footerText: row.first_notice_sent_on ? `AWOL case · 1st notice sent ${longDate(row.first_notice_sent_on)}` : "AWOL case · 1st notice prepared (not sent yet)" });
    return new NextResponse(file, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="awol-first-notice-${(person?.employee_id || "employee").replace(/[^\w-]+/g, "-")}.pdf"`, "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
