// LOCAL ONLY: the BEFORE / AFTER screenshots of the revision report
// (docs/redefense/revision-report.md). Signs in with local test sessions
// (scripts/demo/local-api.mjs) on a local app; never used against production.
//
//   node scripts/demo/shots.mjs before   app on :3102 (the Nov 20 defense version), local copy of live on Nov 20
//   node scripts/demo/shots.mjs after    app on :3101 (Batch 3), local copy of live after Batch 3 + the five demo employees
//
// Writes docs/redefense/screenshots/NN-name-before.png / -after.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { stableId } from "./roster.mjs";

const which = process.argv[2];
if (!["before", "after"].includes(which)) { console.log("node scripts/demo/shots.mjs before|after"); process.exit(1); }
const BASE = which === "before" ? "http://localhost:3102" : "http://localhost:3101";
process.env.DEMO_LOCAL_BASE = BASE;
const { sessionCookie } = await import("./local-api.mjs");
const { database } = await import("./db.mjs");
const OUT = join(process.cwd(), "docs", "redefense", "screenshots");
mkdirSync(OUT, { recursive: true });

const PORTAL = { hr: "/hr", employee: "/employee", accountant: "/accountant", admin: "/admin", super_admin: "/super-admin" };
// Who is signed in: the Nov 9 demo roster before; the five (and the kept demo accounts) after.
const PEOPLE = {
  before: { hr: "hr1", accountant: "acc-b1-1", employee: "emp1", admin: "adm-b1-1" },
  after: { hr: "hr1", accountant: "acc-b1-1", employee: "emp-demo1", employee3: "emp-demo3", admin: "emp-demo-admin" },
};

/** [no, name, who, page, tab text to click (after only, optional)] */
const SHOTS = [
  ["01", "half-day-overtime", "employee", "emp-leave", "Overtime"],
  ["02", "no-request-late-absent", "hr", "hr-attendance", null],
  ["03", "overtime-request-only", "employee", "emp-attendance", null],
  ["04", "category-status", "hr", "hr-employees", null],
  ["05", "leave-credits", "hr", { before: "hr-employees", after: "hr-classification-rules" }, null],
  ["06", "statutory-leave", "employee", "emp-leave", null],
  ["07", "awol", "hr", "hr-awol", null],
  ["08", "sidebar", "hr", "hr-dashboard", null],
  ["09", "substitution", "hr", "hr-leaves", "Substitution"],
  ["10", "additional-pay", "accountant", "ac-incentives", null],
  ["11", "special-working-day", "hr", "hr-holidays", "Special"],
  ["12", "multi-select", "hr", "hr-leaves", null],
  ["13", "approval-filters", "hr", "hr-leaves", null],
  ["14", "automation", "hr", "hr-dashboard", null],
  ["15", "tenure", "hr", "hr-tenure", null],
  ["16", "rfid", "hr", "hr-rfid-cards", null],
  ["17", "hr-charts", "hr", "hr-dashboard", null],
  ["18", "wording", "accountant", "ac-process", null],
  ["19", "preset-remarks", "hr", { before: "hr-leaves", after: "hr-remark-presets" }, null],
  ["20", "correction-requests", { before: "employee", after: "employee3" }, "emp-attendance", null],
  ["21", "payslip-pdf", "employee", "emp-payslips", null],
];

const db = database("local");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const browser = await chromium.launch({ channel: "msedge" });
const results = [];
for (const [no, name, whoSpec, pageSpec, tab] of SHOTS) {
  if (only.length && !only.includes(no)) continue;
  const who = typeof whoSpec === "string" ? whoSpec : whoSpec[which];
  const pageId = typeof pageSpec === "string" ? pageSpec : pageSpec[which];
  const tag = PEOPLE[which][who];
  const [p] = await db.rows(`select id, role, branch_id, email, full_name, first_name, last_name, employee_id, employee_type, position from profiles where id = '${stableId(tag)}'`);
  if (!p) { results.push(`${no} ${name}: no ${tag} on this database`); continue; }
  const person = { id: p.id, role: p.role, branch_id: p.branch_id, email: p.email, full: p.full_name };
  const cookie = (await sessionCookie(person)).split("=");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: cookie[0], value: decodeURIComponent(cookie.slice(1).join("=")), url: BASE }]);
  // What the sign-in screen stores (src/app/login/auth-context.js): the portal leaves for /login without it.
  const authContext = { role: p.role, full_name: p.full_name, first_name: p.first_name || "", last_name: p.last_name || "", email: p.email,
    employee_id: p.employee_id || "", employee_type: p.employee_type || "", position: p.position || "", branch_id: p.branch_id };
  await context.addInitScript((value) => { try { localStorage.setItem("sacs-auth-context", value); } catch {} }, JSON.stringify(authContext));
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}${PORTAL[p.role]}?page=${pageId}`, { waitUntil: "domcontentloaded" });
    await page.locator("#portal-main").waitFor({ timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (tab && which === "after") {
      const t = page.locator("#portal-main").getByRole("tab", { name: new RegExp(tab, "i") }).first();
      if (await t.count()) { await t.click(); await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}); }
    }
    await page.waitForTimeout(1500);
    const file = join(OUT, `${no}-${name}-${which}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push(`${no} ${name}: ${p.full_name} · ${pageId}`);
  } catch (error) {
    results.push(`${no} ${name}: FAILED at ${page.url()} ${String(error.message).split("\n")[0]}`);
    await page.screenshot({ path: join(OUT, `_failed-${no}-${which}.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
console.log(results.join("\n"));
