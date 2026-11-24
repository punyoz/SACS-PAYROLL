// The 2026-11-24 release: the Admin views and monitors; HR <-> Admin messages and
// the same counts; automatic substitution proposals; AWOL fully automatic (app
// side); Settings > Automation; one RFID page; one filter bar.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { leaveDays, proposalSpan } from "@/lib/substitutions/proposals";
import { TRANSITIONS, canTransition } from "@/lib/awol/cases";

const src = (p) => readFileSync(p, "utf8");

describe("substitution proposals from an approved leave", () => {
  const schedule = { work_start: 480, work_end: 1020, work_hours: 8 };
  it("a whole day covers the schedule; periods = its hours (at most 10)", () => {
    expect(proposalSpan(schedule)).toEqual({ start: "08:00", end: "17:00", periods: 8 });
    expect(proposalSpan({ work_start: 420, work_end: 1200, work_hours: 12 }).periods).toBe(10);
  });
  it("a half day covers the morning or the afternoon half", () => {
    expect(proposalSpan(schedule, "AM")).toEqual({ start: "08:00", end: "12:30", periods: 4 });
    expect(proposalSpan(schedule, "PM")).toEqual({ start: "12:30", end: "17:00", periods: 4 });
  });
  it("no schedule, no proposal", () => {
    expect(proposalSpan(null)).toBeNull();
    expect(proposalSpan({ work_start: 600, work_end: 600 })).toBeNull();
  });
  it("school days only: weekends and whole-day holidays left out", () => {
    // Fri Nov 13 to Tue Nov 17, Nov 16 a holiday here.
    expect(leaveDays("2026-11-13", "2026-11-17", ["2026-11-16"])).toEqual(["2026-11-13", "2026-11-17"]);
  });
  it("the server: the Admin cannot file; HR files only an unplanned absence; a proposal is approved with the picked teacher", () => {
    const route = src("src/app/api/substitutions/route.js");
    expect(route).toMatch(/if \(guard\.role !== "hr" && guard\.role !== "super_admin"\) \{\n\s+return NextResponse\.json\(\{ error: "Substitutions come from approved leave/);
    expect(route).toMatch(/if \(!unplanned\) return NextResponse\.json/);
    expect(route).toMatch(/This teacher is on approved leave that day: the system has proposed the substitution/);
    expect(route).toMatch(/if \(action === "approve" && !substituteId\) \{\n\s+substituteId = String\(body\.substitute_id \|\| ""\);\n\s+if \(!UUID\.test\(substituteId\)\) return NextResponse\.json\(\{ error: "Pick the substitute teacher\." \}/);
    // The same rules as the suggestions: only a suggested teacher.
    expect(route).toMatch(/if \(!out\.suggestions\.some\(\(x\) => x\.id === substituteId\)\)/);
    const hook = src("src/lib/automation/leave-recommendations.js");
    expect(hook).toMatch(/if \(decision === "cancel"\) \{ await cancelSubstitutionProposals\(supabase, leave\.id\); return; \}/);
    expect(hook).toMatch(/if \(facts\.teaching && facts\.days\.length\) await proposeSubstitutions\(supabase, leave\);/);
    const sql = src("supabase/migrations/20261124150000_admin_view_only_presets.sql");
    expect(sql).toMatch(/CHECK \(status <> 'approved' OR substitute_id IS NOT NULL\)/);
  });
});

describe("the Admin views and monitors (2026-11-24)", () => {
  it("files only incidents, incentive proposals and RFID issues, each with a preset remark (decision \"file\")", () => {
    const route = src("src/app/api/admin/branch-oversight/route.js");
    expect(route).toMatch(/const ADMIN_FILES = new Set\(\["incident_report", "incentive_endorsement", "rfid_issue"\]\);/);
    expect(route).toMatch(/if \(!ADMIN_FILES\.has\(kind\)\) \{\n\s+return bad\("The system checks this and sends it straight to HR/);
    expect(route).toMatch(/resolveRemark\(supabase, body\.remark, \{ decision: "file", entityType: kind, required: true/);
    const sql = src("supabase/migrations/20261124150000_admin_view_only_presets.sql");
    for (const label of ["Repeated tardiness", "No-show without notice", "Left without time out", "Misconduct reported", "Extra class/coaching", "Event hosting", "Overload", "Card lost", "Card damaged", "Reader not working", "Card not registered"]) {
      expect(sql).toContain(`'${label}'`);
    }
    expect(sql).toMatch(/WHEN p_kind = 'proposal' THEN 'with_hr'/);
  });
  it("the Admin's pages have no decision buttons", () => {
    const pages = ["src/app/admin/endorsement-pages.jsx", "src/app/admin/requests-pages.jsx", "src/app/admin/attendance-page.jsx"].map(src).join("\n");
    for (const word of [">Recommend<", ">Endorse<", "Not endorse", ">Note</Button>", ">Object</Button>", "Flag issue</Button>", "Arrange substitute"]) expect(pages).not.toContain(word);
    expect(src("src/app/admin/requests-pages.jsx")).toMatch(/kind="schedule_request"\n\s+readOnly/);
  });
  it("messages: branch-scoped, information only, logged, the other side told", () => {
    const route = src("src/app/api/branch-messages/route.js");
    expect(route).toMatch(/if \(guard\.role !== "admin"\) return false;\n\s+return !guard\.branchId \|\| !branches\.includes\(String\(guard\.branchId\)\);/);
    expect(route).toMatch(/action: "branch_message"/);
    expect(src("src/proxy.js")).toMatch(/const POST_IS_READ = \[[\s\S]*"\/api\/branch-messages",/);
    const sql = src("supabase/migrations/20261124160000_branch_item_messages.sql");
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.branch_item_messages/);
  });
  it("the same branch numbers on both dashboards (one function)", () => {
    expect(src("src/app/api/admin/branch-oversight/route.js")).toMatch(/await branchCounts\(supabase, branchId, today\)/);
    expect(src("src/app/api/hr/dashboard/route.js")).toMatch(/await branchCounts\(supabase, b\.id, today\)/);
  });
});

describe("Settings > Automation; no card on any dashboard", () => {
  it("no dashboard shows the Automation card", () => {
    for (const p of ["src/app/hr/dashboard-page.jsx", "src/app/admin/dashboard-page.jsx", "src/app/super-admin/dashboard-page.jsx", "src/app/accountant/dashboard-page.jsx"]) {
      expect(src(p), p).not.toContain("<AutomationCard");
    }
    expect(src("src/app/hr/hr-portal.jsx")).toMatch(/\{ id: "hr-automation", label: "Automation"/);
    expect(src("src/app/super-admin/super-admin-portal.jsx")).toMatch(/\{ id: "sa-automation", label: "Automation"/);
  });
  it("the renamed modules", async () => {
    const { AUTOMATION_MODULES } = await import("@/lib/automation/shared");
    expect(AUTOMATION_MODULES.leave_recommendations).toBe("Leave checks");
    expect(AUTOMATION_MODULES.transfer_endorsements).toBe("Transfer checks");
  });
});

describe("profile: accounts not on payroll", () => {
  it("no Government contributions unless on payroll", () => {
    const page = src("src/components/portal/staff-profile.jsx");
    // 2026-11-26: the shared sections (Employment too), still only when on payroll.
    expect(page).toMatch(/\{accountOnly \|\| onPayroll !== true \? null : <EmploymentSection employment=\{stored\.employment\} \/>\}/);
    expect(page).toMatch(/\{accountOnly \|\| onPayroll !== true \? null : <GovernmentSection numbers=\{governmentNumbers\(stored, ctx\)\} \/>\}/);
    expect(page).toMatch(/<Section icon=\{ShieldCheckIcon\} title="Government contributions">/);
    expect(src("src/app/employee/profile-page.jsx")).toMatch(/\{onPayroll === true \? <GovernmentSection /);
    expect(src("src/app/api/legacy-auth/update-profile/route.js")).toMatch(/"on_payroll",/);
  });
});

describe("one RFID page; one filter bar", () => {
  it("old RFID tabs open the one RFID page", () => {
    expect(src("src/app/hr/hr-portal.jsx")).toMatch(/"hr-rfid-terminals": \{ page: "hr-rfid-cards", params: \{\} \}/);
    expect(src("src/app/admin/admin-portal.jsx")).toMatch(/redirectMovedPage\(\{ "adm-rfid-issues": "adm-maintenance" \}\)/);
    expect(src("src/app/super-admin/super-admin-portal.jsx")).toMatch(/redirectMovedPage\(\{ "sa-rfid-terminal": "sa-maintenance", "sa-rfid-issues": "sa-maintenance" \}\)/);
    // Cards, then the issues, then the card history.
    const panel = src("src/components/portal/rfid/rfid-cards-panel.jsx");
    expect(panel.indexOf("{children}")).toBeLessThan(panel.indexOf(">Card history</CardTitle>"));
    expect(panel.indexOf('id="rfid-cards-table"')).toBeLessThan(panel.indexOf("{children}"));
  });
  it("the filter bar brings the one search box; the table then shows none", () => {
    expect(src("src/components/portal/approval-filters.jsx")).toMatch(/data-owns-search="true"/);
    expect(src("src/components/portal/data-table.jsx")).toMatch(/typeof toolbar !== "function" && ownsSearch\(toolbar\)/);
    expect(src("src/components/portal/approval-filters.jsx")).not.toContain("Any employment status");
  });
  it("rows per page: 10 everywhere", () => {
    const { execSync } = require("node:child_process");
    const hits = execSync("git grep -n \"pageSize={15}\" -- src || true", { encoding: "utf8" });
    expect(hits.trim()).toBe("");
  });
});

describe("AWOL: fully automatic until separation (app side)", () => {
  it("HR's actions: one button, stop and resume", () => {
    expect(canTransition("confirm_send", "flagged")).toBe(true);
    expect(canTransition("confirm_send", "first_notice")).toBe(false);
    for (const stage of ["flagged", "first_notice", "second_notice"]) {
      expect(canTransition("stop_automation", stage)).toBe(true);
      expect(canTransition("resume_automation", stage)).toBe(true);
    }
    expect(TRANSITIONS.stop_automation.from).not.toContain("closed");
    const route = src("src/app/api/hr/awol-cases/route.js");
    // A reply recorded by HR stops the automation.
    expect(route).toMatch(/automation: "response", automation_reason: "Response received: the employee replied\. HR decides\."/);
  });
  it("the daily delivery refuses without its secret, and when no secret is set", async () => {
    vi.resetModules();
    const old = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      const { GET } = await import("@/app/api/cron/awol-notices/route");
      expect((await GET(new Request("http://x/api/cron/awol-notices", { headers: { authorization: "Bearer " } }))).status).toBe(401);
      process.env.CRON_SECRET = "a-long-enough-test-secret";
      expect((await GET(new Request("http://x/api/cron/awol-notices", { headers: { authorization: "Bearer wrong-secret-of-same-len" } }))).status).toBe(401);
      expect((await GET(new Request("http://x/api/cron/awol-notices"))).status).toBe(401);
    } finally {
      if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
    }
  });
  it("existing cases are never automatic; the guards keep demo / test and non-employee accounts out", () => {
    const sql = src("supabase/migrations/20261124190000_awol_fully_automatic.sql");
    expect(sql).toMatch(/UPDATE public\.employee_awol_cases\n\s+SET automation = 'needs_review',\n\s+automation_reason = 'Opened before automatic AWOL \(2026-11-24\): HR decides\.'/);
    expect(sql).toMatch(/WHEN COALESCE\(p\.is_demo, FALSE\) THEN 'A demo \/ test account'/);
    expect(sql).toMatch(/IF public\.automation_off\('awol_cases'\) THEN RETURN 0; END IF;/);
    expect(src("vercel.json")).toMatch(/"path": "\/api\/cron\/awol-notices"/);
  });
});
