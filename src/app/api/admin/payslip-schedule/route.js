/**
 * Payslip Schedule (Super Admin → System Configuration → Payroll;
 * docs/payroll-schedule-loans-awol.md §1, §9.1). Effective-dated versions in
 * public.payroll_schedule_settings; the database refuses a change for a
 * period whose generation day has arrived, never edits or deletes a version,
 * and logs who / when / old / new / reason in payroll_setting_changes.
 *
 *   GET                               versions, the next periods' dates, history
 *   POST { action: "preview", ... }   dates the given settings would produce
 *   POST { action: "save", effective_from, first_half_day, second_half_day,
 *          window_days, first_half_rule, non_working_day_rule, note }
 *   first_half_rule: weekend / holiday rule of the 1st half (default next
 *   working day); non_working_day_rule: of the 2nd half (default previous).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey, periodForDateKey } from "@/lib/payroll/periods";
import { createPayslipSchedule, DEFAULT_FIRST_HALF_RULE, NON_WORKING_DAY_RULES } from "@/lib/payroll/schedule";
import { actorName } from "@/lib/payroll/staff";

const NOT_READY = "The payslip schedule is not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";

function nextPeriodStarts(fromKey, count) {
  const starts = [];
  let key = periodForDateKey(fromKey).start_key;
  while (starts.length < count) {
    starts.push(key);
    const [y, m, d] = key.split("-").map(Number);
    key = d === 1 ? `${y}-${String(m).padStart(2, "0")}-16` : (m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`);
  }
  return starts;
}

function preview(schedule, starts) {
  return starts.map((start) => {
    const period = periodForDateKey(start);
    return { ...schedule.forPeriod(start), label: period.label, period_end: period.end_key };
  });
}

function parseInput(body) {
  const day = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
  const input = {
    effective_from: normalizeText(body.effective_from),
    first_half_day: day(body.first_half_day),
    second_half_day: day(body.second_half_day),
    window_days: Number(body.window_days || 5),
    first_half_rule: normalizeText(body.first_half_rule, DEFAULT_FIRST_HALF_RULE),
    non_working_day_rule: normalizeText(body.non_working_day_rule, "previous_working_day"),
    note: normalizeText(body.note).slice(0, 500),
  };
  if (input.first_half_day !== null && !(Number.isInteger(input.first_half_day) && input.first_half_day >= 1 && input.first_half_day <= 15)) return { error: "The 1st-half day is 1 to 15 (blank = the 15th)." };
  if (input.second_half_day !== null && !(Number.isInteger(input.second_half_day) && input.second_half_day >= 16 && input.second_half_day <= 31)) return { error: "The 2nd-half day is 16 to 31 (blank = the month's last day)." };
  if (!(Number.isInteger(input.window_days) && input.window_days >= 1 && input.window_days <= 15)) return { error: "Generation stays open 1 to 15 days." };
  if (!NON_WORKING_DAY_RULES.includes(input.first_half_rule) || !NON_WORKING_DAY_RULES.includes(input.non_working_day_rule)) return { error: "Choose what happens on a weekend or holiday." };
  return { input };
}

async function load(supabase) {
  const [settings, holidays, history] = await Promise.all([
    supabase.from("payroll_schedule_settings").select("*").order("effective_from", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("attendance_holidays").select("holiday_date,day_part,name"),
    supabase.from("payroll_setting_changes").select("*").eq("setting_type", "payslip_schedule").order("changed_at", { ascending: false }),
  ]);
  return { settings, holidays, history };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "system_configuration", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const { settings, holidays, history } = await load(supabase);
    if (settings.error) return NextResponse.json({ available: false, error: NOT_READY });
    const schedule = createPayslipSchedule({ settings: settings.data || [], holidays: holidays.data || [] });
    const today = manilaDateKey();
    const starts = nextPeriodStarts(today, 8);
    const periods = preview(schedule, starts);
    return NextResponse.json({
      available: true,
      today,
      versions: settings.data || [],
      periods,
      // Periods a change may still start from: generation day not reached.
      upcoming: periods.filter((p) => p.generation_date > today).map((p) => ({ value: p.period_start, label: p.label })),
      holidays: (holidays.data || []).filter((h) => (h.day_part || "whole") === "whole"),
      history: history.data || [],
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "system_configuration", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action, "save");
    const parsed = parseInput(body);
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { input } = parsed;
    const supabase = getAdminClient();
    const { settings, holidays } = await load(supabase);
    if (settings.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });

    if (!/^\d{4}-\d{2}-(01|16)$/.test(input.effective_from)) return NextResponse.json({ error: "Choose the first pay period it applies to." }, { status: 400 });
    const draft = { id: "draft", ...input, created_at: "9999-12-31T00:00:00Z" };
    const withDraft = createPayslipSchedule({ settings: [...(settings.data || []), draft], holidays: holidays.data || [] });
    const periods = preview(withDraft, nextPeriodStarts(input.effective_from, 6));
    if (action === "preview") return NextResponse.json({ periods });

    if (input.note.length < 5) return NextResponse.json({ error: "Give the reason for the change (at least 5 characters)." }, { status: 400 });
    const result = await supabase.from("payroll_schedule_settings").insert({
      effective_from: input.effective_from, first_half_day: input.first_half_day, second_half_day: input.second_half_day,
      window_days: input.window_days, first_half_rule: input.first_half_rule, non_working_day_rule: input.non_working_day_rule, note: input.note,
      created_by: guard.userId || null, created_by_name: actorName(guard),
    }).select("id").maybeSingle();
    if (result.error) {
      const code = String(result.error.code || "");
      return NextResponse.json({ error: ["P0001", "23514"].includes(code) ? result.error.message : sanitizeError(result.error) }, { status: ["P0001", "23514"].includes(code) ? 400 : 500 });
    }
    await appendAuditLog({
      actor: guard, module: "system", action: "payslip_schedule_save", entity_type: "payroll_schedule_settings", entity_id: result.data?.id || null,
      status: "success", source: "api",
      description: `Payslip schedule from ${periodForDateKey(input.effective_from).label}: 1st half day ${input.first_half_day ?? 15}, 2nd half day ${input.second_half_day ?? "month end"}, open ${input.window_days} days, weekend/holiday: 1st half ${input.first_half_rule.replaceAll("_", " ")}, 2nd half ${input.non_working_day_rule.replaceAll("_", " ")}. ${input.note}`,
      metadata: input,
    });
    return NextResponse.json({ success: true, periods });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
