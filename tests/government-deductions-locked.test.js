/**
 * Government deductions are computed and read-only for the Accountant
 * (2026-10-26): SSS, PhilHealth, Pag-IBIG and withholding tax always take
 * the value from the rate tables; a different value sent through the API is
 * refused (government_deduction_locked); "Flag for review" notifies HR and
 * the Super Admin instead. Attendance overrides (with a reason) are unchanged.
 *
 * October 2026 2nd half, the ₱15,000 example from the Process Payroll screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { contributionLabel } from "@/lib/payroll/statutory";
import { computeSummary, formDeviations, submissionPayload } from "@/lib/portal/payroll-preview";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const FIRST = "October 1-15, 2026";
const SECOND = "October 16-31, 2026";
const EHD = "7b8837ea-43db-4b30-829a-31b159d08059"; // live: Ehd Astillero Refuerzo, ₱15,000
const PEOPLE = [
  { id: EHD, name: "Ehd Astillero Refuerzo", code: "SACS-001", salary: 15000 },
  { id: "u-low", name: "Lia Floor", code: "SACS-401", salary: 8000 },
  { id: "u-high", name: "Hal Cap", code: "SACS-402", salary: 40000 },
];
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Payroll JM" };
const request = (url, method = "GET", body, who = ACCOUNTANT) => new Request(`https://sacs.test${url}`, {
  method,
  headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${who.user_id}`, email: `${who.user_id}@sacs.test`, ...who })}` },
  body: body ? JSON.stringify(body) : undefined,
});
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);

/** The live settings, with or without the Oct 16 switch to percentages (20261026050000). */
function seed({ percentagesFromOctober }) {
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000, "2018-01-01"),
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
    rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
    rate("contribution_method", 1), rate("sss_fixed", 300, "2026-10-16"), rate("philhealth_fixed", 400, "2026-10-16"), rate("pagibig_fixed", 400, "2026-10-16"),
    rate("contribution_method", 0, "2026-11-01"),
    ...(percentagesFromOctober ? [rate("contribution_method", 0, "2026-10-16")] : []),
  );
}

async function processFirstHalf() {
  vi.setSystemTime(new Date("2026-10-16T10:00:00+08:00"));
  const body = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: FIRST, entries: PEOPLE.map((p) => ({ employee_id: p.id })) }))).json();
  expect(body.processed).toHaveLength(PEOPLE.length);
  vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
}

