// One demo account per role for the empty-page audit (G8). Passwords come
// from the gitignored demo-data/credentials.csv; nothing is printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIT_ROLES = {
  super_admin: { tag: "sa1", portal: "/super-admin" },
  admin: { tag: "adm-b1-1", portal: "/admin" },
  hr: { tag: "hr1", portal: "/hr" },
  accountant: { tag: "acc-b1-1", portal: "/accountant" },
  accountant_single: { tag: "acc-b3-1", portal: "/accountant" },
  employee: { tag: "emp1", portal: "/employee" },
};

export const AUTH_DIR = join(process.cwd(), "test-results", ".auth-demo");
export const stateFile = (role) => join(AUTH_DIR, `${role}.json`);
export const OUT_DIR = join(process.cwd(), "test-results", "demo-audit");

/** tag -> { email, password } from the gitignored credentials file. */
export function credentials() {
  const file = join(process.cwd(), "demo-data", "credentials.csv");
  if (!existsSync(file)) throw new Error("demo-data/credentials.csv is missing: run scripts/demo/build-local.mjs first.");
  return Object.fromEntries(readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).map((line) => {
    const [tag, , email, password] = line.split(",");
    return [tag, { email, password }];
  }));
}
