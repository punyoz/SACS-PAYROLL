// LOCAL ONLY: call the local app (the production build on port 3101) as any
// demo person. A session is registered on the account (app_metadata
// session_id, as sign-in does) and signed with the local test secret, so the
// real routes, guards and database rules run exactly as for a signed-in user.
// Never used against production.
import { createHmac, randomUUID } from "node:crypto";
import { TEST_SESSION_SECRET } from "../../e2e/accounts.mjs";
import { localSupabase } from "../../e2e/local-env.mjs";

export const LOCAL_BASE = process.env.DEMO_LOCAL_BASE || "http://localhost:3101";

const sessions = new Map();

async function adminFetch(path, init = {}) {
  const s = localSupabase();
  const res = await fetch(`${s.url}${path}`, { ...init, headers: { apikey: s.serviceKey, Authorization: `Bearer ${s.serviceKey}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The GoTrue admin API on the local stack (create users with fixed ids). */
export const localAuthAdmin = {
  async upsertUser({ id, email, password, user_metadata }) {
    try {
      return await adminFetch("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ id, email, password, email_confirm: true, user_metadata }) });
    } catch (error) {
      if (!/already|exists|422/.test(String(error.message))) throw error;
      return adminFetch(`/auth/v1/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ email, password, user_metadata, email_confirm: true }) });
    }
  },
};

async function sessionCookie(person) {
  if (sessions.has(person.id)) return sessions.get(person.id);
  const sid = randomUUID();
  await adminFetch(`/auth/v1/admin/users/${person.id}`, { method: "PUT", body: JSON.stringify({ app_metadata: { session_id: sid, session_started_at: new Date().toISOString() } }) });
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: person.id, role: person.role, branch_id: person.role === "hr" || person.role === "super_admin" ? null : person.branch_id || null,
    email: person.email, full_name: person.full, sid, pwd: false, iat: now, lat: now, idl: 8 * 3600, exp: now + 8 * 3600 };
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `${part}.${createHmac("sha256", TEST_SESSION_SECRET).update(part).digest("base64url")}`;
  const cookie = `sacs-session=${encodeURIComponent(token)}`;
  sessions.set(person.id, cookie);
  return cookie;
}

/** `as(person)` -> { get(path), post(path, body), patch(path, body) } returning { status, data }. */
export function as(person) {
  const call = async (method, path, body) => {
    const res = await fetch(`${LOCAL_BASE}${path}`, {
      method,
      headers: { cookie: await sessionCookie(person), "Content-Type": "application/json", "sec-fetch-site": "same-origin", "x-sacs-background": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
    return { status: res.status, data };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    put: (path, body) => call("PUT", path, body),
    del: (path, body) => call("DELETE", path, body),
  };
}

/** Throw unless the reply is 2xx (with the action named). */
export function ok(what, res) {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 500)}`);
  return res.data;
}
