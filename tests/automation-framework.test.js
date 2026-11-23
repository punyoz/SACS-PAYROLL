// Part E step 1 (2026-11-23): the automation framework's shared rules.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { summarizeAutomation, isWaiting, AUTOMATION_STATUSES } from "@/lib/automation/shared";
import { canUndo, undoAutomation } from "@/lib/automation/undo";

const now = new Date().toISOString();
const old = new Date(Date.now() - 3 * 864e5).toISOString();
const rows = [
  { status: "done", created_at: now },
  { status: "done", created_at: old },
  { status: "admin_check", created_at: now },
  { status: "with_hr", created_at: old, escalated_at: now },
  { status: "open", created_at: now },
  { status: "couldnt_decide", created_at: now },
  { status: "undone", created_at: now, escalated_at: now },
];

describe("automation counts", () => {
  it("the Admin's 'waiting for you' is the Admin check; HR's is what was forwarded, open or undecided", () => {
    expect(summarizeAutomation(rows, "admin").for_you).toBe(1);
    expect(summarizeAutomation(rows, "hr").for_you).toBe(3);
  });
  it("done in the last 24 h, escalated only while still waiting", () => {
    const c = summarizeAutomation(rows, "hr");
    expect(c.done_today).toBe(1);
    expect(c.escalated).toBe(1);
    expect(c.couldnt_decide).toBe(1);
  });
  it("waiting statuses", () => {
    expect(["admin_check", "with_hr", "open", "couldnt_decide"].every(isWaiting)).toBe(true);
    expect(["done", "undone", "closed"].some(isWaiting)).toBe(false);
    expect(AUTOMATION_STATUSES).toHaveLength(7);
  });
});

describe("modules", () => {
  it("every module has its own pause; all ship enabled (paused = false)", async () => {
    const { AUTOMATION_MODULES } = await import("@/lib/automation/shared");
    expect(Object.keys(AUTOMATION_MODULES)).toEqual(expect.arrayContaining(["attendance_flags", "schedule_requests"]));
    const sql = readFileSync("supabase/migrations/20261124010000_automation_framework.sql", "utf8");
    expect(sql).toMatch(/\('paused', 'false'\)/);
    expect(sql).toMatch(/FUNCTION public\.automation_off\(p_module TEXT\)/);
  });
});

describe("undo", () => {
  it("a module without an undo handler is refused (fixed on its own page)", async () => {
    expect(canUndo("nothing_registered")).toBe(false);
    const r = await undoAutomation(null, { module: "nothing_registered" }, {});
    expect(r.status).toBe(409);
  });
});

describe("the route never approves anything; roles are checked on the server", () => {
  const route = readFileSync("src/app/api/automation/route.js", "utf8");
  it("Admin: note / object only on their branch; HR: undo; HR / Super Admin: pause", () => {
    expect(route).toMatch(/guard\.role !== "admin"\) return NextResponse\.json\(\{ error: "The branch Admin checks/);
    expect(route).toMatch(/denyForeignBranch\(guard, row\.branch_id\)/);
    expect(route).toMatch(/guard\.role !== "hr"\) return NextResponse\.json\(\{ error: "HR undoes/);
    expect(route).toMatch(/guard\.role !== "hr" && guard\.role !== "super_admin"/);
    expect(route).toMatch(/if \(guard\.role === "admin"\) q = q\.eq\("branch_id", guard\.branchId\)/);
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/approve/i);
  });
});

describe("attendance flags (Part E step 2)", () => {
  it("the employee's list is pinned to the signed-in person, day-level flags only", () => {
    const route = readFileSync("src/app/api/me/attendance-flags/route.js", "utf8");
    expect(route).toMatch(/\.eq\("employee_id", guard\.userId\)/);
    expect(route).toMatch(/requirePermission\(request, "my_account", "read"\)/);
  });
  it("the nightly job skips Admin / Super Admin and device-problem branch-days, and does nothing while paused", () => {
    const sql = readFileSync("supabase/migrations/20261124020000_attendance_flags.sql", "utf8");
    // Paused when everything is paused or this module is (automation_off).
    expect(sql).toMatch(/IF public\.automation_off\('attendance_flags'\) THEN RETURN/);
    expect(sql).toMatch(/lower\(p\.role::TEXT\) IN \('employee', 'accountant', 'hr'\)/);
    expect(sql).toMatch(/d\.branch_id NOT IN \(SELECT branch_id FROM gap\)/);
  });
});

describe("backup column lists (Batch 3 fields)", () => {
  it("the CSV backup carries the new correction and transfer fields and the automation table", async () => {
    const { readFileSync: read } = await import("node:fs");
    const schema = read("src/lib/backup/schema.js", "utf8");
    const line = (t) => (schema.match(new RegExp(`\n  ${t}: "([^"]+)"`)) || [])[1] || "";
    for (const c of ["fix_type:text", "reason_code:text", "attachment_path:text", "pay_effect:json", "pay_correction_id:uuid"]) expect(line("attendance_corrections")).toContain(c);
    for (const c of ["effective_date:date", "applied_at:tstz"]) expect(line("transfer_requests")).toContain(c);
    expect(line("automation_actions")).toContain("rule:text");
  });
});
