/**
 * The one rule for a person's name, wherever one is typed or saved: first,
 * middle and last names, full names and emergency contact persons, on every
 * account form (Edit Account, HR's Add / Edit Employee, the Super Admin's
 * staff accounts) and in every API route that stores them.
 *
 * A letter first (accented letters and ñ count, so "Peña" and "Ibáñez" are
 * fine), then letters, spaces, hyphens, apostrophes and periods ("Dela Cruz",
 * "O'Brien", "Ma. Theresa", "Jr."). No digits and no other symbols.
 *
 * Used by the browser and the server alike, so it imports nothing.
 */

export const PERSON_NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .'-]*$/;

const NOT_IN_A_NAME = /[^A-Za-zÀ-ÖØ-öø-ÿ .'-]/g;

/** "may contain …": the end of every name error message. */
export const PERSON_NAME_RULE = "letters, spaces, hyphens, apostrophes and periods only";

/** Shown under a name box when a typed character was refused. */
export const NAME_TYPING_HINT = "Names can only have letters, spaces, hyphens (-), apostrophes (') and periods (.).";

/** True for a valid name (surrounding spaces ignored). */
export function isPersonName(value) {
  return PERSON_NAME_PATTERN.test(String(value ?? "").trim());
}

/**
 * Drops what a name may not contain as it is typed or pasted:
 * "Ana2" -> { value: "Ana", removed: true }.
 */
export function cleanNameInput(raw) {
  const text = String(raw ?? "");
  const value = text.replace(NOT_IN_A_NAME, "");
  return { value, removed: value !== text };
}
