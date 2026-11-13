// Sign in to the LIVE site one account at a time in a visible browser; the
// person at the keyboard types each emailed code (and the password when it is
// not in demo-data/credentials.csv). The session cookie is kept in
// %USERPROFILE%\sacs-secrets\live-sessions.json (outside the repo, never
// printed) for defense-accounts.mjs and the live checks to use.
//
//   node scripts/demo/live-signin.mjs SACS-HR-001 DEMO-001 ...   (employee IDs, or "sa" for a demo Super Admin)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { database, lit } from "./db.mjs";

const BASE = "https://sacs-payroll.vercel.app";
const DIR = join(homedir(), "sacs-secrets");
const FILE = join(DIR, "live-sessions.json");
const db = database("production");
const creds = existsSync("demo-data/credentials.csv")
  ? Object.fromEntries(readFileSync("demo-data/credentials.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).map(([, , email, password]) => [String(email).toLowerCase(), password]))
  : {};
const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};

for (const code of process.argv.slice(2)) {
  const [p] = await db.rows(code === "sa"
    ? "select id, email, full_name from profiles where role = 'super_admin' and is_demo and not coalesce(archived, false) order by email limit 1"
    : `select id, email, full_name from profiles where employee_id = ${lit(code)} limit 1`);
  if (!p) { console.log(`${code}: not found`); continue; }
  const password = creds[String(p.email).toLowerCase()];
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator("#login-identity").fill(p.email);
  if (password) {
    await page.locator("#login-password").fill(password);
    await page.locator("form button[type=submit]").first().click();
    console.log(`${p.full_name}: type the emailed code in the browser window.`);
  } else {
    await page.locator("#login-password").focus();
    console.log(`${p.full_name}: type the PASSWORD, sign in, then type the emailed code in the browser window.`);
  }
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15 * 60 * 1000 });
  const cookie = (await context.cookies()).find((c) => c.name === "sacs-session");
  if (cookie) { saved[p.id] = cookie.value; console.log(`${p.full_name}: signed in.`); } else console.log(`${p.full_name}: no session cookie found.`);
  await browser.close();
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(saved));
}
