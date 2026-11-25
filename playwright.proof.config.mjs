// Substitution payslip proof (2026-11-25): LOCAL stack only, headless, no slowMo, one worker,
// deviceScaleFactor 2, the local dev server's "today" movable (e2e/support/fake-today.cjs).
// No seed / reset: the spec plants its own fake accounts and removes them at the end.
//   E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test -c playwright.proof.config.mjs
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";

if (process.env.E2E_TIME_TRAVEL !== "1") throw new Error("Run with E2E_TIME_TRAVEL=1 (the Nov 16-30 payslip is processed on a moved date).");
const desktop = base.projects.find((p) => p.name === "desktop");

export default defineConfig({
  ...base,
  globalSetup: undefined,
  testDir: "./e2e/proof",
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  use: { ...base.use, headless: true, launchOptions: { slowMo: 0 }, deviceScaleFactor: 2, video: "off", trace: "off" },
  projects: [{ ...desktop, testDir: "./e2e/proof" }],
});
