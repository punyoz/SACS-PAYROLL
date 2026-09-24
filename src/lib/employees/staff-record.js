/**
 * The record behind a Super Admin / Admin / HR account.
 *
 * These are staff accounts, not employee records. They are created through the
 * same shape of form HR uses for an employee -- identity, contact, position,
 * branch -- and they get the same issued default password and forced first
 * sign-in change. What they deliberately do NOT carry is anything
 * payroll-specific:
 *
 *   excluded: basic_salary, sss_number, philhealth_number, pagibig_number,
 *             tin_number, bank_name, bank_account_number, position
 *
 * Position is left out for a different reason than the rest. The role IS the
 * job for these accounts, and normalizePositionForRole() derives the title
 * that gets displayed from the role no matter what was typed -- so the box
 * collected a value that was then overwritten. /api/admin/users has never
 * asked for one either, so leaving it out keeps the two account flows
 * consistent.
 *
 * Those exist so payroll can pay and report on a person. A Super Admin, Admin
 * or HR account is an operator login; if such a person is also on payroll,
 * that is an employee record, created by HR through the employee flow, and the
 * two are kept separate on purpose. Collecting a bank account or an SSS number
 * on an operator login would be storing regulated personal data with no
 * process that reads it.
 *
 * date_of_birth is required even though nothing pays these accounts: it is
 * half of the issued default password (LastName + MMDDYYYY + "!", see
 * src/lib/auth/password-policy.js), so the account cannot be created without
 * it.
 *
 * NAMES
 * The form collects First / Middle / Last / Suffix. They are stored in
 * profiles.first_name / middle_name / last_name / suffix, and full_name is the
 * composed "First Middle Last Suffix" every table displays (see
 * supabase/migrations/20260924010000_profiles_name_parts.sql, whose trigger
 * keeps the two in step and whose CHECK constraints repeat the name rules).
 *
 * VALIDATION
 * Every rule here is the server-side copy of the browser checks in
 * public/legacy/js/super-admin.js (SA_STAFF_RULES). The browser blocks bad
 * input as it is typed; this is what cannot be bypassed.
 *
 * Mirrors src/lib/employees/record.js in shape and validation style; kept
 * separate rather than parameterised because the two field sets, their
 * required lists and their reasons for existing all differ.
 */

import { normalizeText, normalizeDigits } from "@/lib/auth/normalize";

/** Roles this flow can mint. Super Admin only -- enforced in the route. */
export const STAFF_ROLES = ["super_admin", "admin", "hr"];

/**
 * Only Admin is pinned to one branch. Super Admin and HR serve every branch
 * and are stored with none ("All Branches" / "—" on Admin & HR Logins).
 */
export const STAFF_BRANCH_REQUIRED_ROLES = ["admin"];

export const SEX_OPTIONS = ["Male", "Female"];
export const CIVIL_STATUS_OPTIONS = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
export const ACCOUNT_STATUS_OPTIONS = ["Active", "Pending", "On Leave", "Inactive"];
export const NAME_SUFFIX_OPTIONS = ["Jr.", "Sr.", "II", "III", "IV", "V"];

/** Staff accounts are adults: date of birth must be at least this many years ago. */
export const MIN_STAFF_AGE = 18;

export const STAFF_FIELD_LIMITS = Object.freeze({
  name: 50,
  email: 254,
  address: 160,
  address_min: 5,
});

/** Letters (accented ones too), then letters, spaces, hyphens, apostrophes, periods. */
export const NAME_PART_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .'-]*$/;
/** Letters, numbers, spaces and , . - # / only. */
export const ADDRESS_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 ,.#/-]+$/;
/** Lowercase, no spaces, a dotted domain ending in a 2+ letter TLD. */
export const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
/** 11-digit PH mobile number, as the HR employee form requires. */
export const CONTACT_NUMBER_PATTERN = /^09\d{9}$/;

function pickOption(value, options) {
  const text = normalizeText(value);
  return options.find((option) => option.toLowerCase() === text.toLowerCase()) || "";
}

