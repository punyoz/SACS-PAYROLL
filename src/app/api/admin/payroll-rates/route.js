import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { can } from "@/lib/rbac/permissions";
import {
  RATE_TYPES,
  GOVERNMENT_RATE_TYPES,
  RATE_TYPE_KEYS,
  branchPayRates,
  derivedHourly,
  derivedHourlyHistory,
  hourlyFromDaily,
  hourlyIsDerived,
  HOURLY_DERIVED_MESSAGE,
  typedHourlyVersions,
  loadRateConfigs,
  rateHistory,
  resolveRate,
  validateRateInput,
  validateRatePair,
} from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { note: [300, "The note"] };

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

    // From LEGAL_RULES_EFFECTIVE the hourly rate is the daily rate ÷ 8, never
    // a stored version: show what payroll uses, and offer no Edit for it.
    const inForce = (type, periodStart) => (type === "hourly" && hourlyIsDerived(periodStart)
      ? derivedHourly(resolveRate(configs, "daily", {}, periodStart))
      : resolveRate(configs, type, {}, periodStart));
    // The hourly rate (2026-11-08): never typed. Its value, its history and
    // its dates all come from the daily rate ÷ 8; the versions typed by hand
    // before are listed apart, each marked with what became of it.
    const rates = RATE_TYPE_KEYS.map((type) => ({
      rate_type: type,
      ...RATE_TYPES[type],
      current: inForce(type, current.start_key),
      next_period: inForce(type, upcoming.start_key),
      history: type === "hourly" ? derivedHourlyHistory(configs, "global") : rateHistory(configs, type, "global"),
      // A daily rate set for one branch / position / employee brings its own hourly (÷ 8).
      overrides: type === "hourly"
        ? configs.filter((c) => c.rate_type === "daily" && c.scope !== "global").map((c) => ({ ...c, rate_type: "hourly", value: hourlyFromDaily(c.value), daily_value: Number(c.value) || 0 }))
        : configs.filter((c) => c.rate_type === type && c.scope !== "global"),
      derived: type === "hourly",
      editable: type !== "hourly",
      ...(type === "hourly" ? { typed_versions: typedHourlyVersions(configs) } : {}),
    }));

    // Salary per day, branch by branch, each with its hourly rate (÷ 8). A
    // branch without its own rate uses the default (global) daily rate, and
    // says so. One branch's rate never reaches another branch.
    const branchDaily = branchPayRates(configs, branchResult.error ? [] : branchResult.data || [], current.start_key, upcoming.start_key);

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
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const input = {
      rate_type: normalizeText(body.rate_type),
      scope: normalizeText(body.scope, "global").toLowerCase(),
      scope_ref: normalizeText(body.scope_ref) || null,
      value: body.value,
      effective_date: normalizeText(body.effective_date),
    };
    if (input.scope === "global") input.scope_ref = null;

    // The hourly rate is never typed (2026-11-08): refused for every caller,
    // here and in the database (20261108030000).
    if (input.rate_type === "hourly") {
      return NextResponse.json({ error: HOURLY_DERIVED_MESSAGE, code: "hourly_rate_derived" }, { status: 400 });
    }
    // A daily rate change needs a reason, kept with the version and in the audit log.
    const reason = normalizeText(body.note);
    if (input.rate_type === "daily" && !reason) {
      return NextResponse.json({ error: "Give a reason for the daily rate change.", code: "reason_required" }, { status: 400 });
    }

    const invalid = validateRateInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    // A government deduction rate needs government_rates "create" as well
    // (the Super Admin only, 2026-10-26); the database checks it again
    // (payroll_rate_writer_guard, 20261026030000).
    const government = GOVERNMENT_RATE_TYPES.includes(input.rate_type);
    if (government && !can(guard.role, "government_rates", "create")) {
      return NextResponse.json({ error: "Only the Super Admin changes government deduction rates." }, { status: 403 });
    }

    const supabase = getAdminClient();
    const finalized = await latestFinalizedPeriod(supabase);
    const { configs } = await loadRateConfigs(supabase);

    // Only finalized periods are protected; a date in a period nobody has
    // been paid for yet is taken as given.
    let effectiveDate = input.effective_date;
    let warning = null;
    if (finalized && effectiveDate <= finalized.end_key) {
      effectiveDate = earliestEffectiveDate(finalized);
      warning = `${finalized.label} has already been processed, so this change will apply from the next pay period instead, starting ${effectiveDate}.`;
    }

    const pairProblem = validateRatePair(configs, { ...input, effective_date: effectiveDate });
    if (pairProblem) return NextResponse.json({ error: pairProblem }, { status: 400 });
    // What this version replaces on its effective date (the audit's old value).
    const who = input.scope === "branch" ? { branchId: input.scope_ref } : input.scope === "employee" ? { employeeId: input.scope_ref } : input.scope === "position" ? { position: input.scope_ref } : {};
    const previous = resolveRate(configs, input.rate_type, who, effectiveDate);
    const previousValue = previous.source === "config" && previous.scope === input.scope ? Number(previous.value) : null;

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
    // A daily change moves the hourly rate with it (÷ 8): both, old and new.
    const isDaily = input.rate_type === "daily";
    const hourlyChange = isDaily ? {
      previous_daily_in_force: Number(previous.value) || 0,
      previous_hourly: hourlyFromDaily(previous.value),
      new_hourly: hourlyFromDaily(input.value),
    } : null;
    await appendAuditLog({
      actor: guard,
      module: "config",
      action: "rate_version",
      entity_type: "payroll_rate_config",
      entity_id: data?.id || input.rate_type,
      description: `${label}: ${previousValue === null ? "(not set)" : previousValue} → ${Number(input.value)} from ${effectiveDate}${input.scope === "global" ? "" : ` (${input.scope}: ${input.scope_ref})`}${hourlyChange ? `; hourly rate (daily ÷ 8): ${hourlyChange.previous_hourly} → ${hourlyChange.new_hourly}` : ""} by ${actorName}${reason ? `. Reason: ${reason}` : ""}.`,
      status: "success",
      source: "api",
      metadata: {
        rate_type: input.rate_type,
        scope: input.scope,
        scope_ref: input.scope_ref,
        value: Number(input.value),
        // Old → new: the version this one replaces from its effective date.
        previous_value: previousValue,
        previous_config_id: previousValue === null ? null : previous.config_id,
        previous_effective_date: previousValue === null ? null : previous.effective_date,
        government,
        requested_effective_date: input.effective_date,
        effective_date: effectiveDate,
        moved_past_finalized_period: Boolean(warning),
        reason: reason || null,
        ...(hourlyChange ? { hourly: hourlyChange } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      config: data,
      requested_effective_date: input.effective_date,
      effective_date: effectiveDate,
      adjusted: effectiveDate !== input.effective_date,
      warning,
      ...(hourlyChange ? { hourly_rate: hourlyChange.new_hourly } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
