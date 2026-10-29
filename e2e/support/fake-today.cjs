// Preloaded into the LOCAL dev server only (playwright.config.mjs, when
// E2E_TIME_TRAVEL=1): moves "today" for the payroll calendar without moving
// the clock that sessions are checked against.
//
// `new Date()` with no arguments (how src/lib/payroll/periods.js reads today)
// is shifted by the offset in the file below; `Date.now()` (token expiry in
// src/proxy.js, supabase-js) stays real, so sign-ins keep working while the
// server believes it is, say, December 29.
//
// The offset file holds milliseconds (target - real); e2e/support/time-travel.mjs writes it.
const fs = require("node:fs");
const path = require("node:path");

const FILE = process.env.E2E_FAKE_TODAY_FILE || path.join(process.cwd(), "test-results", ".fake-today-offset");
const RealDate = Date;
let offset = 0;
let checkedAt = 0;

function currentOffset() {
  const now = RealDate.now();
  if (now - checkedAt > 300) {
    checkedAt = now;
    try { offset = Number(fs.readFileSync(FILE, "utf8").trim()) || 0; } catch { offset = 0; }
  }
  return offset;
}

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + currentOffset());
    else super(...args);
  }
}
ShiftedDate.now = RealDate.now;
ShiftedDate.parse = RealDate.parse;
ShiftedDate.UTC = RealDate.UTC;
globalThis.Date = ShiftedDate;
