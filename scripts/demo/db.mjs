// One SQL runner for the demo scripts: the LOCAL stack (docker psql) or
// PRODUCTION (Supabase Management API, token from SUPABASE_ACCESS_TOKEN).
// Nothing here prints a key, a token or a password.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { PRODUCTION } from "./config.mjs";

const LOCAL_CONTAINER = "supabase_db_SACS-PAYROLL";

function localQuery(sql) {
  const run = spawnSync("docker", ["exec", "-i", LOCAL_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tAq", "-f", "-"], {
    input: sql, encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`local SQL failed: ${(run.stderr || run.stdout).slice(0, 1500)}`);
  return run.stdout;
}

async function productionQuery(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set.");
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PRODUCTION.ref}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    if (res.ok) return text;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    throw new Error(`production SQL failed: HTTP ${res.status}: ${text.slice(0, 1500)}`);
  }
}

/**
 * target: "local" | "production". `rows(sql)` runs a SELECT and returns its
 * rows as objects; `exec(sql)` runs statements (one transaction if wrapped).
 */
export function database(target) {
  if (target !== "local" && target !== "production") throw new Error(`Unknown target ${target}.`);
  // The alias is unusual on purpose: a selected column named like it would shadow the row.
  const wrap = (sql) => `select coalesce(json_agg(__demo_row), '[]'::json) from (${sql.trim().replace(/;$/, "")}) __demo_row`;
  if (target === "local") {
    return {
      target,
      rows: async (sql) => JSON.parse(localQuery(wrap(sql)).trim() || "[]"),
      exec: async (sql) => { localQuery(sql); },
    };
  }
  return {
    target,
    rows: async (sql) => {
      const out = JSON.parse(await productionQuery(wrap(sql)));
      return out?.[0]?.coalesce ?? out?.[0]?.json_agg ?? Object.values(out?.[0] || {})[0] ?? [];
    },
    exec: async (sql) => { await productionQuery(sql); },
  };
}

/** SQL literal for a value (strings, numbers, booleans, null, JSON). */
export function lit(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") return `${lit(JSON.stringify(value))}::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Ask a yes/no (or exact text) question on the terminal. */
export async function confirm(question, expected = "yes") {
  if (process.env.DEMO_ASSUME_YES === "1" && expected === "yes") return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} `)).trim();
  rl.close();
  return answer === expected;
}

/**
 * Production guard for every script: the target must be named on the command
 * line AND the production project URL typed back exactly.
 */
export async function chooseTarget(argv = process.argv.slice(2)) {
  const target = (argv.find((a) => a.startsWith("--target=")) || "--target=local").split("=")[1];
  if (target === "production") {
    console.log(`PRODUCTION. Type the project URL to continue (${PRODUCTION.url.replace(/^https:\/\//, "")} written in full, with https://):`);
    const ok = await confirm(">", PRODUCTION.url);
    if (!ok) { console.log("The URL did not match. Nothing was done."); process.exit(1); }
  }
  return database(target);
}
