// Part E step 5 (2026-11-23): the system's transfer endorsement (rules checked).
// Always a recommendation with its warnings: HR decides.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { transferRecommendationFrom } from "@/lib/automation/transfer-recommendations";

const base = { employee: { archived: false, employee_status: "Active" }, destination: { name: "North", status: "Active" }, effectiveDate: "2026-12-01", today: "2026-11-23" };

describe("transfer endorsement", () => {
  it("all fine: recommend endorsing", () => {
    const r = transferRecommendationFrom(base);
    expect(r).toMatchObject({ decision: "endorse", label: "Recommend endorsing", warnings: [] });
    expect(r.reasons).toEqual(["The employee is active", "Destination North is active", "Effective 2026-12-01"]);
  });
  it("each problem is a warning, never a refusal", () => {
    const r = transferRecommendationFrom({ ...base, destination: { name: "Old", status: "Inactive" }, openAwol: true, leaveOnDate: true, ownSchedule: true, runInProgress: true });
    expect(r.label).toBe("Recommend endorsing, with warnings");
    expect(r.warnings).toEqual([
      "The destination branch is not active",
      "An AWOL case is open",
      "On leave on the effective date",
      "The leaving branch's payroll for that cutoff is with HR: the days are split per branch on one payslip",
      "Has their own work schedule: HR checks it fits the new branch",
    ]);
  });
});

describe("applying on the effective date (migration)", () => {
  const sql = readFileSync("supabase/migrations/20261124070000_transfer_automation.sql", "utf8");
  it("a future-dated approval waits; the daily job moves branch, sign-in account and the active card; paused = nothing", () => {
    expect(sql).toMatch(/IF COALESCE\(NEW\.effective_date, \(NOW\(\) AT TIME ZONE 'Asia\/Manila'\)::DATE\) <= \(NOW\(\) AT TIME ZONE 'Asia\/Manila'\)::DATE THEN/);
    expect(sql).toMatch(/UPDATE public\.rfid_cards SET branch_id = p_request\.to_branch_id WHERE employee_id = p_request\.employee_id AND status = 'active'/);
    expect(sql).toMatch(/raw_app_meta_data = .*'session_id', 'revoked:'/);
    expect(sql).toMatch(/IF public\.automation_off\('transfer_endorsements'\) THEN RETURN/);
    // never moved twice: only while still in the branch it was raised for
    expect(sql).toMatch(/WHERE id = r\.employee_id AND branch_id IS NOT DISTINCT FROM r\.from_branch_id/);
  });
});
