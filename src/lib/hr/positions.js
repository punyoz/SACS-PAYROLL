/**
 * Positions HR picks from and adds to (alpha test B3, 20261109050000).
 *
 * One spelling per position: "teacher  i" is the existing "Teacher I". A new
 * position is added on first use. The role defaults stay: an HR account is
 * always "HR Officer", and an empty position (or "Employee" / "Accountant")
 * follows the role, as before.
 */
import { normalizeText } from "@/lib/auth/normalize";

export const POSITION_MIN = 2;
export const POSITION_MAX = 80;
export const POSITION_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 .,'()/&-]*$/;

/** "  teacher   I " -> "teacher I" (spaces folded, case kept). */
export function tidyPosition(raw) {
  return normalizeText(raw).replace(/\s+/g, " ");
}

/** The key two spellings of one position share. */
export function positionKey(raw) {
  return tidyPosition(raw).toLowerCase();
}

/** Why a position cannot be saved, or null. */
export function positionError(raw) {
  const name = tidyPosition(raw);
  if (name.length < POSITION_MIN || name.length > POSITION_MAX) return `Position: ${POSITION_MIN} to ${POSITION_MAX} characters.`;
  if (!POSITION_PATTERN.test(name)) return "Position: letters, numbers, spaces and . , ' ( ) / & - only.";
  return null;
}

/** Every position, A to Z. Never throws: [] when the list is not set up. */
export async function loadPositions(supabase) {
  const result = await supabase.from("employee_positions").select("id,name,created_by_name,created_at").order("name", { ascending: true }).limit(2000);
  return result.error ? [] : result.data || [];
}

/**
 * The position as stored: the existing spelling when one matches (any
 * capitals / spaces), else the new one, added to the list.
 * @returns {Promise<{ name: string, created: boolean } | { error: string, status: number }>}
 */
export async function ensurePosition(supabase, raw, actor = {}) {
  const invalid = positionError(raw);
  if (invalid) return { error: invalid, status: 400 };
  const name = tidyPosition(raw);
  const existing = (await loadPositions(supabase)).find((p) => positionKey(p.name) === positionKey(name));
  if (existing) return { name: existing.name, created: false };
  const inserted = await supabase.from("employee_positions")
    .insert({ name, created_by: actor.userId || null, created_by_name: actor.name || null })
    .select("name").maybeSingle();
  if (inserted.error) {
    // Added by someone else a moment ago: use theirs.
    const again = (await loadPositions(supabase)).find((p) => positionKey(p.name) === positionKey(name));
    if (again) return { name: again.name, created: false };
    return { error: "The position could not be added.", status: 500 };
  }
  return { name: inserted.data?.name || name, created: true };
}

const ROLE_DEFAULTS = new Set(["employee", "accountant", "hr officer", ""]);

/**
 * The position an account is saved with. `fallback(input, role)` is the
 * route's old role rule, used for HR accounts and for an empty / default
 * position.
 */
export async function resolvePosition(supabase, input, role, fallback, actor) {
  const r = String(role || "").toLowerCase();
  if (r === "hr" || r === "admin" || r === "super_admin" || ROLE_DEFAULTS.has(positionKey(input))) {
    return { name: fallback(input, role) };
  }
  return ensurePosition(supabase, input, actor);
}
