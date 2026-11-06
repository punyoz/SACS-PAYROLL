// Processing window enforcement for the LOCAL or DEMO stack (testing and the
// final defense). The live system is changed only by the Super Admin in
// System Configuration -> Payroll -> Processing window enforcement.
//
//   node scripts/window-enforcement.mjs status
//   node scripts/window-enforcement.mjs on  [--reason "..."]
//   node scripts/window-enforcement.mjs off [--reason "..."] [--until YYYY-MM-DD]
//
// Reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
// environment or .env.local. Refuses any non-local URL unless
// SACS_ENVIRONMENT=demo is set. Every change is logged
// (payroll_window_enforcement_changes, source "seed"). Never prints keys.
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const environment = String(process.env.SACS_ENVIRONMENT || "").toLowerCase();

function isLocal(value) {
  try { return ["127.0.0.1", "localhost"].includes(new URL(value).hostname); } catch { return false; }
}

const [command = "status", ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!isLocal(url) && environment !== "demo") {
  console.error("Refusing: this is not the local stack. On a demo project set SACS_ENVIRONMENT=demo; on the live system use System Configuration.");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

async function status() {
  const result = await sb.rpc("payroll_window_enforcement_state");
  if (result.error) throw new Error(result.error.message);
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) || {};
  console.log(`Processing window enforcement: ${row.enforced === false ? "OFF (testing mode)" : "ON"}${row.expires_on ? `, back ON on ${row.expires_on}` : ""}`);
}

if (command === "status") {
  await status();
} else if (command === "on" || command === "off") {
  const enforced = command === "on";
  const result = await sb.rpc("set_payroll_window_enforcement", {
    p_enforced: enforced,
    p_expires_on: enforced ? null : flag("--until") || null,
    p_reason: flag("--reason") || (enforced ? "Demo/local reset: enforcement ON" : "Demo/local: testing mode for the demo"),
    p_actor: null,
    p_actor_name: "Seed script",
    p_source: "seed",
    p_environment: isLocal(url) ? "local" : "demo",
  });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  await status();
} else {
  console.error("Usage: node scripts/window-enforcement.mjs status | on | off [--reason text] [--until YYYY-MM-DD]");
  process.exit(1);
}
