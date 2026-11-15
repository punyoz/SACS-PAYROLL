// G8 empty-page audit (2026-11-09): headless, no slowMo, 4 workers.
//   LOCAL:      npx playwright test -c playwright.demo.config.mjs
//               on the demo bundle AS LOADED (cards stripped, like production):
//               npx supabase db reset; node scripts/demo/build-local.mjs --no-reset --stage=mirror;
//               node scripts/demo/demo.mjs seed --target=local
//               Its own server on :3102 with a fixed clock (e2e/demo/clock.mjs).
//   PRODUCTION: DEMO_AUDIT_BASE=https://sacs-payroll.vercel.app DEMO_AUDIT_READONLY=1 \
//               npx playwright test -c playwright.demo.config.mjs
//               (read-only: opens pages and tabs only; you type the codes, see e2e/demo/README)
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "@playwright/test";
import { FIXED_NOW } from "./e2e/demo/clock.mjs";

// Port 3102: never a server without the fixed clock left running on 3101.
const BASE = process.env.DEMO_AUDIT_BASE || "http://localhost:3102";
const local = /localhost|127\.0\.0\.1/.test(BASE);

export default defineConfig({
  testDir: "e2e/demo",
  // Its own output folder, so the saved sign-ins (test-results/.auth-demo) survive.
  outputDir: "test-results/demo-run",
  timeout: 10 * 60 * 1000,
  workers: 4,
  fullyParallel: true,
  reporter: [["line"]],
  use: { baseURL: BASE, headless: true, channel: "chromium", reducedMotion: "reduce", actionTimeout: 20000, navigationTimeout: 60000 },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.mjs/ },
    { name: "audit", testMatch: /crawl\.spec\.mjs/, dependencies: ["setup"] },
    { name: "screens", testMatch: /sidebar\.spec\.mjs/, dependencies: ["setup"] },
    // Last: it signs in as HR One, which ends the saved HR session the other projects use
    // (one session per account), and it changes data.
    { name: "live", testMatch: /live-flow\.spec\.mjs/, dependencies: ["audit", "screens", "defense"] },
    { name: "defense", testMatch: /defense-prep\.spec\.mjs/, dependencies: ["setup"] },
  ],
  ...(local ? { webServer: {
    command: "node e2e/attendance/prod-server.mjs", url: `${BASE}/api/health`, reuseExistingServer: true, timeout: 300000,
    env: { E2E_ATT_PORT: new URL(BASE).port, E2E_FIXED_NOW: FIXED_NOW, NODE_OPTIONS: `--import=${pathToFileURL(join(process.cwd(), "e2e/support/fixed-clock.mjs")).href}` },
  } } : {}),
});
