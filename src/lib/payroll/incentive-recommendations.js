/**
 * Part E step 6 (2026-11-23): rule-based incentives (Perfect Attendance, the
 * Early Bird winner) wait for HR (20261124080000_incentive_recommendations.sql).
 *
 * From automation.incentive_approval_from, payroll still computes them per
 * cutoff, but pays one only when its recommendation is approved. Saving a
 * payslip records the computed ones as pending for HR (one list with the other
 * incentives, multi-select); HR's approval is paid when the payslip is
 * recomputed, and the run can't be submitted while a decision is open or an
 * approval is not in the payslip yet.
 */
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";

export const RULE_INCENTIVE_KINDS = Object.freeze(["perfect_attendance", "early_bird"]);
export const RULE_INCENTIVE_LABELS = Object.freeze({ perfect_attendance: "Perfect Attendance", early_bird: "Early Bird" });
const OFF = Object.freeze({ on: false, from: null, recs: new Map() });
const key = (employeeId, kind) => `${employeeId}|${kind}`;

/** The gate for a pay period: on when the period starts on or after the setting. Off on any read problem (the table not applied yet). */
export async function loadIncentiveGate(supabase, period) {
  try {
    const { data: cfg, error: cfgError } = await supabase.from("system_config").select("value")
      .eq("section", "automation").eq("key", "incentive_approval_from").maybeSingle();
    const from = String(cfg?.value || "").slice(0, 10);
    if (cfgError || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !period?.start_key || period.start_key < from) return OFF;
    const result = await fetchAllRows(() => supabase.from("incentive_recommendations").select("id,employee_id,kind,status,amount")
      .eq("period_start", period.start_key).order("id", { ascending: true }));
    if (result.error) return OFF;
    return { on: true, from, recs: new Map((result.data || []).map((r) => [key(r.employee_id, r.kind), r])) };
  } catch {
    return OFF;
  }
}

/**
 * Pure (tested): what this payslip pays of the computed rule-based incentives.
 * Returns the amounts to pay and the record of each computed one (paid or held).
 */
export function gateRuleIncentives(gate, employeeId, computed, { closed = true } = {}) {
  const items = [];
  const pay = {};
  for (const kind of RULE_INCENTIVE_KINDS) {
    const amount = Math.max(0, Number(computed[kind]?.amount) || 0);
    pay[kind] = amount;
    if (!gate?.on || !(amount > 0)) continue;
    // While the cutoff's attendance is still open: information only ("on track so far"), held, nothing to HR.
    if (!closed) {
      pay[kind] = 0;
      items.push({ kind, amount, status: "on_track", paid: false, reasons: computed[kind]?.reasons || [] });
      continue;
    }
    const status = gate.recs.get(key(employeeId, kind))?.status || "pending";
    const paid = status === "approved";
    if (!paid) pay[kind] = 0;
    items.push({ kind, amount, status: status === "withdrawn" ? "pending" : status, paid, reasons: computed[kind]?.reasons || [] });
  }
  return { pay, items };
}

/**
 * After payslips are saved: record each computed incentive as pending (or keep
 * HR's decision), update a pending amount that changed, and withdraw a pending
 * one the employee no longer qualifies for. Never throws (payroll is saved).
 */
