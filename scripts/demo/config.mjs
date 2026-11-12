// Demo data settings for the capstone defense (2026-11-09 prompt, Part G).
// Every count is a setting: raise one here and rerun the build; nothing else
// needs rewriting. The base e-mail address is NOT kept here: it comes from
// DEMO_EMAIL_BASE in the gitignored .env.demo.local (never committed, logged
// or put in the roster).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = process.cwd();
/** Gitignored folder for the bundle, the credentials, snapshots and reports. */
export const DATA_DIR = join(ROOT, "demo-data");

export const PRODUCTION = {
  ref: "swtlmaupaarrppypxsip",
  url: "https://swtlmaupaarrppypxsip.supabase.co",
};

/**
 * The 4 demo branches (decided 2026-11-09: BR-001 to BR-004; BR-005 Angono and
 * BR-006 Japan get nothing). Branch 4 has no Admin and no Accountant: the user
 * adds them live during the defense.
 */
export const BRANCHES = [
  { code: "BR-001", admins: 2, accountants: 2, employees: 8, hrHome: 1 },
  { code: "BR-002", admins: 2, accountants: 2, employees: 8, hrHome: 2 },
  { code: "BR-003", admins: 1, accountants: 1, employees: 5 },
  { code: "BR-004", admins: 0, accountants: 0, employees: 5 },
];

export const COUNTS = { superAdmins: 2, hr: 2 };

/** Fake identifiers: reserved ranges nobody real can have. */
export const FAKE = {
  employeeIdPrefix: "DEMO",
  rfidUidStart: 9990000001, // 10 digits, rfid_cards_uid_check
  sssPrefix: "99", // 10 digits
  philhealthPrefix: "9900", // 12 digits
  pagibigPrefix: "9910", // 12 digits
  tinPrefix: "999", // 9 digits
};

/** The first payroll month seeded (the Super Admin's Form 2316 / Alphalist coverage). */
export const HISTORY_FROM = "2026-01-01";

/** The "Demo seed" actor (decision 6): flagged demo, no login, no branch. */
export const SEED_ACTOR = { id: "de000000-0000-4000-8000-00000000d0d0", name: "Demo seed" };

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]));
}

/** DEMO_EMAIL_BASE ("name@gmail.com") from the environment or .env.demo.local. */
export function emailBase() {
  const base = process.env.DEMO_EMAIL_BASE || readEnvFile(join(ROOT, ".env.demo.local")).DEMO_EMAIL_BASE;
  if (!base || !/^[^\s@+]+@[^\s@]+\.[^\s@]+$/.test(base)) {
    throw new Error("Set DEMO_EMAIL_BASE (name@gmail.com) in .env.demo.local (gitignored).");
  }
  return base.toLowerCase();
}

/** base+tag@domain (Gmail plus-addressing: every code lands in one inbox). */
export function demoEmail(tag) {
  const [local, domain] = emailBase().split("@");
  return `${local}+${tag}@${domain}`;
}

export { readEnvFile };
