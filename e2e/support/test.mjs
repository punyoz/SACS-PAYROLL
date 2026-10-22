// The suite's `test`: every page is watched by a Monitor and shows the step
// banner. A test fails at the end when the page logged a console error,
// threw, crashed, or got an unexpected failed request.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { installBanner } from "./banner.mjs";
import { Monitor } from "./monitor.mjs";

const LOG_DIR = join(process.cwd(), "test-results");

export const test = base.extend({
  monitor: [async ({ page }, use, testInfo) => {
    const monitor = new Monitor();
    monitor.attach(page);
    await use(monitor);
    if (monitor.warnings.length) {
      await testInfo.attach("warnings.txt", { body: monitor.warnings.map((w) => `[${w.where}] ${w.text}`).join("\n"), contentType: "text/plain" });
    }
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "issues.jsonl"), `${JSON.stringify({ test: testInfo.titlePath.slice(1).join(" > "), issues: monitor.issues, warnings: monitor.warnings })}\n`);
    if (monitor.issues.length) {
      await testInfo.attach("issues.txt", { body: monitor.summary(), contentType: "text/plain" });
      if (testInfo.status === "passed") {
        expect(monitor.issues, `Console errors / failed requests seen:\n${monitor.summary()}`).toEqual([]);
      }
    }
  }, { auto: true }],
  page: async ({ page, context }, use) => {
    await installBanner(context);
    await use(page);
  },
});

export { expect };
