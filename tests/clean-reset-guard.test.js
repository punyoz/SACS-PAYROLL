import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LIVE_PROJECT_REFS,
  confirmationPhrase,
  isConfirmed,
  projectRefOf,
  resetRefusal,
} from "../scripts/clean-reset-guard.mjs";

/**
 * scripts/clean-reset.mjs hard-deletes data and accounts. It must refuse the
 * live project and need a typed confirmation everywhere else.
 */

const LIVE = `https://${LIVE_PROJECT_REFS[0]}.supabase.co`;
const TEST = "https://testproj123.supabase.co";
const LOCAL = "http://127.0.0.1:54321";

describe("clean-reset guard", () => {
  it("refuses the live project", () => {
    expect(projectRefOf(LIVE)).toBe(LIVE_PROJECT_REFS[0]);
    expect(resetRefusal(LIVE, {})).toMatch(/live project/);
  });

  it("refuses any project listed in SUPABASE_LIVE_PROJECT_REFS", () => {
    expect(resetRefusal(TEST, { SUPABASE_LIVE_PROJECT_REFS: "other, testproj123" })).toMatch(/live project/);
  });

  it("refuses under NODE_ENV=production, and a missing URL", () => {
    expect(resetRefusal(LOCAL, { NODE_ENV: "production" })).toMatch(/production/);
    expect(resetRefusal("", {})).toMatch(/missing/);
  });

  it("lets a local stack or another project ask for confirmation", () => {
    expect(resetRefusal(LOCAL, {})).toBeNull();
    expect(resetRefusal(TEST, {})).toBeNull();
  });

  it("accepts only the exact typed phrase", () => {
    expect(confirmationPhrase(TEST)).toBe("RESET testproj123");
    expect(confirmationPhrase(LOCAL)).toBe("RESET 127.0.0.1:54321");
    expect(isConfirmed("  RESET testproj123 ", TEST)).toBe(true);
    for (const answer of ["", "y", "yes", "RESET", "reset testproj123", "RESET 127.0.0.1:54321"]) {
      expect(isConfirmed(answer, TEST), answer).toBe(false);
    }
  });

  it("the script checks the guard and a terminal before it deletes anything", () => {
    const script = readFileSync("scripts/clean-reset.mjs", "utf8");
    const firstDelete = script.indexOf("await clearTable(");
    for (const check of ["resetRefusal(projectUrl", "process.stdin.isTTY", "isConfirmed(answer"]) {
      expect(script.indexOf(check), check).toBeGreaterThan(-1);
      expect(script.indexOf(check), check).toBeLessThan(firstDelete);
    }
  });
});
