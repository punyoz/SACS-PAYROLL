/**
 * The demo bundle fitted to the target before loading (scripts/demo/bundle.mjs
 * fitBundleToTarget + describeFit). The live reset of 2026-11-15 needed both
 * by hand: 1,440 lines pointed at the build's local-only rate rows, and the
 * demo's Main Branch October 16-31 run (Pending) met a real Pending run there.
 */
import { describe, it, expect } from "vitest";
import { describeFit, fitBundleToTarget } from "../scripts/demo/bundle.mjs";

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
    { id: "e2", run_id: "run-main-oct2", status: "draft", employee_name: "Benjie Demo Quiambao", payslip_no: null },
    { id: "e3", run_id: "run-main-oct1", status: "paid", employee_name: "Andrea Demo Ilagan", payslip_no: "PS-202611-0575" },
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
    const fit = fitBundleToTarget(tables(), target);
    expect(fit.tables.payroll_deductions.map((d) => d.rate_config_id)).toEqual(["rate-live", null, null]);
    expect(fit.tables.payroll_deductions[1]).toMatchObject({ amount: 551.73, rate: 551.73 });
    expect(fit.tables.payroll_incentives[0].rate_config_id).toBeNull();
    expect([...fit.unlinked]).toEqual([["rate-local-only", 2]]);
  });

  it("drops a NOT approved demo run that would make two runs open; its payslips stay, outside any run", () => {
    const { tables: t } = fitBundleToTarget(tables(), target);
    expect(t.payroll_runs.map((r) => r.id)).toEqual(["run-main-oct1", "run-sv-oct2"]);
    expect(t.payroll_run_items.map((r) => r.id)).toEqual(["it2"]);
    expect(t.payroll_approval_history).toEqual([]);
    expect(t.payroll_entries.map((e) => [e.id, e.run_id, e.status])).toEqual([["e1", null, "paid"], ["e2", null, "draft"], ["e3", "run-main-oct1", "paid"]]);
    // Notifications about the run that is not loaded are not loaded either.
    expect(t.notifications.map((n) => n.id)).toEqual(["n2"]);
  });

  it("stops the load when an APPROVED demo run meets a target run that is not approved", () => {
    const input = tables();
    input.payroll_runs[0].status = "approved";
    expect(() => fitBundleToTarget(input, target)).toThrow(/approved demo run meets a target run that is not approved.*October 16-31, 2026.*Nothing loaded/);
  });

  it("keeps an approved demo run beside an approved target run, and changes nothing when nothing collides", () => {
    const input = tables();
    const fit = fitBundleToTarget(input, { rateIds: new Set(["rate-live", "rate-local-only"]), targetRuns: [{ branch_id: MAIN, period_start: "2026-10-01", status: "approved" }] });
    expect(fit.tables.payroll_runs).toHaveLength(3);
    expect(fit.tables.payroll_entries.every((e) => e.run_id)).toBe(true);
    expect(describeFit(fit)).toEqual([]);
    // The input is not changed.
    expect(input.payroll_deductions[1].rate_config_id).toBe("rate-local-only");
    expect(input.payroll_entries[0].run_id).toBe("run-main-oct2");
  });
});

describe("describeFit (the summary printed before any prompt)", () => {
  it("names each rate row and each payslip, with the payslip number as it will be loaded and its real status", () => {
    const fit = fitBundleToTarget(tables(), target);
    const notes = describeFit(fit, new Map([["PS-202611-0585", "PS-202611-0702"]]));
    const text = notes.join("\n");
    expect(text).toMatch(/2 payslip line\(s\) unlinked from 1 rate row\(s\)/);
    expect(text).toContain("rate row rate-local-only: 2 line(s)");
    expect(text).toMatch(/demo run October 16-31, 2026, branch branch-main \(pending\) not loaded.*2 payslip\(s\).*1 Final: Action needed, supplemental run; 1 not Final/);
    expect(text).toContain("Andrea Demo Ilagan PS-202611-0702 (Final)");
    expect(text).not.toContain("PS-202611-0585");
    expect(text).toContain("Benjie Demo Quiambao (draft)");
  });
});
