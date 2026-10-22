// Environment for the local Playwright suite: the LOCAL Supabase stack's URL
// and keys (from `supabase status`), never .env.local's live project.
import { execSync } from "node:child_process";
import { ACCOUNTS, TEST_SESSION_SECRET } from "./accounts.mjs";

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

export function assertLocalUrl(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* invalid */ }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`Refusing to run the E2E suite against ${url || "(no URL)"}: it must be the local Supabase stack.`);
  }
}

let cached = null;

/** The local stack's settings, read once from `npx supabase status -o env`. */
export function localSupabase() {
  if (cached) return cached;
  const out = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) values[m[1]] = m[2];
  }
  if (!values.API_URL || !values.SERVICE_ROLE_KEY || !values.ANON_KEY) {
    throw new Error("Local Supabase is not running. Start Docker, then `npx supabase start`.");
  }
  assertLocalUrl(values.API_URL);
  cached = { url: values.API_URL, anonKey: values.ANON_KEY, serviceKey: values.SERVICE_ROLE_KEY, dbUrl: values.DB_URL };
  return cached;
}

/**
 * Every variable the app reads, set explicitly so nothing falls through to
 * .env.local (Next.js never overrides a variable that is already set, even
 * an empty one): no live database, no Gmail, no Sentry.
 */
export function appEnv() {
  const s = localSupabase();
  return {
    NEXT_PUBLIC_SUPABASE_URL: s.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: s.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: s.serviceKey,
    SESSION_SECRET: TEST_SESSION_SECRET,
    GMAIL_USER: "",
    GMAIL_APP_PASSWORD: "",
    MAIL_FROM_NAME: "",
    USE_MAILTM: "false",
    PASSWORD_BREACH_CHECK: "off",
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    SENTRY_ENVIRONMENT: "e2e",
    SENTRY_AUTH_TOKEN: "",
    SUPABASE_DB_URL: "",
    SEED_SUPER_ADMIN_EMAIL: ACCOUNTS.super_admin.email,
    SEED_SUPER_ADMIN_PASSWORD: ACCOUNTS.super_admin.password,
    SEED_SUPER_ADMIN_USERNAME: ACCOUNTS.super_admin.login,
    SEED_ADMIN_EMAIL: ACCOUNTS.admin.email,
    SEED_ADMIN_PASSWORD: ACCOUNTS.admin.password,
    SEED_ADMIN_USERNAME: ACCOUNTS.admin.login,
    SEED_HR_EMAIL: ACCOUNTS.hr.email,
    SEED_HR_PASSWORD: ACCOUNTS.hr.password,
    SEED_HR_USERNAME: ACCOUNTS.hr.login,
    SEED_HR_EMPLOYEE_ID: "E2E-HR-001",
    SEED_ACCOUNTANT_EMAIL: ACCOUNTS.accountant.email,
    SEED_ACCOUNTANT_PASSWORD: ACCOUNTS.accountant.password,
    SEED_ACCOUNTANT_EMPLOYEE_ID: "E2E-ACCT-001",
    SEED_EMPLOYEE_EMAIL: ACCOUNTS.employee.email,
    SEED_EMPLOYEE_PASSWORD: ACCOUNTS.employee.password,
    SEED_EMPLOYEE_LOGIN_ID: "E2E-EMP-001",
  };
}
