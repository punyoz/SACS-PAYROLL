/**
 * Licensed Teacher Subsidy settings (Super Admin → System Configuration →
 * Payroll; docs/payroll-schedule-loans-awol.md §6.2, §9.2). Versions in
 * public.payroll_subsidy_settings apply from the NEXT subsidy year (the
 * database refuses anything earlier); existing balances keep the amount
 * they were granted under. Every save is logged in payroll_setting_changes.
 *
 *   GET    versions, the current year and its totals, warning days, history
 *   POST   { action: "save", effective_year_start, annual_amount, year_basis,
 *            year_start_month, payout_month, proration, advance_limit,
 *            on_resignation, on_dismissal, tax_treatment, note }
 *          { action: "set_warning_days", days }   license expiry warning (HR)
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey } from "@/lib/payroll/periods";
import { roundPeso } from "@/lib/payroll/money";
import { actorName } from "@/lib/payroll/staff";

const peso = (value) => roundPeso(value);
const NOT_READY = "The teacher subsidy is not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";
const CHOICES = {
  year_basis: ["calendar", "school_year"],
  proration: ["monthly", "none"],
  advance_limit: ["full_year", "earned_to_date"],
  on_resignation: ["prorate", "forfeit"],
  on_dismissal: ["prorate", "forfeit"],
  tax_treatment: ["other_benefit", "taxable", "exempt"],
};

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "system_configuration", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const today = manilaDateKey();
    const [versions, year, history, warning, balances] = await Promise.all([
      supabase.from("payroll_subsidy_settings").select("*").order("effective_year_start", { ascending: false }).order("created_at", { ascending: false }),
      supabase.rpc("payroll_subsidy_year_for", { p_day: today }),
      supabase.from("payroll_setting_changes").select("*").eq("setting_type", "teacher_subsidy").order("changed_at", { ascending: false }),
      supabase.from("system_config").select("value").eq("section", "hr").eq("key", "license_expiry_warning_days").maybeSingle(),
      supabase.from("payroll_subsidy_balances").select("subsidy_year_start,status,entitlement,advances_total,paid_out,remaining"),
    ]);
    if (versions.error) return NextResponse.json({ available: false, error: NOT_READY });
    const current = Array.isArray(year.data) ? year.data[0] : year.data;
    const thisYear = (balances.data || []).filter((b) => current && b.subsidy_year_start === current.year_start);
    return NextResponse.json({
      available: true,
      today,
      versions: versions.data || [],
      current_year: current || null,
      totals: {
        teachers: thisYear.length,
        entitlement: peso(thisYear.reduce((s, b) => s + Number(b.entitlement || 0), 0)),
        advanced: peso(thisYear.reduce((s, b) => s + Number(b.advances_total || 0), 0)),
        to_pay: peso(thisYear.filter((b) => b.status === "open").reduce((s, b) => s + Math.max(0, Number(b.remaining || 0)), 0)),
      },
      warning_days: Number(warning.data?.value) || 60,
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
    const supabase = getAdminClient();

    if (action === "set_warning_days") {
      const days = Number(body.days);
      if (!(Number.isInteger(days) && days >= 1 && days <= 365)) return NextResponse.json({ error: "Warn 1 to 365 days before expiry." }, { status: 400 });
      const result = await supabase.from("system_config").upsert(
        { section: "hr", key: "license_expiry_warning_days", value: String(days), updated_by: actorName(guard) || "Super Admin", updated_at: new Date().toISOString() },
        { onConflict: "section,key" },
      );
      if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 500 });
      await appendAuditLog({ actor: guard, module: "system", action: "license_warning_days", entity_type: "system_config", entity_id: "hr.license_expiry_warning_days",
        status: "success", source: "api", description: `License expiry warning set to ${days} days before expiry.`, metadata: { days } });
      return NextResponse.json({ success: true });
    }

    const input = {
      effective_year_start: normalizeText(body.effective_year_start),
      annual_amount: peso(body.annual_amount),
      year_basis: normalizeText(body.year_basis, "calendar"),
      year_start_month: Number(body.year_start_month || 1),
      payout_month: body.payout_month === "" || body.payout_month === null || body.payout_month === undefined ? null : Number(body.payout_month),
      proration: normalizeText(body.proration, "monthly"),
      advance_limit: normalizeText(body.advance_limit, "full_year"),
      on_resignation: normalizeText(body.on_resignation, "prorate"),
      on_dismissal: normalizeText(body.on_dismissal, "forfeit"),
      tax_treatment: normalizeText(body.tax_treatment, "other_benefit"),
      note: normalizeText(body.note).slice(0, 500),
    };
    if (!(input.annual_amount > 0 && input.annual_amount <= 9999999.99)) return NextResponse.json({ error: "Enter the annual subsidy amount." }, { status: 400 });
    for (const [key, options] of Object.entries(CHOICES)) {
      if (!options.includes(input[key])) return NextResponse.json({ error: `Choose a value for ${key.replaceAll("_", " ")}.` }, { status: 400 });
    }
    if (input.year_basis === "calendar") input.year_start_month = 1;
    if (!(Number.isInteger(input.year_start_month) && input.year_start_month >= 1 && input.year_start_month <= 12)) return NextResponse.json({ error: "Choose the month the school year starts." }, { status: 400 });
    if (input.payout_month !== null && !(Number.isInteger(input.payout_month) && input.payout_month >= 1 && input.payout_month <= 12)) return NextResponse.json({ error: "Choose the payout month." }, { status: 400 });
    if (!/^\d{4}-\d{2}-01$/.test(input.effective_year_start) || Number(input.effective_year_start.slice(5, 7)) !== input.year_start_month) {
      return NextResponse.json({ error: "The first subsidy year must start on the 1st of the year's starting month." }, { status: 400 });
    }
    if (input.note.length < 5) return NextResponse.json({ error: "Give the reason for the change (at least 5 characters)." }, { status: 400 });

    const result = await supabase.from("payroll_subsidy_settings").insert({
      ...input, created_by: guard.userId || null, created_by_name: actorName(guard),
    }).select("id").maybeSingle();
    if (result.error) {
      const code = String(result.error.code || "");
      return NextResponse.json({ error: ["P0001", "23514"].includes(code) ? result.error.message : sanitizeError(result.error) }, { status: ["P0001", "23514"].includes(code) ? 400 : 500 });
    }
    await appendAuditLog({
      actor: guard, module: "system", action: "teacher_subsidy_save", entity_type: "payroll_subsidy_settings", entity_id: result.data?.id || null,
      status: "success", source: "api",
      description: `Licensed teacher subsidy from ${input.effective_year_start}: ${input.annual_amount} a year (${input.year_basis.replace("_", " ")}), tax ${input.tax_treatment.replace("_", " ")}. ${input.note}`,
      metadata: input,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
