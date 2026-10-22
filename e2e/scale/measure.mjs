// Times every role's main APIs and every sidebar page on the LOCAL stack with
// the scale dataset loaded (e2e/scale/seed-scale.mjs). Writes
// test-results/scale/timings.json and prints a table.
//
//   E2E_BASE=http://localhost:3200 node e2e/scale/measure.mjs [role ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { loginThroughUi } from "../support/auth.mjs";
import { PAGES, settle } from "../support/portal.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const BASE = process.env.E2E_BASE || "http://localhost:3200";
const OUT = join(process.cwd(), "test-results", "scale");
const month = (from, to) => `from=${from}&to=${to}`;

export const APIS = {
  accountant: [
    "/api/accountant/payroll",
    `/api/accountant/payroll?period=${encodeURIComponent("October 1-15, 2026")}`,
    `/api/accountant/payroll-runs?period=${encodeURIComponent("October 1-15, 2026")}`,
    "/api/accountant/payroll?view=thirteenth_month&year=2025",
    "/api/accountant/loans",
    "/api/attendance/logs?" + month("2026-10-01", "2026-10-21"),
  ],
  hr: [
    "/api/hr/dashboard", "/api/hr/employees", "/api/hr/payroll-records", "/api/hr/payroll-runs?status=all",
    "/api/hr/leave-requests", "/api/hr/awol-cases", "/api/hr/tenure-protection", "/api/rfid/cards",
    "/api/hr/attendance?" + month("2026-10-01", "2026-10-21"), "/api/admin/transfer-requests",
  ],
  admin: [
    "/api/admin/branch-oversight?view=dashboard",
    "/api/admin/branch-oversight?view=attendance&" + month("2026-10-01", "2026-10-21"),
    "/api/admin/branch-oversight?view=payroll", "/api/admin/branch-oversight?view=employees",
  ],
  super_admin: ["/api/admin/dashboard", "/api/admin/audit-logs", "/api/admin/users", "/api/admin/system", "/api/admin/branches"],
  employee: ["/api/employee/stats?email=" + encodeURIComponent(ACCOUNTS.employee.email), "/api/employee/payslips?email=" + encodeURIComponent(ACCOUNTS.employee.email), "/api/employee/leave-requests"],
};

async function timeApi(page, path) {
  const started = Date.now();
  try {
    const res = await page.request.get(`${BASE}${path}`, { timeout: 180000 });
    const body = await res.body();
    const out = { path, status: res.status(), ms: Date.now() - started, kb: Math.round(body.length / 1024) };
    if (!res.ok()) out.error = body.toString("utf8").slice(0, 200);
    return out;
  } catch (error) {
    return { path, status: "timeout", ms: Date.now() - started, kb: 0, error: String(error.message).slice(0, 120) };
  }
}

async function timePage(page, role, id, label) {
  const started = Date.now();
  try {
    await page.goto(`${BASE}${ACCOUNTS[role].portal}?page=${id}`, { timeout: 180000 });
    await page.locator("#portal-main").waitFor({ timeout: 180000 });
    const done = await settle(page, 180000);
    return { page: label, ms: Date.now() - started, settled: done };
  } catch (error) {
    return { page: label, ms: Date.now() - started, settled: false, error: String(error.message).slice(0, 120) };
  }
}

const roles = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(APIS);
const browser = await chromium.launch({ channel: "chromium", headless: process.env.E2E_HEADLESS !== "0" });
const results = {};
for (const role of roles) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await loginThroughUi(page, role);
  const apis = [];
  for (const path of APIS[role] || []) apis.push(await timeApi(page, path));
  const pages = [];
  if (process.env.E2E_SKIP_PAGES !== "1") for (const [id, label] of PAGES[role] || []) pages.push(await timePage(page, role, id, label));
  results[role] = { apis, pages };
  console.log(`\n== ${role}`);
  for (const a of apis) console.log(`  API  ${String(a.ms).padStart(7)} ms ${String(a.kb).padStart(7)} KB  ${a.status}  ${a.path}${a.error ? `  ${a.error}` : ""}`);
  for (const p of pages) console.log(`  PAGE ${String(p.ms).padStart(7)} ms  ${p.settled ? "ok " : "NOT SETTLED"}  ${p.page}${p.error ? `  ${p.error}` : ""}`);
  await context.close();
}
await browser.close();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `timings-${Date.now()}.json`), JSON.stringify(results, null, 2));
