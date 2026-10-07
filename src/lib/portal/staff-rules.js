/*
 * The Super Admin's staff-account form rules (Add Staff Account + Edit
 * Account): SA_STAFF_RULES and friends in public/legacy/js/super-admin.js.
 * Each textbox is filtered as it is typed or pasted and checked on the spot;
 * the server repeats every rule (src/lib/employees/staff-record.js and the
 * profiles CHECK constraints), so none of this is the real gate.
 */

import { digitsOnly } from "./format";

export const STAFF_ROLES = ["super_admin", "admin", "hr"];
export const STAFF_ROLE_LABELS = { super_admin: "Super Admin", admin: "Admin", hr: "HR" };
export const NAME_SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];
export const EMERGENCY_RELATIONSHIPS = ["Spouse", "Parent", "Child", "Sibling", "Guardian", "Relative", "Partner", "Friend", "Other"];
export const SEXES = ["Male", "Female"];
export const CIVIL_STATUSES = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
export const MIN_STAFF_AGE = 18;

const NAME_MAX = 50;
const EMAIL_MAX = 254;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 160;
const EMERGENCY_NAME_MAX = 100;
const EMERGENCY_ADDRESS_MAX = 200;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .'-]*$/;
const NAME_BLOCKED = /[^A-Za-zÀ-ÖØ-öø-ÿ .'-]/g;
const ADDRESS_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 ,.#/-]+$/;
const ADDRESS_BLOCKED = /[^A-Za-zÀ-ÖØ-öø-ÿ0-9 ,.#/-]/g;
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

const NAME_NOTE = "Letters, spaces, hyphens, apostrophes and periods only.";
const ADDRESS_NOTE = "Letters, numbers, spaces and , . - # / only.";

export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function yearsBetween(earlier, later) {
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  if (later.getUTCMonth() < earlier.getUTCMonth()
    || (later.getUTCMonth() === earlier.getUTCMonth() && later.getUTCDate() < earlier.getUTCDate())) {
    years -= 1;
  }
  return years;
}

/** The latest birth date the date picker allows (18 years ago today). */
export function latestBirthDate(now = new Date()) {
  const today = todayUtc(now);
  return new Date(Date.UTC(today.getUTCFullYear() - MIN_STAFF_AGE, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
}

function checkNamePart(value, label, required) {
  if (!value) return required ? `${label} is required.` : "";
  if (value.length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(value)) return "Must start with a letter; letters, spaces, - ' . only.";
  return "";
}

const cleanName = (v) => v.replace(NAME_BLOCKED, "").replace(/^[\s.'-]+/, "").replace(/\s{2,}/g, " ");
const cleanAddress = (v) => v.replace(ADDRESS_BLOCKED, "").replace(/^\s+/, "").replace(/\s{2,}/g, " ");

/**
 * The Edit dialog may leave the emergency contact blank for an account that
 * has none on file yet. Once any of the four is filled, or one is on file,
 * all four are checked. Add Staff Account always checks them.
 */
export function emergencySkipped(values, { editing = false, ecOnFile = false } = {}) {
  if (!editing || ecOnFile) return false;
  return ["emergency_contact_name", "emergency_contact_relationship", "emergency_contact_address", "emergency_contact_number"]
    .every((key) => !String(values[key] || "").trim());
}

/**
 * Per-field rules, keyed by field name.
 *   clean(value)        what the field may hold (blockedNote says why a character went)
 *   check(v, values, o) "" when valid, otherwise the message under the field
 */
export const STAFF_RULES = {
  first_name: { clean: cleanName, maxLength: NAME_MAX, blockedNote: NAME_NOTE, check: (v) => checkNamePart(v, "First name", true) },
  middle_name: { clean: cleanName, maxLength: NAME_MAX, blockedNote: NAME_NOTE, check: (v) => checkNamePart(v, "Middle name", false) },
  last_name: { clean: cleanName, maxLength: NAME_MAX, blockedNote: NAME_NOTE, check: (v) => checkNamePart(v, "Last name", true) },
  suffix: { check: (v) => (!v || NAME_SUFFIXES.includes(v) ? "" : "Choose a suffix from the list.") },
  email: {
    clean: (v) => v.replace(/\s+/g, "").toLowerCase(),
    maxLength: EMAIL_MAX,
    blockedNote: "Spaces are not allowed; email is saved in lowercase.",
    check: (v) => {
      if (!v) return "Email is required.";
      if (v.length > EMAIL_MAX) return `At most ${EMAIL_MAX} characters.`;
      return EMAIL_PATTERN.test(v) ? "" : "Enter a valid email address, e.g. name@example.com.";
    },
  },
  role: { check: (v) => (STAFF_ROLES.includes(v) ? "" : "Select a role.") },
  employee_status: { check: (v) => (v ? "" : "Select an account status.") },
  // Only Admin carries a branch; HR and Super Admin serve every branch.
  branch_id: { check: (v, values) => (values.role !== "admin" || v ? "" : "Select the branch this account belongs to.") },
  date_of_birth: {
    check: (v) => {
      if (!v) return "Date of birth is required.";
      const birth = parseIsoDate(v);
      if (!birth) return "Enter a valid date.";
      const today = todayUtc();
      if (birth > today) return "Date of birth cannot be in the future.";
      if (yearsBetween(birth, today) < MIN_STAFF_AGE) return `Must be at least ${MIN_STAFF_AGE} years old.`;
      return "";
    },
  },
  date_hired: {
    check: (v, values) => {
      if (!v) return "Date hired is required.";
      const hired = parseIsoDate(v);
      if (!hired) return "Enter a valid date.";
      const birth = parseIsoDate(values.date_of_birth);
      if (birth && yearsBetween(birth, hired) < MIN_STAFF_AGE) return `Must be on or after the ${MIN_STAFF_AGE}th birthday.`;
      return "";
    },
  },
  sex: { check: (v) => (v ? "" : "Select a sex.") },
  civil_status: { check: (v) => (v ? "" : "Select a civil status.") },
  cp_number: {
    digits: "cp_number",
    check: (v) => {
      const digits = digitsOnly(v);
      if (!digits) return "Contact number is required.";
      return /^09\d{9}$/.test(digits) ? "" : "Must be an 11-digit mobile number starting with 09.";
    },
  },
  address: {
    clean: cleanAddress,
    maxLength: ADDRESS_MAX,
    blockedNote: ADDRESS_NOTE,
    check: (v) => {
      if (!v) return "Home address is required.";
      if (v.length < ADDRESS_MIN) return "Enter the complete home address.";
      if (v.length > ADDRESS_MAX) return `At most ${ADDRESS_MAX} characters.`;
      return ADDRESS_PATTERN.test(v) ? "" : ADDRESS_NOTE;
    },
  },
  emergency_contact_name: {
    clean: cleanName,
    maxLength: EMERGENCY_NAME_MAX,
    blockedNote: NAME_NOTE,
    check: (v, values, o) => {
      if (emergencySkipped(values, o)) return "";
      if (!v) return "Contact person is required.";
      if (v.length > EMERGENCY_NAME_MAX) return `At most ${EMERGENCY_NAME_MAX} characters.`;
      return NAME_PATTERN.test(v) ? "" : "Must start with a letter; letters, spaces, - ' . only.";
    },
  },
  emergency_contact_relationship: {
    check: (v, values, o) => (emergencySkipped(values, o) || EMERGENCY_RELATIONSHIPS.includes(v) ? "" : "Select a relationship."),
  },
  emergency_contact_number: {
    digits: "emergency_contact_number",
    check: (v, values, o) => {
      if (emergencySkipped(values, o)) return "";
      const digits = digitsOnly(v);
      if (!digits) return "Emergency contact number is required.";
      if (!/^09\d{9}$/.test(digits)) return "Must be an 11-digit mobile number starting with 09.";
      if (digits === digitsOnly(values.cp_number || "")) return "Must differ from the account holder's own number.";
      return "";
    },
  },
  emergency_contact_address: {
    clean: cleanAddress,
    maxLength: EMERGENCY_ADDRESS_MAX,
    blockedNote: ADDRESS_NOTE,
    check: (v, values, o) => {
      if (emergencySkipped(values, o)) return "";
      if (!v) return "Emergency contact address is required.";
      if (v.length < ADDRESS_MIN) return "Enter the complete address.";
      if (v.length > EMERGENCY_ADDRESS_MAX) return `At most ${EMERGENCY_ADDRESS_MAX} characters.`;
      return ADDRESS_PATTERN.test(v) ? "" : ADDRESS_NOTE;
    },
  },
  // Optional on the Edit dialog: blank keeps the current password.
  password: {
    clean: (v) => v.replace(/\s+/g, ""),
    maxLength: PASSWORD_MAX,
    blockedNote: "Spaces are not allowed.",
    check: (v) => {
      if (!v) return "";
      if (v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) return `${PASSWORD_MIN}-${PASSWORD_MAX} characters.`;
      if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return "Needs both letters and numbers.";
      if (!/[A-Z]/.test(v)) return "Needs at least one uppercase letter.";
      if (!/[^A-Za-z0-9\s]/.test(v)) return "Needs at least one symbol (e.g. ! @ # $).";
      return "";
    },
  },
};

/** Filter a typed or pasted value. Returns { value, note } (note when something was removed). */
export function cleanStaffField(name, raw) {
  const rule = STAFF_RULES[name];
  if (!rule?.clean) return { value: raw, note: "" };
  let value = rule.clean(raw);
  if (rule.maxLength && value.length > rule.maxLength) value = value.slice(0, rule.maxLength);
  return { value, note: value !== raw ? rule.blockedNote || "" : "" };
}

/** Every listed field's message ("" when valid). */
export function checkStaffFields(fields, values, options = {}) {
  return Object.fromEntries(fields.map((name) => [name, STAFF_RULES[name]?.check(String(values[name] ?? "").trim(), values, options) || ""]));
}
