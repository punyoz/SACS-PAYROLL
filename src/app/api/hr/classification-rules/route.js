/**
 * Leave credits and pay rules per category × status × type, and the HR
 * settings behind the reminders (Part A, 20261121010000). Values the school
 * has not set yet are defaults marked "pending policy manual".
 *
 *   GET   the rules in effect (and upcoming), legal-minimum warnings, settings
 *   POST  { kind: "leave", effective_from, note?, rows: [{ leave_type, employee_type, employment_status, employment_type, days_per_year }] }
 *         { kind: "pay", effective_from, note?, rows: [{ employee_type, employment_status, employment_type, pay_basis, overtime_allowed, subsidy_eligible, incentive_eligible, loan_eligible }] }
 *         { kind: "settings", values: { probation_months, probation_reminder_days, contract_reminder_days } }
 *         { kind: "loan_limit", multiplier }   the cash advance salary limit (20261126050000; pending policy manual)
 *   HR / Super Admin only; every save is a new version (history kept) and audited.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import {
  CATEGORY_OPTIONS, CREDIT_LEAVE_TYPES, POOL_LEAVE_TYPE, EMPLOYMENT_STATUS_OPTIONS, EMPLOYMENT_TYPE_OPTIONS, HR_SETTINGS,
  leaveRuleFor, legalMinimumWarnings, payRuleFor,
} from "@/lib/employees/classification";
import { loadLeaveRules, loadPayRules, loadStatutoryLeaves } from "@/lib/employees/classification-server";
import { LOAN_LIMIT_BASIS_LABELS, LOAN_LIMIT_DEFAULTS, LOAN_LIMIT_MULTIPLIER_RANGE, multiplierText } from "@/lib/payroll/loan-limit";

/** The loan salary limit settings (system_config payroll.loan_limit_*), defaults when unset. */
async function loadLoanLimitSettings(supabase) {
  const rows = (await supabase.from("system_config").select("key,value,updated_by,updated_at").eq("section", "payroll").in("key", ["loan_limit_basis", "loan_limit_multiplier"])).data || [];
  const row = (key) => rows.find((r) => r.key === key);
  const m = Number(row("loan_limit_multiplier")?.value);
  const basis = LOAN_LIMIT_BASIS_LABELS[row("loan_limit_basis")?.value] ? row("loan_limit_basis").value : LOAN_LIMIT_DEFAULTS.basis;
  return {
    basis, basis_label: LOAN_LIMIT_BASIS_LABELS[basis],
    multiplier: Number.isFinite(m) && m > 0 ? m : LOAN_LIMIT_DEFAULTS.multiplier,
    ...LOAN_LIMIT_MULTIPLIER_RANGE,
    updated_by: row("loan_limit_multiplier")?.updated_by || null,
    updated_at: row("loan_limit_multiplier")?.updated_at || null,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const combos = () => CATEGORY_OPTIONS.flatMap((employee_type) => EMPLOYMENT_STATUS_OPTIONS.flatMap((employment_status) =>
  EMPLOYMENT_TYPE_OPTIONS.map((employment_type) => ({ employee_type, employment_status, employment_type }))));
const sameCombo = (a, b) => a.employee_type === b.employee_type && a.employment_status === b.employment_status && a.employment_type === b.employment_type;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "user_management", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const [leaveRules, payRules, config, statutory, loanLimit] = await Promise.all([
      loadLeaveRules(supabase), loadPayRules(supabase),
      supabase.from("system_config").select("key,value").eq("section", "hr").in("key", Object.keys(HR_SETTINGS)),
      loadStatutoryLeaves(supabase),
      loadLoanLimitSettings(supabase),
    ]);
    const on = today();
    const leave = combos().map((c) => ({
      ...c,
      // One shared pool a year (2026-11-24): one "days per year" per Category x Status.
      days: Object.fromEntries([POOL_LEAVE_TYPE].map((t) => {
        const rule = leaveRuleFor(leaveRules, t, c, on);
        return [t, rule ? { days: Number(rule.days_per_year), effective_from: rule.effective_from, note: rule.note } : null];
      })),
    }));
    const pay = combos().map((c) => ({ ...c, rule: payRuleFor(payRules, c, on) }));
    const upcoming = {
      leave: leaveRules.filter((r) => String(r.effective_from) > on),
      pay: payRules.filter((r) => String(r.effective_from) > on),
    };
    const settings = Object.fromEntries(Object.entries(HR_SETTINGS).map(([key, def]) => {
      const n = Number((config.data || []).find((r) => r.key === key)?.value);
      return [key, { ...def, value: Number.isFinite(n) && n > 0 ? n : def.fallback }];
    }));
    return NextResponse.json({ leave, pay, upcoming, warnings: legalMinimumWarnings(leaveRules, on), settings, leave_types: [POOL_LEAVE_TYPE], statutory, loan_limit: loanLimit });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "user_management", "update");
    if (guard.denied) return guard.denied;
    if (!["hr", "super_admin"].includes(guard.role)) return NextResponse.json({ error: "Only HR or the Super Admin changes these rules." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const by = normalizeText(guard.session?.full_name, guard.session?.email);
    const note = normalizeText(body.note).slice(0, 500) || null;

    // Statutory leaves: on / off, days, how many times (maternity, paternity, ...).
    if (body.kind === "statutory") {
      const known = await loadStatutoryLeaves(supabase);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const changed = [];
      for (const r of rows) {
        const row = known.find((k) => k.leave_type === r.leave_type);
        if (!row) return NextResponse.json({ error: "Unknown statutory leave." }, { status: 400 });
        const days = Number(r.days);
        const max = r.max_events === "" || r.max_events === null || r.max_events === undefined ? null : Number(r.max_events);
        if (!Number.isFinite(days) || days <= 0 || days > 366 || Math.round(days * 2) !== days * 2) {
          return NextResponse.json({ error: `${row.leave_type}: days must be above 0 and at most 366, in half days.` }, { status: 400 });
        }
        if (max !== null && (!Number.isInteger(max) || max < 1 || max > 50)) {
          return NextResponse.json({ error: `${row.leave_type}: times must be a whole number from 1 to 50, or blank.` }, { status: 400 });
        }
        const next = { enabled: r.enabled === true, days, max_events: max };
        if (next.enabled === row.enabled && next.days === Number(row.days) && next.max_events === row.max_events) continue;
        const saved = await supabase.from("statutory_leave_types").update({ ...next, updated_by_name: by, updated_at: new Date().toISOString() }).eq("leave_type", row.leave_type);
        if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
        changed.push(`${row.leave_type}: ${next.enabled ? "on" : "off"}, ${days} days${max ? `, first ${max} times` : ""}`);
      }
      if (changed.length) {
        await appendAuditLog({ actor: guard, module: "employees", action: "statutory_leave_change", entity_type: "statutory_leave_types", entity_id: "statutory", status: "success", source: "api",
          description: `Statutory leave saved by ${by}: ${changed.join("; ")}.`, metadata: { changes: changed } });
      }
      return NextResponse.json({ success: true, changed: changed.length });
    }

    if (body.kind === "loan_limit") {
      const m = Number(body.multiplier);
      const { min, max } = LOAN_LIMIT_MULTIPLIER_RANGE;
      if (!Number.isFinite(m) || m < min || m > max || Math.abs(Math.round(m * 100) - m * 100) > 1e-9) {
        return NextResponse.json({ error: `Cash advance limit: a number of months' salary from ${min} to ${max} (up to 2 decimals).` }, { status: 400 });
      }
      const before = await loadLoanLimitSettings(supabase);
      const saved = await supabase.from("system_config").upsert({ section: "payroll", key: "loan_limit_multiplier", value: String(m), updated_by: by, updated_at: new Date().toISOString() }, { onConflict: "section,key" });
      if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
      await appendAuditLog({ actor: guard, module: "payroll", action: "loan_limit_setting_change", entity_type: "system_config", entity_id: "payroll.loan_limit_multiplier", status: "success", source: "api",
        description: `Cash advance limit set by ${by}: ${multiplierText(m)} (was ${multiplierText(before.multiplier)}). Applies to new and changed cash advances only.`, metadata: { from: before.multiplier, to: m } });
      return NextResponse.json({ success: true });
    }

    if (body.kind === "settings") {
      const values = body.values || {};
      const rows = [];
      for (const [key, raw] of Object.entries(values)) {
        const def = HR_SETTINGS[key];
        if (!def) return NextResponse.json({ error: `Unknown setting: ${key}.` }, { status: 400 });
        const n = Number(raw);
        if (!Number.isInteger(n) || n < def.min || n > def.max) return NextResponse.json({ error: `${def.label}: a whole number from ${def.min} to ${def.max}.` }, { status: 400 });
        rows.push({ key, value: String(n) });
      }
      for (const row of rows) {
        const saved = await supabase.from("system_config").upsert({ section: "hr", key: row.key, value: row.value, updated_by: by, updated_at: new Date().toISOString() }, { onConflict: "section,key" });
        if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
      }
      await appendAuditLog({ actor: guard, module: "employees", action: "hr_settings_change", entity_type: "system_config", entity_id: "hr", status: "success", source: "api",
        description: `HR settings saved by ${by}: ${rows.map((r) => `${HR_SETTINGS[r.key].label} = ${r.value}`).join("; ")}.`, metadata: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
      return NextResponse.json({ success: true });
    }

    const effectiveFrom = String(body.effective_from || "");
    if (!DATE.test(effectiveFrom)) return NextResponse.json({ error: "Choose the date the rules apply from." }, { status: 400 });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    for (const r of rows) {
      if (!combos().some((c) => sameCombo(c, r))) return NextResponse.json({ error: "Each row needs a valid category, status and type." }, { status: 400 });
    }

    if (body.kind === "leave") {
      const insert = [];
      for (const r of rows) {
        const days = Number(r.days_per_year);
        if (r.leave_type !== POOL_LEAVE_TYPE && !CREDIT_LEAVE_TYPES.includes(r.leave_type)) return NextResponse.json({ error: "Unknown leave type." }, { status: 400 });
        if (!Number.isFinite(days) || days < 0 || days > 366 || Math.round(days * 2) !== days * 2) {
          return NextResponse.json({ error: `${r.leave_type}: days must be 0 to 366, in half days.` }, { status: 400 });
        }
        // Category × Status (stored as the Full-time row; no part-time employees, 2026-11-23).
        insert.push({ leave_type: r.leave_type, employee_type: r.employee_type, employment_status: r.employment_status, employment_type: "Full-time",
          days_per_year: days, effective_from: effectiveFrom, note, created_by: guard.userId, created_by_name: by });
      }
      const saved = await supabase.from("leave_credit_rules").upsert(insert, { onConflict: "leave_type,employee_type,employment_status,employment_type,effective_from" });
      if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
      const after = await loadLeaveRules(supabase);
      const warnings = legalMinimumWarnings(after, effectiveFrom);
      await appendAuditLog({ actor: guard, module: "employees", action: "leave_credit_rules_change", entity_type: "leave_credit_rules", entity_id: effectiveFrom, status: "success", source: "api",
        description: `Leave credits from ${effectiveFrom} saved by ${by}: ${insert.length} value${insert.length === 1 ? "" : "s"}${note ? ` (${note})` : ""}${warnings.length ? `; ${warnings.length} combination${Number(warnings.length) === 1 ? "" : "s"} below the 5-day service incentive leave` : ""}.`,
        metadata: { effective_from: effectiveFrom, rows: insert.map(({ created_by, created_by_name, ...r }) => r), warnings } });
      return NextResponse.json({ success: true, warnings });
    }

    if (body.kind === "pay") {
      const insert = [];
      for (const r of rows) {
        // Monthly salary only (no part-time employees, 2026-11-23).
        if ((r.pay_basis || "monthly") !== "monthly") return NextResponse.json({ error: "Employees are paid a monthly salary." }, { status: 400 });
        if ((r.employment_type || "Full-time") !== "Full-time") return NextResponse.json({ error: "Rules are per category and status (everyone is Full-time)." }, { status: 400 });
        insert.push({ employee_type: r.employee_type, employment_status: r.employment_status, employment_type: r.employment_type, pay_basis: r.pay_basis,
          overtime_allowed: r.overtime_allowed !== false, subsidy_eligible: r.subsidy_eligible !== false, incentive_eligible: r.incentive_eligible !== false,
          loan_eligible: r.loan_eligible !== false, effective_from: effectiveFrom, note, created_by: guard.userId, created_by_name: by });
      }
      const saved = await supabase.from("employee_pay_rules").upsert(insert, { onConflict: "employee_type,employment_status,employment_type,effective_from" });
      if (saved.error) return NextResponse.json({ error: sanitizeError(saved.error) }, { status: 400 });
      await appendAuditLog({ actor: guard, module: "employees", action: "pay_rules_change", entity_type: "employee_pay_rules", entity_id: effectiveFrom, status: "success", source: "api",
        description: `Pay rules from ${effectiveFrom} saved by ${by}: ${insert.length} combination${insert.length === 1 ? "" : "s"}${note ? ` (${note})` : ""}.`,
        metadata: { effective_from: effectiveFrom, rows: insert.map(({ created_by, created_by_name, ...r }) => r) } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown kind." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
