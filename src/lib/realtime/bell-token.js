import crypto from "node:crypto";

/**
 * A short-lived token that lets the browser listen on its OWN private bell
 * channel (decision 2026-11-09 #11, 20261109120000). Signed HS256 with the
 * project's JWT secret (SUPABASE_JWT_SECRET, server only, never sent).
 *
 * Role "authenticated": Realtime checks the channel against the RLS policy
 * bell_listen_own_topic (auth.uid() must own the topic). The role has no
 * grant on any public table and both storage buckets refuse it, so the token
 * reads no data (e2e/specs/99-rls-channels.spec.mjs).
 *
 * Returns null when no secret is configured: the bell then reloads once a
 * minute instead of live.
 */
export const BELL_TOKEN_SECONDS = 60 * 60;

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export function bellToken(userId, { now = Date.now(), secret = process.env.SUPABASE_JWT_SECRET } = {}) {
  if (!secret || !userId) return null;
  const iat = Math.floor(now / 1000);
  const payload = { sub: String(userId), role: "authenticated", aud: "authenticated", iat, exp: iat + BELL_TOKEN_SECONDS, purpose: "bell" };
  const unsigned = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return { token: `${unsigned}.${signature}`, expires_at: new Date((iat + BELL_TOKEN_SECONDS) * 1000).toISOString() };
}
