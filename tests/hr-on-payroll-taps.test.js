import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dayTaps } from "@/lib/attendance/demo-taps";

const read = (p) => readFileSync(p, "utf8");

describe("every account on payroll taps (2026-11-24)", () => {
  const route = read("src/app/api/admin/attendance/route.js");
  it("the terminal takes Employee, Accountant AND HR accounts on payroll", () => {
    expect(route).toMatch(/const PAYROLL_ROLES = \["employee", "accountant", "hr"\]/);
    expect(route.match(/PAYROLL_ROLES\.includes\(role\) && isOnPayroll\(user\)/g)).toHaveLength(2);
  });
  it("an account not on payroll (Admin, Super Admin) is refused with a clear message", () => {
    expect(route).toMatch(/Not on payroll: card .* belongs to an account that does not record attendance\./);
    expect(route).toMatch(/code: "not_on_payroll"/);
  });
  it("no self-handling: an HR officer never registers or changes their own card", () => {
    const cards = read("src/app/api/rfid/cards/route.js");
    expect(cards).toMatch(/Your own card is registered by another HR or the Super Admin\./);
    expect(cards).toMatch(/Your own card is changed by another HR or the Super Admin\./);
  });
  it("Admin views of the branch count HR on payroll", () => {
    expect(read("src/app/api/admin/branch-employees/route.js")).toMatch(/role === "hr"\) && isOnPayroll\(u\)/);
    expect(read("src/lib/branch-requests-server.js")).toMatch(/\.in\("role", \["employee", "accountant", "hr"\]\)/);
  });
});

describe("the defense's daily taps", () => {
  const sched = { start: 8 * 60, end: 17 * 60 };
  it("a normal day: in 5-25 minutes before the start, out 0-20 minutes after the end, never 3 hours early", () => {
    let late = 0;
    for (let i = 0; i < 400; i += 1) {
      const [tin, tout] = dayTaps({ id: `p${i}`, day: "2026-11-25", ...sched });
      if (tin > sched.start) { late += 1; expect(tin - sched.start).toBeGreaterThanOrEqual(12); expect(tin - sched.start).toBeLessThanOrEqual(40); continue; }
      expect(sched.start - tin).toBeGreaterThanOrEqual(5);
      expect(sched.start - tin).toBeLessThanOrEqual(25);
      expect(tout - sched.end).toBeGreaterThanOrEqual(0);
      expect(tout - sched.end).toBeLessThanOrEqual(20);
      expect(tout).toBeGreaterThan(tin);
    }
    expect(late).toBeGreaterThan(5); // about one day in twenty
    expect(late).toBeLessThan(45);
  });
  it("the same person and day give the same taps (a rerun adds nothing new)", () => {
    expect(dayTaps({ id: "x", day: "2026-11-26", ...sched })).toEqual(dayTaps({ id: "x", day: "2026-11-26", ...sched }));
  });
  it("a half-day leave taps only the worked half", () => {
    const mid = (sched.start + sched.end) / 2;
    const [amIn] = dayTaps({ id: "y", day: "2026-11-25", ...sched, half: "AM" });
    expect(amIn).toBeLessThan(mid);
    expect(mid - amIn).toBeLessThanOrEqual(10);
    const [, pmOut] = dayTaps({ id: "y", day: "2026-11-25", ...sched, half: "PM" });
    expect(pmOut).toBeGreaterThanOrEqual(mid);
    expect(pmOut - mid).toBeLessThanOrEqual(5);
  });
  it("off unless the setting turns it on, and only with the cron secret", () => {
    const cron = read("src/app/api/cron/demo-taps/route.js");
    expect(cron).toMatch(/if \(!setting\?\.enabled \|\| \(setting\.until && today > setting\.until\)/);
    expect(cron).toMatch(/if \(!authorized\(request\)\) return NextResponse\.json\(\{ error: "Not allowed\." \}, \{ status: 401 \}\)/);
    expect(read("vercel.json")).toMatch(/"\/api\/cron\/demo-taps"/);
  });
});
