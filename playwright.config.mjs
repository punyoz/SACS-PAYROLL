// Playwright end-to-end suite (e2e/). Runs against the LOCAL Supabase stack
// and a local `next dev` started with that stack's keys (e2e/local-env.mjs),
// never the live project.
//
//   npx playwright test                 headed, slowed down, watchable
//   E2E_HEADLESS=1 npx playwright test  headless
//   E2E_SLOWMO=0                        full speed
//   E2E_RESET=0                         keep the current local data (no db reset)
import { defineConfig, devices } from "@playwright/test";
import { appEnv } from "./e2e/local-env.mjs";

const PORT = Number(process.env.E2E_PORT || 3100);
const headless = process.env.E2E_HEADLESS === "1";

export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: "./test-results/artifacts",
  globalSetup: "./e2e/global-setup.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60 * 1000,
  expect: { timeout: 20000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/html", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    headless,
    // The full Chromium build (also for headless), not the separate headless shell.
    channel: "chromium",
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? (headless ? 0 : 450)) },
    video: { mode: "on", size: { width: 1440, height: 900 } },
    trace: "on",
    screenshot: "only-on-failure",
    actionTimeout: 20000,
    navigationTimeout: 60000,
    timezoneId: "Asia/Manila",
    locale: "en-PH",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    // E2E_TIME_TRAVEL=1: the server's "today" can be moved by a spec
    // (e2e/support/time-travel.mjs); sign-in clocks stay real.
    env: process.env.E2E_TIME_TRAVEL === "1"
      ? { ...appEnv(), NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(new URL("./e2e/support/fake-today.cjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))}`.trim() }
      : appEnv(),
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 180000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
