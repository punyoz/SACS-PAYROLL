// A watchable tour, role by role (Super Admin, Admin, HR, Accountant,
// Employee): every sidebar page is opened live, one safe action is tried,
// and the brand (seal + green/gold) is checked as each page loads. Also
// watches for the "vanishing data" bug (Payroll Records and an open payslip
// left alone 12 s), checks that government deductions in Process Payroll are
// read-only text, and that lower roles are turned away from other portals.
// Each step is logged with a number and the time; a summary prints at the
// end. Nothing approved is changed: payroll is only viewed, never submitted.
//
//   E2E_SLOWMO=500 npx playwright test e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-live-tour.spec.mjs
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, AUTH_DIR, ROLE_LABEL, signOutLocally } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { PAGES, expectHealthy, lostLines, main, navTo, settle, snapshot } from "../support/portal.mjs";
import { choose } from "../support/flow.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const SECOND = "October 16-31, 2026";
const WATCH_MS = 12000;
const PROBLEM_PAUSE_MS = 4000;

// One worker keeps the role order; not "serial" mode, so a failing role does
// not skip the roles after it.
test.use({ viewport: { width: 1280, height: 800 } });

const tour = { steps: 0, pages: [], actions: [], problems: [] };
const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });

function say(text) {
  tour.steps += 1;
  console.log(`  [#${tour.steps} ${clock()}] ${text}`);
  return tour.steps;
}

/** Log a problem in plain words and leave it on screen a little longer. */
async function problem(page, where, text) {
  const n = say(`PROBLEM on ${where}: ${text}`);
  tour.problems.push({ step: n, time: clock(), where, text });
  await page.waitForTimeout(PROBLEM_PAUSE_MS);
}

/** The seal loaded, the sidebar is green and the role label is gold. */
async function checkBrand(page, where) {
  const brand = await page.evaluate(() => {
    const rgb = (color) => {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a };
    };
    const seal = document.querySelector('[data-sidebar="header"] img[src*="/brand/logo"]');
    const inner = document.querySelector('[data-sidebar="sidebar"]');
    const label = document.querySelector('[data-sidebar="header"] .text-sidebar-primary');
    return {
      seal: Boolean(seal && seal.complete && seal.naturalWidth > 0),
      sidebar: inner ? rgb(getComputedStyle(inner).backgroundColor) : null,
      gold: label ? rgb(getComputedStyle(label).color) : null,
    };
  });
  const out = [];
  if (!brand.seal) out.push("the school seal in the sidebar did not load");
  const s = brand.sidebar;
  if (!s || !(s.g > s.r && s.g >= s.b)) out.push(`the sidebar is not green (rgb ${s ? `${s.r},${s.g},${s.b}` : "none"})`);
  const g = brand.gold;
  if (!g || !(g.r > g.b + 40 && g.g > g.b + 20)) out.push(`the role label is not gold (rgb ${g ? `${g.r},${g.g},${g.b}` : "none"})`);
  for (const text of out) await problem(page, where, text);
}

/** Watch a page untouched; report any line or row that disappears. */
async function watchStill(page, where) {
  say(`Watching ${where} for ${WATCH_MS / 1000} s without touching anything (vanishing-data check)…`);
  const before = await snapshot(page);
  await page.waitForTimeout(WATCH_MS);
  const after = await snapshot(page);
  const lost = lostLines(before, after);
  if (lost.length) await problem(page, where, `data vanished while idle: ${lost.slice(0, 5).join(" | ")}`);
  else if (after.rows < before.rows) await problem(page, where, `table rows dropped from ${before.rows} to ${after.rows} while idle`);
  else say(`${where}: nothing vanished (${after.rows} table rows, totals unchanged).`);
}

/** A sub-tab: click the second one and come back. */
async function tryTabs(page, where) {
  const tabs = main(page).locator('[role="tab"]:visible');
  if ((await tabs.count()) < 2) return false;
  const name = (await tabs.nth(1).innerText()).trim().replace(/\s+/g, " ");
  say(`Clicking tab "${name}" on ${where}…`);
  await tabs.nth(1).click();
  await settle(page);
  await tabs.first().click();
  await settle(page);
  tour.actions.push(`${where}: tab "${name}"`);
  return true;
}

