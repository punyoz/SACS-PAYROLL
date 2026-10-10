/**
 * Safety checks for scripts/clean-reset.mjs, which hard-deletes payroll,
 * attendance, leave and audit rows and every non-seed account.
 *
 *   1. It refuses the live project outright: its ref is listed below (more
 *      can be added, comma-separated, in SUPABASE_LIVE_PROJECT_REFS), and it
 *      refuses whenever NODE_ENV is "production".
 *   2. Anywhere else it needs the operator to type `RESET <target>` in a
 *      terminal, where <target> is the project ref (or host:port for a local
 *      stack). Piped or scripted input is refused.
 *
 * Kept separate from clean-reset.mjs so tests can import it: importing that
 * script would run the reset.
 */

/** The production project (NEXT_PUBLIC_SUPABASE_URL https://<ref>.supabase.co). */
export const LIVE_PROJECT_REFS = Object.freeze(["swtlmaupaarrppypxsip"]);

function parse(url) {
  try {
    return new URL(String(url || ""));
  } catch {
    return null;
  }
}

/** "abc123" for https://abc123.supabase.co, else null. */
export function projectRefOf(url) {
  const host = parse(url)?.hostname.toLowerCase() || "";
  const match = host.match(/^([a-z0-9]+)\.supabase\.(co|in)$/);
  return match ? match[1] : null;
}

/** What the operator types after RESET: the project ref, or host:port. */
export function resetTarget(url) {
  const parsed = parse(url);
  if (!parsed) return "";
  return projectRefOf(url) || parsed.host.toLowerCase();
}

export function confirmationPhrase(url) {
  return `RESET ${resetTarget(url)}`;
}

function liveRefs(env) {
  const extra = String(env?.SUPABASE_LIVE_PROJECT_REFS || "")
    .split(",")
    .map((ref) => ref.trim().toLowerCase())
    .filter(Boolean);
  return [...LIVE_PROJECT_REFS, ...extra];
}

/** Why the reset must not run against this URL, or null when it may ask. */
export function resetRefusal(url, env = {}) {
  if (!parse(url)) return "NEXT_PUBLIC_SUPABASE_URL is missing or not a URL.";
  if (String(env.NODE_ENV || "").toLowerCase() === "production") {
    return "Refusing to run with NODE_ENV=production.";
  }
  const ref = projectRefOf(url);
  if (ref && liveRefs(env).includes(ref)) {
    return `Refusing to reset the live project (${ref}). Point .env.local at a local or test project first.`;
  }
  return null;
}

/** True only for the exact phrase (surrounding spaces ignored). */
export function isConfirmed(answer, url) {
  return String(answer || "").trim() === confirmationPhrase(url);
}