export async function syncIncentiveRecommendations(supabase, entries) {
  try {
    // Only once the cutoff's attendance is complete (the nightly close ran for its last day).
    const gated = (entries || []).filter((e) => e?.payroll?.rule_incentives?.period_start && e.payroll.rule_incentives.closed !== false);
    if (!gated.length) return;
    const byPeriod = new Map();
    for (const e of gated) {
      const p = e.payroll.rule_incentives.period_start;
      if (!byPeriod.has(p)) byPeriod.set(p, []);
      byPeriod.get(p).push(e);
    }
    for (const [periodStart, list] of byPeriod) {
      const ids = list.map((e) => e.employee_id);
      const existing = await fetchAllIn(() => supabase.from("incentive_recommendations").select("id,employee_id,kind,status,amount")
        .eq("period_start", periodStart).order("id", { ascending: true }), "employee_id", ids);
      const have = new Map((existing.data || []).map((r) => [key(r.employee_id, r.kind), r]));
      const now = new Date().toISOString();
      const inserts = [];
      for (const e of list) {
        const ri = e.payroll.rule_incentives;
        const wanted = new Map((ri.items || []).map((i) => [i.kind, i]));
        for (const kind of RULE_INCENTIVE_KINDS) {
          const row = have.get(key(e.employee_id, kind));
          const item = wanted.get(kind);
          if (item && !row) {
            inserts.push({ employee_id: e.employee_id, branch_id: ri.branch_id || null, pay_period: e.pay_period, period_start: ri.period_start,
              period_end: ri.period_end, window_start: ri.window_start || null, window_end: ri.window_end || null, kind, amount: item.amount, reasons: item.reasons, status: "pending" });
          } else if (item && row && (row.status === "withdrawn" || (row.status === "pending" && Number(row.amount) !== Number(item.amount)))) {
            await supabase.from("incentive_recommendations").update({ status: "pending", amount: item.amount, reasons: item.reasons,
              window_start: ri.window_start || null, window_end: ri.window_end || null, updated_at: now }).eq("id", row.id).in("status", ["pending", "withdrawn"]);
          } else if (!item && row?.status === "pending") {
            await supabase.from("incentive_recommendations").update({ status: "withdrawn", updated_at: now }).eq("id", row.id).eq("status", "pending");
          }
        }
      }
      if (inserts.length) await supabase.from("incentive_recommendations").upsert(inserts, { onConflict: "employee_id,period_start,kind", ignoreDuplicates: true });
    }
  } catch { /* the payslips are saved; the next save records them */ }
}

/**
 * Pure (tested): why a run can't be submitted yet. A held incentive still
 * pending is HR's to decide; an approved one not paid on the payslip needs the
 * payslip recomputed.
 */
export function ruleIncentiveBlockers(entries, recs) {
  const waiting = [];
  const recompute = [];
  for (const e of entries || []) {
    const ri = e?.payroll?.rule_incentives;
    for (const kind of RULE_INCENTIVE_KINDS) {
      const rec = recs.get(key(e.employee_id, kind));
      const item = (ri?.items || []).find((i) => i.kind === kind);
      // Computed while the cutoff was still open: recompute once it has closed, then HR decides.
      if (item?.status === "on_track") recompute.push(`${e.employee_name} (${RULE_INCENTIVE_LABELS[kind]}: computed before the cutoff closed)`);
      else if (rec?.status === "pending" && item) waiting.push(`${e.employee_name} (${RULE_INCENTIVE_LABELS[kind]})`);
      else if (rec?.status === "approved" && item && !item.paid) recompute.push(`${e.employee_name} (${RULE_INCENTIVE_LABELS[kind]})`);
    }
  }
  return { waiting, recompute };
}

/**
 * Pure (tested): the cutoff's attendance is complete. The nightly close runs at 00:05 Manila for
 * the day before, so a window ending on D is closed from D + 1 at 00:10 Manila.
 */
export function cutoffClosed(windowEnd, now = new Date()) {
  if (!windowEnd) return true;
  const manila = new Date(now.getTime() + 8 * 3600e3);
  const today = manila.toISOString().slice(0, 10);
  const minutes = manila.getUTCHours() * 60 + manila.getUTCMinutes();
  const next = new Date(Date.parse(`${String(windowEnd).slice(0, 10)}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  return today > next || (today === next && minutes >= 10);
}

/** What the Accountant's form says about a rule-based incentive (null when there is nothing to say). */
export function ruleIncentiveNote(ruleIncentives, kind) {
  const item = (ruleIncentives?.items || []).find((i) => i.kind === kind);
  if (!item) return null;
  return {
    on_track: "on track so far: decided when the cutoff closes",
    pending: "waiting for HR's approval (not paid yet)",
    approved: "approved by HR",
    rejected: "rejected by HR: not paid",
  }[item.status] || null;
}

/** The recommendations for these payslips (submit check). */
export async function recommendationsFor(supabase, entries) {
  const out = new Map();
  const periods = [...new Set((entries || []).map((e) => e?.payroll?.rule_incentives?.period_start).filter(Boolean))];
  for (const p of periods) {
    const ids = entries.filter((e) => e?.payroll?.rule_incentives?.period_start === p).map((e) => e.employee_id);
    const result = await fetchAllIn(() => supabase.from("incentive_recommendations").select("employee_id,kind,status")
      .eq("period_start", p).order("id", { ascending: true }), "employee_id", ids);
    for (const r of result.data || []) out.set(key(r.employee_id, r.kind), r);
  }
  return out;
}
