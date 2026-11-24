/**
 * The defense's Nov 16–30 recompute (2026-11-26, owner's request; vercel.json crons, the night after Thursday,
 * ~00:30 Manila, after the nightly close). Perfect Attendance and Early Bird count only once the cutoff has
 * closed, so the 2nd-half payslips computed before then must be recomputed before they can be submitted.
 *
 * For every payslip of the period not yet in a run: the Accountant's own Recompute (the payroll route's PATCH
 * "generate" with reprocess + recompute), in this process, as the branch's Accountant. The result is logged.
 *
 * Switch: system_config demo.recompute = {"enabled": true, "period": "November 16-30, 2026", "on": "2026-11-27"}.
 * Runs only on that day (Manila) and once (a done marker is written). GET Authorization: Bearer <CRON_SECRET>.
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { PATCH as payrollPatch } from "@/app/api/accountant/payroll/route";
import { appendAuditLog } from "@/lib/audit/store";
import { getServiceClient } from "@/lib/supabase/admin";
import { createSessionToken } from "@/lib/rbac/session";
import { manilaDateKey } from "@/lib/payroll/periods";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 16) return false;
  const given = Buffer.from(String(request.headers.get("authorization") || ""));
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const supabase = getServiceClient();
  const today = manilaDateKey();
  const { data: cfg } = await supabase.from("system_config").select("value").eq("section", "demo").eq("key", "recompute").maybeSingle();
  let setting = null;
  try { setting = cfg?.value ? JSON.parse(cfg.value) : null; } catch { setting = null; }
  if (!setting?.enabled || !setting.period || setting.on !== today || setting.done_on) return NextResponse.json({ skipped: "not today" });

  const { data: entries } = await supabase.from("payroll_entries").select("employee_id,employee_name").eq("pay_period", setting.period).is("run_id", null);
  const ids = (entries || []).map((e) => e.employee_id);
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,branch_id").in("id", ids) : { data: [] };
  const branchOf = new Map((people || []).map((p) => [p.id, p.branch_id]));
  // The branch's Accountant (an active Accountant login of that branch; the demo approver first).
  const { data: accountants } = await supabase.from("profiles").select("id,full_name,email,branch_id,is_demo").eq("role", "accountant").eq("archived", false);
  const accountantOf = (branchId) => (accountants || []).filter((a) => a.branch_id === branchId).sort((a, b) => Number(b.is_demo) - Number(a.is_demo))[0] || null;
  const origin = new URL(request.url).origin;
  const results = [];
  for (const e of entries || []) {
    const acc = accountantOf(branchOf.get(e.employee_id));
    if (!acc) { results.push({ name: e.employee_name, status: "no accountant" }); continue; }
    const token = createSessionToken({ user_id: acc.id, role: "accountant", branch_id: acc.branch_id, email: acc.email, full_name: acc.full_name, session_id: "cron-recompute" });
    const res = await payrollPatch(new NextRequest(`${origin}/api/accountant/payroll`, {
      method: "PATCH", headers: { cookie: `sacs-session=${encodeURIComponent(token)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", reprocess: true, recompute: true, employee_id: e.employee_id, pay_period: setting.period, confirm_incomplete: true }),
    }));
    results.push({ name: e.employee_name, status: res.status, error: res.status === 200 ? null : (await res.json().catch(() => ({}))).error || null });
  }
  const ok = results.filter((r) => r.status === 200).length;
  await supabase.from("system_config").update({ value: JSON.stringify({ ...setting, done_on: today, recomputed: ok, of: results.length }) }).eq("section", "demo").eq("key", "recompute");
  const failed = results.filter((r) => r.status !== 200);
  await appendAuditLog({ actor: null, module: "payroll", action: "scheduled_recompute", entity_type: "payroll_period", entity_id: setting.period, status: failed.length ? "failed" : "success", source: "system",
    description: `${setting.period} recomputed after the cutoff closed (by System): ${ok} of ${results.length} payslips.${failed.length ? ` Not recomputed: ${failed.map((f) => `${f.name} (${f.error || f.status})`).join("; ").slice(0, 400)}` : ""}` }).catch(() => {});
  return NextResponse.json({ period: setting.period, recomputed: ok, of: results.length, failed });
}
