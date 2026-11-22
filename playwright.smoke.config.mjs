// SMOKE suite (e2e/smoke/, 2026-11-22): run after every part, with its unit
// tests and the specs of the pages it changed. Same local stack, server and
// seed as the full suite (playwright.config.mjs); desktop only.
//
//   npm run test:smoke          headless, full speed (~3 min with the seed)
//   E2E_HEADLESS=0 E2E_SLOWMO=500 npm run test:smoke   to watch it
import base from "./playwright.config.mjs";

export default {
  ...base,
  testDir: "./e2e/smoke",
  outputDir: "./test-results/smoke-artifacts",
  reporter: [["list"], ["html", { outputFolder: "test-results/smoke-html", open: "never" }]],
  // No video in the smoke run (faster); traces only when a test fails.
  use: {
    ...base.use,
    headless: process.env.E2E_HEADLESS !== "0",
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 0) },
    video: "off",
    trace: "retain-on-failure",
  },
  projects: [{ name: "smoke", testDir: "./e2e/smoke" }],
};
