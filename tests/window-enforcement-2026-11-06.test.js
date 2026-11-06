import { describe, expect, it } from "vitest";
import { generationWindow } from "@/lib/payroll/generation-window";
import { attendanceOverrideState } from "@/lib/payroll/override-window";
import {
  applyWindowEnforcement, deploymentEnvironment, ENFORCED, loadWindowEnforcement, publicEnforcement, TESTING_MODE_BANNER, windowNotEnforced,
} from "@/lib/payroll/window-enforcement";

const period = { start_key: "2026-10-01", end_key: "2026-10-15", label: "October 1-15, 2026" };
const schedule = { generation_date: "2026-10-15", closes_on: "2026-10-19", attendance_cutoff: null };
const OFF = { enforced: false, available: true, expires_on: "2026-12-01" };
const ON = { enforced: true, available: true, expires_on: null };

describe("applyWindowEnforcement", () => {
  for (const today of ["2026-10-10", "2026-10-16", "2026-11-06"]) {
    it(`ON returns the very same window object (${today})`, () => {
      const win = generationWindow(period, { today, schedule });
      expect(applyWindowEnforcement(win, ON)).toBe(win);
      expect(applyWindowEnforcement(win, ENFORCED)).toBe(win);
      expect(applyWindowEnforcement(win, null)).toBe(win);
    });
  }

  it("OFF opens generation before the window and keeps the original state", () => {
    const win = generationWindow(period, { today: "2026-10-10", schedule });
    expect(win.state).toBe("not_open");
    const off = applyWindowEnforcement(win, OFF);
    expect(off.state).toBe("final");
    expect(off.can_generate).toBe(true);
    expect(off.enforced_state).toBe("not_open");
    expect(off.message.startsWith(TESTING_MODE_BANNER)).toBe(true);
    expect(off.window_enforcement).toEqual({ enforced: false, testing_mode: true, expires_on: "2026-12-01", banner: TESTING_MODE_BANNER });
    expect(windowNotEnforced(off)).toBe(true);
    expect(windowNotEnforced(win)).toBe(false);
  });

  it("OFF after the window: open, and the late mark source is kept", () => {
    const win = generationWindow(period, { today: "2026-11-06", schedule });
    expect(win.state).toBe("closed");
    const off = applyWindowEnforcement(win, OFF);
    expect(off.state).toBe("final");
    expect(off.enforced_state).toBe("closed");
  });

  it("OFF never counts attendance past today", () => {
    const win = generationWindow({ start_key: "2026-11-16", end_key: "2026-11-30", label: "November 16-30, 2026" }, {
      today: "2026-11-06", schedule: { generation_date: "2026-11-30", closes_on: "2026-12-04", attendance_cutoff: "2026-11-29" },
    });
    expect(applyWindowEnforcement(win, OFF).attendance_through).toBe("2026-11-06");
  });
});

describe("attendanceOverrideState with the switch", () => {
  const outside = generationWindow(period, { today: "2026-11-06", schedule });

  it("ON: outside the window is refused, exactly as before", () => {
    expect(attendanceOverrideState({ window: outside }).code).toBe("override_outside_window");
    expect(attendanceOverrideState({ window: applyWindowEnforcement(outside, ON) }).code).toBe("override_outside_window");
  });

  it("OFF: allowed on any date", () => {
    const state = attendanceOverrideState({ window: applyWindowEnforcement(outside, OFF) });
    expect(state.allowed).toBe(true);
    expect(state.message).toMatch(/Testing mode/);
  });

  it("OFF: every non-date rule still refuses", () => {
    const window = applyWindowEnforcement(outside, OFF);
    expect(attendanceOverrideState({ window, sameBranch: false }).code).toBe("override_other_branch");
    expect(attendanceOverrideState({ window, runStatus: "pending" }).code).toBe("override_run_submitted");
    expect(attendanceOverrideState({ window, runStatus: "approved" }).code).toBe("override_run_approved");
    expect(attendanceOverrideState({ window, payslipStatus: "final" }).code).toBe("override_payslip_final");
  });
});

describe("loadWindowEnforcement", () => {
  const client = (result) => ({ rpc: async () => result });
  it("reads the database state", async () => {
    const state = await loadWindowEnforcement(client({ data: [{ enforced: false, stored_enforced: false, expired: false, expires_on: "2026-12-01", today: "2026-11-06" }], error: null }));
    expect(state.enforced).toBe(false);
    expect(state.available).toBe(true);
    expect(state.expires_on).toBe("2026-12-01");
  });
  it("fails safe to ON on an error, no row, or a throw", async () => {
    expect((await loadWindowEnforcement(client({ data: null, error: { message: "missing" } }))).enforced).toBe(true);
    expect((await loadWindowEnforcement(client({ data: [], error: null }))).enforced).toBe(true);
    expect((await loadWindowEnforcement({ rpc: async () => { throw new Error("x"); } })).enforced).toBe(true);
  });
  it("an expired OFF row reads as ON (the database applies the date)", async () => {
    const state = await loadWindowEnforcement(client({ data: [{ enforced: true, stored_enforced: false, expired: true, expires_on: "2026-11-06" }], error: null }));
    expect(state.enforced).toBe(true);
    expect(state.expired).toBe(true);
  });
});

describe("publicEnforcement and the environment", () => {
  it("tells other roles only whether testing mode is on", () => {
    expect(publicEnforcement({ enforced: true, reason: "x", changed_by_name: "y" })).toEqual({ enforced: true, testing_mode: false, expires_on: null, banner: null });
    const off = publicEnforcement({ enforced: false, expires_on: "2026-12-01", reason: "secret", changed_by_name: "SA" });
    expect(off).toEqual({ enforced: false, testing_mode: true, expires_on: "2026-12-01", banner: TESTING_MODE_BANNER });
  });
  it("detects local, demo and production", () => {
    expect(deploymentEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" })).toBe("local");
    expect(deploymentEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).toBe("production");
    expect(deploymentEnvironment({ SACS_ENVIRONMENT: "demo", NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).toBe("demo");
    expect(deploymentEnvironment({})).toBe("production");
  });
});
