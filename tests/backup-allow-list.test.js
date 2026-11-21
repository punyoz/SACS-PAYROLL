/**
 * The app's backup tables (BACKUP_GROUPS) and the database allow-list
 * (public.backup_export_tables(), the latest migration that defines it) must
 * match both ways: a table only in the app is refused at backup time (500),
 * a table only in the database is never exported.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { BACKUP_GROUPS } from "@/lib/backup/full-backup";

function allowList() {
  const dir = "supabase/migrations";
  const file = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse()
    .find((f) => /FUNCTION public\.backup_export_tables\(\)/.test(readFileSync(`${dir}/${f}`, "utf8")));
  const sql = readFileSync(`${dir}/${file}`, "utf8");
  const array = sql.slice(sql.indexOf("FUNCTION public.backup_export_tables()")).match(/ARRAY\[([\s\S]*?)\]::text\[\]/)[1];
  return [...array.replace(/--.*$/gm, "").matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

describe("backup table lists", () => {
  it("the app's list and the database allow-list hold the same tables", () => {
    const app = [...new Set(BACKUP_GROUPS.flatMap((g) => g.tables))].sort();
    const db = [...new Set(allowList())].sort();
    expect(app.filter((t) => !db.includes(t))).toEqual([]);
    expect(db.filter((t) => !app.includes(t))).toEqual([]);
    expect(db).toContain("payroll_final_pay_submissions");
  });
});
