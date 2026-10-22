// Seeds the LOCAL Supabase stack for the Playwright suite:
//   1. the five role accounts through the project seed (scripts/seed-auth-users.mjs)
//   2. a second branch, a second Admin and three employees
//   3. attendance and subsidy fixtures (e2e/fixtures.sql)
// Refuses to run against anything but the local stack.
//
//   node e2e/seed-e2e.mjs            seed the running local stack
//   node e2e/seed-e2e.mjs --reset    `supabase db reset` first (fresh database)
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { ACCOUNTS, BRANCH_MAIN, BRANCH_NORTH } from "./accounts.mjs";
import { appEnv, assertLocalUrl, localSupabase } from "./local-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export async function seed({ reset = false } = {}) {
  if (reset) {
    console.log("[seed] supabase db reset (local)");
    execSync("npx supabase db reset", { cwd: root, stdio: "ignore" });
  }
  const local = localSupabase();
  assertLocalUrl(local.url);
  const env = { ...process.env, ...appEnv() };

  console.log("[seed] role accounts via scripts/seed-auth-users.mjs");
  execSync("node scripts/seed-auth-users.mjs", { cwd: root, env, stdio: "ignore" });

  const sb = createClient(local.url, local.serviceKey, { auth: { persistSession: false } });
  const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

  const main = must(await sb.from("branches").select("id").eq("name", BRANCH_MAIN).single(), "main branch");
  let north = (await sb.from("branches").select("id").eq("name", BRANCH_NORTH).maybeSingle()).data;
  if (!north) north = must(await sb.from("branches").insert({ name: BRANCH_NORTH }).select("id").single(), "north branch");

  const extra = [
    { acct: ACCOUNTS.employee2, role: "employee", full_name: "Bea Santos Reyes", first_name: "Bea", last_name: "Reyes", employee_id: "E2E-EMP-002", salary: 30000, rfid: "1000000002", branch: main.id, type: "Non-Teaching", position: "Registrar Staff", hired: "2020-06-01" },
    { acct: ACCOUNTS.employee3, role: "employee", full_name: "Carlo Mendoza Cruz", first_name: "Carlo", last_name: "Cruz", employee_id: "E2E-EMP-003", salary: 50000, rfid: "1000000003", branch: north.id, type: "Teaching", position: "Teacher", hired: "2025-06-01" },
    { acct: ACCOUNTS.admin2, role: "admin", full_name: "North Branch Admin", first_name: "North", last_name: "Admin", employee_id: null, branch: north.id },
  ];
  const users = must(await sb.auth.admin.listUsers({ perPage: 500 }), "list users").users;
  for (const e of extra) {
    let user = users.find((u) => u.email === e.acct.email);
    const meta = { role: e.role, full_name: e.full_name, employee_id: e.employee_id || "", branch_id: e.branch };
    if (!user) user = must(await sb.auth.admin.createUser({ email: e.acct.email, password: e.acct.password, email_confirm: true, user_metadata: meta }), `create ${e.acct.email}`).user;
    else must(await sb.auth.admin.updateUserById(user.id, { password: e.acct.password, user_metadata: meta }), `update ${e.acct.email}`);
    const profile = { id: user.id, email: e.acct.email, role: e.role, full_name: e.full_name, first_name: e.first_name, last_name: e.last_name, employee_id: e.employee_id, branch_id: e.branch };
    if (e.role === "employee") Object.assign(profile, { basic_salary: e.salary, employee_type: e.type, position: e.position, date_hired: e.hired });
    must(await sb.from("profiles").upsert(profile), `profile ${e.acct.email}`);
  }

  const set = async (email, patch) => must(await sb.from("profiles").update(patch).eq("email", email), `update ${email}`);
  await set(ACCOUNTS.admin.email, { branch_id: main.id, first_name: "Main", last_name: "Admin" });
  await set(ACCOUNTS.accountant.email, { branch_id: main.id, basic_salary: 25000, first_name: "Paula", last_name: "Accountant", date_hired: "2024-06-01", employee_type: "Non-Teaching", position: "Accountant" });
  await set(ACCOUNTS.hr.email, { branch_id: main.id, basic_salary: 28000, first_name: "Hector", last_name: "Officer", date_hired: "2024-06-01", employee_type: "Non-Teaching", position: "HR Officer" });
  await set(ACCOUNTS.employee.email, { branch_id: main.id, basic_salary: 18000, first_name: "Ana", last_name: "Lopez", full_name: "Ana Dizon Lopez", date_hired: "2025-06-01", position: "Teacher", employee_type: "Teaching" });
  // HR's employee form writes these to both the profile and the account
  // metadata (src/app/api/hr/employees/route.js); payroll reads the metadata,
  // so mirror them the same way.
  const everyone = [ACCOUNTS.admin, ACCOUNTS.admin2, ACCOUNTS.accountant, ACCOUNTS.hr, ACCOUNTS.employee, ACCOUNTS.employee2, ACCOUNTS.employee3];
  for (const { email } of everyone) {
    const p = must(await sb.from("profiles").select("id,branch_id,full_name,employee_id,employee_type,position,basic_salary,date_hired").eq("email", email).single(), `read ${email}`);
    const u = must(await sb.auth.admin.getUserById(p.id), `auth ${email}`).user;
    const meta = { ...u.user_metadata, branch_id: p.branch_id, full_name: p.full_name };
    for (const key of ["employee_id", "employee_type", "position", "basic_salary", "date_hired"]) if (p[key] !== null && p[key] !== undefined) meta[key] = p[key];
    must(await sb.auth.admin.updateUserById(p.id, { user_metadata: meta }), `meta ${email}`);
  }

  // Cards go through RFID registration (profiles refuse a direct rfid_uid).
  // Bea and Carlo get one here; Ana's is registered by the RFID spec.
  const hr = must(await sb.from("profiles").select("id").eq("email", ACCOUNTS.hr.email).single(), "hr id");
  for (const e of extra.filter((x) => x.rfid)) {
    const emp = must(await sb.from("profiles").select("id,rfid_uid").eq("email", e.acct.email).single(), `read ${e.acct.email}`);
    if (emp.rfid_uid) continue;
    must(await sb.rpc("rfid_card_register", { p_actor: hr.id, p_employee: emp.id, p_uid: e.rfid, p_reason: "E2E seed" }), `card ${e.acct.email}`);
  }

  console.log("[seed] fixtures.sql");
  const sql = readFileSync(join(here, "fixtures.sql"), "utf8");
  execSync("docker exec -i supabase_db_SACS-PAYROLL psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres", { input: sql, stdio: ["pipe", "ignore", "inherit"] });
  console.log("[seed] done");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed({ reset: process.argv.includes("--reset") }).catch((err) => { console.error(err); process.exit(1); });
}
