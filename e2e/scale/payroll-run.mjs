// SC-07 / AC-01 / AC-12 at scale: the Main Campus Accountant processes
// October 1-15, 2026 for ~300 employees through the UI (timed), then the same
// request is sent again twice at once (a retry and a double-click): no
// payslip may be duplicated. LOCAL scale stack only (e2e/scale/serve.mjs).
//
//   E2E_BASE=http://localhost:3200 node e2e/scale/payroll-run.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { loginThroughUi } from "../support/auth.mjs";
import { db, rows } from "../support/db.mjs";

const BASE = process.env.E2E_BASE || "http://localhost:3200";
const PERIOD = "October 1-15, 2026";

const branch = await rows(db().from("branches").select("id").eq("name", "Main Campus").single());
const count = async () => {
  const { count: n, error } = await db().from("payroll_entries").select("id", { count: "exact", head: true })
    .eq("branch_id", branch.id).eq("pay_period", PERIOD).neq("status", "draft");
  if (error) throw new Error(error.message);
  return n;
};

const browser = await chromium.launch({ channel: "chromium", headless: process.env.E2E_HEADLESS !== "0" });
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await loginThroughUi(page, "accountant");
await page.goto(`${BASE}/accountant?page=ac-process&period=${encodeURIComponent(PERIOD)}`);
await page.locator("#portal-main").waitFor();
await page.getByRole("button", { name: "Process payroll for all →" }).waitFor({ timeout: 120000 });
await page.waitForFunction(() => !document.querySelector('#portal-main [data-slot="skeleton"]'), null, { timeout: 120000 });

const before = await count();
let body = null;
page.on("request", (req) => {
  if (req.method() === "POST" && req.url().includes("/api/accountant/payroll") && !body) body = req.postData();
});
const started = Date.now();
const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/api/accountant/payroll"), { timeout: 600000 });
await page.getByRole("button", { name: "Process payroll for all →" }).click();
await page.locator('[role="alertdialog"]').getByRole("button", { name: "Process payroll" }).click();
const res = await response;
const result = await res.json().catch(() => ({}));
const ms = Date.now() - started;
const after = await count();

// The same request twice at once: a network retry and a double-click.
const replay = () => page.request.post(`${BASE}/api/accountant/payroll`, { data: JSON.parse(body), timeout: 600000 }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => ({})) }));
const replayStarted = Date.now();
const [r1, r2] = await Promise.all([replay(), replay()]);
const replayMs = Date.now() - replayStarted;
const final = await count();
const entries = JSON.parse(body).entries.length;

const report = {
  period: PERIOD,
  employees_sent: entries,
  status: res.status(),
  processed: (result.processed || []).length,
  skipped: (result.skipped || []).length,
  skipped_reasons: [...new Set((result.skipped || []).map((s) => s.code || s.reason))],
  ms,
  payslips_before: before,
  payslips_after: after,
  replay: { ms: replayMs, statuses: [r1.status, r2.status], processed: [(r1.body.processed || []).length, (r2.body.processed || []).length] },
  payslips_after_replay: final,
  duplicates: final - after,
};
console.log(JSON.stringify(report, null, 2));
mkdirSync(join(process.cwd(), "test-results", "scale"), { recursive: true });
writeFileSync(join(process.cwd(), "test-results", "scale", `payroll-run-${Date.now()}.json`), JSON.stringify(report, null, 2));
await browser.close();
if (report.duplicates !== 0) process.exit(1);
