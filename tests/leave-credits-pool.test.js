// Leave credits: ONE shared pool a year (2026-11-24): Regular 5 / new staff 3; from the 1-year anniversary the
// Regular total, pro-rated; Vacation / Sick / Emergency all draw from it (classification-server.leaveBalances).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POOL_LEAVE_TYPE, leaveEntitlement, legalMinimumWarnings } from "@/lib/employees/classification";

const rule = (status, days) => ["Teaching", "Non-Teaching"].map((t) => ({ leave_type: POOL_LEAVE_TYPE, employee_type: t, employment_status: status, employment_type: "Full-time", days_per_year: days, effective_from: "2026-01-01" }));
const rules = [...rule("Regular", 5), ...rule("Probationary", 3), ...rule("Provisional", 3), ...rule("Contractual", 3),
  // The old per-type rules stay as history and are not read once the pool exists.
  { leave_type: "Vacation Leave", employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", days_per_year: 5, effective_from: "2026-01-01" }];

describe("one pool a year", () => {
  it("Regular 5, new staff 3 (a whole year)", () => {
    expect(leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Regular" }, year: 2026, dateHired: "2020-06-01" })[POOL_LEAVE_TYPE].days).toBe(5);
    const probationary = leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Probationary" }, year: 2026, dateHired: "2025-12-01", regularAfterMonths: 120 });
    expect(probationary[POOL_LEAVE_TYPE].days).toBe(3);
    // Only the pool: no per-type entitlement any more.
    expect(probationary["Vacation Leave"]).toBeUndefined();
  });
  it("from the 1-year anniversary the Regular 5, pro-rated (the calculation is shown in parts)", () => {
    // Hired Jul 1, 2025 as Provisional: 3 a year until Jun 30, 2026, then 5: 181 days at 3 + 184 days at 5 = 1.49 + 2.52 = 4.01 -> 4.
    const e = leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Provisional" }, year: 2026, dateHired: "2025-07-01" })[POOL_LEAVE_TYPE];
    expect(e.days).toBe(4);
    expect(e.parts.map((p) => p.rule_days)).toEqual([3, 5]);
  });
  it("the legal minimum: a Regular pool under 5 is flagged; new staff's 3 is not", () => {
    expect(legalMinimumWarnings(rules, "2026-11-24")).toEqual([]);
    const low = rules.map((r) => (r.leave_type === POOL_LEAVE_TYPE && r.employment_status === "Regular" ? { ...r, days_per_year: 4 } : r));
    expect(legalMinimumWarnings(low, "2026-11-24").every((w) => w.employment_status === "Regular" && w.total === 4)).toBe(true);
  });
  it("every credit type draws from the pool; statutory leaves never do", () => {
    const server = readFileSync("src/lib/employees/classification-server.js", "utf8");
    expect(server).toMatch(/const used = CREDIT_LEAVE_TYPES\.reduce\(\(s, t\) => s \+ paid\(t\), 0\);/);
    expect(server).toMatch(/\[type, \{ allotment: e\.days, computed: e\.computed, used: paid\(type\), remaining, /);
    // Half a day is 0.5 (requestDays) and statutory types are not CREDIT_LEAVE_TYPES.
    expect(readFileSync("src/lib/employees/classification.js", "utf8")).toMatch(/export const CREDIT_LEAVE_TYPES = \["Vacation Leave", "Sick Leave", "Emergency Leave"\];/);
    const sql = readFileSync("supabase/migrations/20261124230000_leave_credits_pool.sql", "utf8");
    expect(sql).toMatch(/CASE WHEN st\.v = 'Regular' THEN 5 ELSE 3 END/);
  });
});
