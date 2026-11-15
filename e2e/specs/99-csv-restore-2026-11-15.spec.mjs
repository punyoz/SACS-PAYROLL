// 2026-11-15: restore test of the CSV backup, LOCAL stack only.
//   export everything (as the Super Admin) -> empty the local database -> load
//   the CSVs with scripts/backup/restore-csv-local.mjs (the README's restore
//   guide) -> every table's row count and 3 payslips per branch match the
//   source to the centavo. Reports the time.
//
// It EMPTIES and reloads the local database, so it only runs when asked:
//   $env:E2E_RESTORE=1; $env:E2E_HEADLESS=1; $env:E2E_SLOWMO=0; npx playwright test e2e/specs/99-csv-restore-2026-11-15.spec.mjs --project=desktop

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { psql } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

// Every table the backup holds, as the database lists them.
const tablesOfBackup = () => psql("select unnest(public.backup_export_tables())").split(/\r?\n/).filter(Boolean);

test.skip(!process.env.E2E_RESTORE, "Empties the local database: run with E2E_RESTORE=1.");

const OUT = join(process.cwd(), "screenshots", "2026-11-15");
mkdirSync(OUT, { recursive: true });
const results = [];
function check(where, ok, text) {
  results.push({ where, ok, text });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  expect.soft(ok, `${where}: ${text}`).toBe(true);
}

// The stored amounts of a payslip by the database's own rule (as the export reads them), plus its whole record.
const share = (kind) => `coalesce(case when jsonb_typeof(e.payroll #> '{final_pay,breakdown,deductions}') = 'array'
  then (select coalesce(sum(public.payroll_json_amount(l -> 'amount')), 0) from jsonb_array_elements(e.payroll #> '{final_pay,breakdown,deductions}') l where l ->> 'kind' = '${kind}')
  else public.payroll_json_amount(e.payroll #> '{deductions,${kind}}') end, e.${kind})`;
const PAYSLIP = `e.payslip_no || '|' ||
  coalesce(public.payroll_json_amount(e.payroll #> '{monthly,cutoff,gross_pay}'), public.payroll_json_amount(e.payroll #> '{totals,gross_pay}'), e.gross_pay)::text || '|' ||
  coalesce(greatest(0, public.payroll_json_amount(e.payroll #> '{totals,net_pay}')), e.net_pay)::text || '|' ||
  coalesce(public.payroll_json_amount(e.payroll #> '{totals,total_deductions}'), e.total_deductions)::text || '|' ||
  ${share("sss")}::text || '|' || ${share("philhealth")}::text || '|' || ${share("pagibig")}::text || '|' || md5(coalesce(e.payroll::text, ''))`;

