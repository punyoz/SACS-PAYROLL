// The demo roster: 40 accounts (decision 7), built from config.mjs. Every id
// is derived from the account's tag, so the local build and production get the
// same UUIDs and a rebuild is identical. Passwords are generated once and kept
// in demo-data/credentials.csv (gitignored); a rebuild reuses them.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRANCHES, COUNTS, DATA_DIR, FAKE, demoEmail } from "./config.mjs";

/** A stable UUID (v4 layout) from a text key. */
export function stableId(key) {
  const h = createHash("sha256").update(`sacs-demo:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const FIRST = ["Andrea", "Benjie", "Carmela", "Dindo", "Elena", "Ferdie", "Gemma", "Hernan", "Imelda", "Jomar", "Katrina", "Lito", "Marites",
  "Nestor", "Odessa", "Paolo", "Queenie", "Rodel", "Sheryl", "Teodoro", "Ursula", "Virgilio", "Wilma", "Xander", "Yolanda", "Zaldy"];
const LAST = ["Bautista", "Cabrera", "Dimaculangan", "Espiritu", "Florentino", "Galang", "Hilario", "Ilagan", "Jacinto", "Lacson", "Macaraeg",
  "Navarro", "Ocampo", "Pangilinan", "Quiambao", "Ramirez", "Santiago", "Tolentino", "Umali", "Valdez", "Yap", "Zamora", "Agbayani", "Buenaventura", "Castillo", "Dizon"];

/** Employee mix: [type, position, monthly basic]. One under the PhilHealth floor, several taxable. */
const EMPLOYEE_PLAN = [
  ["Teaching", "Teacher", 24000], ["Teaching", "Teacher", 32000], ["Non-Teaching", "Registrar Staff", 16500], ["Teaching", "Teacher", 45000],
  ["Non-Teaching", "Utility Staff", 9500], ["Teaching", "Teacher", 21000], ["Non-Teaching", "Librarian", 18500], ["Teaching", "Guidance Counselor", 28000],
];
/** Hire dates: several over 2 years (tenure), one mid-year joiner per small branch. */
const HIRED = ["2019-06-03", "2021-07-12", "2023-06-05", "2018-06-04", "2024-01-08", "2022-08-01", "2025-06-02", "2020-06-08"];

function readCredentials() {
  const file = join(DATA_DIR, "credentials.csv");
  if (!existsSync(file)) return new Map();
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1);
  return new Map(lines.map((line) => { const [tag, , , password] = line.split(","); return [tag, password]; }));
}

function strongPassword() {
  // 18 characters: letters, digits and symbols; meets the password policy.
  const raw = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
  return `Dm${raw}#7`;
}

/**
 * The people. `branchCodes` maps "BR-001" -> { id, name } (the real branches).
 * Returns [{ tag, id, email, role, branch_code, ... }].
 */
export function buildRoster(branchCodes) {
  const people = [];
  const branchName = (code) => branchCodes[code]?.name || code;
  // Name parts allow letters only (profiles_*_name_valid): numbers as words,
  // the branch written out ("Demo Accountant One Spring Valley").
  const word = (n) => ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][n] || String(n);
  const short = (code) => branchName(code).replace(/\s+Branch$/i, "").replace(/[^A-Za-z .'-]/g, "").trim();
  for (let i = 1; i <= COUNTS.superAdmins; i += 1) {
    people.push({ tag: `sa${i}`, role: "super_admin", first: "Demo", last: `Super Admin ${word(i)}`, full: `Demo Super Admin ${word(i)}`, branch_code: null });
  }
  for (let i = 1; i <= COUNTS.hr; i += 1) {
    const home = BRANCHES.find((b) => b.hrHome === i)?.code || BRANCHES[0].code;
    people.push({ tag: `hr${i}`, role: "hr", first: "Demo", last: `HR ${word(i)}`, full: `Demo HR ${word(i)}`, branch_code: home,
      employee_type: "Non-Teaching", position: "HR Officer", basic_salary: i === 1 ? 35000 : 32000, date_hired: i === 1 ? "2019-06-03" : "2022-06-06" });
  }
  let emp = 0;
  BRANCHES.forEach((branch, bi) => {
    const b = bi + 1;
    for (let i = 1; i <= branch.admins; i += 1) {
      people.push({ tag: `adm-b${b}-${i}`, role: "admin", first: "Demo", last: `Admin ${word(i)} ${short(branch.code)}`, full: `Demo Admin ${word(i)} ${short(branch.code)}`, branch_code: branch.code });
    }
    for (let i = 1; i <= branch.accountants; i += 1) {
      people.push({ tag: `acc-b${b}-${i}`, role: "accountant", first: "Demo", last: `Accountant ${word(i)} ${short(branch.code)}`, full: `Demo Accountant ${word(i)} ${short(branch.code)}`,
        branch_code: branch.code, employee_type: "Non-Teaching", position: "Accountant", basic_salary: 30000 - (i - 1) * 2000 - bi * 500, date_hired: i === 1 ? "2020-06-01" : "2024-06-03" });
    }
    for (let i = 1; i <= branch.employees; i += 1) {
      emp += 1;
      const [type, position, salary] = EMPLOYEE_PLAN[(emp - 1) % EMPLOYEE_PLAN.length];
      const first = FIRST[(emp - 1) % FIRST.length];
      const last = LAST[(emp * 7) % LAST.length];
      people.push({ tag: `emp${emp}`, role: "employee", first, middle: "Demo", last, full: `${first} Demo ${last}`, branch_code: branch.code,
        employee_type: type, position, basic_salary: salary + bi * 250,
        date_hired: i === branch.employees && bi >= 2 ? "2026-06-16" : HIRED[(emp - 1) % HIRED.length] });
    }
  });

  // Two separated employees for Final Pay (G7): their attendance stops here.
  const SEPARATED = { emp7: { on: "2026-09-30", reason: "Resigned" }, emp15: { on: "2026-10-15", reason: "End of contract" } };
  for (const person of people) {
    if (SEPARATED[person.tag]) Object.assign(person, { separated_on: SEPARATED[person.tag].on, separation_reason: SEPARATED[person.tag].reason });
  }

  const saved = readCredentials();
  let payrollNo = 0;
  let rfid = FAKE.rfidUidStart;
  return people.map((p) => {
    const onPayroll = ["hr", "accountant", "employee"].includes(p.role);
    const n = onPayroll ? (payrollNo += 1) : null;
    const pad = (value, width) => String(value).padStart(width, "0");
    return {
      ...p,
      id: stableId(p.tag),
      email: demoEmail(p.tag),
      branch_id: p.branch_code ? branchCodes[p.branch_code]?.id || null : null,
      on_payroll: onPayroll,
      employee_id: onPayroll ? `${FAKE.employeeIdPrefix}-${pad(n, 3)}` : null,
      rfid_uid: onPayroll ? String(rfid++) : null,
      sss_number: onPayroll ? `${FAKE.sssPrefix}${pad(n, 8)}` : null,
      philhealth_number: onPayroll ? `${FAKE.philhealthPrefix}${pad(n, 8)}` : null,
      pagibig_number: onPayroll ? `${FAKE.pagibigPrefix}${pad(n, 8)}` : null,
      tin_number: onPayroll ? `${FAKE.tinPrefix}${pad(n, 6)}` : null,
      cp_number: `0999${pad(1000000 + (n || 900 + people.indexOf(p)), 7)}`,
      password: saved.get(p.tag) || strongPassword(),
    };
  });
}

/** Write the gitignored credentials file (tag, role, email, password). */
export function saveCredentials(roster) {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = ["tag,role,email,password", ...roster.map((p) => [p.tag, p.role, p.email, p.password].join(","))];
  writeFileSync(join(DATA_DIR, "credentials.csv"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** The shareable roster (no passwords). */
export function saveRosterCsv(roster, branchCodes) {
  mkdirSync(DATA_DIR, { recursive: true });
  const esc = (v) => (/[",]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  // Decision 5: the base address never goes in the roster, only the "+tag" part.
  const lines = ["Name,Role,Branch,Employee ID,Login tag", ...roster.map((p) => [p.full, p.role, p.branch_code ? `${p.branch_code} ${branchCodes[p.branch_code]?.name || ""}` : "All branches", p.employee_id || "", `+${p.tag}`].map(esc).join(","))];
  writeFileSync(join(DATA_DIR, "demo-roster.csv"), `${lines.join("\n")}\n`);
}
