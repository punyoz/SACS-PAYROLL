// Builds and serves the app against the LOCAL stack (production mode, the
// way the timings should be read). Never uses .env.local's live project.
//
//   node e2e/scale/serve.mjs [--no-build]     then http://localhost:3200
import { spawn, execSync } from "node:child_process";
import { appEnv } from "../local-env.mjs";

const env = { ...process.env, ...appEnv(), NODE_ENV: "production" };
if (!process.argv.includes("--no-build")) {
  execSync("npx next build", { env, stdio: "inherit" });
}
const server = spawn("npx", ["next", "start", "-p", process.env.E2E_SCALE_PORT || "3200"], { env, stdio: "inherit", shell: true });
server.on("exit", (code) => process.exit(code ?? 0));
