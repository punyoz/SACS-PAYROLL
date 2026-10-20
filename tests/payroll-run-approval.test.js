/**
 * Payroll Approval (supabase/migrations/20261014010000_payroll_run_approval.sql).
 *
 * The routes, the payroll locks, the employee payslip gate and the snapshot
 * shaping run for real on the in-memory database. The four database
 * functions are stood in for by small JS versions with the same rules
 * (fakeRunRpcs below); the SQL itself is exercised by
 * scripts/checks/payroll-run-approval-scenarios.sql on a local replay.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inflateRawSync } from "node:zlib";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";
import {
  attentionFlags, describeRunError, payslipVisible, previousSameCutoffLabel, requiresApproval, runTotals, shapeRunItem,
} from "@/lib/payroll/runs";
import { buildXlsx, crc32 } from "@/lib/export/xlsx";
import { buildTablePdf } from "@/lib/export/table-pdf";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

afterEach(() => { vi.useRealTimers(); });

/* ── Pure rules ─────────────────────────────────────────────────────────── */

describe("run rules", () => {
  it("payslips from Oct 1, 2026 wait for approval; older ones never did", () => {
    expect(requiresApproval("September 16-30, 2026")).toBe(false);
    expect(requiresApproval("October 1-15, 2026")).toBe(true);
    expect(payslipVisible("October 1-15, 2026", "pending")).toBe(false);
    expect(payslipVisible("October 1-15, 2026", "rejected")).toBe(false);
    expect(payslipVisible("October 1-15, 2026", "approved")).toBe(true);
    expect(payslipVisible("September 16-30, 2026", null)).toBe(true);
  });

  it("compares with the same cutoff of the month before", () => {
    expect(previousSameCutoffLabel("October 16-31, 2026")).toBe("September 16-30, 2026");
    expect(previousSameCutoffLabel("January 1-15, 2027")).toBe("December 1-15, 2026");
  });

  it("highlights net below zero, no days worked and a large change", () => {
    expect(attentionFlags({ grossPay: 1000, totalDeductions: 1500, netPay: 0, daysWorked: 2, previousNet: null })).toContain("negative_net");
    expect(attentionFlags({ grossPay: 1000, totalDeductions: 0, netPay: 1000, daysWorked: 0, previousNet: null })).toContain("zero_days");
    expect(attentionFlags({ grossPay: 30000, totalDeductions: 0, netPay: 30000, daysWorked: 10, previousNet: 20000 })).toEqual(["large_change"]);
    expect(attentionFlags({ grossPay: 21000, totalDeductions: 0, netPay: 21000, daysWorked: 10, previousNet: 20000 })).toEqual([]);
  });

  it("maps the database's refusals to HTTP", () => {
    expect(describeRunError({ message: "self_approval: you processed this payroll" })).toMatchObject({ status: 403, code: "self_approval" });
    expect(describeRunError({ message: "invalid_transition: this run is approved" })).toMatchObject({ status: 409, code: "invalid_transition" });
    expect(describeRunError({ message: "remarks_required: write the reason" })).toMatchObject({ status: 409, error: "write the reason" });
  });
});

describe("exports", () => {
  it("writes a real .xlsx (a ZIP with the sheet inside)", () => {
    expect(crc32(Buffer.from("hello"))).toBe(0x3610a686);
    const file = buildXlsx([{ name: "Payroll", columns: [{ header: "Employee" }, { header: "Net" }], rows: [["Ana & Co", 1234.5]] }]);
    expect(file.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    // Read the parts back out of the archive.
    const parts = {};
    for (let at = 0; file.readUInt32LE(at) === 0x04034b50;) {
      const packed = file.readUInt32LE(at + 18);
      const nameLength = file.readUInt16LE(at + 26);
      const name = file.subarray(at + 30, at + 30 + nameLength).toString("utf8");
      const start = at + 30 + nameLength;
      parts[name] = inflateRawSync(file.subarray(start, start + packed)).toString("utf8");
      at = start + packed;
    }
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]));
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("Ana &amp; Co");
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("<v>1234.5</v>");
  });

  it("writes a multi-page PDF for a long run", () => {
    const pdf = buildTablePdf({ title: "Payroll", columns: [{ header: "Employee", width: 200 }, { header: "Net", width: 80, align: "right" }], rows: Array.from({ length: 120 }, (_, i) => [`Employee ${i}`, "1,000.00"]) });
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect((text.match(/\/Type \/Page /g) || []).length).toBeGreaterThan(2);
  });
});

