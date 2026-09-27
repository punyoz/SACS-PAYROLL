/**
 * Refuse passwords that appear in known data breaches.
 *
 * Supabase Auth's own "leaked password protection" does this, but only on
 * Pro plans and above; this project is on the Free plan, where the setting is
 * refused. This is the same check done by the app, against the same
 * HaveIBeenPwned "Pwned Passwords" list.
 *
 * PRIVACY. The password never leaves the server, and neither does its hash.
 * Only the first 5 hex characters of its SHA-1 are sent (the k-anonymity
 * range API); the service answers with every breached hash sharing that
 * prefix -- hundreds of them -- and the match is made here. The Add-Padding
 * header makes every answer a similar size, so even the response length says
 * nothing. No API key is needed.
 *
 * FAILS OPEN. If the service is slow or unreachable the password is judged
 * on the local rules alone (src/lib/auth/password-policy.js): a network blip
 * must not stop anyone from changing their password.
 *
 * Set PASSWORD_BREACH_CHECK=off to disable (it is off under the test runner).
 */

import crypto from "node:crypto";

export const BREACHED_PASSWORD_MESSAGE =
  "This password has appeared in a known data breach. Choose a different one.";

const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 3000;

function isEnabled() {
  const setting = String(process.env.PASSWORD_BREACH_CHECK || "").trim().toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") return false;
  if (setting === "on" || setting === "true" || setting === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/**
 * How many times `password` appears in the breach corpus: 0 when it does not,
 * or when the check could not be made.
 *
 * @param {string} password
 * @param {{ fetchImpl?: typeof fetch, force?: boolean }} [options] test seams
 * @returns {Promise<number>}
 */
export async function breachCount(password, { fetchImpl = globalThis.fetch, force = false } = {}) {
  const value = String(password ?? "");
  if (!value || (!force && !isEnabled()) || typeof fetchImpl !== "function") return 0;

  const hash = crypto.createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  try {
    const response = await fetchImpl(`${RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "sacs-payroll-password-check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return 0;

    const body = await response.text();
    for (const line of body.split("\n")) {
      const [candidate, count] = line.trim().split(":");
      if (candidate === suffix) {
        const n = Number(count);
        return Number.isFinite(n) && n > 0 ? n : 0; // padding rows carry count 0
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

/** The refusal message when `password` is breached, else null. */
export async function breachedPasswordError(password, options) {
  return (await breachCount(password, options)) > 0 ? BREACHED_PASSWORD_MESSAGE : null;
}
