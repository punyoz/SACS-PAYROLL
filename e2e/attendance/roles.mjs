// Shared bits of the fast attendance tests.
import { join } from "node:path";

// Kept apart from the main suite's sessions (other port, other origin); gitignored.
export const ATT_AUTH_DIR = join(process.cwd(), "test-results", ".auth-attendance");

export const ATT_ROLES = ["employee", "admin", "hr", "accountant", "super_admin"];
export const stateFile = (role) => join(ATT_AUTH_DIR, `${role}.json`);

/** Each role's attendance page (one shared view, different controls). */
export const ATT_PAGE = {
  employee: "/employee?page=emp-attendance",
  admin: "/admin?page=adm-attendance",
  hr: "/hr?page=hr-attendance",
  accountant: "/accountant?page=ac-attendance",
  super_admin: "/super-admin?page=sa-attendance",
};

/** The seeded range (e2e/attendance/seed.sql). */
export const SEED = { from: "2026-10-22", to: "2026-10-31" };
