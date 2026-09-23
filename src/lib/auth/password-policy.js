/**
 * Password rules shared by account creation, sign-in and change-password.
 *
 * New accounts are issued a guessable default password — the last name plus
 * the date of birth plus a fixed symbol (e.g. DelaCruz10082004!) — so the
 * holder must replace it before the account can do anything else. The fixed
 * symbol is required because the Supabase Auth project's password policy
 * demands at least one symbol character; the app's own rules (see
 * validateNewPassword below) never required one. Two independent signals
 * decide the "must change" check at sign-in, and either one is enough:
 *
 *   1. The password matches the one-time password the account was issued.
 *      Its keyed hash is kept in app_metadata (never user-editable), so this
 *      still holds after HR corrects the name or birth date on the record.
 *   2. The password has the default LastName+MMDDYYYY+symbol shape for the
 *      name and birth date on file. This also covers accounts created before
 *      (1) existed.
 */

import crypto from "node:crypto";

export const PASSWORD_MIN_LENGTH = 8;
// GoTrue hashes with bcrypt, which silently ignores anything past 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;
// Guarantees the generated default password satisfies the Supabase project's
// "at least one symbol" requirement, which plain LastName+MMDDYYYY does not.
export const DEFAULT_PASSWORD_SYMBOL = "!";

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

function toTitleCaseWords(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** YYYY-MM-DD -> MMDDYYYY, or "" when the date is not in that form. */
export function formatDateForPassword(dateOfBirth) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOfBirth ?? "").trim());
  if (!match) return "";
  const [, year, month, day] = match;
  return `${month}${day}${year}`;
}

export function buildDefaultPassword(lastName, dateOfBirth) {
  const last = toTitleCaseWords(lastName).replace(/\s+/g, "");
  const dob = formatDateForPassword(dateOfBirth);
  if (!last || !dob) return "";
  return `${last}${dob}${DEFAULT_PASSWORD_SYMBOL}`;
}

/**
 * Every run of trailing name words a stored full name could have taken its
 * last name from ("Juan Santos Dela Cruz Jr." -> Cruz, DelaCruz, SantosDelaCruz).
 * Only a composed full name is stored, so the exact split is not recoverable.
 */
function lastNameCandidates(fullName) {
  const tokens = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  while (tokens.length && NAME_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  const candidates = [];
  for (let start = tokens.length - 1; start >= 1; start -= 1) {
    candidates.push(tokens.slice(start).join("").toLowerCase());
  }
  return candidates;
}

/** True when `password` is the LastName+MMDDYYYY+symbol default for this person. */
export function isDefaultPassword(password, { full_name, date_of_birth } = {}) {
  const value = String(password ?? "");
  const dob = formatDateForPassword(date_of_birth);
  const suffix = dob ? `${dob}${DEFAULT_PASSWORD_SYMBOL}` : "";
  if (!value || !suffix || !value.endsWith(suffix)) return false;

  const prefix = value.slice(0, -suffix.length).toLowerCase();
  if (!prefix) return false;
  return lastNameCandidates(full_name).includes(prefix);
}

function hashingKey() {
  const key = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("Missing SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY for password hashing.");
  }
  return key;
}

/** Keyed hash of an issued one-time password, stored as app_metadata.temp_password_hash. */
export function hashTemporaryPassword(password) {
  return crypto
    .createHmac("sha256", hashingKey())
    .update(`sacs-temp-password:${String(password ?? "")}`)
    .digest("base64url");
}

function matchesTemporaryPassword(password, appMetadata) {
  const stored = String(appMetadata?.temp_password_hash || "");
  if (!stored) return false;

  let computed;
  try {
    computed = hashTemporaryPassword(password);
  } catch {
    return false;
  }
  const a = Buffer.from(stored);
  const b = Buffer.from(computed);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Decide at sign-in whether this password still has to be replaced.
 * `fullName` should be the authoritative (profiles) name when available.
 */
export function mustChangePassword(password, user, fullName) {
  if (matchesTemporaryPassword(password, user?.app_metadata)) return true;
  return isDefaultPassword(password, {
    full_name: fullName || user?.user_metadata?.full_name,
    date_of_birth: user?.user_metadata?.date_of_birth,
  });
}

/**
 * Validate a password the user chose for themselves. Returns an error message,
 * or null when the password is acceptable.
 */
export function validateNewPassword(newPassword, { currentPassword, full_name, date_of_birth } = {}) {
  const value = String(newPassword ?? "");

  if (value.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `New password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (/\s/.test(value)) {
    return "New password cannot contain spaces.";
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return "New password must contain both letters and numbers.";
  }
  if (currentPassword !== undefined && value === String(currentPassword)) {
    return "New password must be different from your current password.";
  }
  if (isDefaultPassword(value, { full_name, date_of_birth })) {
    return "New password cannot be your default password (last name + birth date).";
  }
  return null;
}
