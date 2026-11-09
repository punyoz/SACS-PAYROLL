// Decision 2026-11-09 #11, LOCAL stack only: the public anon key in the
// browser reads no table, and the live-bell channels are restricted per user
// by RLS (20261109120000).
//   1. anon key, and a user's bell token: every public table gives 0 rows
//   2. user A's token hears A's ping on A's private channel
//   3. user B's token, and no token at all, hear nothing on A's channel
//
//   E2E_RESET=0 npx playwright test e2e/specs/99-rls-channels.spec.mjs --project=desktop
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "../support/test.mjs";

import { profileByEmail, psql } from "../support/db.mjs";
import { localSupabase } from "../local-env.mjs";
import { ACCOUNTS } from "../accounts.mjs";
import crypto from "node:crypto";

// The same token src/lib/realtime/bell-token.js makes (tests/live-bell-2026-11-09.test.js
// pins that file to this shape); the app file is an ES module Next.js compiles.
function bellToken(userId, { secret }) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: String(userId), role: "authenticated", aud: "authenticated", iat, exp: iat + 3600, purpose: "bell" })}`;
  return { token: `${unsigned}.${crypto.createHmac("sha256", secret).update(unsigned).digest("base64url")}` };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Join `bell-<topic>` privately with `token` (or none); resolves { status, pings }. */
async function listen(url, anonKey, topic, token) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (token) client.realtime.setAuth(token);
  const state = { status: "pending", pings: 0, client };
  const channel = client.channel(`bell-${topic}`, { config: { private: true } })
    .on("broadcast", { event: "ping" }, () => { state.pings += 1; });
  state.channel = channel;
  await new Promise((resolve) => {
    channel.subscribe((status) => { state.status = status; if (status !== "pending") resolve(); });
    setTimeout(resolve, 8000);
  });
  return state;
}

test("anon key reads no table; bell channels are per user (RLS)", async () => {
  test.setTimeout(3 * 60 * 1000);
  const s = localSupabase();
  test.skip(!s.jwtSecret, "The local stack did not report its JWT secret.");
  const a = await profileByEmail(ACCOUNTS.employee.email);
  const b = await profileByEmail(ACCOUNTS.employee2.email);
  const tokenA = bellToken(a.id, { secret: s.jwtSecret }).token;
  const tokenB = bellToken(b.id, { secret: s.jwtSecret }).token;

  await test.step("1. anon key and a bell token: every public table gives 0 rows", async () => {
    const tables = psql("select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema = 'public' and table_type in ('BASE TABLE', 'VIEW')").split(",");
    expect(tables.length).toBeGreaterThan(40);
    const readable = [];
    for (const [who, auth] of [["anon", s.anonKey], ["bell token", tokenA]]) {
      for (const table of tables) {
        const res = await fetch(`${s.url}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: s.anonKey, Authorization: `Bearer ${auth}` } });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (res.ok && Array.isArray(body) && body.length) readable.push(`${who}: ${table}`);
      }
    }
    console.log(`    checked ${tables.length} tables / views twice; readable: ${readable.length ? readable.join(", ") : "none"}`);
    expect(readable).toEqual([]);
  });

  // Each account's topic (created on first use, as the API does).
  psql(`insert into notification_channels (user_id) values ('${a.id}'), ('${b.id}') on conflict do nothing`);
  const topicA = psql(`select topic from notification_channels where user_id = '${a.id}'`);

  await test.step("2-3. A hears its own ping; B's token and no token hear nothing on A's channel", async () => {
    const own = await listen(s.url, s.anonKey, topicA, tokenA);
    const other = await listen(s.url, s.anonKey, topicA, tokenB);
    const none = await listen(s.url, s.anonKey, topicA, null);
    console.log(`    joined: A=${own.status} B=${other.status} anon=${none.status}`);
    expect(own.status).toBe("SUBSCRIBED");
    psql(`insert into notifications (recipient_id, kind, title) values ('${a.id}', 'e2e_rls', 'RLS channel check')`);
    await wait(4000);
    console.log(`    pings: A=${own.pings} B=${other.pings} anon=${none.pings}`);
    expect(own.pings).toBeGreaterThan(0);
    expect(other.pings).toBe(0);
    expect(none.pings).toBe(0);
    for (const l of [own, other, none]) await l.client.removeChannel(l.channel).catch(() => {});
    psql("delete from notifications where kind = 'e2e_rls'");
  });
});
