/**
 * Attendance rows must not cross branches.
 *
 * THE BUG THIS PINS
 * fetchAttendanceRows() selected every attendance_logs row for the day with
 * no branch filter, then used activeEmployees ONLY to add "Absent"
 * placeholders. Every other branch's taps came through untouched, so an Admin
 * in a branch with no staff still saw the whole school's attendance -- and the
 * Late/Present/Absent panels counted them.
 *
 * Read as text, matching tests/login-otp-flow.test.js: importing the route
 * would need live Supabase env values and would fire a real network call.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const attendanceRoute = readFileSync("src/app/api/admin/attendance/route.js", "utf8");
const dashboardRoute = readFileSync("src/app/api/admin/dashboard/route.js", "utf8");
const hrAttendanceRoute = readFileSync("src/app/api/hr/attendance/route.js", "utf8");

describe("Admin attendance is scoped to the caller's own branch", () => {
  it("filters the fetched taps, not just the absent placeholders", () => {
    // The fix: a Set of visible employee ids, applied to the mapped rows
    // BEFORE they are collapsed into the per-employee map.
    expect(attendanceRoute).toMatch(/const visibleIds = new Set\(/);
    expect(attendanceRoute).toMatch(/branchScoped\s*\n?\s*\?\s*mapped\.filter\(/);
  });

  it("collapses the scoped rows, not the unscoped ones", () => {
    // Regression guard: collapsing `mapped` again would silently restore the
    // leak even with the filter present.
    expect(attendanceRoute).toMatch(/collapseDailyTaps\(scoped,/);
    expect(attendanceRoute).not.toMatch(/collapseDailyTaps\(mapped,/);
  });

  it("the GET handler asks for scoping whenever the caller is branch-scoped", () => {
    expect(attendanceRoute).toMatch(/!guard\.branchExempt,/);
    const fetchIdx = attendanceRoute.indexOf("const attendanceData = await fetchAttendanceRows(");
    const flagIdx = attendanceRoute.indexOf("!guard.branchExempt,", fetchIdx);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(fetchIdx);
  });

  it("a branch-exempt caller is not filtered", () => {
    // Super Admin is handed every employee anyway; skipping the filter keeps
    // a row whose employee no longer resolves visible rather than dropped.
    expect(attendanceRoute).toMatch(/branchScoped = false/);
  });

  it("the dashboard panels are scoped by the same flag", () => {
    // getAttendancePanels shares fetchAttendanceRows, so the Late/Present/
    // Absent counts leaked in exactly the same way.
    expect(dashboardRoute).toMatch(/getAttendancePanels\(supabase, activeEmployees, !guard\.branchExempt\)/);
    expect(attendanceRoute).toMatch(/export async function getAttendancePanels\(supabase, activeEmployees, branchScoped = false\)/);
  });

  it("HR's equivalent route still scopes its own query", () => {
    // HR was already correct -- it filters in SQL. Pinned so the two routes
    // are not "fixed" into agreeing by removing HR's filter.
    expect(hrAttendanceRoute).toMatch(/query\.eq\("branch_id", guard\.branchId\)/);
  });
});

describe("Scoping keys off the employee's current branch", () => {
  it("does not filter the query by the row's own branch_id", () => {
    // attendance_logs.branch_id is stamped where the tap happened and never
    // moves. Filtering on it would hand an employee's history to the branch
    // they used to be in. The employee set comes from profiles, which is
    // current.
    expect(attendanceRoute).not.toMatch(/attendance_logs[\s\S]{0,200}?\.eq\("branch_id"/);
    expect(attendanceRoute).toMatch(/activeEmployees\.map\(\(employee\) => String\(employee\.id\)\)/);
  });
});
