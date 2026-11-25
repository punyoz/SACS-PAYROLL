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
    // 2026-11-25: only modules whose switch stops real work get a switch; tracking-only ones stay on.
    const { AUTOMATION_SWITCHES } = await import("@/lib/automation/shared");
    expect(AUTOMATION_SWITCHES).toEqual(["attendance_flags", "schedule_requests", "attendance_corrections", "leave_recommendations", "transfer_endorsements", "rfid_issues", "awol_cases"]);
    for (const m of ["overtime_requests", "substitutions", "incident_tracking", "incentive_recommendations"]) {
      expect(AUTOMATION_SWITCHES).not.toContain(m);
      expect(AUTOMATION_MODULES[m]).toBeTruthy();
    }
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
  it("no Admin step (2026-11-24): note / object refused for everyone; HR: undo; HR / Super Admin: pause and the digests", () => {
    expect(route).toMatch(/if \(action === "note" \|\| action === "object"\) \{\n\s+return NextResponse\.json\(\{ error: "The system sends this straight to HR[^}]*\}, \{ status: 409 \}\);/);
    expect(route).not.toMatch(/admin_noted_by: guard\.userId/);
    expect(route).toMatch(/async function digest\(guard, body\) \{\n\s+if \(guard\.role !== "hr" && guard\.role !== "super_admin"\)/);
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

describe("RFID issues (Part E step 7)", () => {
  it("flags only (no automatic fixes), once per issue, paused with its module, nightly", () => {
    const sql = readFileSync("supabase/migrations/20261124090000_rfid_issues.sql", "utf8");
    expect(sql).toMatch(/IF public\.automation_off\('rfid_issues'\) THEN RETURN/);
    expect(sql).toMatch(/\('rfid_offline_cutoff', '09:00'\)/);
    expect(sql).not.toMatch(/UPDATE public\.rfid_cards/);
    expect(sql).toMatch(/cron\.schedule\('automation-rfid-issues'/);
  });
});

describe("incident tracking (Part E step 8)", () => {
  it("incidents and RFID reports are tracked until HR decides; a no-show is tracked in AWOL Cases", async () => {
    const { trackingFor } = await import("@/lib/automation/incident-tracking");
    expect(trackingFor("incident_report", { employee_name: "Ana", incident_type_label: "Misconduct", incident_date: "2026-11-20" }).summary)
      .toBe("Incident report, Ana: Misconduct on 2026-11-20. HR handles and closes it.");
    expect(trackingFor("rfid_issue", { issue_type_label: "Reader not working", device: "Main gate" }).summary).toMatch(/Reader not working \(Main gate\)/);
    expect(trackingFor("incident_report", {}, { routedElsewhere: true })).toBeNull();
    expect(trackingFor("schedule_request", {})).toBeNull();
    expect(readFileSync("src/app/api/hr/branch-requests/route.js", "utf8")).toMatch(/closeBranchReport\(supabase, row\.id/);
  });
  it("a lost-card report blocks the card at once (reversible deactivate, logged by System)", () => {
    const route = readFileSync("src/app/api/admin/branch-oversight/route.js", "utf8");
    expect(route).toMatch(/details\.issue_type === "lost_card" && employeeId/);
    expect(route).toMatch(/p_action: "deactivate"/);
    expect(route).not.toMatch(/p_action: "mark_lost"/);
  });
});
