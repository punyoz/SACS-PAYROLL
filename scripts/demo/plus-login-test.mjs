// Item 3 (2026-11-09): the ONE production test of a "+" address login code.
// Creates a single is_demo Employee (+emptest, Pinugay Branch), asks the live
// site to sign it in (which e-mails the 6-digit code), and reports the reply.
// `--remove` deletes that one account again. Nothing else is touched.
//   node scripts/demo/plus-login-test.mjs --target=production [--remove]
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, demoEmail, readEnvFile } from "./config.mjs";
import { chooseTarget, lit } from "./db.mjs";
import { stableId } from "./roster.mjs";
import { profileInsert } from "./build-local.mjs";

const db = await chooseTarget(process.argv.slice(2));
if (db.target !== "production") throw new Error("This test is for production only.");
const env = readEnvFile(join(process.cwd(), ".env.live.local"));
const id = stableId("emptest");
const email = demoEmail("emptest");
const admin = (path, init = {}) => fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users${path}`, { ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" } });

if (process.argv.includes("--remove")) {
  await db.exec(`begin; alter table profiles disable trigger user; delete from notification_channels where user_id = ${lit(id)}; delete from profiles where id = ${lit(id)} and is_demo; alter table profiles enable trigger user; commit;`);
  const r = await admin(`/${id}`, { method: "DELETE" });
  console.log(`removed the test account (login account: HTTP ${r.status})`);
  process.exit(0);
}

const [branch] = await db.rows("select id, name from branches where code = 'BR-004'");
const password = `Dm${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}#7`;
const created = await admin("", { method: "POST", body: JSON.stringify({ id, email, password, email_confirm: true, user_metadata: { role: "employee", full_name: "Plus Demo Test", branch_id: branch.id, employee_id: "DEMO-T01", is_demo: true } }) });
if (!created.ok) throw new Error(`login account: HTTP ${created.status} ${(await created.text()).slice(0, 200)}`);
await db.exec(profileInsert({ id, email, full: "Plus Demo Test", first: "Plus", middle: "Demo", last: "Test", role: "employee", employee_id: "DEMO-T01", branch_id: branch.id,
  employee_type: "Non-Teaching", position: "Staff", basic_salary: 15000, date_hired: "2026-11-01", cp_number: "09990000999", on_payroll: true,
  sss_number: "9800000999", philhealth_number: "980000000999", pagibig_number: "981000000999", tin_number: "998000999" }));
writeFileSync(join(DATA_DIR, "plus-login-test.csv"), `tag,email,password\nemptest,${email},${password}\n`, { mode: 0o600 });
console.log(`created one is_demo Employee in ${branch.name} (+emptest); its password is only in demo-data/plus-login-test.csv`);

const res = await fetch("https://sacs-payroll.vercel.app/api/legacy-auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: email, password }) });
const body = await res.json().catch(() => ({}));
console.log(`sign-in on the live site: HTTP ${res.status} ${JSON.stringify({ otp_required: body.otp_required ?? body.requires_otp ?? null, sent_to: body.masked_email || body.sent_to || null, error: body.error || null })}`);
console.log("Check the inbox for a code addressed to the +emptest tag.");
