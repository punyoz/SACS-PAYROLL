/**
 * The demo bundle fitted to the target before loading (scripts/demo/bundle.mjs
 * fitBundleToTarget). The live reset of 2026-11-15 needed both by hand:
 * 1,440 lines pointed at the build's local-only rate rows, and the demo's Main
 * Branch October 16-31 run (Pending) met a real Pending run there.
 */
import { describe, it, expect } from "vitest";
import { fitBundleToTarget } from "../scripts/demo/bundle.mjs";

const MAIN = "branch-main";
const SV = "branch-sv";
const tables = () => ({
  payroll_deductions: [
    { id: "d1", rate_config_id: "rate-live", amount: 100 },
    { id: "d2", rate_config_id: "rate-local-only", amount: 551.73, rate: 551.73 },
    { id: "d3", rate_config_id: null, amount: 5 },
  ],
  payroll_incentives: [{ id: "i1", rate_config_id: "rate-local-only", amount: 300 }],
  payroll_runs: [
    { id: "run-main-oct2", branch_id: MAIN, period_start: "2026-10-16", period_label: "October 16-31, 2026", status: "pending" },
    { id: "run-main-oct1", branch_id: MAIN, period_start: "2026-10-01", period_label: "October 1-15, 2026", status: "approved" },
    { id: "run-sv-oct2", branch_id: SV, period_start: "2026-10-16", period_label: "October 16-31, 2026", status: "rejected" },
  ],
  payroll_run_items: [{ id: "it1", run_id: "run-main-oct2" }, { id: "it2", run_id: "run-sv-oct2" }],
  payroll_approval_history: [{ id: "h1", run_id: "run-main-oct2" }],
  payroll_run_exclusions: [],
  payroll_entries: [
    { id: "e1", run_id: "run-main-oct2", status: "paid", employee_name: "Andrea Demo Ilagan", payslip_no: "PS-202611-0585" },
    { id: "e2", run_id: "run-main-oct2", status: "paid" },
    { id: "e3", run_id: "run-main-oct1", status: "paid" },
  ],
  notifications: [{ id: "n1", run_id: "run-main-oct2" }, { id: "n2", run_id: null }],
});
// The target (live): an approved real Oct 1-15 run and a PENDING real Oct 16-31 run, both Main Branch.
const target = {
  rateIds: new Set(["rate-live"]),
  targetRuns: [
    { branch_id: MAIN, period_start: "2026-10-01", status: "approved" },
    { branch_id: MAIN, period_start: "2026-10-16", status: "pending" },
  ],
};

describe("fitBundleToTarget", () => {
  it("unlinks only lines whose rate row the target lacks; each keeps its own amount and rate", () => {
    const { tables: t } = fitBundleToTarget(tables(), target);
    expect(t.payroll_deductions.map((d) => d.rate_config_id)).toEqual(["rate-live", null, null]);
    expect(t.payroll_deductions[1]).toMatchObject({ amount: 551.73, rate: 551.73 });
    expect(t.payroll_incentives[0].rate_config_id).toBeNull();
  });

  it("drops a demo run that would make two runs open; its payslips stay, Final, outside any run", () => {
    const { tables: t, notes } = fitBundleToTarget(tables(), target);
    expect(t.payroll_runs.map((r) => r.id)).toEqual(["run-main-oct1", "run-sv-oct2"]);
    expect(t.payroll_run_items.map((r) => r.id)).toEqual(["it2"]);
    expect(t.payroll_approval_history).toEqual([]);
    expect(t.payroll_entries.map((e) => [e.id, e.run_id, e.status])).toEqual([["e1", null, "paid"], ["e2", null, "paid"], ["e3", "run-main-oct1", "paid"]]);
    expect(t.notifications.map((n) => n.run_id)).toEqual([null, null]);
    const text = notes.join(" | ");
    expect(text).toMatch(/October 16-31, 2026, branch branch-main \(pending\) not loaded.*2 payslip\(s\)/);
    expect(text).toContain("Andrea Demo Ilagan PS-202611-0585");
    expect(text).toMatch(/2 payslip line\(s\) unlinked from 1 rate row\(s\).*rate row rate-local-only: 2 line\(s\)/);
  });

  it("keeps an approved demo run beside an approved target run, and changes nothing when nothing collides", () => {
    const input = tables();
    const { tables: t } = fitBundleToTarget(input, { rateIds: new Set(["rate-live", "rate-local-only"]), targetRuns: [{ branch_id: MAIN, period_start: "2026-10-01", status: "approved" }] });
    expect(t.payroll_runs).toHaveLength(3);
    expect(t.payroll_entries.every((e) => e.run_id)).toBe(true);
    // The input is not changed.
    expect(input.payroll_deductions[1].rate_config_id).toBe("rate-local-only");
  });
});
