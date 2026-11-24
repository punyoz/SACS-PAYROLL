/**
 * The defense's daily taps (2026-11-24, owner's request; vercel.json crons, 17:40 Manila on school days, before
 * the nightly close at 00:05). For every account ON PAYROLL that is Active, holds an active RFID card and has a
 * working day today (its current schedule; no full-day approved leave), the day's two taps go through the RFID
 * terminal route itself (/api/admin/attendance, kiosk session of the configured HR account), as taps the
 * terminal saved during the day: the same card, branch, too-early and duplicate rules, and the nightly close
 * sets the status. Normal day: in 5-25 min before the start, out 0-20 min after the end; about one day in
 * twenty is a late arrival. A half-day leave taps only the worked half.
 *
 * Switch: system_config demo.daily_taps = {"enabled": true, "until": "2026-11-27", "kiosk_account": "<HR id>"}.
 * Off when missing, disabled, or after `until`. GET Authorization: Bearer <CRON_SECRET> (Vercel Cron).
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { POST as terminalTap } from "@/app/api/admin/attendance/route";
import { appendAuditLog } from "@/lib/audit/store";
import { getServiceClient } from "@/lib/supabase/admin";
import { KIOSK_COOKIE, KIOSK_HEADER, createKioskToken } from "@/lib/auth/kiosk-session";
import { manilaDateKey } from "@/lib/payroll/periods";
import { dayTaps, hhmm } from "@/lib/attendance/demo-taps";

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
  const { data: cfg } = await supabase.from("system_config").select("value").eq("section", "demo").eq("key", "daily_taps").maybeSingle();
  let setting = null;
  try { setting = cfg?.value ? JSON.parse(cfg.value) : null; } catch { setting = null; }
  if (!setting?.enabled || (setting.until && today > setting.until) || !setting.kiosk_account) return NextResponse.json({ skipped: "off" });
  const { data: kioskUser } = await supabase.from("profiles").select("id,role,email,full_name,branch_id,archived").eq("id", setting.kiosk_account).maybeSingle();
  if (!kioskUser || kioskUser.archived) return NextResponse.json({ skipped: "no kiosk account" });
  const cookie = `${KIOSK_COOKIE}=${encodeURIComponent(createKioskToken({ user_id: kioskUser.id, role: kioskUser.role, branch_id: kioskUser.role === "hr" ? null : kioskUser.branch_id, email: kioskUser.email, full_name: kioskUser.full_name }))}`;

  const { data: people } = await supabase.from("profiles").select("id,branch_id,full_name,employee_status,role")
    .eq("archived", false).eq("on_payroll", true).eq("employee_status", "Active").in("role", ["employee", "accountant", "hr"]);
  // The terminal route's own handler, in this process (no network: the deployment URL is protected and the
  // project's production domain is not one this app answers on). Same kiosk session, header and rules.
  const origin = new URL(request.url).origin;
  const manilaNow = new Date(Date.now() + 8 * 3600e3);
  const nowMin = manilaNow.getUTCHours() * 60 + manilaNow.getUTCMinutes();
  let firstFailure = null;
  const done = [];
  for (const p of people || []) {
    const { data: card } = await supabase.from("rfid_cards").select("uid").eq("employee_id", p.id).eq("status", "active").maybeSingle();
    if (!card?.uid || !p.branch_id) continue;
    const { data: working } = await supabase.rpc("attendance_is_working_day_for", { p_employee: p.id, p_branch: p.branch_id, p_day: today });
    if (!working) continue;
    const { data: leave } = await supabase.from("leave_requests").select("half_day").eq("employee_id", p.id).eq("status", "approved").lte("start_date", today).gte("end_date", today);
    if ((leave || []).some((l) => !l.half_day)) continue;
    const { count } = await supabase.from("attendance_taps").select("id", { count: "exact", head: true }).eq("employee_id", p.id).eq("log_date", today);
    if ((count || 0) >= 2) continue; // the day already has its time in and time out
    const { data: sched } = await supabase.rpc("attendance_schedule_for", { p_employee: p.id, p_branch: p.branch_id, p_day: today });
    const s = Array.isArray(sched) ? sched[0] : sched;
    if (!s) continue;
    // Two runs a day (2026-11-26): each posts the planned taps already due and not yet recorded, so the
    // morning run records the time in and the evening run the time out (and a late time in it finds missing).
    const planned = dayTaps({ id: p.id, day: today, start: Number(s.work_start), end: Number(s.work_end), half: (leave || [])[0]?.half_day || null });
    const taps = planned.slice(count || 0).filter((t) => t <= nowMin);
    if (!taps.length) continue;
    const results = [];
    for (const t of taps) {
      const res = await terminalTap(new NextRequest(`${origin}/api/admin/attendance`, { method: "POST", headers: { cookie, [KIOSK_HEADER]: "1", "Content-Type": "application/json" },
        body: JSON.stringify({ device: "RFID Terminal", rfid_code: card.uid, offline_tapped_at: `${today}T${hhmm(t)}:00+08:00` }) }));
      results.push(res.status);
      if (res.status !== 200 && !firstFailure) firstFailure = `${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`;
    }
    done.push({ id: p.id, statuses: results });
  }
  await appendAuditLog({ actor: null, module: "attendance", action: "daily_taps", entity_type: "attendance", entity_id: today, status: "success", source: "system",
    description: `Daily taps (defense setting, until ${setting.until}): ${done.length} people, ${done.filter((d) => d.statuses.every((x) => x === 200)).length} recorded in full (by System).${firstFailure ? ` First refusal: ${firstFailure}` : ""}` }).catch(() => {});
  return NextResponse.json({ day: today, people: done.length, ok: done.filter((d) => d.statuses.every((x) => x === 200)).length });
}