const secondHalfDefaults = async () => {
  const body = await (await GET(request(`/api/accountant/payroll?period=${encodeURIComponent(SECOND)}`))).json();
  return { body, row: (id) => body.attendance_rows.find((r) => r.employee_id === id) };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-gov-locked";
  resetDb();
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH, role: "accountant", full_name: "Payroll JM" },
    { id: "00000000-0000-4000-8000-0000000000a1", branch_id: null, role: "hr", full_name: "HR Officer", archived: false },
    { id: "00000000-0000-4000-8000-0000000000a2", branch_id: null, role: "super_admin", full_name: "Super Administrator", archived: false },
  );
  PEOPLE.forEach((p) => {
    users.push({ id: p.id, email: `${p.code}@sacs.test`, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
    table("profiles").push({ id: p.id, full_name: p.name, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code, archived: false, basic_salary: p.salary, date_hired: "2024-06-01" });
  });
  table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("the ₱15,000 example, October 16-31", () => {
  it("before (fixed amounts until Nov 1): SSS 300, PhilHealth 400, Pag-IBIG 400 — configured, not typed", async () => {
    seed({ percentagesFromOctober: false });
    await processFirstHalf();
    const { row } = await secondHalfDefaults();
    expect(row(EHD).defaults).toMatchObject({ sss: 300, philhealth: 400, pagibig: 400, contribution_source: { sss: "fixed", philhealth: "fixed", pagibig: "fixed" }, government_locked: true });
  });

  it("after (percentages from Oct 16): SSS 5% × 15,000 = 750, PhilHealth 2.5% × 15,000 = 375, Pag-IBIG 2% × 10,000 = 200", async () => {
    seed({ percentagesFromOctober: true });
    await processFirstHalf();
    const { row } = await secondHalfDefaults();
    const d = row(EHD).defaults;
    expect(d).toMatchObject({ sss: 750, philhealth: 375, pagibig: 200, withholding_tax: 0, government_locked: true });
    expect(d.tax_bracket).toEqual({ over: 0, base: 0, rate_pct: 0 });
    expect([contributionLabel("SSS", d.contribution_basis.sss), contributionLabel("PhilHealth", d.contribution_basis.philhealth), contributionLabel("Pag-IBIG", d.contribution_basis.pagibig)])
      .toEqual(["SSS (5% of ₱15,000 salary credit)", "PhilHealth (2.5% of ₱15,000 basic)", "Pag-IBIG (2% of ₱10,000 fund salary cap)"]);
    // Processing with nothing sent for them uses exactly these figures.
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: SECOND, deductions: {} }));
    expect(res.status).toBe(200);
    expect(entry(EHD, SECOND).payroll.deductions).toMatchObject({ sss: 750, philhealth: 375, pagibig: 200, withholding_tax: 0 });
    // 15,000 − 1,325 = 13,675 for the month; the 1st half paid 7,500.
    expect(entry(EHD, SECOND).payroll.totals.net_pay).toBe(6175);
  });

  it("labels for other salaries: PhilHealth floor at ₱8,000, every cap at ₱40,000", async () => {
    seed({ percentagesFromOctober: true });
    await processFirstHalf();
    const { row } = await secondHalfDefaults();
    const low = row("u-low").defaults;
    expect(low).toMatchObject({ sss: 400, philhealth: 250, pagibig: 160 });
    expect(contributionLabel("PhilHealth", low.contribution_basis.philhealth)).toBe("PhilHealth (2.5% of ₱10,000 floor)");
    const high = row("u-high").defaults;
    expect(high).toMatchObject({ sss: 1750, philhealth: 1000, pagibig: 200 });
    expect(contributionLabel("SSS", high.contribution_basis.sss)).toBe("SSS (5% of ₱35,000 salary credit)");
    // 40,000 − 2,950 = 37,050 → 1,875 + 20% × 3,717 = 2,618.40.
    expect(high.withholding_tax).toBe(2618.4);
    expect(high.tax_bracket).toEqual({ over: 33333, base: 1875, rate_pct: 20 });
  });
});

describe("the API refuses a typed government deduction", () => {
  beforeEach(async () => { seed({ percentagesFromOctober: true }); await processFirstHalf(); });

  it.each([["sss", 300], ["philhealth", 400], ["pagibig", 400], ["withholding_tax", 500]])("single entry: %s = %s → 422, nothing saved", async (field, value) => {
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: SECOND, deductions: { [field]: value }, override_reason: "Typed by hand" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "government_deduction_locked" });
    expect(entry(EHD, SECOND)).toBeUndefined();
  });

  it("a draft and the batch refuse it too; the batch still processes everyone else", async () => {
    const draft = await POST(request("/api/accountant/payroll", "POST", { action: "save_draft", employee_id: EHD, pay_period: SECOND, deductions: { sss: 300 } }));
    expect(draft.status).toBe(422);
    const batch = await (await POST(request("/api/accountant/payroll", "POST", {
      action: "batch_submit", pay_period: SECOND,
      entries: [{ employee_id: EHD, deductions: { philhealth: 400 } }, { employee_id: "u-low" }],
    }))).json();
    expect(batch.skipped).toEqual([expect.objectContaining({ employee_id: EHD, code: "government_deduction_locked" })]);
    expect(batch.processed.map((p) => p.employee_id)).toEqual(["u-low"]);
  });

  it("sending the computed value itself is accepted (no change)", async () => {
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: SECOND, deductions: { sss: 750, philhealth: 375, pagibig: 200, withholding_tax: 0 } }));
    expect(res.status).toBe(200);
  });

  it("attendance overrides still work as before: changed, with a reason, logged", async () => {
    const refused = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: SECOND, deductions: { absences_days: 2 } }));
    expect(refused.status).not.toBe(200);
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: SECOND, deductions: { absences_days: 2 }, override_reason: "Missed RFID tap on Oct 20 and 21 confirmed absent" }));
    expect(res.status).toBe(200);
    const payroll = entry(EHD, SECOND).payroll;
    // 2 × 15,000 × 12 ÷ 261 = 2 × 689.66 = 1,379.32; contributions unchanged.
    expect(payroll.totals.absence_deduction).toBe(1379.32);
    expect(payroll.deductions).toMatchObject({ sss: 750, philhealth: 375, pagibig: 200 });
    expect(payroll.audit.deviations).toMatchObject({ items: [{ field: "absences_days", default: 0, value: 2 }], reason: "Missed RFID tap on Oct 20 and 21 confirmed absent" });
  });
});

