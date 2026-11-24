/**
 * AWOL settings (Part D, 2026-11-22; 2026-11-24: fully automatic): the two
 * notice templates and the day settings, in system_config (section hr). HR and
 * the Super Admin edit them; every change is audited.
 *
 *   GET   { text, second_text, fields, days: { flag_days, reply_days, separation_days } }
 *   POST  { text } | { kind: "second", text }      a template (20 to 4000 characters)
 *   POST  { days: { flag_days?, reply_days?, separation_days? } }   whole numbers (flag 3-30, reply 1-30, separation 1-30)
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";

const FIELDS = ["employee_name", "employee_code", "branch", "first_absent_on", "reply_by", "separation_on", "today"];
const TEMPLATE_KEYS = { first: "awol_first_notice_template", second: "awol_second_notice_template" };
const DAY_KEYS = { flag_days: ["awol_flag_days", 3, 30, 5], reply_days: ["awol_reply_days", 1, 30, 5], separation_days: ["awol_separation_days", 1, 30, 3] };

async function save(supabase, key, value, by) {
  const { data: existing } = await supabase.from("system_config").select("id").eq("section", "hr").eq("key", key).maybeSingle();
  const write = existing
    ? await supabase.from("system_config").update({ value, updated_at: new Date().toISOString(), updated_by: by }).eq("id", existing.id)
    : await supabase.from("system_config").insert({ section: "hr", key, value, updated_by: by });
  if (write.error) throw write.error;
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "read");
    if (guard.denied) return guard.denied;
    const keys = [...Object.values(TEMPLATE_KEYS), ...Object.values(DAY_KEYS).map((d) => d[0])];
    const { data } = await getServiceClient().from("system_config").select("key,value,updated_at,updated_by").eq("section", "hr").in("key", keys);
    const row = (k) => (data || []).find((r) => r.key === k);
    const days = Object.fromEntries(Object.entries(DAY_KEYS).map(([name, [key, , , dflt]]) => [name, Number(row(key)?.value) || dflt]));
    return NextResponse.json({
      text: row(TEMPLATE_KEYS.first)?.value || "", second_text: row(TEMPLATE_KEYS.second)?.value || "",
      updated_at: row(TEMPLATE_KEYS.first)?.updated_at || null, updated_by: row(TEMPLATE_KEYS.first)?.updated_by || null,
      fields: FIELDS, days,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "awol_cases", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "hr" && guard.role !== "super_admin") return NextResponse.json({ error: "HR edits the AWOL settings." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const by = guard.session?.full_name || guard.session?.email || guard.role;
    const supabase = getServiceClient();
    if (body.days && typeof body.days === "object") {
      const changed = [];
      for (const [name, [key, min, max]] of Object.entries(DAY_KEYS)) {
        if (body.days[name] === undefined) continue;
        const n = Number(body.days[name]);
        if (!Number.isInteger(n) || n < min || n > max) return NextResponse.json({ error: `${name.replace(/_/g, " ")}: a whole number from ${min} to ${max}.` }, { status: 400 });
        await save(supabase, key, String(n), by);
        changed.push(`${name.replace(/_/g, " ")} ${n}`);
      }
      if (!changed.length) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
      await appendAuditLog({ actor: guard, module: "hr", action: "awol_settings_saved", entity_type: "system_config", entity_id: "hr.awol_days", description: `AWOL settings saved by ${by}: ${changed.join(", ")}.` });
      return NextResponse.json({ ok: true });
    }
    const kind = body.kind === "second" ? "second" : "first";
    const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
    if (text.length < 20 || text.length > 4000) return NextResponse.json({ error: "The template is 20 to 4000 characters." }, { status: 400 });
    await save(supabase, TEMPLATE_KEYS[kind], text, by);
    await appendAuditLog({ actor: guard, module: "hr", action: "awol_notice_template_saved", entity_type: "system_config", entity_id: `hr.${TEMPLATE_KEYS[kind]}`, description: `AWOL ${kind === "second" ? "2nd" : "1st"} notice template saved by ${by}.` });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
