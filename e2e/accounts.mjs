// Test accounts for the local Playwright suite (e2e/). They exist only on the
// LOCAL Supabase stack: e2e/seed-e2e.mjs creates them and refuses any other
// database. Never use these addresses or passwords on the live project.

export const ACCOUNTS = {
  super_admin: { login: "e2esa", email: "sa@e2e.test", password: "E2e-SuperAdmin#2026", portal: "/super-admin" },
  admin: { login: "e2eadmin", email: "admin@e2e.test", password: "E2e-Admin#2026", portal: "/admin" },
  admin2: { login: "admin2@e2e.test", email: "admin2@e2e.test", password: "E2e-Admin#2026", portal: "/admin" },
  hr: { login: "e2ehr", email: "hr@e2e.test", password: "E2e-HrOfficer#2026", portal: "/hr" },
  accountant: { login: "acct@e2e.test", email: "acct@e2e.test", password: "E2e-Accountant#2026", portal: "/accountant" },
  employee: { login: "emp1@e2e.test", email: "emp1@e2e.test", password: "E2e-Employee#2026", portal: "/employee" },
  employee2: { login: "emp2@e2e.test", email: "emp2@e2e.test", password: "E2e-Employee#2026", portal: "/employee" },
  employee3: { login: "emp3@e2e.test", email: "emp3@e2e.test", password: "E2e-Employee#2026", portal: "/employee" },
};

// The five roles the suite walks page by page.
export const ROLES = ["super_admin", "admin", "hr", "accountant", "employee"];

// The fixed sign-in code the suite plants (e2e/support/auth.mjs) instead of
// reading an email.
export const TEST_OTP = "246810";

// Session secret for the local dev server the suite starts.
export const TEST_SESSION_SECRET = "e2e-local-only-session-secret-0123456789abcdef";

// Branches: everyone is in Main Campus except emp3 and admin2 (North).
export const BRANCH_MAIN = "Main Campus";
export const BRANCH_NORTH = "E2E North Branch";
