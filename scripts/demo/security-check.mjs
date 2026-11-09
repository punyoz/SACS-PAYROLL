// The security check before and after the demo seed on PRODUCTION (or local):
//   1. the anon (publishable) key reads no row of any public table or view;
//   2. a live-bell channel listens only for its owner: another user's token
//      and no token at all are refused (RLS on realtime.messages).
// Read-only: it subscribes and reads, never writes. Keys come from
// .env.live.local (production) and are never printed.
//   node scripts/demo/security-check.mjs --target=production
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readEnvFile } from "./config.mjs";
import { chooseTarget } from "./db.mjs";

const db = await chooseTarget(process.argv.slice(2));
let url; let anon; let jwtSecret;
if (db.target === "production") {
  const env = readEnvFile(join(process.cwd(), ".env.live.local"));
  url = env.NEXT_PUBLIC_SUPABASE_URL; anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const res = await fetch(`https://api.supabase.com/v1/projects/swtlmaupaarrppypxsip/postgrest`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } });
  jwtSecret = (await res.json()).jwt_secret;
} else {
  const s = (await import("../../e2e/local-env.mjs")).localSupabase();
  url = s.url; anon = s.anonKey; jwtSecret = s.jwtSecret;
}

const relations = (await db.rows("select table_name as t from information_schema.tables where table_schema = 'public' order by 1")).map((r) => r.t);
let readable = 0;
const leaks = [];
for (const t of relations) {
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
  const body = await res.text();
  if (res.ok && body.trim() !== "[]") { readable += 1; leaks.push(t); }
}
console.log(`1. anon key: ${relations.length} tables/views tried, ${readable} returned rows${leaks.length ? `: ${leaks.join(", ")}` : ""}`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (sub) => { const now = Math.floor(Date.now() / 1000); const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 300, purpose: "bell" })}`; return `${body}.${createHmac("sha256", jwtSecret).update(body).digest("base64url")}`; };
const [owner] = await db.rows("select c.user_id, c.topic from notification_channels c join profiles p on p.id = c.user_id order by p.is_demo desc limit 1");
const { createClient } = createRequire(join(process.cwd(), "package.json"))("@supabase/supabase-js");
async function listen(jwt, topic) {
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  if (jwt) client.realtime.setAuth(jwt);
  const status = await new Promise((done) => {
    const timer = setTimeout(() => done("TIMED_OUT"), 15000);
    client.channel(`bell-${topic}`, { config: { private: true } }).subscribe((s) => { if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(s)) { clearTimeout(timer); done(s); } });
  });
  await client.removeAllChannels();
  return status;
}
if (owner) {
  const own = await listen(token(owner.user_id), owner.topic);
  const other = await listen(token(randomUUID()), owner.topic);
  const none = await listen(null, owner.topic);
  console.log(`2. live channel of one account: owner ${own}, another user ${other}, no token ${none}`);
  const ok = readable === 0 && own === "SUBSCRIBED" && other !== "SUBSCRIBED" && none !== "SUBSCRIBED";
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
} else {
  console.log("2. no live channel exists yet (one is made on an account's first sign-in); channel check skipped");
  console.log(readable === 0 ? "PASS (anon)" : "FAIL");
  process.exit(readable === 0 ? 0 : 1);
}
