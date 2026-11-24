import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { periodDisplay } from "@/lib/payroll/period-display";

describe("final-pay label (display only, 2026-11-26)", () => {
  it("reads as a date; the stored label is unchanged", () => {
    expect(periodDisplay("Final pay — separated 2026-10-21")).toBe("Final pay: separated Oct 21, 2026");
    expect(periodDisplay("November 16-30, 2026")).toBe("November 16-30, 2026");
    expect(readFileSync("src/app/api/accountant/final-pay/route.js", "utf8")).toMatch(/const finalPayLabel = \(separatedOn\) => `Final pay — separated \$\{separatedOn\}`/);
  });
});

describe("daily taps: two runs (2026-11-26)", () => {
  it("a morning run and an evening run, Monday to Friday", () => {
    const crons = JSON.parse(readFileSync("vercel.json", "utf8")).crons.map((c) => `${c.path} ${c.schedule}`);
    expect(crons).toContain("/api/cron/demo-taps?run=in 0 0 * * 1-5");
    expect(crons).toContain("/api/cron/demo-taps?run=out 0 10 * * 1-5");
  });
  it("each run posts only the taps already due and not yet recorded", () => {
    const route = readFileSync("src/app/api/cron/demo-taps/route.js", "utf8");
    expect(route).toMatch(/planned\.slice\(count \|\| 0\)\.filter\(\(t\) => t <= nowMin\)/);
    expect(route).toMatch(/if \(\(count \|\| 0\) >= 2\) continue;/);
  });
});
