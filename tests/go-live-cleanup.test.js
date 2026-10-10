import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * scripts/go-live/clear-test-data.sql deletes data for real once dry_run is
 * FALSE. These checks keep its safety rails from being lost in an edit.
 */

const sql = readFileSync("scripts/go-live/clear-test-data.sql", "utf8");

describe("go-live test-data cleanup script", () => {
  it("ships as a dry run that rolls itself back", () => {
    expect(sql).toMatch(/INSERT INTO go_live_mode VALUES \(TRUE\);/);
    expect(sql).toMatch(/RAISE EXCEPTION E'DRY RUN: nothing was saved/);
  });

  it("refuses placeholder or test addresses and requires an active Super Admin", () => {
    expect(sql).toContain("REPLACE-WITH-THE-REAL-SUPER-ADMIN-EMAIL");
    expect(sql).toMatch(/still lists a placeholder or test address/);
    expect(sql).toMatch(/has no active Super Admin/);
  });

  it("switches every delete guard back on that it switched off", () => {
    const off = [...sql.matchAll(/ALTER TABLE (public\.\w+)\s+DISABLE TRIGGER USER;/g)].map((m) => m[1]).sort();
    const on = [...sql.matchAll(/ALTER TABLE (public\.\w+)\s+ENABLE TRIGGER USER;/g)].map((m) => m[1]).sort();
    expect(off.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });

  it("never deletes the settings that must survive go-live", () => {
    for (const kept of ["branches", "role_permissions", "system_config", "payroll_rate_configs", "payroll_tax_brackets",
      "payroll_schedule_settings", "payroll_subsidy_settings", "attendance_holidays"]) {
      expect(sql, kept).not.toMatch(new RegExp(`DELETE FROM public\\.${kept}\\b`));
    }
    // Only the per-employee licence rows of the shared change log go.
    expect(sql).toMatch(/DELETE FROM public\.payroll_setting_changes WHERE setting_type = 'teacher_license'/);
  });
});
