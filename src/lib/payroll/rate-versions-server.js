import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { can } from "@/lib/rbac/permissions";
import { notify, superAdminIds } from "@/lib/branch-requests-server";
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
 * Effective-dated payroll rates, shared by
 *   /api/admin/payroll-rates   (Super Admin, System Configuration)
 *   /api/payroll/rates         (HR, Government Rates page; alpha test Part E)
 * so both enforce the same rules:
 *
 *   * Who changes what (rateChangeAllowed): government deduction rates need
 *     government_rates "create" (HR, Super Admin); the daily rate needs
 *     pay_rates "create" (HR, Super Admin); every other payroll rule needs
 *     system_configuration "create" (Super Admin). The hourly rate is never
 *     typed (daily ÷ 8). The withholding tax table (fixed by law) is not a
 *     rate here: it stays the Super Admin's (payroll-settings).
 *   * Effective date and reason are required; future pay periods only (from
 *     the next period's first day). A date in a period whose payroll is being
 *     processed is saved with a warning.
 *   * Nobody changes a rate set for themselves: another HR or the Super Admin
 *     does it, and the audit says so (own_rate_blocked / fallback_for).
 *   * Every change is a new effective-dated version (append-only), audited
 *     with the old and new values; the Super Admin is notified when someone
 *     else made it.
 *   * The database checks the same (payroll_rate_writer_guard,
 *     20261109020000).
 *
 * Original notes (Super Admin, System Configuration):
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

/** Which permission a change of this rate needs (null: nobody, e.g. hourly). */
export function rateChangePermission(rateType) {
  if (rateType === "hourly") return null;
  if (GOVERNMENT_RATE_TYPES.includes(rateType)) return "government_rates";
  if (rateType === "daily") return "pay_rates";
  return "system_configuration";
}

/** May this role add a version of this rate? */
export function rateChangeAllowed(role, rateType) {
  const needed = rateChangePermission(rateType);
  return Boolean(needed) && can(role, needed, "create");
}

/** The pay periods whose payroll is being processed (draft / pending runs). */
async function periodsInProcessing(supabase) {
  const result = await supabase.from("payroll_runs").select("period_label,period_start,period_end,status").in("status", ["draft", "pending"]).limit(500);
  return result.error ? [] : result.data || [];
}

/** GET: every version, the value in force, history and the date rules. */
export async function rateVersionsView(guard) {
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
      // Future pay periods only (alpha test Part E).
      min_effective_date: finalized && earliestEffectiveDate(finalized) > upcoming.start_key ? earliestEffectiveDate(finalized) : upcoming.start_key,
      // What this account may change (the page offers Edit only for these).
      can_change: Object.fromEntries(RATE_TYPE_KEYS.map((type) => [type, rateChangeAllowed(guard.role, type)])),
      actor_id: guard.userId || null,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** POST: add one effective-dated version. */
export async function addRateVersion(request, guard) {
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
    // Who may change this rate (alpha test Part E): checked before anything else.
    if (!rateChangeAllowed(guard.role, input.rate_type)) {
      const needed = rateChangePermission(input.rate_type);
      const who = needed === "system_configuration" ? "Only the Super Admin changes this payroll rule." : "Only HR and the Super Admin change government rates and the daily rate.";
      return NextResponse.json({ error: who, code: "forbidden" }, { status: 403 });
    }
    // Every change needs a reason (alpha test Part E; the daily rate since
    // 2026-11-08), kept with the version and in the audit log.
    const reason = normalizeText(body.note);
    if (!reason) {
      return NextResponse.json({ error: input.rate_type === "daily" ? "Give a reason for the daily rate change." : "Give a reason for the rate change.", code: "reason_required" }, { status: 400 });
    }
    if (!input.effective_date) {
      return NextResponse.json({ error: "Choose the date the change takes effect.", code: "effective_date_required" }, { status: 400 });
    }

    const invalid = validateRateInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const government = GOVERNMENT_RATE_TYPES.includes(input.rate_type);

    const supabase = getAdminClient();
    // Nobody changes a rate set for themselves (alpha test Part E): another
    // HR or the Super Admin does it. The refusal is logged.
    if (input.scope === "employee" && input.scope_ref && input.scope_ref === guard.userId) {
      await appendAuditLog({
        actor: guard, module: "config", action: "own_rate_blocked", entity_type: "payroll_rate_config", entity_id: input.rate_type,
        description: `${normalizeText(guard.session?.full_name, guard.session?.email)} tried to change their own ${RATE_TYPES[input.rate_type]?.label || input.rate_type}; refused (another HR or the Super Admin makes it).`,
        status: "failed", source: "api", metadata: { rate_type: input.rate_type, scope: input.scope, requested_effective_date: input.effective_date },
      });
      return NextResponse.json({ error: "You cannot change your own rate. Ask another HR account or the Super Admin to make this change.", code: "own_rate" }, { status: 403 });
    }

    // Future pay periods only: from the next period's first day.
    const upcoming = nextPeriod(manilaDateKey());
    if (input.effective_date < upcoming.start_key) {
      return NextResponse.json({ error: `Rate changes apply to future pay periods only: choose ${upcoming.start_key} or later.`, code: "future_periods_only", min_effective_date: upcoming.start_key }, { status: 400 });
    }

    const [finalized, { configs }, processing] = await Promise.all([latestFinalizedPeriod(supabase), loadRateConfigs(supabase), periodsInProcessing(supabase)]);

    // Only finalized periods are protected; a date in a period nobody has
    // been paid for yet is taken as given.
    let effectiveDate = input.effective_date;
    let warning = null;
    if (finalized && effectiveDate <= finalized.end_key) {
      effectiveDate = earliestEffectiveDate(finalized);
      warning = `${finalized.label} has already been processed, so this change will apply from the next pay period instead, starting ${effectiveDate}.`;
    }

    // A date inside a period whose payroll is already being processed: saved,
    // with a warning (that run keeps the rate it was computed with until it
    // is processed again).
    const busy = processing.find((run) => run.period_start <= effectiveDate && effectiveDate <= run.period_end);
    if (busy && !warning) {
      warning = `${busy.period_label || `${busy.period_start} to ${busy.period_end}`} is being processed now (${busy.status}). Payslips already computed for it keep the old rate until they are processed again.`;
    }

    // Changing the rate set for another HR, Accountant or the Super Admin:
    // the fallback for the own-rate rule, recorded as such.
    let fallbackFor = null;
    if (input.scope === "employee" && input.scope_ref) {
      const target = await supabase.from("profiles").select("id,full_name,role").eq("id", input.scope_ref).maybeSingle();
      if (target.data && ["hr", "super_admin", "accountant"].includes(target.data.role)) fallbackFor = { id: target.data.id, name: target.data.full_name, role: target.data.role };
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
        moved_past_finalized_period: effectiveDate !== input.effective_date,
        in_processing_period: busy ? busy.period_label || busy.period_start : null,
        reason: reason || null,
        changed_by_role: guard.role,
        ...(fallbackFor ? { fallback_for: fallbackFor } : {}),
        ...(hourlyChange ? { hourly: hourlyChange } : {}),
      },
    });

    // Tell the Super Admin when someone else changed a rate. Names and dates
    // only, never an amount (the bell is not a salary channel).
    if (guard.role !== "super_admin") {
      await notify(supabase, await superAdminIds(supabase), {
        kind: "rate_change",
        title: `${label} changed by ${actorName}`,
        body: `A new version takes effect ${effectiveDate}${input.scope === "global" ? "" : ` (${input.scope})`}. Reason: ${reason}. See System Configuration, Rates.`,
        link_page: "sa-config",
      });
    }

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
