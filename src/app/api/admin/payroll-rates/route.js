import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import {
  RATE_TYPES,
  RATE_TYPE_KEYS,
  loadRateConfigs,
  rateHistory,
  resolveRate,
  validateRateInput,
} from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";

/**
 * Effective-dated payroll rates (Super Admin, System Configuration).
 *
 *   GET   every version, the value in force now and for the next period,
 *         each rate's history, and the earliest date a new version may take
 *         effect.
 *   POST  { rate_type, scope, scope_ref?, value, effective_date, note? }
 *         adds a new version. Rates are never edited or deleted
 *         (public.payroll_rate_configs is append-only).
 *
 * A pay period is finalized once payroll has been processed for anyone in
 * it. A new version may not start inside (or before) the latest finalized
 * period: it is moved to the next period's first day, and the reply says so.
 * Payroll reads the version in force on a period's first day, so past
 * payslips are never affected.
 */

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The latest pay period anyone has been paid for, or null. */
async function latestFinalizedPeriod(supabase) {
  const result = await supabase
    .from("payroll_entries")
    .select("pay_period")
    .eq("status", "paid")
    .limit(5000);
  if (result.error) throw new Error(result.error.message);

  let latest = null;
  new Set((result.data || []).map((row) => row.pay_period)).forEach((label) => {
    const period = periodFromLabel(label);
    if (period && (!latest || period.end_key > latest.end_key)) latest = period;
  });
  return latest;
}

/** The first date a new version may take effect: after the latest finalized period. */
function earliestEffectiveDate(finalized) {
  return finalized ? nextPeriod(finalized.end_key).start_key : null;
}

export async function GET(request) {
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const [{ configs, available, error }, finalized, branchResult] = await Promise.all([
      loadRateConfigs(supabase),
      latestFinalizedPeriod(supabase),
      supabase.from("branches").select("id,name,status").order("name", { ascending: true }),
    ]);

    const today = manilaDateKey();
    const current = periodForDateKey(today);
    const upcoming = nextPeriod(today);

    const rates = RATE_TYPE_KEYS.map((type) => ({
      rate_type: type,
      ...RATE_TYPES[type],
      current: resolveRate(configs, type, {}, current.start_key),
      next_period: resolveRate(configs, type, {}, upcoming.start_key),
      history: rateHistory(configs, type, "global"),
      overrides: configs.filter((c) => c.rate_type === type && c.scope !== "global"),
    }));

    // Salary per day, branch by branch. A branch without its own rate uses
    // the default (global) daily rate, and says so.
    const branchDaily = (branchResult.error ? [] : branchResult.data || []).map((branch) => ({
      branch_id: branch.id,
      name: branch.name,
      status: branch.status || "Active",
      current: resolveRate(configs, "daily", { branchId: branch.id }, current.start_key),
      next_period: resolveRate(configs, "daily", { branchId: branch.id }, upcoming.start_key),
      history: rateHistory(configs, "daily", "branch", branch.id),
    }));

    return NextResponse.json({
      available,
      branch_daily: branchDaily,
      error: available ? null : "Payroll rates are not set up yet: apply supabase/migrations/20260926020000_payroll_rate_configs.sql.",
      detail: available ? null : sanitizeError(error),
      rates,
      current_period: current,
      next_period: upcoming,
      finalized_period: finalized,
      earliest_effective_date: earliestEffectiveDate(finalized),
      default_effective_date: upcoming.start_key,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "system_configuration", "create");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const input = {
      rate_type: normalizeText(body.rate_type),
      scope: normalizeText(body.scope, "global").toLowerCase(),
      scope_ref: normalizeText(body.scope_ref) || null,
      value: body.value,
      effective_date: normalizeText(body.effective_date),
    };
    if (input.scope === "global") input.scope_ref = null;

    const invalid = validateRateInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const supabase = getAdminClient();
    const finalized = await latestFinalizedPeriod(supabase);

    // Only finalized periods are protected; a date in a period nobody has
    // been paid for yet is taken as given.
    let effectiveDate = input.effective_date;
    let warning = null;
    if (finalized && effectiveDate <= finalized.end_key) {
      effectiveDate = earliestEffectiveDate(finalized);
      warning = `${finalized.label} has already been processed, so this change will apply from the next pay period instead, starting ${effectiveDate}.`;
    }

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const { data, error } = await supabase
      .from("payroll_rate_configs")
      .insert({
        rate_type: input.rate_type,
        scope: input.scope,
        scope_ref: input.scope_ref,
        value: Number(input.value),
        effective_date: effectiveDate,
        note: normalizeText(body.note).slice(0, 300) || null,
        created_by: guard.userId || null,
        created_by_name: actorName || null,
      })
      .select("id,rate_type,scope,scope_ref,value,effective_date,note,created_by_name,created_at")
      .maybeSingle();
    if (error) throw new Error(error.message);

    const label = RATE_TYPES[input.rate_type].label;
    await appendAuditLog({
      module: "config",
      action: "rate_version",
      entity_type: "payroll_rate_config",
      entity_id: data?.id || input.rate_type,
      description: `${label} set to ${Number(input.value)} from ${effectiveDate}${input.scope === "global" ? "" : ` (${input.scope}: ${input.scope_ref})`} by ${actorName}.`,
      status: "success",
      source: "api",
      metadata: {
        rate_type: input.rate_type,
        scope: input.scope,
        scope_ref: input.scope_ref,
        value: Number(input.value),
        requested_effective_date: input.effective_date,
        effective_date: effectiveDate,
        moved_past_finalized_period: Boolean(warning),
      },
    });

    return NextResponse.json({
      success: true,
      config: data,
      requested_effective_date: input.effective_date,
      effective_date: effectiveDate,
      adjusted: effectiveDate !== input.effective_date,
      warning,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
