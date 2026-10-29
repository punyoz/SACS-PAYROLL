// Moves the local dev server's "today" (e2e/support/fake-today.cjs). Only
// works when the suite runs with E2E_TIME_TRAVEL=1.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TIME_TRAVEL = process.env.E2E_TIME_TRAVEL === "1";
export const OFFSET_FILE = join(process.cwd(), "test-results", ".fake-today-offset");

/**
 * The browser follows the server (same rule: only `new Date()` with no
 * arguments moves), so pages render the same dates on both sides.
 */
export async function shiftBrowser(context) {
  await context.addInitScript(() => {
    let offset = 0;
    try { offset = Number(localStorage.getItem("e2e-fake-offset")) || 0; } catch { /* storage blocked */ }
    if (!offset) return;
    const RealDate = Date;
    class ShiftedDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
    }
    ShiftedDate.now = RealDate.now;
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    window.Date = ShiftedDate;
  });
}

/** The server's today becomes `dateKey` ("YYYY-MM-DD"), at 10:00 Manila; with `page`, its browser too. */
export async function travelTo(dateKey, page) {
  const target = Date.parse(`${dateKey}T10:00:00+08:00`);
  mkdirSync(dirname(OFFSET_FILE), { recursive: true });
  writeFileSync(OFFSET_FILE, String(target - Date.now()));
  if (page) await page.evaluate((o) => { try { localStorage.setItem("e2e-fake-offset", String(o)); } catch { /* blocked */ } }, target - Date.now()).catch(() => {});
  // The server re-reads the file at most every 300 ms.
  await new Promise((r) => setTimeout(r, 700));
}

/** Back to the real date. */
export async function travelHome(page) {
  rmSync(OFFSET_FILE, { force: true });
  if (page) await page.evaluate(() => { try { localStorage.removeItem("e2e-fake-offset"); } catch { /* blocked */ } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
}