/** A search box: search for nonsense, then clear it. */
async function trySearch(page, where) {
  const box = main(page).locator('input[type="search"]:visible, input[placeholder^="Search" i]:visible').first();
  if (!(await box.count()) || !(await box.isEnabled())) return false;
  say(`Typing a search on ${where}, then clearing it…`);
  await box.fill("zzqx");
  await settle(page);
  await box.fill("");
  await settle(page);
  tour.actions.push(`${where}: search`);
  return true;
}

/** An "Add / New / View…" dialog: open it and close it unsaved. */
async function tryDialog(page, where) {
  const opener = main(page).getByRole("button", { name: /^(\+\s*)?(Add|New|Create|Register|File|Request|View|Details)\b/i }).first();
  if (!(await opener.isVisible().catch(() => false)) || !(await opener.isEnabled().catch(() => false))) return false;
  const name = (await opener.innerText()).trim().replace(/\s+/g, " ");
  say(`Opening "${name}" on ${where} (closing it without saving)…`);
  await opener.click();
  await page.waitForTimeout(800);
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()); i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await settle(page);
  tour.actions.push(`${where}: opened "${name}"`);
  return true;
}

async function defaultAction(page, where) {
  if (await tryTabs(page, where)) return;
  if (await trySearch(page, where)) return;
  if (await tryDialog(page, where)) return;
  say(`${where}: view-only page, nothing to click.`);
}

