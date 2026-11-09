// FAST attendance redesign tests (2026-11-09), LOCAL stack only.
//
//   npx playwright test -c playwright.attendance.config.mjs
//
// Headless, no slowMo, 4 workers, reduced motion, against a production build
// (e2e/attendance/prod-server.mjs, port 3101). The data set is seeded once
// (global-setup) and each role signs in once (the "setup" project). Rules
// are checked by API and SQL (api.spec.mjs); the browser only checks the
// screen (ui.spec.mjs). Report screenshots: --project=report.
//
// A headed, slowed rehearsal of ONE test, only when asked:
//   E2E_HEADED=1 E2E_SLOWMO=500 npx playwright test -c playwright.attendance.config.mjs -g "<name>"
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_ATT_PORT || 3101);

export default defineConfig({
  testDir: "./e2e/attendance",
  outputDir: "./test-results/attendance-artifacts",
  globalSetup: "./e2e/attendance/global-setup.mjs",
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS || 4),
  retries: 0,
  timeout: 90 * 1000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: "test-results/attendance-results.json" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    headless: process.env.E2E_HEADED !== "1",
    // Full Chromium in its headless mode (the separate headless shell is not installed).
    channel: "chromium",
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO || 0) },
    reducedMotion: "reduce",
    viewport: { width: 1366, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.mjs/ },
    { name: "api", testMatch: /api\.spec\.mjs/, dependencies: ["setup"] },
    { name: "ui", testMatch: /ui\.spec\.mjs/, dependencies: ["setup"] },
    { name: "report", testMatch: /report\.spec\.mjs/, dependencies: ["setup"] },
  ],
  webServer: {
    command: "node e2e/attendance/prod-server.mjs",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 10 * 60 * 1000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
