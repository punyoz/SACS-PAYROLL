// Playwright end-to-end suite (e2e/). Runs against the LOCAL Supabase stack
// and a local `next dev` started with that stack's keys (e2e/local-env.mjs),
// never the live project.
//
//   npx playwright test                 headed, slowed down (500 ms), watchable:
//                                       desktop 1280x800 first, then the key
//                                       flows again on a phone (390x844)
//   E2E_HEADLESS=1 npx playwright test  headless
//   E2E_SLOWMO=0                        full speed
//   E2E_RESET=0                         keep the current local data (no db reset)
import { defineConfig, devices } from "@playwright/test";
import { appEnv } from "./e2e/local-env.mjs";

const PORT = Number(process.env.E2E_PORT || 3100);
const headless = process.env.E2E_HEADLESS === "1";
const slowMo = Number(process.env.E2E_SLOWMO ?? (headless ? 0 : 500));
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

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
    viewport: DESKTOP,
    headless,
    // The full Chromium build (also for headless), not the separate headless shell.
    channel: "chromium",
    launchOptions: { slowMo },
    video: { mode: "on", size: DESKTOP },
    trace: "on",
    screenshot: "only-on-failure",
    actionTimeout: 20000,
    navigationTimeout: 60000,
    timezoneId: "Asia/Manila",
    locale: "en-PH",
  },
  // Desktop runs every spec; the phone project repeats the key flows
  // (e2e/mobile/) afterwards, in the same single visible worker.
  projects: [
    { name: "desktop", testDir: "./e2e/specs" },
    {
      name: "mobile",
      testDir: "./e2e/mobile",
      use: { viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, video: { mode: "on", size: PHONE } },
    },
  ],
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
