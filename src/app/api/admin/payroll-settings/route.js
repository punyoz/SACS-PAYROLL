import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { listUsersCached } from "@/lib/auth/users-cache";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { can } from "@/lib/rbac/permissions";
import { loadRateConfigs, rateValues, resolveRates } from "@/lib/payroll/rates";
import { manilaDateKey, nextPeriod, periodForDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { monthlyContributionsFor } from "@/lib/payroll/school-sheet";
import { resolveTaxTableRows } from "@/lib/payroll/semi-monthly";
import { loadSssMscRows, mscTableOn, mscVersions, validateMscRows } from "@/lib/payroll/sss-msc";
import { roundPeso } from "@/lib/payroll/money";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { CONTRIBUTION_MAX, TAX_AMOUNT_MAX, pesoLimit } from "@/lib/input-limits";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { note: [300, "The note"] };

/**
 * Semi-monthly payroll settings (Super Admin, System Configuration).
 *
 *   GET   the monthly withholding tax table in force and its versions, and
 *         every employee's monthly SSS / PhilHealth / Pag-IBIG: the amounts
 *         set for them, else what payroll uses by default -- the fixed
 *         amounts in Payroll Rates when "Contributions as fixed amounts" is
 *         On (the school's SSS / PhilHealth / Pag-IBIG), else the legal tables.
 *         Also the SSS monthly salary credit table in force and its versions.
 *   POST  { kind: "tax_table", effective_date, rows: [{ bracket_over, base_tax, rate_pct }], note? }
 *         { kind: "sss_msc_table", effective_date, rows: [{ salary_from, msc }], note? }
 *         { kind: "contribution", employee_id, effective_date, sss, philhealth, pagibig, note? }
 *         (a blank amount = the Payroll Rates default above)
 *
 * Both are versions, never overwrites: payroll uses the one in force on the
 * pay period's first day, and a date inside an already-processed period is
 * moved to the next period. The divisor, lock day and overload premium are
 * Payroll Rates (/api/admin/payroll-rates).
 */

const TAX_COLUMNS = "id,version_id,effective_date,bracket_over,base_tax,rate_pct,note,created_by_name,created_at";
const CONTRIBUTION_COLUMNS = "id,employee_id,effective_date,sss,philhealth,pagibig,note,created_by_name,created_at";
const peso = (value) => roundPeso(value);

/** The latest pay period anyone has been paid for, or null. */
async function latestFinalizedPeriod(supabase) {
  const result = await supabase.from("payroll_entries").select("pay_period").eq("status", "paid").limit(5000);
  if (result.error) throw new Error(result.error.message);
  let latest = null;
  new Set((result.data || []).map((row) => row.pay_period)).forEach((label) => {
    const period = periodFromLabel(label);
    if (period && (!latest || period.end_key > latest.end_key)) latest = period;
  });
  return latest;
}

/** A date inside (or before) the latest processed period moves to the next period. */
function protectEffectiveDate(effectiveDate, finalized) {
  if (!finalized || effectiveDate > finalized.end_key) return { effectiveDate, warning: null };
  const moved = nextPeriod(finalized.end_key).start_key;
  return {
    effectiveDate: moved,
    warning: `${finalized.label} has already been processed, so this change will apply from the next pay period instead, starting ${moved}.`,
  };
}

/** Versions of the tax table, newest first. */
function taxVersions(rows) {
  const byVersion = new Map();
  (rows || []).forEach((row) => {
    if (!byVersion.has(row.version_id)) {
      byVersion.set(row.version_id, {
        version_id: row.version_id, effective_date: row.effective_date, note: row.note || null,
        created_by_name: row.created_by_name || null, created_at: row.created_at, rows: [],
      });
    }
    byVersion.get(row.version_id).rows.push({
      bracket_over: Number(row.bracket_over), base_tax: Number(row.base_tax), rate_pct: Number(row.rate_pct),
    });
  });
  return [...byVersion.values()]
    .map((version) => ({ ...version, rows: version.rows.sort((a, b) => a.bracket_over - b.bracket_over) }))
    .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at).localeCompare(String(a.created_at))));
}

function validateTaxRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "Add at least one bracket.";
  if (rows.length > 20) return "A tax table has at most 20 brackets.";
  const parsed = rows.map((row) => ({ over: Number(row.bracket_over), base: Number(row.base_tax), pct: Number(row.rate_pct) }));
  if (parsed.some((r) => ![r.over, r.base, r.pct].every(Number.isFinite) || r.over < 0 || r.base < 0 || r.pct < 0)) return "Every amount must be 0 or more.";
  if (parsed.some((r) => r.pct > 100)) return "A rate cannot be more than 100%.";
  if (parsed.some((r) => r.over > TAX_AMOUNT_MAX || r.base > TAX_AMOUNT_MAX)) return `Every amount must be at most ${pesoLimit(TAX_AMOUNT_MAX)}.`;
  if (parsed[0].over !== 0) return "The first bracket must start at 0.";
  if (parsed.some((r, i) => i > 0 && r.over <= parsed[i - 1].over)) return "Each bracket must start above the one before it.";
  return null;
}

/** " Changed: over 20,833: 15% → 18%; …" — each bracket that differs, for the audit description. */
function describeTaxChange(before, after) {
  const key = (row) => Number(row.bracket_over);
  const show = (row) => (row ? `₱${Number(row.base_tax)} + ${Number(row.rate_pct)}%` : "none");
  const overs = [...new Set([...before.map(key), ...after.map(key)])].sort((a, b) => a - b);
  const changes = overs.map((over) => {
    const old = before.find((row) => key(row) === over);
    const now = after.find((row) => key(row) === over);
    return old && now && Number(old.base_tax) === Number(now.base_tax) && Number(old.rate_pct) === Number(now.rate_pct)
      ? null : `over ₱${over}: ${show(old)} → ${show(now)}`;
  }).filter(Boolean);
  return changes.length ? ` Changed: ${changes.slice(0, 10).join("; ")}${changes.length > 10 ? ` (+${changes.length - 10} more)` : ""}.` : " No bracket changed.";
}

/** Same for the SSS salary credit table. */
function describeMscChange(before, after) {
  const key = (row) => Number(row.salary_from);
  const froms = [...new Set([...before.map(key), ...after.map(key)])].sort((a, b) => a - b);
  const changes = froms.map((from) => {
    const old = before.find((row) => key(row) === from);
    const now = after.find((row) => key(row) === from);
    return old && now && Number(old.msc) === Number(now.msc)
      ? null : `from ₱${from}: ${old ? `₱${Number(old.msc)}` : "none"} → ${now ? `₱${Number(now.msc)}` : "none"}`;
  }).filter(Boolean);
  return changes.length ? ` Changed: ${changes.slice(0, 10).join("; ")}${changes.length > 10 ? ` (+${changes.length - 10} more)` : ""}.` : " No bracket changed.";
}

function validateDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? null : "Choose the date the change takes effect.";
}