/* ── The workflow through the routes ────────────────────────────────────── */

const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";
const ANA = "aaaaaaaa-1111-4111-8111-000000000001";
const BEN = "aaaaaaaa-1111-4111-8111-000000000002";
const CARA = "aaaaaaaa-1111-4111-8111-000000000003";
const ACCT = "aaaaaaaa-1111-4111-8111-0000000000ac";
const HR = "aaaaaaaa-1111-4111-8111-0000000000e1";
const HR2 = "aaaaaaaa-1111-4111-8111-0000000000e2";
const SA = "aaaaaaaa-1111-4111-8111-0000000000fa";
const ACCT_B = "aaaaaaaa-1111-4111-8111-0000000000ab";
const FIRST = "October 1-15, 2026";
const SECOND = "October 16-31, 2026";
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const LEGAL = { sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000, philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000 };

const rate = (rateType, value, effectiveDate = "2026-01-01") => ({ id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z` });
const log = (id, employeeId, date, fields = {}) => ({
  id, employee_id: employeeId, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, created_at: `${date}T00:00:00Z`,
  status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false, arrival_offset_minutes: 0, ...fields,
});

/** The approval functions, with the SQL's rules (roles, moves, self-approval, snapshot check). */
function fakeRunRpcs() {
  const actor = (id) => table("profiles").find((p) => p.id === id) || null;
  const fail = (message) => ({ data: null, error: { message } });
  const runs = () => table("payroll_runs");
  const record = (run, action, from, who, remarks) => {
    table("payroll_approval_history").push({ id: `h-${table("payroll_approval_history").length}`, run_id: run.id, action, from_status: from, to_status: run.status, actor_id: who.id, actor_role: who.role, actor_name: who.full_name, remarks: remarks || null, created_at: new Date().toISOString() });
    table("audit_logs").push({ module: "payroll_approval", action: `payroll_run_${action}`, entity_id: run.id, actor_id: who.id, actor_role: who.role, metadata: { remarks } });
  };
  const notify = (ids, kind, title, runId) => [...new Set(ids.filter(Boolean))].forEach((id) => table("notifications").push({ id: `n-${table("notifications").length}-${Math.random().toString(16).slice(2, 6)}`, recipient_id: id, kind, title, run_id: runId, read_at: null, created_at: new Date().toISOString() }));
  const summaries = () => runs().map((r) => ({ ...r, branch_name: table("branches").find((b) => b.id === r.branch_id)?.name, flagged_employees: 0 }));

  rpc.results.ensure_payroll_run = ({ p_branch, p_period_label, p_actor }) => {
    const who = actor(p_actor);
    if (!who || !["accountant", "super_admin"].includes(who.role)) return fail("forbidden: only an Accountant or a Super Admin starts a payroll run.");
    let run = runs().find((r) => r.branch_id === p_branch && r.period_label === p_period_label);
    if (!run) {
      const first = p_period_label.includes(" 1-15,");
      run = { id: `bbbbbbbb-2222-4222-8222-${String(runs().length + 1).padStart(12, "0")}`, branch_id: p_branch, period_label: p_period_label, period_start: first ? "2026-10-01" : "2026-10-16", period_end: first ? "2026-10-15" : "2026-10-31", cutoff_type: first ? "first" : "second", status: "draft", submission_no: 0, processed_by: who.id, processed_by_name: who.full_name };
      runs().push(run);
    }
    table("payroll_run_summaries").splice(0, Infinity, ...summaries());
    return { data: run, error: null };
  };
  rpc.results.submit_payroll_run = ({ p_run_id, p_actor, p_items }) => {
    const run = runs().find((r) => r.id === p_run_id);
    const who = actor(p_actor);
    if (!who || !["accountant", "super_admin"].includes(who.role)) return fail("forbidden: only an Accountant or a Super Admin submits payroll.");
    if (!["draft", "rejected"].includes(run.status)) return fail(`invalid_transition: this run is ${run.status} and cannot be submitted.`);
    const finals = table("payroll_entries").filter((e) => e.branch_id === run.branch_id && e.pay_period === run.period_label && e.status === "paid");
    if (finals.map((e) => e.id).sort().join() !== p_items.map((i) => i.entry_id).sort().join()) return fail("snapshot_mismatch: the snapshot must cover exactly the run's Final payslips.");
    const bad = p_items.find((i) => {
      const t = finals.find((e) => e.id === i.entry_id).payroll.totals;
      return Math.round(i.net_pay * 100) !== Math.round(Math.max(0, t.net_pay) * 100)
        || Math.round(i.gross_pay * 100) !== Math.round((t.gross_pay + (t.total_incentives || 0)) * 100);
    });
    if (bad) return fail(`snapshot_mismatch: ${bad.employee_name} does not match the payslip.`);
    const from = run.status;
    run.submission_no += 1;
    p_items.forEach((i) => table("payroll_run_items").push({ id: `item-${table("payroll_run_items").length}`, run_id: run.id, submission_no: run.submission_no, ...i }));
    finals.forEach((e) => { e.run_id = run.id; });
    const totals = runTotals(p_items);
    Object.assign(run, { status: "pending", submitted_by: who.id, submitted_by_name: who.full_name, submitted_at: new Date().toISOString(), remarks: null, total_employees: totals.employees, total_gross: totals.gross, total_deductions: totals.deductions, total_net: totals.net });
    record(run, from === "rejected" ? "resubmitted" : "submitted", from, who, null);
    notify(table("profiles").filter((p) => p.role === "hr").map((p) => p.id), "payroll_run_submitted", "Payroll waiting for approval", run.id);
    table("payroll_run_summaries").splice(0, Infinity, ...summaries());
    return { data: run, error: null };
  };
  const decide = (status) => ({ p_run_id, p_actor, p_remarks }) => {
    const run = runs().find((r) => r.id === p_run_id);
    const who = actor(p_actor);
    if (!who || who.role !== "hr") return fail(`forbidden: only HR ${status === "approved" ? "approves" : "rejects"} payroll.`);
    if (status === "rejected" && String(p_remarks || "").trim().length < 5) return fail("remarks_required: write the reason for rejecting (at least 5 characters).");
    if (run.status !== "pending") return fail(`invalid_transition: this run is ${run.status} and cannot be ${status}.`);
    if (status === "approved" && [run.processed_by, run.submitted_by].includes(who.id)) return fail("self_approval: you processed this payroll, so someone else must approve it.");
    Object.assign(run, { status, reviewed_by: who.id, reviewed_by_name: who.full_name, reviewed_at: new Date().toISOString(), remarks: p_remarks || null });
    if (status === "approved") {
      table("payroll_entries").filter((e) => e.run_id === run.id).forEach((e) => { e.approved_by = who.id; });
      table("early_bird_winners").filter((w) => w.period_label === run.period_label && !w.finalized_at).forEach((w) => { w.finalized_at = new Date().toISOString(); });
    }
    record(run, status, "pending", who, p_remarks);
    notify([run.processed_by, run.submitted_by], `payroll_run_${status}`, `Payroll ${status}`, run.id);
    table("payroll_run_summaries").splice(0, Infinity, ...summaries());
    return { data: run, error: null };
  };
  rpc.results.approve_payroll_run = decide("approved");
  rpc.results.reject_payroll_run = decide("rejected");
}

describe("Payroll Approval workflow", () => {
  let payroll;
  let runsRoute;
  let hrRoute;
  let payslipsRoute;
  let notificationsRoute;
  let proxy;
  let createSessionToken;
  let SESSION_COOKIE;

  const session = (who) => {
    const person = table("profiles").find((p) => p.id === who);
    return createSessionToken({ user_id: who, role: person.role, branch_id: person.branch_id ?? null, email: person.email, full_name: person.full_name, session_id: `s-${who}` });
  };
  const req = (who, path, method = "GET", body = null) => {
    const request = new Request(`https://sacs.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${session(who)}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    request.nextUrl = new URL(request.url);
    return request;
  };
  const json = async (responsePromise) => {
    const response = await responsePromise;
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  async function processBranchA(period = FIRST) {
    const result = await json(payroll.POST(req(ACCT, "/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: period, entries: [{ employee_id: ANA }, { employee_id: BEN }] })));
    expect(result.status).toBe(200);
    expect(result.body.processed).toHaveLength(2);
  }
  async function submitBranchA(period = FIRST) {
    return json(runsRoute.PATCH(req(ACCT, "/api/accountant/payroll-runs", "PATCH", { action: "submit", branch_id: BRANCH_A, period })));
  }
  const runOf = (branchId, period = FIRST) => table("payroll_runs").find((r) => r.branch_id === branchId && r.period_label === period);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-payroll-approval";
    resetDb();
    const meta = (role, name, code, branch) => ({ role, full_name: name, employee_id: code, basic_salary: 52200, branch_id: branch });
    users.push(
      { id: ANA, email: "ana@sacs.test", user_metadata: meta("employee", "Ana Preschool", "SACS-001", BRANCH_A) },
      { id: BEN, email: "ben@sacs.test", user_metadata: meta("employee", "Ben Senior High", "SACS-002", BRANCH_A) },
      { id: CARA, email: "cara@sacs.test", user_metadata: meta("employee", "Cara Clerk", "SACS-003", BRANCH_B) },
    );
    table("branches").push({ id: BRANCH_A, name: "Main", status: "active" }, { id: BRANCH_B, name: "Annex", status: "active" });
    table("profiles").push(
      { id: ANA, full_name: "Ana Preschool", email: "ana@sacs.test", branch_id: BRANCH_A, role: "employee", employee_id: "SACS-001", archived: false, employee_level: "preschool" },
      { id: BEN, full_name: "Ben Senior High", email: "ben@sacs.test", branch_id: BRANCH_A, role: "employee", employee_id: "SACS-002", archived: false, employee_level: "senior_high" },
      { id: CARA, full_name: "Cara Clerk", email: "cara@sacs.test", branch_id: BRANCH_B, role: "employee", employee_id: "SACS-003", archived: false },
      { id: ACCT, full_name: "Ana Accountant", email: "acct@sacs.test", branch_id: BRANCH_A, role: "accountant" },
      { id: ACCT_B, full_name: "Bert Accountant", email: "acct-b@sacs.test", branch_id: BRANCH_B, role: "accountant" },
      { id: HR, full_name: "Helen HR", email: "hr@sacs.test", branch_id: null, role: "hr" },
      { id: HR2, full_name: "Hugo HR", email: "hr2@sacs.test", branch_id: null, role: "hr" },
      { id: SA, full_name: "Sam Super", email: "sa@sacs.test", branch_id: null, role: "super_admin" },
    );
    table("payroll_rate_configs").push(
      rate("hourly", 68.75), rate("daily", 550), rate("half_day_pct", 50), rate("absent_pct", 100),
      rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 100), rate("perfect_attendance_bonus", 0),
      ...Object.entries({ ...LEGAL, overtime_premium_pct: 25, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30, working_days_per_year: 261 })
        .map(([type, value]) => rate(type, value, "2026-10-01")),
    );
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({ id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z" })));
    table("system_config").push({ section: "early_bird", key: "threshold_minutes", value: "15" }, { section: "early_bird", key: "incentive_amount", value: "500" });
    table("attendance_logs").push(
      log("a1", ANA, "2026-10-01", { arrival_offset_minutes: -20 }),
      log("a2", ANA, "2026-10-05", { status: "Late", late_minutes: 20, arrival_offset_minutes: 20 }),
      log("b1", BEN, "2026-10-01", { arrival_offset_minutes: -16 }),
      log("b2", BEN, "2026-10-02", { arrival_offset_minutes: -15 }),
      log("a5", ANA, "2026-10-19", { time_in: null, time_out: null, status: "Absent", arrival_offset_minutes: null }),
    );
    table("payroll_runs");
    table("payroll_run_items");
    table("payroll_run_summaries");
    table("payroll_approval_history");
    table("notifications");
    fakeRunRpcs();

    payroll = await import("@/app/api/accountant/payroll/route");
    runsRoute = await import("@/app/api/accountant/payroll-runs/route");
    hrRoute = await import("@/app/api/hr/payroll-runs/route");
    payslipsRoute = await import("@/app/api/employee/payslips/route");
    notificationsRoute = await import("@/app/api/notifications/route");
    ({ proxy } = await import("@/proxy"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("refuses to submit while an employee has no Final payslip", async () => {
    await json(payroll.POST(req(ACCT, "/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: FIRST, entries: [{ employee_id: ANA }] })));
    const result = await submitBranchA();
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "missing_payslips", missing: [{ name: "Ben Senior High" }] });
    expect(table("payroll_runs")).toHaveLength(0);
  });

  it("Accountant submits: Pending, the snapshot saved, HR notified, the run locked", async () => {
    await processBranchA();
    const result = await submitBranchA();
    expect(result.status).toBe(200);
    expect(result.body.run).toMatchObject({ status: "pending", total_employees: 2 });
    const call = rpc.calls.find((c) => c.fn === "submit_payroll_run");
    expect(call.args.p_actor).toBe(ACCT);
    expect(call.args.p_items.map((i) => i.employee_name).sort()).toEqual(["Ana Preschool", "Ben Senior High"]);

    // Both HR accounts are notified, and see it in their bell.
    expect(table("notifications").filter((n) => n.kind === "payroll_run_submitted").map((n) => n.recipient_id).sort()).toEqual([HR, HR2].sort());
    const bell = await json(notificationsRoute.GET(req(HR, "/api/notifications")));
    expect(bell.body).toMatchObject({ unread: 1, notifications: [expect.objectContaining({ kind: "payroll_run_submitted" })] });
    // The sidebar badge.
    expect((await json(hrRoute.GET(req(HR, "/api/hr/payroll-runs?count=1")))).body.pending).toBe(1);
  });

  it("HR opens the run and sees every employee's computation; totals are the sum of the rows", async () => {
    await processBranchA();
    await submitBranchA();
    const list = await json(hrRoute.GET(req(HR, "/api/hr/payroll-runs?status=pending")));
    expect(list.body.runs).toEqual([expect.objectContaining({ branch_name: "Main", period_label: FIRST, status: "pending", total_employees: 2 })]);
    const detail = await json(hrRoute.GET(req(HR, `/api/hr/payroll-runs?run_id=${list.body.runs[0].id}`)));
    expect(detail.status).toBe(200);
    expect(detail.body.can_review).toBe(true);
    const [ana, ben] = detail.body.items;
    expect(ana).toMatchObject({ employee_name: "Ana Preschool", employee_level: "Pre-school", late_minutes: 20, late_deduction: 100, attendance_deduction: 100, net_pay: 26000 });
    expect(ana.breakdown.cutoff.deductions).toEqual([expect.objectContaining({ label: "Late (1 day)", amount: 100 })]);
    expect(ana.breakdown.rates).toMatchObject({ daily: 2400, hourly: 300 });
    expect(ben).toMatchObject({ early_bird_incentive: 500, net_pay: 26600 });
    const sum = (key) => detail.body.items.reduce((total, item) => total + item[key], 0);
    expect(detail.body.run.totals).toEqual({ employees: 2, gross: sum("gross_pay"), deductions: sum("total_deductions"), net: sum("net_pay") });
    expect(detail.body.run.totals.net).toBe(52600);
    // The Early Bird winner shows on the run, not locked yet.
    expect(detail.body.early_bird).toMatchObject({ employee_name: "Ben Senior High", early_count: 2, amount: 500, finalized: false });
    // 1st cutoff: attendance only, no tax, contributions or loans on any row.
    detail.body.items.forEach((item) => expect([item.withholding_tax, item.sss, item.philhealth, item.pagibig, item.loans]).toEqual([0, 0, 0, 0, 0]));
  });

  it("the snapshot stays the same when attendance or the payslip changes after submission", async () => {
    await processBranchA();
    await submitBranchA();
    const run = runOf(BRANCH_A);
    const before = (await json(hrRoute.GET(req(HR, `/api/hr/payroll-runs?run_id=${run.id}`)))).body.items;
    // Something rewrites the attendance and the payslip behind the run's back
    // (the database refuses this; here the snapshot must not care either way).
    table("attendance_logs").push(log("a9", ANA, "2026-10-06", { status: "Absent", time_in: null, time_out: null }));
    const entry = table("payroll_entries").find((e) => e.employee_id === ANA && e.pay_period === FIRST);
    entry.payroll = { ...entry.payroll, totals: { ...entry.payroll.totals, net_pay: 1 } };
    const after = (await json(hrRoute.GET(req(HR, `/api/hr/payroll-runs?run_id=${run.id}`)))).body.items;
    expect(after).toEqual(before);
  });

  it("HR approves: the run is locked, the Early Bird winner too, and employees see their payslips", async () => {
    await processBranchA();
    await submitBranchA();
    const run = runOf(BRANCH_A);
    // Pending: Ana cannot see her payslip yet.
    expect((await json(payslipsRoute.GET(req(ANA, "/api/employee/payslips?email=ana@sacs.test")))).body.payslips).toEqual([]);
    table("early_bird_winners").push({ period_label: FIRST, employee_id: BEN, early_count: 2, amount: 500, window_start: "2026-10-01", window_end: "2026-10-15", finalized_at: null });

    const approved = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [run.id] })));
    expect(approved.status).toBe(200);
    expect(run.status).toBe("approved");
    expect(table("early_bird_winners")[0].finalized_at).toBeTruthy();
    expect(table("notifications").filter((n) => n.kind === "payroll_run_approved").map((n) => n.recipient_id)).toEqual([ACCT]);
    // Each employee on the run is told the payslip is ready (2026-10-20 audit).
    expect(table("notifications").filter((n) => n.kind === "payslip_released").map((n) => n.recipient_id)).toContain(ANA);

    const visible = (await json(payslipsRoute.GET(req(ANA, "/api/employee/payslips?email=ana@sacs.test")))).body.payslips;
    expect(visible).toEqual([expect.objectContaining({ period_label: FIRST, net_pay: 26000 })]);

    // Locked: no reprocess, override, new payslip or cancel.
    const reprocess = await json(payroll.PATCH(req(ACCT, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: ANA, pay_period: FIRST, reprocess: true })));
    expect(reprocess).toMatchObject({ status: 409, body: { code: "payroll_run_locked" } });
    // The Super Admin no longer reaches payroll at all (2026-10-20).
    const override = await json(payroll.PATCH(req(SA, "/api/accountant/payroll", "PATCH", { action: "override_final", employee_id: ANA, pay_period: FIRST, reason: "Correcting a late tap" })));
    expect(override.status).toBe(403);
  });

  it("an Accountant cannot edit a Pending run, nor approve one", async () => {
    await processBranchA();
    await submitBranchA();
    const generate = await json(payroll.PATCH(req(ACCT, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: BEN, pay_period: FIRST, reprocess: true })));
    expect(generate).toMatchObject({ status: 409, body: { code: "payroll_run_locked" } });
    const single = await json(payroll.POST(req(ACCT, "/api/accountant/payroll", "POST", { action: "save_draft", employee_id: BEN, pay_period: FIRST })));
    expect(single.body.code).toBe("payroll_run_locked");
    const batch = await json(payroll.POST(req(ACCT, "/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: FIRST, entries: [{ employee_id: BEN }] })));
    expect(batch.body.skipped).toEqual([expect.objectContaining({ code: "payroll_run_locked" })]);
    // A second submit of a Pending run is refused by the database function.
    expect((await submitBranchA()).body.code).toBe("invalid_transition");

    // Approving: the proxy and the route both say no.
    expect((await proxy(req(ACCT, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [runOf(BRANCH_A).id] }))).status).toBe(403);
    expect((await json(hrRoute.PATCH(req(ACCT, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [runOf(BRANCH_A).id] })))).status).toBe(403);
    // Super Admin views only.
    expect((await json(hrRoute.PATCH(req(SA, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [runOf(BRANCH_A).id] })))).status).toBe(403);
    expect(runOf(BRANCH_A).status).toBe("pending");
  });

  it("nobody approves a run they processed", async () => {
    await processBranchA();
    await submitBranchA();
    // An HR account that processed this run (e.g. moved from Accountant).
    runOf(BRANCH_A).processed_by = HR;
    const result = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [runOf(BRANCH_A).id] })));
    expect(result.status).toBe(403);
    expect(result.body.results[0]).toMatchObject({ ok: false, code: "self_approval" });
    expect(runOf(BRANCH_A).status).toBe("pending");
  });

  it("HR cannot change a computation", async () => {
    await processBranchA();
    await submitBranchA();
    // No payroll access at all: the proxy refuses HR on the Accountant's routes.
    expect((await proxy(req(HR, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: ANA, pay_period: FIRST, reprocess: true }))).status).toBe(403);
    expect((await proxy(req(HR, "/api/accountant/payroll-runs", "PATCH", { action: "submit", branch_id: BRANCH_A, period: FIRST }))).status).toBe(403);
    // And its own route has no editing action.
    const edit = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "update_item", run_id: runOf(BRANCH_A).id, net_pay: 99999 })));
    expect(edit.status).toBe(400);
  });

  it("rejecting needs a reason; the Accountant then corrects and resubmits", async () => {
    await processBranchA();
    await submitBranchA();
    const run = runOf(BRANCH_A);
    const noReason = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "reject", run_id: run.id, remarks: " " })));
    expect(noReason).toMatchObject({ status: 400, body: { code: "remarks_required" } });
    expect(run.status).toBe("pending");

    const rejected = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "reject", run_id: run.id, remarks: "Ana's Oct 5 late is a correction in progress" })));
    expect(rejected.status).toBe(200);
    expect(run).toMatchObject({ status: "rejected", remarks: "Ana's Oct 5 late is a correction in progress" });
    expect(table("notifications").find((n) => n.kind === "payroll_run_rejected")?.recipient_id).toBe(ACCT);
    // Nothing was cleared: the payslips are still there.
    expect(table("payroll_entries").filter((e) => e.pay_period === FIRST && e.status === "paid")).toHaveLength(2);
    // The Accountant sees the reason.
    const panel = await json(runsRoute.GET(req(ACCT, `/api/accountant/payroll-runs?period=${encodeURIComponent(FIRST)}`)));
    expect(panel.body.runs[0]).toMatchObject({ status: "rejected", editable: true, can_submit: true, run: expect.objectContaining({ remarks: "Ana's Oct 5 late is a correction in progress" }) });

    // HR approved the correction: Ana's Oct 5 is now On Time. Reprocess, resubmit.
    Object.assign(table("attendance_logs").find((l) => l.id === "a2"), { status: "Corrected", late_minutes: 0, arrival_offset_minutes: 0 });
    const reprocessed = await json(payroll.PATCH(req(ACCT, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: ANA, pay_period: FIRST, reprocess: true })));
    expect(reprocessed.status).toBe(200);
    expect(table("payroll_records").filter((r) => r.employee_id === ANA && r.period_label === FIRST).map((r) => r.archived)).toEqual([true, false]);
    const resubmitted = await submitBranchA();
    expect(resubmitted.body.run).toMatchObject({ status: "pending", submission_no: 2 });
    const detail = (await json(hrRoute.GET(req(HR, `/api/hr/payroll-runs?run_id=${run.id}`)))).body;
    expect(detail.items.find((i) => i.employee_name === "Ana Preschool")).toMatchObject({ late_deduction: 0, net_pay: 26100 });
    expect(detail.history.map((h) => h.action)).toEqual(["submitted", "rejected", "resubmitted"]);
    expect(table("audit_logs").filter((a) => a.module === "payroll_approval").map((a) => a.actor_role)).toEqual(["accountant", "hr", "accountant"]);

    // HR's History (2026-10-20): every decision stays listed, the rejection
    // included, each with the submission it answered.
    await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [run.id], remarks: "OK now" })));
    const history = (await json(hrRoute.GET(req(HR, "/api/hr/payroll-runs?view=history")))).body;
    expect(history.available).toBe(true);
    expect(history.history.map((h) => [h.decision, h.period_label, h.branch_name])).toEqual([["approved", FIRST, "Main"], ["rejected", FIRST, "Main"]]);
    expect(history.history[1]).toMatchObject({ remarks: "Ana's Oct 5 late is a correction in progress", decided_by_name: expect.any(String), submitted_by_name: expect.any(String), submitted_at: expect.any(String), decided_at: expect.any(String) });
    expect(history.history[0].submitted_at >= history.history[1].decided_at).toBe(true);
  });

  it("a 2nd cutoff run shows every deduction", async () => {
    await processBranchA();
    await submitBranchA();
    await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: [runOf(BRANCH_A).id] })));
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    await processBranchA(SECOND);
    expect((await submitBranchA(SECOND)).status).toBe(200);
    const detail = (await json(hrRoute.GET(req(HR, `/api/hr/payroll-runs?run_id=${runOf(BRANCH_A, SECOND).id}`)))).body;
    const ana = detail.items.find((i) => i.employee_name === "Ana Preschool");
    expect(ana).toMatchObject({ absence_deduction: 2400, sss: 1750, philhealth: 1305, pagibig: 200 });
    expect(ana.withholding_tax).toBeGreaterThan(0);
    expect(ana.breakdown.cutoff.deductions.map((l) => l.label)).toEqual(["Absences (1 day)", "SSS", "PhilHealth", "Pag-IBIG", "Withholding tax"]);
  });

  it("HR approves two branches at once: one record each", async () => {
    await processBranchA();
    await submitBranchA();
    // Annex: processed and submitted by its own Accountant; the Super Admin
    // can do neither (2026-10-20).
    expect((await json(payroll.PATCH(req(SA, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: CARA, pay_period: FIRST })))).status).toBe(403);
    expect((await json(runsRoute.PATCH(req(SA, "/api/accountant/payroll-runs", "PATCH", { action: "submit", branch_id: BRANCH_B, period: FIRST })))).status).toBe(403);
    expect((await json(payroll.PATCH(req(ACCT_B, "/api/accountant/payroll", "PATCH", { action: "generate", employee_id: CARA, pay_period: FIRST })))).status).toBe(200);
    const annex = await json(runsRoute.PATCH(req(ACCT_B, "/api/accountant/payroll-runs", "PATCH", { action: "submit", branch_id: BRANCH_B, period: FIRST })));
    expect(annex.status).toBe(200);
    const ids = [runOf(BRANCH_A).id, runOf(BRANCH_B).id];
    const result = await json(hrRoute.PATCH(req(HR, "/api/hr/payroll-runs", "PATCH", { action: "approve", run_ids: ids })));
    expect(result.body).toMatchObject({ approved: 2 });
    expect(ids.map((id) => table("payroll_runs").find((r) => r.id === id).status)).toEqual(["approved", "approved"]);
    expect(table("payroll_approval_history").filter((h) => h.action === "approved")).toHaveLength(2);
    expect(rpc.calls.filter((c) => c.fn === "approve_payroll_run")).toHaveLength(2);
  });
});
