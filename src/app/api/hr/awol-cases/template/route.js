/**
 * The AWOL 1st notice template (Part D, 2026-11-22): system_config
 * hr.awol_first_notice_template. HR and the Super Admin edit it.
 *
 *   GET            the template and its fields
 *   POST { text }  save (20 to 4000 characters; audited)
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";

const FIELDS = ["employee_name", "employee_code", "branch", "first_absent_on", "reply_by", "today"];

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "read");
    if (guard.denied) return guard.denied;
    const { data } = await getServiceClient().from("system_config").select("value,updated_at,updated_by").eq("section", "hr").eq("key", "awol_first_notice_template").maybeSingle();
    return NextResponse.json({ text: data?.value || "", updated_at: data?.updated_at || null, updated_by: data?.updated_by || null, fields: FIELDS });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "hr" && guard.role !== "super_admin") return NextResponse.json({ error: "HR edits the notice template." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
    if (text.length < 20 || text.length > 4000) return NextResponse.json({ error: "The template is 20 to 4000 characters." }, { status: 400 });
    const by = guard.session?.full_name || guard.session?.email || guard.role;
    const supabase = getServiceClient();
    const { data: existing } = await supabase.from("system_config").select("id").eq("section", "hr").eq("key", "awol_first_notice_template").maybeSingle();
    const write = existing
      ? await supabase.from("system_config").update({ value: text, updated_at: new Date().toISOString(), updated_by: by }).eq("id", existing.id)
      : await supabase.from("system_config").insert({ section: "hr", key: "awol_first_notice_template", value: text, updated_by: by });
    if (write.error) throw write.error;
    await appendAuditLog({ actor: guard, module: "hr", action: "awol_notice_template_saved", entity_type: "system_config", entity_id: "hr.awol_first_notice_template", description: `AWOL 1st notice template saved by ${by}.` });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
