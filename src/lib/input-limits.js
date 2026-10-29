/**
 * The input limits every form box, API route and database CHECK share
 * (input limits, 2026-10-29). Change a limit here AND in
 * supabase/migrations/20261029090000_input_limits_reference.sql.
 *
 * Used by the browser and the server alike, so it imports nothing.
 */

// ── Peso amounts: a maximum value, which also fixes the digit count ────────
/** Monthly basic salary: ₱1,000,000 (7 whole digits). */
export const SALARY_MAX = 1_000_000;
/** One loan: ₱500,000 (6 digits). */
export const LOAN_MAX = 500_000;
/** One cash advance (and a loan of the "cash advance" type): ₱50,000 (5 digits). */
export const CASH_ADVANCE_MAX = 50_000;
/** One incentive, and the early-bird incentive: ₱100,000 (6 digits). */
export const INCENTIVE_MAX = 100_000;
/** Government contribution and rate-table amounts: ₱999,999.99 (6 digits). */
export const CONTRIBUTION_MAX = 999_999.99;
/** Other peso amounts (13th month, corrections, the teacher subsidy): ₱1,000,000. */
export const PESO_MAX = 1_000_000;
/** Withholding-tax table amounts: ₱9,999,999.99 (7 digits). */
export const TAX_AMOUNT_MAX = 9_999_999.99;

// ── Attendance counts ──────────────────────────────────────────────────────
/** Days in a month: the most absent / late / half / leave days on one payslip. */
export const DAYS_MAX = 31;
/** Late or undertime minutes in one day. */
export const MINUTES_PER_DAY = 1440;
/** Undertime minutes on one payslip: 16 days (the longest half-month) × 1,440. */
export const PERIOD_MINUTES_MAX = 16 * MINUTES_PER_DAY;

// ── Text ───────────────────────────────────────────────────────────────────
export const NAME_PART_MAX = 50;
export const SUFFIX_MAX = 10;
export const POSITION_MAX = 100;
export const BRANCH_NAME_MAX = 100;
export const TERMINAL_NAME_MAX = 50;
export const EMAIL_MAX = 254;
/** Override, leave, salary-change and other reasons. */
export const REASON_MAX = 500;
/** General notes and remarks. */
export const REMARKS_MAX = 1000;
/**
 * AWOL case records (the employee's reply, the grounds): a documented
 * exception to REMARKS_MAX. A dismissal record may have to set out dates and
 * incidents well enough to stand up if the termination is contested (NLRC),
 * so it keeps 2,000 (decision 2026-10-29).
 */
export const AWOL_RECORD_MAX = 2000;
/** A search box: longer than any name, ID or title it can match. */
export const SEARCH_MAX = 100;

/** A branch name: letters (ñ and accents too), digits, spaces, and . ' - */
export const BRANCH_NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 .'-]*$/;

// ── Identifiers ────────────────────────────────────────────────────────────
/**
 * An RFID card number: MATCHES THE CURRENT RFID CARD FORMAT — UPDATE IF THE
 * CARD TYPE CHANGES. The school's cards read as 10 zero-padded digits
 * (0001234567). A card of another type is refused with "exactly 10 digits",
 * never accepted half-read. Changing it: this constant, plus the database's
 * copy in rfid_cards_uid_check and rfid_uid_free() (a new migration).
 */
export const RFID_UID_LENGTH = 10;
export const RFID_UID_PATTERN = new RegExp(`^[0-9]{${RFID_UID_LENGTH}}$`);

/**
 * TIN digit counts BIR has issued: 9 (older registrations), 12 (with the
 * 3-digit branch code) and 14 (with the 5-digit branch code). All three are
 * accepted (decision 2026-10-29); numeric only.
 */
export const TIN_LENGTHS = Object.freeze([9, 12, 14]);
export const TIN_RULE = "TIN must be 9, 12 or 14 digits (with the branch code).";
/** True for a TIN of an issued length (digits only). */
export function isTinLength(digits) {
  return /^[0-9]+$/.test(digits) && TIN_LENGTHS.includes(digits.length);
}

/**
 * The digits of a number box that may hold only digits, spaces and dashes
 * ("12-3456789-0" → "1234567890"). null when anything else was sent
 * ("12a4567890"), so a letter is refused rather than silently dropped.
 */
export function digitsOrNull(value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9 -]*$/.test(text)) return null;
  return text.replace(/[^0-9]/g, "");
}

/** "₱1,000,000" / "₱999,999.99" for messages. */
export function pesoLimit(max) {
  return `₱${Number(max).toLocaleString("en-PH", { minimumFractionDigits: Number.isInteger(max) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * The first text field in `body` longer than its cap, as a message, or null.
 * `caps` is { field: [max, "Label"] }; a field that is absent is skipped.
 */
export function textLimitError(body, caps) {
  for (const [field, [max, label]] of Object.entries(caps)) {
    const value = body?.[field];
    if (value === undefined || value === null) continue;
    if (String(value).trim().length > max) return `${label} can be at most ${max.toLocaleString("en-PH")} characters.`;
  }
  return null;
}
