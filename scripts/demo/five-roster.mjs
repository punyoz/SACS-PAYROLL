// The five live demo employees for the redefense (requested 2026-11-24; see
// scripts/demo/five.mjs). Every id comes from the tag (the local build and
// live get the same UUIDs); the logins are plus-addresses of the demo inbox
// (DEMO_EMAIL_BASE in the gitignored .env.demo.local). Passwords are made
// once and kept in demo-data/five-credentials.csv (gitignored); they are
// never printed by the build, never committed and never put in a document.
//
// Fake identifiers use their own range (DEMO-101.., cards 99900001xx), so they
// never meet the Nov 9 demo's numbers (DEMO-001..).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, demoEmail } from "./config.mjs";
import { stableId } from "./roster.mjs";

/** The Main Branch (BR-001) holds all five. */
export const BRANCH_CODE = "BR-001";

/**
 * The people. `admin` is the Demo Admin who files the substitution: a demo
 * account WITHOUT a login (banned, off payroll), created and removed with the
 * five, because a row a real Admin filed would mix demo and real people.
 */
export const FIVE = [
  { tag: "emp-demo1", first: "Marisol", last: "Aquino", employee_type: "Teaching", position: "Teacher", employment_status: "Regular",
    date_hired: "2022-06-06", basic_salary: 28000, note: "Teacher, Regular since 2022 (tenure, 5 / 5 leave credits)" },
  { tag: "emp-demo2", first: "Carlo", last: "Mendoza", employee_type: "Teaching", position: "Teacher", employment_status: "Probationary",
    date_hired: "2026-08-03", basic_salary: 22000, note: "Teacher, Probationary from Aug 2026 (3 / 3 credits, regularization reminder)" },
  { tag: "emp-demo3", first: "Liza", last: "Ferrer", employee_type: "Teaching", position: "Teacher", employment_status: "Provisional",
    date_hired: "2026-06-15", basic_salary: 21000, note: "Teacher, Provisional from Jun 2026 (no PRC license yet)" },
  { tag: "emp-demo4", first: "Ramon", last: "Salazar", employee_type: "Non-Teaching", position: "Registrar Staff", employment_status: "Regular",
    date_hired: "2023-07-03", basic_salary: 18000, note: "Non-teaching office staff, Regular since 2023; absent from Nov 18 (the AWOL case)" },
  // 2026-11-24: Maintenance is a POSITION (no Group field any more).
  { tag: "emp-demo5", first: "Nestor", last: "Pascual", employee_type: "Non-Teaching", position: "Maintenance", employment_status: "Contractual",
    date_hired: "2026-01-05", contract_end_date: "2026-12-15", basic_salary: 13500, note: "Maintenance, Contractual (contract ends Dec 15, 2026)" },
];
export const ADMIN = { tag: "emp-demo-admin", first: "Demo", last: "Admin Main", role: "admin" };

const CREDENTIALS = join(DATA_DIR, "five-credentials.csv");

function readCredentials() {
  if (!existsSync(CREDENTIALS)) return new Map();
  return new Map(readFileSync(CREDENTIALS, "utf8").trim().split(/\r?\n/).slice(1).map((line) => { const [tag, , password] = line.split(","); return [tag, password]; }));
}

/** 18 characters, letters, digits and symbols (meets the password policy). */
function strongPassword() {
  return `Fv${randomBytes(12).toString("base64url").replace(/[-_]/g, "y")}#5`;
}

/** The roster with ids, e-mails, fake numbers and passwords. `branch` = the Main Branch row. */
export function fiveRoster(branch) {
  const saved = readCredentials();
  const pad = (v, w) => String(v).padStart(w, "0");
  const people = FIVE.map((p, i) => {
    const n = 101 + i;
    return {
      ...p, role: "employee", middle: "Demo", full: `${p.first} Demo ${p.last}`,
      id: stableId(p.tag), email: demoEmail(p.tag), branch_id: branch.id, on_payroll: true,
      employee_id: `DEMO-${n}`, rfid_uid: String(9990000100 + n - 100),
      sss_number: `99${pad(n, 8)}`, philhealth_number: `9900${pad(n, 8)}`, pagibig_number: `9910${pad(n, 8)}`, tin_number: `999${pad(n, 6)}`,
      cp_number: `0999${pad(2000000 + n, 7)}`, password: saved.get(p.tag) || strongPassword(),
    };
  });
  const admin = { ...ADMIN, employee_type: "Non-Teaching", position: "Staff", middle: null, full: `${ADMIN.first} ${ADMIN.last}`, id: stableId(ADMIN.tag), email: demoEmail(ADMIN.tag), branch_id: branch.id,
    on_payroll: false, employee_id: null, rfid_uid: null, sss_number: null, philhealth_number: null, pagibig_number: null, tin_number: null,
    cp_number: `0999${pad(2000100, 7)}`, password: null, no_login: true };
  // 2026-11-24: no Demo Admin any more (the substitution is the system's proposal; HR picks the teacher).
  return { people, admin, all: people };
}

/** demo-data/five-credentials.csv (gitignored): tag, e-mail, password. Never printed. */
export function saveFiveCredentials(people) {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = ["tag,email,password", ...people.map((p) => [p.tag, p.email, p.password].join(","))];
  writeFileSync(CREDENTIALS, `${lines.join("\n")}\n`, { mode: 0o600 });
  return CREDENTIALS;
}
