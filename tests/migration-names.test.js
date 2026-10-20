/**
 * Migration file names (docs/local-migration-replay.md, "Naming new
 * migrations"). The live history keeps the row 20261018032608 for the file
 * 20261018010000 (decision of 2026-10-21), so every later file must be
 * stamped after 20261018032608, or `supabase db push` would treat it as
 * older than what live has already run.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../supabase/migrations");
const LIVE_STAMP = "20261018032608";
// The one file the live row stands for, and everything named before it.
const RENAMED_FILE = "20261018010000";

const versions = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => ({ file: f, version: f.split("_")[0] }));

describe("migration file names", () => {
  it("every file starts with a 14-digit timestamp, used once", () => {
    for (const { file, version } of versions) expect(version, file).toMatch(/^\d{14}$/);
    expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length);
  });

  it(`files after ${RENAMED_FILE} are stamped after ${LIVE_STAMP}`, () => {
    const later = versions.filter((v) => v.version > RENAMED_FILE);
    for (const { file, version } of later) expect(version > LIVE_STAMP, `${file} must be later than ${LIVE_STAMP}`).toBe(true);
  });
});
