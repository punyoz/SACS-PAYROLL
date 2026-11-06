/**
 * Processing window enforcement: the Super Admin's testing switch
 * (2026-11-06; supabase/migrations/20261106090000_payroll_window_enforcement_switch.sql).
 *
 * ON (the default, and the only state before the migration): the processing
 * window rules in generation-window.js / override-window.js apply exactly as
 * before; applyWindowEnforcement() returns the window object untouched.
 *
 * OFF (testing / the final defense): the Accountant may process, generate,
 * reprocess and submit any cutoff of their OWN branch on any date, and the
 * attendance overrides (Absent, Late, Undertime, Half day, Leave without pay,
 * Perfect attendance) are open on any date, still with a reason and logged.
 * Every other rule is untouched: branch scope, run locks (Pending /
 * Approved), read-only government deductions and tax, partial submission
 * acknowledgment, HR approval, own payslip system-computed only, the Super
 * Admin's Final payslip override.
 *
 * The server reads the setting from the database
 * (payroll_window_enforcement_state(), which applies the auto-expiry date at
 * read time) and puts the result into the window object the API returns, so
 * the portal and the API always judge by the same value. Any read error
 * counts as ON.
 */

export const TESTING_MODE_BANNER = "Testing mode: processing window not enforced.";

/** ON: what every caller assumes when the setting cannot be read. */
export const ENFORCED = Object.freeze({ enforced: true, available: false, expires_on: null, expired: false });

/** True when the deployment is the real one (turning OFF then needs an explicit confirmation). */
export function deploymentEnvironment(env = process.env) {
  const named = String(env.SACS_ENVIRONMENT || "").trim().toLowerCase();
  if (["production", "demo", "local"].includes(named)) return named;
  const url = String(env.NEXT_PUBLIC_SUPABASE_URL || "");
  if (/^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:|\/|$)/i.test(url)) return "local";
  return "production";
}

/**
 * The switch as the server applies it.
 * @returns {Promise<{ enforced: boolean, available: boolean, expires_on: string|null, expired: boolean, stored_enforced?: boolean, reason?: string|null, changed_by_name?: string|null, changed_at?: string|null, today?: string }>}
 */
export async function loadWindowEnforcement(supabase) {
  try {
    const result = await supabase.rpc("payroll_window_enforcement_state");
    if (result.error) return { ...ENFORCED };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) return { ...ENFORCED };
    return {
      enforced: row.enforced !== false,
      available: true,
      stored_enforced: row.stored_enforced !== false,
      expired: row.expired === true,
      expires_on: row.expires_on || null,
      reason: row.reason || null,
      changed_by_name: row.changed_by_name || null,
      changed_at: row.changed_at || null,
      today: row.today || null,
    };
  } catch {
    return { ...ENFORCED };
  }
}

/** What Accountant / HR pages are told: only whether testing mode is on (no reason, no names). */
export function publicEnforcement(enforcement) {
  const off = enforcement && enforcement.enforced === false;
  return { enforced: !off, testing_mode: off, expires_on: off ? enforcement.expires_on || null : null, banner: off ? TESTING_MODE_BANNER : null };
}

/**
 * The generation window (generationWindow()) with the switch applied.
 * ON: the same object, unchanged. OFF: generation open ("final"), the
 * original state kept in `enforced_state` (a payslip processed after the
 * window still carries HR's "processed late" mark), and attendance never
 * counted past today (a cutoff processed before its days have passed).
 */
export function applyWindowEnforcement(window, enforcement) {
  if (!window || !enforcement || enforcement.enforced !== false) return window;
  const today = window.today;
  const through = window.attendance_through && today && window.attendance_through > today ? today : window.attendance_through;
  return {
    ...window,
    state: "final",
    can_generate: true,
    enforced_state: window.state,
    enforced_message: window.message,
    enforcement_off: true,
    attendance_through: through,
    message: `${TESTING_MODE_BANNER} Generating creates the Final payslip on any date (normally: ${window.message})`,
    window_enforcement: publicEnforcement(enforcement),
  };
}

/** True when the window object says the processing window is not enforced. */
export function windowNotEnforced(window) {
  return Boolean(window && window.enforcement_off === true);
}
