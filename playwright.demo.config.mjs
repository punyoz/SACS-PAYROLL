// G8 empty-page audit (2026-11-09): headless, no slowMo, 4 workers.
//   LOCAL:      npx playwright test -c playwright.demo.config.mjs
//   PRODUCTION: DEMO_AUDIT_BASE=https://sacs-payroll.vercel.app DEMO_AUDIT_READONLY=1 \
//               npx playwright test -c playwright.demo.config.mjs
//               (read-only: opens pages and tabs only; you type the codes, see e2e/demo/README)
import { defineConfig } from "@playwright/test";

const BASE = process.env.DEMO_AUDIT_BASE || "http://localhost:3101";
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
  ],
  ...(local ? { webServer: { command: "node e2e/attendance/prod-server.mjs", url: `${BASE}/api/health`, reuseExistingServer: true, timeout: 300000 } } : {}),
});
