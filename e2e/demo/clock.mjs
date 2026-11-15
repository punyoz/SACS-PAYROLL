// One fixed time for the whole demo suite (server and browser), so pages that
// depend on the date read the same on any day it runs: Tuesday Nov 3, 2026,
// 10:00 Manila. A working day (Nov 1-2 are holidays) with taps in the demo
// data, the last day of October 16-31's processing window (Oct 30 - Nov 3),
// the cutoff live-flow reprocesses.
export const FIXED_NOW = "2026-11-03T10:00:00+08:00";

/** Local runs only: production's server keeps its own clock, so the browser keeps the real one there. */
export const CLOCK_FIXED = !process.env.DEMO_AUDIT_BASE || /localhost|127\.0\.0\.1/.test(process.env.DEMO_AUDIT_BASE);

/** The browser side: the page's clock starts at FIXED_NOW and then runs normally. */
export async function fixClock(context) {
  if (CLOCK_FIXED) await context.clock.install({ time: new Date(FIXED_NOW) });
  return context;
}