test("2026-11-15: restore the CSV backup into an empty local database", async ({ page }) => {
  test.setTimeout(900_000);
  const TABLES = tablesOfBackup();
  let zipPath;
  let source;

  await step(page, "Setup: 3 paid payslips per branch, one with stale amount columns (local only)", async () => {
    psql(`set session_replication_role = replica;
      insert into payroll_entries (employee_id, employee_name, employee_code, employee_type, position, pay_period, cutoff, status, basic_salary, gross_pay, sss, philhealth, pagibig, withholding_tax, total_deductions, net_pay, branch_id, payslip_no, payroll, created_at, updated_at, approved_at)
      select p.id, p.full_name, p.employee_id, p.employee_type, p.position, 'August 1-15, 2026', 'first', 'paid', 0, 0, 0, 0, 0, 0, 0, 0, p.branch_id, 'E2E-RST-' || p.employee_id,
        jsonb_build_object('basic_salary', 12000, 'basic_earned', 6000,
          'totals', jsonb_build_object('gross_pay', 6000.5 + p.rn, 'total_deductions', 436.8, 'net_pay', 5563.7 + p.rn),
          'deductions', jsonb_build_object('sss', 300, 'philhealth', 75.4, 'pagibig', 61.4, 'withholding_tax', 0)),
        now(), now(), now()
      from (select q.*, row_number() over (partition by q.branch_id order by q.employee_id) rn from profiles q
            where lower(q.role::text) <> 'super_admin' and q.branch_id is not null and q.employee_id is not null) p
      where p.rn <= 3 and not exists (select 1 from payroll_entries e where e.payslip_no = 'E2E-RST-' || p.employee_id);`);
  });

  await step(page, "Export everything as the Super Admin", async () => {
    await as(page, "super_admin", "sa-backup");
    const res = await page.request.post("/api/admin/backup/full", { data: { password: ACCOUNTS.super_admin.password, groups: ["all"] }, timeout: 300_000 });
    check("Export", res.status() === 200, `download ${res.status()}`);
    zipPath = join(OUT, "restore-source.zip");
    writeFileSync(zipPath, await res.body());
    // Source snapshot right after the export.
    source = {
      counts: Object.fromEntries(TABLES.map((t) => [t, Number(psql(`select count(*) from public.${t}`))])),
      accounts: Number(psql("select count(*) from auth.users")),
      payslips: psql(`select ${PAYSLIP} from (select e.*, row_number() over (partition by e.branch_id order by e.payslip_no) rn from payroll_entries e) e where e.rn <= 3 order by 1`).split("\n").filter(Boolean),
    };
    check("Source", source.payslips.length >= 3, `${source.payslips.length} payslips picked (3 per branch with payslips)`);
  });

  let restore;
  await step(page, "Empty the local database and load the CSVs (restore guide)", async () => {
    const started = Date.now();
    let out = "";
    try {
      out = execFileSync(process.execPath, [join(process.cwd(), "scripts", "backup", "restore-csv-local.mjs"), zipPath, "--yes"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      out = `${error.stdout || ""}${error.stderr || ""}`;
    }
    const seconds = (Date.now() - started) / 1000;
    console.log(out.split("\n").filter((l) => !l.startsWith("{")).join("\n"));
    restore = JSON.parse(out.split("\n").reverse().find((l) => l.startsWith("{")) || "{}");
    check("Restore", Array.isArray(restore.tables) && restore.tables.every((t) => t.ok), `loaded ${restore.tables?.length} tables in ${seconds.toFixed(1)} s (script: ${restore.seconds?.toFixed(1)} s)`);
    writeFileSync(join(OUT, "restore-result.json"), JSON.stringify({ seconds, ...restore }, null, 2));
  });

  await step(page, "Row counts and payslips match the source to the centavo", async () => {
    const wrong = [];
    for (const t of TABLES) {
      const now = Number(psql(`select count(*) from public.${t}`));
      // The export's own "completed" audit entry is written after the file is made.
      const expected = t === "audit_logs" ? source.counts[t] - 1 : source.counts[t];
      if (now !== expected) wrong.push(`${t} ${now}≠${expected}`);
    }
    check("Row counts", !wrong.length, wrong.length ? wrong.join(", ") : `all ${TABLES.length} tables: restored = source`);
    const accounts = Number(psql("select count(*) from auth.users"));
    check("Accounts", accounts === source.accounts, `sign-in accounts ${accounts} = ${source.accounts} (no passwords: reset needed)`);
    const after = psql(`select ${PAYSLIP} from public.payroll_entries e where e.payslip_no in (${source.payslips.map((l) => `'${l.split("|")[0]}'`).join(",")}) order by 1`).split("\n").filter(Boolean);
    source.payslips.forEach((line) => {
      const restored = after.find((l) => l.split("|")[0] === line.split("|")[0]);
      check("Payslip", restored === line, `${line.split("|").slice(0, 7).join(" / ")}${restored === line ? "" : ` ≠ ${restored}`}`);
    });
    const columns = Number(psql(`select count(*) from public.payroll_entries e where e.payslip_no in (${source.payslips.map((l) => `'${l.split("|")[0]}'`).join(",")})
      and e.gross_pay = coalesce(public.payroll_json_amount(e.payroll #> '{monthly,cutoff,gross_pay}'), public.payroll_json_amount(e.payroll #> '{totals,gross_pay}'), e.gross_pay)`));
    check("Payslip columns", columns === source.payslips.length, "restored amount columns hold the payslip record's amounts");
    writeFileSync(join(OUT, "restore-results.json"), JSON.stringify(results, null, 2));
  });
});
