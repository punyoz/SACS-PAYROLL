// The production build for the fast attendance tests (LOCAL stack keys only).
// Builds once into .next-e2e (E2E_BUILD=1 forces a rebuild), then serves it on
// E2E_ATT_PORT (3101). A running dev server's .next is not touched.
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appEnv } from "../local-env.mjs";

const port = process.env.E2E_ATT_PORT || "3101";
const env = { ...process.env, ...appEnv(), NEXT_DIST_DIR: ".next-e2e", NEXT_TELEMETRY_DISABLED: "1" };
if (process.env.E2E_BUILD === "1" || !existsSync(join(process.cwd(), ".next-e2e", "BUILD_ID"))) {
  execSync("npx next build", { env, stdio: "inherit" });
}
const child = spawn("npx", ["next", "start", "-p", port], { env, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