// Page-specific checks (the rest get defaultAction).
const ACTIONS = {
  "sa-audit": async (page, where) => {
    say(`Scrolling to the year-end records on ${where} (Super Admin: read only)…`);
    const records = main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: "Year-end tax annualization" }) }).first();
    if (!(await records.count())) return problem(page, where, "no year-end tax section found");
    await records.scrollIntoViewIfNeeded();
    await settle(page);
    if (await records.getByRole("button", { name: /Run annualization|Run again/ }).count()) {
      await problem(page, where, "the Super Admin sees a Run annualization button (should be read only)");
    } else say(`${where}: year-end records shown with no Run button (read only).`);
    const files = main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: "Generated BIR files" }) }).first();
    if (await files.count()) { await files.scrollIntoViewIfNeeded(); say(`${where}: Generated BIR files (2316 / alphalist) list shown.`); }
    tour.actions.push(`${where}: year-end / 2316 / alphalist read-only views`);
  },

  "hr-payroll-records": async (page, where) => {
    await watchStill(page, where);
    tour.actions.push(`${where}: 12 s idle watch`);
  },

  "ac-process": async (page, where) => {
    say(`Opening Process Payroll for ${SECOND} (2nd half: government deductions apply)…`);
    await page.goto(`/accountant?page=ac-process&period=${encodeURIComponent(SECOND)}`);
    await main(page).waitFor();
    await settle(page);
    say("Single: choosing Ana in Process Payroll (view only, not submitted)…");
    await choose(page, main(page).locator("#pc-employee"), /Ana/);
    await settle(page);
    for (const id of ["pc-sss", "pc-philhealth", "pc-pagibig", "pc-tax"]) {
      const field = main(page).locator(`#${id}`);
      await field.scrollIntoViewIfNeeded().catch(() => {});
      if (await main(page).locator(`input#${id}`).count()) await problem(page, where, `${id.slice(3).toUpperCase()} is an editable input box`);
      else if (!(await field.isVisible().catch(() => false))) await problem(page, where, `${id.slice(3).toUpperCase()} is not shown`);
    }
    say("Single: SSS / PhilHealth / Pag-IBIG / Tax checked (should be read-only text with Flag for review).");
    await page.waitForTimeout(1500);
    say("Batch: scrolling to the batch table (Process payroll for all is NOT clicked)…");
    const batch = main(page).locator("table").filter({ has: page.locator("th", { hasText: "PhilHealth" }) }).first();
    if (await batch.count()) {
      await batch.scrollIntoViewIfNeeded();
      const header = (await batch.locator("thead th").allInnerTexts()).map((t) => t.trim());
      const govCols = ["SSS", "PhilHealth", "Pag-IBIG", "Tax"].map((h) => header.indexOf(h)).filter((i) => i >= 0);
      let editable = 0;
      for (const col of govCols) editable += await batch.locator(`tbody tr td:nth-child(${col + 1}) input`).count();
      if (editable) await problem(page, where, `the batch table has ${editable} editable government deduction boxes`);
      else say("Batch: government deduction columns are read-only.");
      await page.waitForTimeout(1500);
    } else await problem(page, where, "batch table not found");
    tour.actions.push(`${where}: single + batch views, government deductions read-only check`);
  },

  "ac-records": async (page, where) => {
    await watchStill(page, where);
    const open = main(page).getByRole("button", { name: "Payslip", exact: true }).first();
    if (!(await open.isEnabled().catch(() => false))) return problem(page, where, "no payslip to open (no processed records)");
    say("Clicking Payslip on the first record…");
    await open.click();
    await settle(page);
    await watchStill(page, "Accountant > Payslips (opened from Payroll Records)");
    say("Going back to Payroll Records to see the list is still there…");
    await navTo(page, "Payroll Records");
    await watchStill(page, `${where} (after opening a payslip)`);
    tour.actions.push(`${where}: idle watch, open payslip, idle watch, back`);
  },

  "ac-reports": async (page, where) => {
    const card = (title) => main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: title }) }).first();
    const yearEnd = card("Year-end tax annualization");
    if (await yearEnd.count()) {
      await yearEnd.scrollIntoViewIfNeeded();
      const run = yearEnd.getByRole("button", { name: /Run annualization|Run again/ });
      if (await run.isEnabled().catch(() => false)) {
        say("Clicking Run annualization (a computation only; nothing is scheduled onto a payslip)…");
        await run.click();
        const dialog = page.locator('[role="alertdialog"]:visible, [role="dialog"]:visible').last();
        await dialog.getByRole("button", { name: "Run annualization", exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 30000 }).catch(() => {});
        await settle(page);
        tour.actions.push(`${where}: year-end annualization run`);
      }
    } else await problem(page, where, "no year-end tax annualization section");
    const bir = card("BIR forms");
    if (await bir.count()) {
      await bir.scrollIntoViewIfNeeded();
      await settle(page, 40000);
      // The card opens on last year; the local payslips are this year's.
      await bir.getByRole("button", { name: "All 2316 (PDF)" }).waitFor({ timeout: 60000 }).catch(() => {});
      const thisYear = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear(); // Manila
      say(`Choosing tax year ${thisYear} in BIR forms…`);
      await choose(page, bir.getByRole("combobox", { name: "Tax year" }), String(thisYear)).catch(() => {});
      await settle(page, 40000);
      for (const [label, name] of [["Form 2316 (PDF)", "All 2316 (PDF)"], ["Alphalist (CSV)", "Alphalist (CSV)"]]) {
        const button = bir.getByRole("button", { name, exact: true });
        if (!(await button.isEnabled().catch(() => false))) { say(`${label}: button disabled (no paid payslips in the shown year).`); continue; }
        say(`Generating ${label}…`);
        const download = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
        await button.click();
        const file = await download;
        if (file) say(`${label}: downloaded ${file.suggestedFilename()}`);
        else await problem(page, where, `${label} produced no file`);
        tour.actions.push(`${where}: ${label}`);
      }
    } else await problem(page, where, "no BIR forms section");
  },

  "emp-payslips": async (page, where) => {
    await watchStill(page, where);
    const mine = main(page).locator("[data-slot=card]").filter({ has: page.locator("[data-slot=card-title]", { hasText: "My BIR 2316" }) }).first();
    if (!(await mine.count())) return problem(page, where, "no My BIR 2316 section");
    await mine.scrollIntoViewIfNeeded();
    const button = mine.getByRole("button").first();
    if (!(await button.isEnabled().catch(() => false))) { say(`${where}: no 2316 year to download yet.`); return; }
    say("Downloading my Form 2316…");
    const download = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    await button.click();
    const file = await download;
    if (file) say(`${where}: downloaded ${file.suggestedFilename()}`);
    else await problem(page, where, "Form 2316 download produced no file");
    tour.actions.push(`${where}: idle watch + Form 2316 download`);
  },
};

/** Open a sidebar page, check it, try its action, report what went wrong. */
async function visit(page, monitor, role, id, label) {
  const where = `${ROLE_LABEL[role]} > ${label}`;
  monitor.at(where);
  const issuesBefore = monitor.issues.length;
  say(`Navigating to ${where}…`);
  await step(page, where);
  tour.pages.push(where);
  try {
    await navTo(page, label);
    if (!(await settle(page))) await problem(page, where, "still loading after 25 s");
    await expectHealthy(page, where);
  } catch (err) {
    await problem(page, where, err.message.split("\n")[0]);
  }
  await checkBrand(page, where);
  try {
    await (ACTIONS[id] || defaultAction)(page, where);
  } catch (err) {
    await problem(page, where, `action failed: ${err.message.split("\n")[0]}`);
  }
  for (const issue of monitor.issues.slice(issuesBefore)) {
    await problem(page, where, `${issue.kind === "http" ? "a request failed" : issue.kind}: ${issue.text}`);
  }
}