function collapseSpaces(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

/** "dela cruz" -> "Dela Cruz". Only first letters change, so "McDonald" stays. */
function capitalizeWords(value) {
  return collapseSpaces(value).replace(/(^|[\s-])([a-zà-öø-ÿ])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

/** "jr", "JR.", "Jr." -> "Jr."; anything not in the list -> "". */
export function normalizeSuffix(value) {
  const key = normalizeText(value).toLowerCase().replace(/\.$/, "");
  return NAME_SUFFIX_OPTIONS.find((option) => option.toLowerCase().replace(/\.$/, "") === key) || "";
}

export function composeFullName({ first_name, middle_name, last_name, suffix } = {}) {
  return [first_name, middle_name, last_name, suffix]
    .map((part) => collapseSpaces(part))
    .filter(Boolean)
    .join(" ");
}

const SURNAME_PARTICLES = new Set([
  "de", "del", "dela", "della", "delos", "des", "di", "da", "dos", "das",
  "du", "la", "las", "le", "los", "san", "santa", "sta.", "sto.", "van", "von",
]);

/**
 * Best-effort split of a composed full name. The same rules as
 * public.split_full_name() in 20260924010000_profiles_name_parts.sql; used for
 * accounts whose parts were never stored.
 *   "Juan Santos Dela Cruz Jr." -> Juan | Santos | Dela Cruz | Jr.
 */
export function splitFullName(fullName) {
  const tokens = collapseSpaces(fullName).split(" ").filter(Boolean);
  const parts = { first_name: "", middle_name: "", last_name: "", suffix: "" };
  if (!tokens.length) return parts;

  if (tokens.length > 1) {
    const suffix = normalizeSuffix(tokens[tokens.length - 1]);
    if (suffix) {
      parts.suffix = suffix;
      tokens.pop();
    }
  }

  if (tokens.length === 1) {
    parts.first_name = tokens[0];
    return parts;
  }

  let lastStart = tokens.length - 1;
  while (lastStart > 1 && SURNAME_PARTICLES.has(tokens[lastStart - 1].toLowerCase())) {
    lastStart -= 1;
  }
  parts.last_name = tokens.slice(lastStart).join(" ");

  if (lastStart >= 2) {
    parts.middle_name = tokens[lastStart - 1];
    parts.first_name = tokens.slice(0, lastStart - 1).join(" ");
  } else {
    parts.first_name = tokens.slice(0, lastStart).join(" ");
  }
  return parts;
}

/**
 * Name parts from a request body. A caller that sends the split fields gets
 * exactly those; an older caller that sends only full_name has it split.
 */
export function normalizeNameParts(body = {}) {
  const hasParts = ["first_name", "middle_name", "last_name", "suffix"]
    .some((key) => normalizeText(body[key]));
  const source = hasParts ? body : splitFullName(body.full_name);
  const parts = {
    first_name: capitalizeWords(source.first_name),
    middle_name: capitalizeWords(source.middle_name),
    last_name: capitalizeWords(source.last_name),
    suffix: normalizeSuffix(source.suffix),
  };
  return { ...parts, full_name: composeFullName(parts) };
}

/**
 * Check First / Middle / Last / Suffix. Returns an error message or null.
 * `rawSuffix` is what the caller sent, so an unknown suffix is reported rather
 * than silently dropped.
 */
export function validateNameParts(parts, rawSuffix) {
  const fields = [
    ["first_name", "First name", true],
    ["middle_name", "Middle name", false],
    ["last_name", "Last name", true],
  ];
  for (const [key, label, required] of fields) {
    const value = normalizeText(parts[key]);
    if (!value) {
      if (required) return `${label} is required.`;
      continue;
    }
    if (value.length > STAFF_FIELD_LIMITS.name) {
      return `${label} must be at most ${STAFF_FIELD_LIMITS.name} characters.`;
    }
    if (!NAME_PART_PATTERN.test(value)) {
      return `${label} may contain letters, spaces, hyphens, apostrophes and periods only.`;
    }
  }
  if (normalizeText(rawSuffix) && !parts.suffix) {
    return `Suffix must be one of ${NAME_SUFFIX_OPTIONS.join(", ")}.`;
  }
  return null;
}

/** Lowercased, trimmed; null when it fails the pattern or the length cap. */
export function validateStaffEmail(email) {
  const value = normalizeText(email);
  if (!value) return "Email is required.";
  if (value.length > STAFF_FIELD_LIMITS.email) return `Email must be at most ${STAFF_FIELD_LIMITS.email} characters.`;
  if (/\s/.test(value)) return "Email cannot contain spaces.";
  if (value !== value.toLowerCase() || !EMAIL_PATTERN.test(value)) return "Enter a valid email address.";
  return null;
}

/** Normalised copies of every field a staff account carries. */
export function normalizeStaffFields(body = {}) {
  return {
    ...normalizeNameParts(body),
    suffix_input: normalizeText(body.suffix),
    email: normalizeText(body.email).toLowerCase(),
    role: normalizeText(body.role).toLowerCase(),
    branch_id: normalizeText(body.branch_id),
    date_of_birth: normalizeText(body.date_of_birth),
    sex: pickOption(body.sex, SEX_OPTIONS),
    civil_status: pickOption(body.civil_status, CIVIL_STATUS_OPTIONS),
    date_hired: normalizeText(body.date_hired),
    employee_status: pickOption(body.employee_status, ACCOUNT_STATUS_OPTIONS),
    address: collapseSpaces(body.address),
    cp_number: normalizeDigits(body.cp_number),
  };
}

const FIELD_LABELS = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  role: "Role",
  branch_id: "Branch",
  date_of_birth: "Date of birth",
  sex: "Sex",
  civil_status: "Civil status",
  date_hired: "Date hired",
  employee_status: "Account status",
  address: "Home address",
  cp_number: "Contact number",
};

/** Required on every staff account. Branch is conditional -- see below. */
export const STAFF_REQUIRED_FIELDS = [
  "first_name", "last_name", "email", "role", "date_of_birth", "sex", "civil_status",
  "date_hired", "employee_status", "address", "cp_number",
];

function parseDate(value) {
  const text = normalizeText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // Rejects impossible dates such as 2026-02-31, which Date would roll over.
  if (date.toISOString().slice(0, 10) !== text) return null;
  return date;
}

function yearsBetween(earlier, later) {
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  const beforeAnniversary =
    later.getUTCMonth() < earlier.getUTCMonth()
    || (later.getUTCMonth() === earlier.getUTCMonth() && later.getUTCDate() < earlier.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return years;
}

/**
 * Validate a staff record. Returns an error message, or null when it is sound.
 *
 * @param {ReturnType<normalizeStaffFields>} record
 */
export function validateStaffRecord(record) {
  for (const field of STAFF_REQUIRED_FIELDS) {
    if (!normalizeText(record[field])) {
      return `${FIELD_LABELS[field]} is required.`;
    }
  }

  const nameError = validateNameParts(record, record.suffix_input);
  if (nameError) return nameError;

  if (!STAFF_ROLES.includes(record.role)) {
    return "Select a valid role: Super Admin, Admin, or HR.";
  }

  // Admin works inside one branch and cannot exist without one. Super Admin
  // and HR serve every branch, so a branch on either would be meaningless.
  if (STAFF_BRANCH_REQUIRED_ROLES.includes(record.role) && !record.branch_id) {
    return "Select the branch this account belongs to.";
  }

  const emailError = validateStaffEmail(record.email);
  if (emailError) return emailError;

  const birthDate = parseDate(record.date_of_birth);
  if (!birthDate) return "Enter a valid date of birth.";

  const hiredDate = parseDate(record.date_hired);
  if (!hiredDate) return "Enter a valid date hired.";

  const todayUtc = parseDate(new Date().toISOString().slice(0, 10));

  if (birthDate > todayUtc) return "Date of birth cannot be in the future.";

  if (yearsBetween(birthDate, todayUtc) < MIN_STAFF_AGE) {
    return `The account holder must be at least ${MIN_STAFF_AGE} years old.`;
  }

  if (yearsBetween(birthDate, hiredDate) < MIN_STAFF_AGE) {
    return `Date hired must be on or after the account holder's ${MIN_STAFF_AGE}th birthday.`;
  }

  if (!CONTACT_NUMBER_PATTERN.test(record.cp_number)) {
    return "Contact number must be an 11-digit PH mobile number starting with 09.";
  }

  if (record.address.length < STAFF_FIELD_LIMITS.address_min) {
    return "Enter the complete home address.";
  }
  if (record.address.length > STAFF_FIELD_LIMITS.address) {
    return `Home address must be at most ${STAFF_FIELD_LIMITS.address} characters.`;
  }
  if (!ADDRESS_PATTERN.test(record.address)) {
    return "Home address may contain letters, numbers, spaces and , . - # / only.";
  }

  return null;
}