/** Payroll employees (Employee / Accountant accounts, not archived). */
async function listPayrollEmployees(supabase) {
  const [usersResult, profiles, branches] = await Promise.all([
    listUsersCached(supabase),
    supabase.from("profiles").select("id,full_name,branch_id"),
    supabase.from("branches").select("id,name"),
  ]);
  if (usersResult.error) throw new Error(usersResult.error.message);
  const profileMap = new Map((profiles.data || []).map((p) => [p.id, p]));
  const branchNames = new Map((branches.data || []).map((b) => [b.id, b.name]));
  return (usersResult.data.users || [])
    .filter((user) => ["employee", "accountant"].includes(String(user.user_metadata?.role || "employee").toLowerCase()))
    .filter((user) => !user.user_metadata?.archived)
    .map((user) => {
      const metadata = user.user_metadata || {};
      const profile = profileMap.get(user.id);
      const branchId = profile?.branch_id || metadata.branch_id || null;
      return {
        id: user.id,
        full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
        employee_id: normalizeText(metadata.employee_id),
        position: normalizeText(metadata.position),
        branch_id: branchId,
        branch_name: branchNames.get(branchId) || null,
        basic_salary: Number(metadata.basic_salary || 0),
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function GET(request) {
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const today = manilaDateKey();
    const current = periodForDateKey(today);
    const upcoming = nextPeriod(today);
    const [taxResult, contributionResult, { configs }, employees, finalized, msc] = await Promise.all([
      supabase.from("payroll_tax_brackets").select(TAX_COLUMNS).order("effective_date", { ascending: false }),
      supabase.from("payroll_contribution_amounts").select(CONTRIBUTION_COLUMNS).order("effective_date", { ascending: false }),
      loadRateConfigs(supabase),
      listPayrollEmployees(supabase),
      latestFinalizedPeriod(supabase),
      loadSssMscRows(supabase),
    ]);
    const mscNow = mscTableOn(msc.rows, current.start_key);
    if (taxResult.error || contributionResult.error) {
      return NextResponse.json({
        available: false,
        error: "Semi-monthly payroll settings are not set up yet: apply supabase/migrations/20261003010000_semi_monthly_payroll.sql.",
      });
    }

    const inForce = (date) => resolveTaxTableRows(taxResult.data, date)[0]?.version_id || null;
    const versions = taxVersions(taxResult.data);

    const latestFor = (employeeId, date) => (contributionResult.data || [])
      .filter((row) => row.employee_id === employeeId && String(row.effective_date) <= date)
      .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at).localeCompare(String(a.created_at))))[0] || null;

    const contributions = employees.map((employee) => {
      const rates = rateValues(resolveRates(configs, {
        employeeId: employee.id, branchId: employee.branch_id, position: employee.position, monthlySalary: employee.basic_salary,
      }, current.start_key));
      // The same default payroll deducts (src/lib/payroll/school-sheet.js).
      const computed = monthlyContributionsFor(employee.basic_salary, rates, {}, { mscTable: mscNow });
      const fixed = latestFor(employee.id, current.start_key);
      const scheduled = latestFor(employee.id, "9999-12-31");
      const amounts = (row) => (row && ["sss", "philhealth", "pagibig"].some((type) => row[type] !== null && row[type] !== undefined)
        ? { sss: row.sss, philhealth: row.philhealth, pagibig: row.pagibig, effective_date: row.effective_date, note: row.note || null, created_by_name: row.created_by_name || null }
        : null);
      return {
        employee_id: employee.id,
        employee_name: employee.full_name,
        employee_code: employee.employee_id,
        branch_name: employee.branch_name,
        monthly_salary: employee.basic_salary,
        computed: { sss: computed.sss, philhealth: computed.philhealth, pagibig: computed.pagibig },
        // "fixed": the Payroll Rates fixed amounts; "legal": the legal tables.
        default_source: Number(rates.contribution_method) === 1 ? "fixed" : "legal",
        fixed: amounts(fixed),
        scheduled: scheduled && scheduled !== fixed ? amounts(scheduled) || { cleared: true, effective_date: scheduled.effective_date } : null,
      };
    });

    return NextResponse.json({
      available: true,
      tax_table: {
        current_version_id: inForce(current.start_key),
        next_period_version_id: inForce(upcoming.start_key),
        versions: versions.slice(0, 10),
      },
      // The SSS salary credit table (20261026020000); available false until
      // it is applied (payroll then uses the ₱500-step formula).
      sss_msc: {
        available: msc.available,
        current_version_id: resolveTaxTableRows(msc.rows, current.start_key)[0]?.version_id || null,
        next_period_version_id: resolveTaxTableRows(msc.rows, upcoming.start_key)[0]?.version_id || null,
        versions: mscVersions(msc.rows).slice(0, 10),
      },
      contributions,
      current_period: current,
      next_period: upcoming,
      finalized_period: finalized,
      earliest_effective_date: finalized ? nextPeriod(finalized.end_key).start_key : null,
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
    const kind = normalizeText(body.kind).toLowerCase();
    const requested = normalizeText(body.effective_date);
    const note = normalizeText(body.note).slice(0, 300) || null;
    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const invalidDate = validateDate(requested);
    if (invalidDate) return NextResponse.json({ error: invalidDate }, { status: 400 });

    const supabase = getAdminClient();

    // The government tables and per-employee contributions need
    // government_rates "create" as well (the Super Admin only, 2026-10-26);
    // the database checks it again (payroll_rate_writer_guard).
    if (["tax_table", "sss_msc_table", "contribution"].includes(kind) && !can(guard.role, "government_rates", "create")) {
      return NextResponse.json({ error: "Only the Super Admin changes government deduction tables." }, { status: 403 });
    }

    if (kind === "tax_table") {
      const invalid = validateTaxRows(body.rows);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      const { effectiveDate, warning } = protectEffectiveDate(requested, await latestFinalizedPeriod(supabase));
      // The version this one replaces on its effective date (old → new).
      const existing = await supabase.from("payroll_tax_brackets").select(TAX_COLUMNS);
      const before = resolveTaxTableRows(existing.data || [], effectiveDate);
      const versionId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const rows = body.rows.map((row) => ({
        version_id: versionId,
        effective_date: effectiveDate,
        bracket_over: peso(row.bracket_over),
        base_tax: peso(row.base_tax),
        rate_pct: Number(row.rate_pct),
        note,
        created_by: guard.userId || null,
        created_by_name: actorName || null,
        created_at: createdAt,
      }));
      const result = await supabase.from("payroll_tax_brackets").insert(rows);
      if (result.error) throw new Error(result.error.message);

      await appendAuditLog({
        actor: guard,
        module: "config",
        action: "tax_table_version",
        entity_type: "payroll_tax_brackets",
        entity_id: versionId,
        description: `Monthly withholding tax table: ${before.length ? `${before.length} brackets (version of ${before[0].effective_date})` : "none"} → ${rows.length} brackets from ${effectiveDate}, by ${actorName}.${describeTaxChange(before, rows)}`,
        status: "success",
        source: "api",
        metadata: {
          version_id: versionId, effective_date: effectiveDate, requested_effective_date: requested,
          rows: rows.map(({ bracket_over: over, base_tax: base, rate_pct: pct }) => ({ over, base, pct })),
          previous_version_id: before[0]?.version_id || null,
          previous_rows: before.map((row) => ({ over: Number(row.bracket_over), base: Number(row.base_tax), pct: Number(row.rate_pct) })),
        },
      });
      return NextResponse.json({ success: true, version_id: versionId, effective_date: effectiveDate, adjusted: effectiveDate !== requested, warning });
    }

    if (kind === "sss_msc_table") {
      const invalid = validateMscRows(body.rows);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      const { effectiveDate, warning } = protectEffectiveDate(requested, await latestFinalizedPeriod(supabase));
      const before = resolveTaxTableRows((await loadSssMscRows(supabase)).rows, effectiveDate);
      const versionId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const rows = body.rows.map((row) => ({
        version_id: versionId,
        effective_date: effectiveDate,
        salary_from: peso(row.salary_from),
        msc: peso(row.msc),
        note,
        created_by: guard.userId || null,
        created_by_name: actorName || null,
        created_at: createdAt,
      }));
      const result = await supabase.from("payroll_sss_msc_brackets").insert(rows);
      if (result.error) throw new Error(result.error.message);

      await appendAuditLog({
        actor: guard,
        module: "config",
        action: "sss_msc_table_version",
        entity_type: "payroll_sss_msc_brackets",
        entity_id: versionId,
        description: `SSS salary credit table: ${before.length ? `${before.length} brackets (version of ${before[0].effective_date})` : "none"} → ${rows.length} brackets, ₱${rows[0].msc}–₱${rows[rows.length - 1].msc}, from ${effectiveDate}, by ${actorName}.${describeMscChange(before, rows)}`,
        status: "success",
        source: "api",
        metadata: {
          version_id: versionId, effective_date: effectiveDate, requested_effective_date: requested,
          rows: rows.map(({ salary_from: from, msc: credit }) => ({ from, msc: credit })),
          previous_version_id: before[0]?.version_id || null,
          previous_rows: before.map((row) => ({ from: Number(row.salary_from), msc: Number(row.msc) })),
        },
      });
      return NextResponse.json({ success: true, version_id: versionId, effective_date: effectiveDate, adjusted: effectiveDate !== requested, warning });
    }

    if (kind === "contribution") {
      const employeeId = normalizeText(body.employee_id);
      const employees = await listPayrollEmployees(supabase);
      const employee = employees.find((row) => row.id === employeeId);
      if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
      const amount = (value) => (value === "" || value === null || value === undefined ? null : Number(value));
      const values = { sss: amount(body.sss), philhealth: amount(body.philhealth), pagibig: amount(body.pagibig) };
      if (Object.values(values).some((v) => v !== null && (!Number.isFinite(v) || v < 0 || v > CONTRIBUTION_MAX))) {
        return NextResponse.json({ error: "Enter each amount as 0 or more, or leave it blank to use the legal table." }, { status: 400 });
      }
      const { effectiveDate, warning } = protectEffectiveDate(requested, await latestFinalizedPeriod(supabase));
      // The amounts this replaces on its effective date (old → new).
      const prior = ((await supabase.from("payroll_contribution_amounts").select(CONTRIBUTION_COLUMNS).eq("employee_id", employeeId)).data || [])
        .filter((existing) => String(existing.effective_date) <= effectiveDate)
        .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at).localeCompare(String(a.created_at))))[0] || null;
      const shown = (value) => (value === null || value === undefined ? "computed" : value);
      const row = {
        employee_id: employeeId,
        effective_date: effectiveDate,
        sss: values.sss === null ? null : peso(values.sss),
        philhealth: values.philhealth === null ? null : peso(values.philhealth),
        pagibig: values.pagibig === null ? null : peso(values.pagibig),
        note,
        created_by: guard.userId || null,
        created_by_name: actorName || null,
        created_at: new Date().toISOString(),
      };
      const result = await supabase.from("payroll_contribution_amounts").insert(row);
      if (result.error) throw new Error(result.error.message);

      const cleared = Object.values(values).every((v) => v === null);
      await appendAuditLog({
        actor: guard,
        module: "config",
        action: "contribution_amounts",
        entity_type: "payroll_contribution_amounts",
        entity_id: employeeId,
        description: cleared
          ? `Contributions for ${employee.full_name} back to the legal table from ${effectiveDate}, by ${actorName}.`
          : `Monthly contributions for ${employee.full_name}: SSS ${shown(prior?.sss)} → ${shown(row.sss)}, PhilHealth ${shown(prior?.philhealth)} → ${shown(row.philhealth)}, Pag-IBIG ${shown(prior?.pagibig)} → ${shown(row.pagibig)} from ${effectiveDate}, by ${actorName}.`,
        status: "success",
        source: "api",
        metadata: { ...row, requested_effective_date: requested, previous: prior ? { sss: prior.sss, philhealth: prior.philhealth, pagibig: prior.pagibig, effective_date: prior.effective_date } : null },
      });
      return NextResponse.json({ success: true, effective_date: effectiveDate, adjusted: effectiveDate !== requested, warning });
    }

    return NextResponse.json({ error: "kind must be tax_table, sss_msc_table or contribution." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
