/**
 * The employer's details printed on BIR Form 2316 and the alphalist
 * (scenario AC-11, 2026-10-22). Saved by the Super Admin under System
 * Configuration → General (system_config section "general"); every field is
 * optional there, and the forms say which ones are still blank.
 *
 * The boxes follow the system's shared rules (2026-11-12), checked as typed
 * (cleanBirEmployerInput), before saving and again by the server
 * (/api/admin/config → birEmployerErrors):
 *   name    letters, spaces, hyphens, apostrophes and periods (src/lib/person-name.js)
 *   tin     the employee TIN rule: 9, 12 or 14 digits (src/lib/input-limits.js)
 *   digits  numbers only, a fixed count (RDO code 3, ZIP code 4)
 *   title   the job-title rule of positions (src/lib/hr/positions.js)
 *   text    letters, numbers and punctuation (the address)
 *
 * Safe for the browser: no server imports.
 */

import { isTinLength, digitsOrNull, TIN_RULE } from "@/lib/input-limits";
import { cleanNameInput, isPersonName, NAME_TYPING_HINT, PERSON_NAME_RULE } from "@/lib/person-name";
import { POSITION_PATTERN } from "@/lib/hr/positions";
import { formatDigitField } from "@/lib/portal/format";

export const BIR_EMPLOYER_SECTION = "general";

/**
 * [key, label, placeholder, maxLength, kind] in the order the forms print
 * them. maxLength is what the box takes as typed (the TIN with its dashes).
 */
export const BIR_EMPLOYER_FIELDS = [
  ["bir_employer_name", "Registered name", "e.g. Shepherd Angels Christian School of Antipolo Inc.", 200, "name"],
  ["bir_employer_tin", "Employer TIN", "000-000-000-00000", 17, "tin"],
  ["bir_rdo_code", "RDO code", "e.g. 046", 3, "digits"],
  ["bir_registered_address", "Registered address", "Street, barangay, city / municipality, province", 250, "text"],
  ["bir_zip_code", "ZIP code", "e.g. 1870", 4, "digits"],
  ["bir_signatory_name", "Authorized signatory", "Name of the person who signs the 2316", 120, "name"],
  ["bir_signatory_title", "Signatory's title", "e.g. School Director", 120, "title"],
];

const FIELD = Object.fromEntries(BIR_EMPLOYER_FIELDS.map(([key, label, placeholder, maxLength, kind]) => [key, { key, label, placeholder, maxLength, kind }]));

/** Every key of the BIR employer details. */
export const BIR_EMPLOYER_KEYS = Object.freeze(BIR_EMPLOYER_FIELDS.map(([key]) => key));

/** Shown under a number box when a typed or pasted character was refused. */
export const DIGITS_TYPING_HINT = "Numbers only: letters and symbols are not accepted.";
/** Shown under the title box when a typed character was refused. */
export const TITLE_TYPING_HINT = "A title can have letters, numbers, spaces and . , ' ( ) / & - only.";

const NOT_IN_A_TITLE = /[^A-Za-zÀ-ÖØ-öø-ÿ0-9 .,'()/&-]/g;

const digits = (value) => String(value ?? "").replace(/\D/g, "");

/** A TIN as 000-000-000-00000 (the branch code defaults to 00000). Blank stays blank. */
export function formatTin(value) {
  const d = digits(value);
  if (!d) return "";
  const branch = d.slice(9).padEnd(5, "0").slice(0, 5);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), branch].filter(Boolean).join("-");
}

/**
 * A box's value as it is typed or pasted, cleaned the way the system's other
 * boxes clean it: { value, hint } (hint: why a character was dropped, or "").
 */
export function cleanBirEmployerInput(key, raw) {
  const field = FIELD[key];
  const text = String(raw ?? "");
  if (!field) return { value: text, hint: "" };
  if (field.kind === "name") {
    const { value, removed } = cleanNameInput(text);
    return { value: value.slice(0, field.maxLength), hint: removed ? NAME_TYPING_HINT : "" };
  }
  if (field.kind === "tin") {
    // As the employee TIN box: 123-456-789-00000, at most 14 digits.
    const value = formatDigitField(text, "tin_number");
    return { value, hint: /[^0-9 -]/.test(text) ? DIGITS_TYPING_HINT : "" };
  }
  if (field.kind === "digits") {
    const value = digits(text).slice(0, field.maxLength);
    return { value, hint: /\D/.test(text) ? DIGITS_TYPING_HINT : "" };
  }
  if (field.kind === "title") {
    const value = text.replace(NOT_IN_A_TITLE, "");
    return { value: value.slice(0, field.maxLength), hint: value !== text ? TITLE_TYPING_HINT : "" };
  }
  return { value: text.slice(0, field.maxLength), hint: "" };
}

/** The value to store: trimmed; the TIN as digits only (as the employees' TINs). */
export function birEmployerStoredValue(key, value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (FIELD[key]?.kind === "tin") return digits(text);
  return text;
}

/**
 * { key: message } for values that are filled in but malformed. Blank is
 * allowed. Only the keys present in `values` are checked (the server checks
 * exactly what was sent).
 */
export function birEmployerErrors(values = {}) {
  const errors = {};
  for (const field of Object.values(FIELD)) {
    if (!(field.key in values)) continue;
    const raw = values[field.key];
    if (raw !== null && raw !== undefined && typeof raw !== "string" && typeof raw !== "number") {
      errors[field.key] = `${field.label}: enter text.`;
      continue;
    }
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (field.kind === "tin") {
      const tin = digitsOrNull(value);
      if (tin === null) errors[field.key] = "Employer TIN: numbers only (dashes and spaces are fine).";
      else if (!isTinLength(tin)) errors[field.key] = TIN_RULE;
      continue;
    }
    if (field.key === "bir_rdo_code" && !/^\d{3}$/.test(value)) { errors[field.key] = "The RDO code is 3 digits (numbers only)."; continue; }
    if (field.key === "bir_zip_code" && !/^\d{4}$/.test(value)) { errors[field.key] = "The ZIP code is 4 digits (numbers only)."; continue; }
    if (value.length > field.maxLength) {
      errors[field.key] = `${field.label} can be at most ${field.maxLength} characters.`;
      continue;
    }
    if (field.kind === "name" && !isPersonName(value)) errors[field.key] = `${field.label} may contain ${PERSON_NAME_RULE}.`;
    else if (field.kind === "title" && !POSITION_PATTERN.test(value)) errors[field.key] = `${field.label}: letters, numbers, spaces and . , ' ( ) / & - only.`;
  }
  return errors;
}

/** The saved values (from the "general" section), trimmed; the TIN formatted. */
export function birEmployerFrom(general = {}) {
  const out = Object.fromEntries(BIR_EMPLOYER_FIELDS.map(([key]) => [key, String(general?.[key] ?? "").trim()]));
  out.bir_employer_tin = formatTin(out.bir_employer_tin);
  return out;
}

/** Labels of the fields still blank. */
export function missingBirEmployerFields(employer = {}) {
  return BIR_EMPLOYER_FIELDS.filter(([key]) => !String(employer[key] || "").trim()).map(([, label]) => label);
}
