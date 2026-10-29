/**
 * Leave proof documents are read only where they are shown (cleanup
 * 2026-10-29). proof_url holds the base64 proof file: on the live database 4
 * rows carried 2.9 MB of proof and 1.3 KB of everything else, and payroll,
 * the HR dashboard count and the overlap checks downloaded all of it.
 *
 *   readAllLeaveRequests            every column, proof included: HR's Leave
 *                                   Requests list (GET /api/hr/leave-requests)
 *   readLeaveRequestsWithoutProof   the same filters, no proof_url column
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table } from "./helpers/fake-supabase.js";

// The fake answers whole rows whatever the column list, so record the list
// each leave_requests select asked for.
const selects = [];
vi.mock("@supabase/supabase-js", async () => {
  const fake = (await import("./helpers/fake-supabase.js")).supabaseModule;
  return {
    ...fake,
    createClient: (...args) => {
      const client = fake.createClient(...args);
      const from = client.from;
      client.from = (name) => {
        const query = from(name);
        const select = query.select;
        query.select = (columns, options) => {
          if (name === "leave_requests") selects.push(columns);
          return select(columns, options);
        };
        return query;
      };
      return client;
    },
  };
});

import { readAllLeaveRequests, readLeaveRequestsWithoutProof } from "@/lib/leave-requests/store";

const PROOF = `data:application/pdf;base64,${"A".repeat(700_000)}`;

const leaveRow = (fields = {}) => ({
  id: "leave-1",
  employee_id: "u-emp",
  employee_name: "Ella Employee",
  position: "Teacher",
  leave_type: "Sick Leave",
  pay_status: "with_pay",
  start_date: "2026-10-05",
  end_date: "2026-10-06",
  reason: "Flu",
  proof_url: PROOF,
  status: "approved",
  submitted_at: "2026-10-01T00:00:00.000Z",
  branch_id: "branch-a",
  ...fields,
});

beforeEach(() => {
  resetDb();
  selects.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  table("leave_requests").push(
    leaveRow(),
    leaveRow({ id: "leave-2", status: "pending_admin", start_date: "2026-10-20", end_date: "2026-10-20" }),
    leaveRow({ id: "leave-3", employee_id: "u-other", branch_id: "branch-b", start_date: "2026-11-02", end_date: "2026-11-03" }),
  );
});

describe("readLeaveRequestsWithoutProof", () => {
  it("never asks for proof_url, and its rows carry no proof key", async () => {
    const rows = await readLeaveRequestsWithoutProof({ employeeId: "u-emp" });
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toBe("*");
    expect(selects[0].split(",")).not.toContain("proof_url");
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row).not.toHaveProperty("proof_url"));
  });

  it("keeps every field the callers read", async () => {
    const [row] = await readLeaveRequestsWithoutProof({ id: "leave-1" });
    expect(row).toMatchObject({
      id: "leave-1", employee_id: "u-emp", branch_id: "branch-a", employee_name: "Ella Employee",
      leave_type: "Sick Leave", pay_status: "with_pay", start_date: "2026-10-05", end_date: "2026-10-06",
      reason: "Flu", status: "approved",
    });
  });

  it("applies the same filters as the full read", async () => {
    const filters = [
      { status: "approved", overlapFrom: "2026-10-01", overlapTo: "2026-10-31" },
      { statuses: ["pending_admin", "pending_accountant"] },
      { statuses: ["pending_admin", "pending_accountant"], branchId: "branch-b" },
      { employeeId: "u-emp", status: "approved" },
      { id: "leave-3" },
    ];
    for (const filter of filters) {
      const light = await readLeaveRequestsWithoutProof(filter);
      const full = await readAllLeaveRequests(filter);
      expect(light.map((r) => r.id)).toEqual(full.map((r) => r.id));
    }
  });

  it("transfers a small fraction of the full read", async () => {
    const light = JSON.stringify(await readLeaveRequestsWithoutProof({}));
    const full = JSON.stringify(await readAllLeaveRequests({}));
    expect(full.length).toBeGreaterThan(2_000_000);
    expect(light.length).toBeLessThan(full.length / 100);
  });
});

describe("readAllLeaveRequests (HR's Leave Requests list)", () => {
  it("still returns the proof document", async () => {
    const rows = await readAllLeaveRequests({ statuses: ["pending_admin"] });
    expect(selects).toEqual(["*"]);
    expect(rows[0].proof_url).toBe(PROOF);
  });
});

describe("callers", () => {
  const source = (file) => readFileSync(file, "utf8");

  it("only HR's list reads the proof", () => {
    const hr = source("src/app/api/hr/leave-requests/route.js");
    expect(hr.match(/readAllLeaveRequests\(/g)).toHaveLength(2);
    expect(hr).toContain("readAllLeaveRequests({ ...scope, statuses: PENDING })");
    expect(hr).toContain("readAllLeaveRequests({ ...scope, excludeStatuses: PENDING, submittedSince: since })");
    expect(hr).toContain("readLeaveRequestsWithoutProof({ id })");
    expect(hr).toContain('readLeaveRequestsWithoutProof({ employeeId: current.employee_id, status: "approved" })');
  });

  it("payroll, the HR dashboard and the employee's own leave never read it", () => {
    for (const file of [
      "src/app/api/accountant/payroll/route.js",
      "src/app/api/hr/dashboard/route.js",
      "src/app/api/employee/leave-requests/route.js",
    ]) {
      expect(source(file)).not.toContain("readAllLeaveRequests");
      expect(source(file)).toContain("readLeaveRequestsWithoutProof(");
    }
  });
});