describe("Flag for review", () => {
  beforeEach(() => seed({ percentagesFromOctober: true }));

  it("notifies HR and the Super Admin, logs it, and changes nothing", async () => {
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    const res = await POST(request("/api/accountant/payroll", "POST", {
      action: "flag_deduction", employee_id: EHD, pay_period: SECOND, field: "philhealth", amount: 375, note: "Employee says PhilHealth was ₱400 last year",
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).notified).toBe(2);
    const sent = table("notifications");
    expect(sent.map((n) => n.recipient_id).sort()).toEqual(["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"]);
    expect(sent[0]).toMatchObject({ kind: "deduction_flag", title: "PhilHealth flagged for review: Ehd Astillero Refuerzo" });
    expect(table("audit_logs").find((a) => a.action === "deduction_flagged")).toMatchObject({ actor_role: "accountant" });
    expect(table("payroll_entries")).toHaveLength(0);
  });

  it("needs a field it knows and a real note", async () => {
    const post = (body) => POST(request("/api/accountant/payroll", "POST", { action: "flag_deduction", employee_id: EHD, pay_period: SECOND, ...body }));
    expect((await post({ field: "absences", note: "Looks wrong to me here" })).status).toBe(400);
    expect((await post({ field: "sss", note: "wrong" })).status).toBe(400);
  });

  it("only the Accountant's payroll permission reaches it", async () => {
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "flag_deduction", employee_id: EHD, pay_period: SECOND, field: "sss", note: "Please check this one" }, { user_id: EHD, role: "employee", branch_id: BRANCH }));
    expect(res.status).toBe(403);
  });
});

describe("the form helpers never send or count them", () => {
  const data = {
    active_period: { label: SECOND }, semi_monthly: { half: "second" },
    attendance_rows: [{ employee_id: EHD, rates: { daily: 689.66, hourly: 86.21 }, pay: { unit_amounts: { daily: 689.66, hourly: 86.21, absent: 689.66, half_day: 344.83, late_days_per_absent: 0, late_minute_pct: 0, perfect_attendance: 0 }, counts: {}, amounts: {} },
      defaults: { basic_salary: 15000, statutory_method: "legal", government_locked: true, sss: 750, philhealth: 375, pagibig: 200, withholding_tax: 0, semi_monthly: "second", first_half_paid: 7500 } }],
  };
  const employee = { id: EHD };
  const form = { basic: "15000", sss: "300", philhealth: "400", pagibig: "400", tax: "99", taxEdited: true, absences: "0", late: "0", undertime: "0", halfDays: "0", lwp: "0", lwop: "0", perfect: false, overrideReason: "" };

  it("the summary uses the computed figures whatever a field holds", () => {
    const summary = computeSummary(data, employee, form);
    expect([summary.sss, summary.philhealth, summary.pagibig]).toEqual([750, 375, 200]);
    expect(summary.tax).not.toBe(99);
  });

  it("they are not overrides, and the payload leaves them out", () => {
    expect(formDeviations(data, employee, form, 0)).toEqual([]);
    const payload = submissionPayload("submit", { employee, period: SECOND, form, tax: 99, data });
    expect(payload.deductions).not.toHaveProperty("sss");
    expect(payload.deductions).not.toHaveProperty("philhealth");
    expect(payload.deductions).not.toHaveProperty("pagibig");
    expect(payload.deductions).not.toHaveProperty("withholding_tax");
    expect(payload.deductions).toHaveProperty("absences_days", 0);
  });
});