/** Try each other portal; it must send this role back to its own. */
async function boundaries(page, monitor, role) {
  monitor.allow(/^40[13] /);
  const own = ACCOUNTS[role].portal;
  for (const portal of ["/super-admin", "/admin", "/hr", "/accountant", "/employee"].filter((p) => p !== own)) {
    const where = `${ROLE_LABEL[role]} > role boundary ${portal}`;
    say(`As ${ROLE_LABEL[role]}, trying to open ${portal} (should be turned back to ${own})…`);
    await step(page, where);
    await page.goto(portal);
    await page.waitForURL((url) => url.pathname.startsWith(own) || url.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const now = new URL(page.url()).pathname;
    if (now.startsWith(portal)) await problem(page, where, `${ROLE_LABEL[role]} was let into ${portal}`);
    else say(`Denied: ${ROLE_LABEL[role]} landed on ${now}.`);
    tour.actions.push(where);
  }
  monitor.clearAllowed();
  await page.goto(own);
  await main(page).waitFor();
}

test("1. Login: password, then the emailed code", async ({ page, monitor }) => {
  monitor.at("Login");
  for (const role of ["super_admin", "admin", "hr", "accountant", "employee"]) {
    const file = join(AUTH_DIR, `${role}.json`);
    if (existsSync(file)) rmSync(file);
  }
  await signOutLocally(page);
  say("Opening the login page…");
  await page.goto("/login");
  await page.locator("#login-identity").waitFor();
  await checkLoginBrand(page);
  say("Trying a wrong password (should be refused)…");
  // The refusal is expected (kept allowed for the rest of this test: the
  // response can land after the check below).
  monitor.allow(/^40[01] POST \/api\/legacy-auth\/login/, /^429 /);
  await page.fill("#login-identity", ACCOUNTS.super_admin.login);
  await page.fill("#login-password", "wrong-password-123");
  await page.locator("form button[type=submit]").first().click();
  await page.waitForTimeout(2500);
  if (await page.getByText("Check your email").isVisible().catch(() => false)) await problem(page, "Login", "a wrong password was accepted");
  else say("Wrong password refused.");
  say("Signing in as Super Admin: password, then the emailed code (planted locally, see note)…");
  await as(page, "super_admin");
  tour.actions.push("Login: wrong password refused; password + emailed code accepted");
});

async function checkLoginBrand(page) {
  const ok = await page.evaluate(() => {
    const img = document.querySelector('img[src*="/brand/logo"]');
    return Boolean(img && img.complete && img.naturalWidth > 0);
  });
  if (!ok) await problem(page, "Login", "the school seal did not load");
  else say("Login page: school seal shown.");
}

for (const [n, role] of [[2, "super_admin"], [3, "admin"], [4, "hr"], [5, "accountant"], [6, "employee"]]) {
  test(`${n}. ${ROLE_LABEL[role]}: every page`, async ({ page, monitor }) => {
    test.setTimeout(45 * 60 * 1000);
    say(`===== ${ROLE_LABEL[role]} =====`);
    await as(page, role);
    for (const [id, label] of PAGES[role]) await visit(page, monitor, role, id, label);
    if (role !== "super_admin") await boundaries(page, monitor, role);
    // The tour reports problems itself; the monitor's end-of-test check still applies.
  });
}

test.afterAll(() => {
  const line = "=".repeat(64);
  console.log(`\n${line}\n LIVE TOUR SUMMARY (${clock()})\n${line}`);
  console.log(` Steps logged:  ${tour.steps}`);
  console.log(` Pages visited: ${tour.pages.length}`);
  console.log(` Actions tried: ${tour.actions.length}`);
  for (const a of tour.actions) console.log(`   - ${a}`);
  console.log(` Problems:      ${tour.problems.length}`);
  for (const p of tour.problems) console.log(`   ! step #${p.step} at ${p.time}  ${p.where}: ${p.text}`);
  console.log(line);
});
