/**
 * Final payslips do not change when attendance is corrected afterwards; the
 * correction says so, and the Super Admin's override list marks them
 * (src/lib/payroll/final-payslips.js).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let lib;
let supabase;

const secondHalf = {
  id: "pe-oct2", employee_id: "e1", pay_period: "October 16-31, 2026", status: "paid", payslip_no: "PS-202611-0001",
  submitted_at: "2026-11-01T02:00:00.000Z",
  payroll: {
    monthly: { half: "second", window: { start_key: "2026-10-01", end_key: "2026-10-15" } },
    generation: { generated_at: "2026-11-01T02:00:00.000Z" },
  },
};
const firstHalf = {
  id: "pe-oct1", employee_id: "e1", pay_period: "October 1-15, 2026", status: "paid", payslip_no: "PS-202610-0009",
  submitted_at: "2026-10-16T02:00:00.000Z",
  payroll: { monthly: { half: "first" } },
};
const sept = {
  id: "pe-sep", employee_id: "e1", pay_period: "September 16-30, 2026", status: "paid",
  submitted_at: "2026-10-01T02:00:00.000Z",
  payroll: { audit: { period: { start_key: "2026-09-16", end_key: "2026-09-30" } } },
};

beforeEach(async () => {
  vi.resetModules();
  resetDb();
  lib = await import("@/lib/payroll/final-payslips");
  const { createClient } = (await import("./helpers/fake-supabase.js")).supabaseModule;
  supabase = createClient();
});

describe("which days a Final payslip counted", () => {
  it("a 16-end payslip: its attendance window; a 1-15 payslip: none; otherwise its period", () => {
    expect(lib.attendanceSpanOf(secondHalf)).toEqual({ start_key: "2026-10-01", end_key: "2026-10-15" });
    expect(lib.attendanceSpanOf(firstHalf)).toBeNull();
    expect(lib.attendanceSpanOf(sept)).toEqual({ start_key: "2026-09-16", end_key: "2026-09-30" });
  });
});

describe("a correction on a Final payslip's day", () => {
  it("names the payslip that needs an override", async () => {
    table("payroll_entries").push(secondHalf, firstHalf, { ...sept, status: "draft" });
    const notice = await lib.correctionPayrollNotice(supabase, "e1", "2026-10-07");
    expect(notice).toContain("October 16-31, 2026 (PS-202611-0001)");
    expect(notice).toContain("Super Admin");
    // A Draft is recomputed on Regenerate; no notice for it.
    expect(await lib.correctionPayrollNotice(supabase, "e1", "2026-09-20")).toBeNull();
  });
});

describe("attendance changed after Final", () => {
  it("marks a payslip whose days changed after it was finalized, and only those", async () => {
    table("attendance_logs_history").push(
      // Before Final: already counted.
      { employee_id: "e1", changed_at: "2026-10-20T00:00:00+00:00", new_log_date: "2026-10-07", old_status: "Incomplete", new_status: "Corrected" },
      // After Final, inside the window: the payslip is out of date.
      { employee_id: "e1", changed_at: "2026-11-03T05:00:00+00:00", new_log_date: "2026-10-09", old_status: "Absent", new_status: "Corrected" },
      // After Final, outside the window (next month's): not this payslip's.
      { employee_id: "e1", changed_at: "2026-11-03T05:00:00+00:00", new_log_date: "2026-10-20", old_status: "Absent", new_status: "Corrected" },
      // A write that changed nothing.
      { employee_id: "e1", changed_at: "2026-11-04T05:00:00+00:00", old_log_date: "2026-10-10", new_log_date: "2026-10-10", old_status: "On Time", new_status: "On Time" },
    );
    const changes = await lib.attendanceChangesAfterFinal(supabase, [secondHalf, firstHalf]);
    expect(changes.get("pe-oct2")).toMatchObject({ count: 1, days: ["2026-10-09"] });
    expect(changes.has("pe-oct1")).toBe(false);
  });
});
