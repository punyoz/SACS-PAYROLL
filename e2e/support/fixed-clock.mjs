// E2E only (never imported by the app): a fixed clock for the test server, so
// date-dependent pages (today's attendance, the processing window, weekends)
// read the same on any day the suite runs. Loaded with
//   NODE_OPTIONS=--import=<this file's URL>  and  E2E_FIXED_NOW=<ISO time>
// The clock starts at E2E_FIXED_NOW and then runs normally (timeouts, ages
// and "x seconds ago" keep working). The database keeps its own real clock.
const fixed = Date.parse(process.env.E2E_FIXED_NOW || "");
if (Number.isFinite(fixed)) {
  const RealDate = Date;
  const offset = fixed - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  // Own properties, not inherited: Next's middleware sandbox copies only those.
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;
}
