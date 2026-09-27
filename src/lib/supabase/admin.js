/**
 * The service-role Supabase client, in one place.
 *
 * Thirty-one routes and helpers each carried their own copy of this function,
 * in six slightly different spellings. Two behaviours were in use, and both
 * are kept:
 *
 *   getServiceClient()        a fresh client per call; throws when the
 *                             environment is missing. What the API routes use:
 *                             a misconfigured deployment fails loudly.
 *   getCachedServiceClient()  one client reused for the process; null when the
 *                             environment is missing. What the per-request
 *                             helpers use (session check, live branch,
 *                             security settings, throttles): they run on every
 *                             call and fall back gracefully instead of failing.
 *
 * The service-role key bypasses row-level security: only server code may
 * import this module.
 */

import { createClient } from "@supabase/supabase-js";

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } };

function environment() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function getServiceClient() {
  const { url, key } = environment();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(url, key, CLIENT_OPTIONS);
}

let cachedClient = null;

export function getCachedServiceClient() {
  const { url, key } = environment();
  if (!url || !key) return null;
  if (!cachedClient) cachedClient = createClient(url, key, CLIENT_OPTIONS);
  return cachedClient;
}
