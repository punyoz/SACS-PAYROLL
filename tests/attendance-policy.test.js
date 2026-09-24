import { describe, it, expect } from "vitest";
import {
  attendanceSectionForBranch,
  resolveAttendancePolicy,
  getBranchAttendancePolicy,
  isLateForPolicy,
  tardinessMinutes,
  undertimeMinutes,
  formatPolicyTime12,
  loadAttendanceConfig,
} from "@/lib/attendance/policy";

const MAIN = "11111111-1111-1111-1111-111111111111";
const SECOND = "22222222-2222-2222-2222-222222222222";

const config = {
  attendance: { work_start: "08:00", work_end: "17:00", grace: "15", work_hours: "8" },
  [`attendance:${SECOND}`]: { work_start: "07:00", work_end: "16:00" },
};

// Manila is UTC+8 with no DST.
const manila = (hhmm) => `2026-09-24T${hhmm}:00+08:00`;

describe("attendanceSectionForBranch", () => {
  it("uses the default section without a branch", () => {
    expect(attendanceSectionForBranch(null)).toBe("attendance");
    expect(attendanceSectionForBranch("")).toBe("attendance");
  });
  it("namespaces a branch's section", () => {
    expect(attendanceSectionForBranch(SECOND)).toBe(`attendance:${SECOND}`);
  });
});

describe("resolveAttendancePolicy", () => {
  it("gives a branch with no schedule the default one", () => {
    const p = resolveAttendancePolicy(config, MAIN);
    expect(p).toMatchObject({ work_start: "08:00", work_end: "17:00", grace: 15, work_hours: 8, source: "default" });
  });
  it("applies a branch's own times and inherits keys it does not set", () => {
    const p = resolveAttendancePolicy(config, SECOND);
    expect(p).toMatchObject({ work_start: "07:00", work_end: "16:00", grace: 15, work_hours: 8, source: "branch" });
  });
  it("ignores blank or malformed values", () => {
    const p = resolveAttendancePolicy({ [`attendance:${SECOND}`]: { work_start: "", grace: "abc", work_end: "25:00" } }, SECOND);
    expect(p).toMatchObject({ work_start: "08:00", work_end: "17:00", grace: 15, source: "default" });
  });
  it("falls back to built-in defaults with no config", () => {
    expect(resolveAttendancePolicy(undefined, null)).toMatchObject({ work_start: "08:00", grace: 15 });
  });
});

describe("late / tardiness / undertime per branch", () => {
  const main = resolveAttendancePolicy(config, MAIN);
  const second = resolveAttendancePolicy(config, SECOND);

  it("7:10 is on time at main but 10 minutes late (within grace) at the 7am branch", () => {
    expect(tardinessMinutes(manila("07:10"), main)).toBe(0);
    expect(tardinessMinutes(manila("07:10"), second)).toBe(10);
    expect(isLateForPolicy(manila("07:10"), second)).toBe(false);
  });
  it("marks Late only past the grace period", () => {
    expect(isLateForPolicy(manila("08:15"), main)).toBe(false);
    expect(isLateForPolicy(manila("08:16"), main)).toBe(true);
    expect(isLateForPolicy(manila("07:16"), second)).toBe(true);
  });
  it("measures undertime against each branch's end time", () => {
    expect(undertimeMinutes(manila("16:00"), main)).toBe(60);
    expect(undertimeMinutes(manila("16:00"), second)).toBe(0);
  });
});

describe("getBranchAttendancePolicy", () => {
  const fakeClient = (rows, error = null) => ({
    from: () => ({ select: () => ({ in: async () => ({ data: rows, error }) }) }),
  });

  it("reads the default and branch sections", async () => {
    const rows = [
      { section: "attendance", key: "grace", value: "10" },
      { section: `attendance:${SECOND}`, key: "work_start", value: "07:00" },
    ];
    const p = await getBranchAttendancePolicy(fakeClient(rows), SECOND);
    expect(p).toMatchObject({ work_start: "07:00", grace: 10, source: "branch" });
  });
  it("returns built-in defaults on a read error", async () => {
    const p = await getBranchAttendancePolicy(fakeClient(null, { message: "boom" }), SECOND);
    expect(p).toMatchObject({ work_start: "08:00", work_end: "17:00", source: "default" });
  });
});

describe("formatPolicyTime12", () => {
  it("formats the timesheet's shift times", () => {
    expect(formatPolicyTime12("07:00")).toBe("07:00 AM");
    expect(formatPolicyTime12("16:30")).toBe("04:30 PM");
    expect(formatPolicyTime12("12:00")).toBe("12:00 PM");
    expect(formatPolicyTime12("00:15")).toBe("12:15 AM");
    expect(formatPolicyTime12("bad")).toBeNull();
  });
});

describe("loadAttendanceConfig", () => {
  it("asks only for the default and the distinct branch sections", async () => {
    let asked = null;
    const client = { from: () => ({ select: () => ({ in: async (_col, sections) => { asked = sections; return { data: [], error: null }; } }) }) };
    await loadAttendanceConfig(client, [SECOND, SECOND, null, MAIN]);
    expect(asked).toEqual(["attendance", `attendance:${SECOND}`, `attendance:${MAIN}`]);
  });
});
