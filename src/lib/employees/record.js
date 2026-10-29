/**
 * The employee record HR keeps — what is required, which values are allowed,
 * and how each field is normalised before it is stored.
 *
 * Every field marked required (*) in HR's Add/Edit Employee forms is enforced
 * here as well, so an account can never be created with a blank field by
 * calling the API directly. The option lists must match the <select> options
 * in public/legacy/pages/hr.html.
 *
 * The government numbers follow the formats the issuing agencies print:
 *   SSS         10 digits   12-3456789-0
 *   PhilHealth  12 digits   12-345678901-2
 *   Pag-IBIG    12 digits   1234-5678-9012
 *   TIN         9, 12 or 14 digits (3- or 5-digit branch code)   123-456-789-000
 */

import { normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";
import { PERSON_NAME_PATTERN, PERSON_NAME_RULE } from "@/lib/person-name";
import { EMAIL_MAX, NAME_PART_MAX, POSITION_MAX, SALARY_MAX, TIN_RULE, digitsOrNull, isTinLength, pesoLimit } from "@/lib/input-limits";

export const SEX_OPTIONS = ["Male", "Female"];
export const CIVIL_STATUS_OPTIONS = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
export const EMPLOYMENT_TYPE_OPTIONS = ["Full-time", "Part-time"];
export const EMPLOYMENT_STATUS_OPTIONS = ["Regular", "Probationary", "Contractual", "Substitute"];
export const EMPLOYEE_TYPE_OPTIONS = ["Teaching", "Non-Teaching"];
export const ACCOUNT_STATUS_OPTIONS = ["Active", "Pending", "On Leave", "Inactive"];
// profiles_suffix_valid; the form's Suffix list.
export const SUFFIX_OPTIONS = ["Jr.", "Sr.", "II", "III", "IV", "V"];

export const MIN_WORKING_AGE = 15;
export { SALARY_MAX };

// The shared rule for a person's name (src/lib/person-name.js).
const NAME_PATTERN = PERSON_NAME_PATTERN;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The case-insensitive match of `value` among `options`, or "". */
export function pickOption(value, options) {
  const needle = normalizeText(value).toLowerCase();
  return options.find((option) => option.toLowerCase() === needle) || "";
}

function parseIsoDate(value) {
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

// Number fields that take digits, spaces and dashes only.
const DIGIT_FIELDS = ["cp_number", "sss_number", "philhealth_number", "pagibig_number", "tin_number"];

/** Normalised copies of every field the employee record carries. */
export function normalizeEmployeeFields(body = {}) {
  // A letter in a number field is refused (validateEmployeeRecord), not dropped.
  const notDigits = DIGIT_FIELDS.filter((field) => digitsOrNull(body[field]) === null);
  return {
    not_digits: notDigits,
    first_name: normalizeText(body.first_name),
    middle_initial: normalizeText(body.middle_initial),
    last_name: normalizeText(body.last_name),
    suffix: normalizeText(body.suffix),
    // Kept as typed (lower-cased) so an invalid address is reported as
    // invalid rather than as missing; validateEmployeeRecord checks the format.
    email: normalizeText(body.email).toLowerCase(),
    date_of_birth: normalizeText(body.date_of_birth),
    sex: pickOption(body.sex, SEX_OPTIONS),
    civil_status: pickOption(body.civil_status, CIVIL_STATUS_OPTIONS),
    employee_type: pickOption(body.employee_type, EMPLOYEE_TYPE_OPTIONS),
    employment_type: pickOption(body.employment_type, EMPLOYMENT_TYPE_OPTIONS),
    employment_status: pickOption(body.employment_status, EMPLOYMENT_STATUS_OPTIONS),
    employee_status: pickOption(body.employee_status, ACCOUNT_STATUS_OPTIONS),
    position: normalizeText(body.position),
    date_hired: normalizeText(body.date_hired),
    basic_salary: body.basic_salary === undefined || body.basic_salary === "" ? NaN : Number(body.basic_salary),
    address: normalizeText(body.address),
    cp_number: digitsOrNull(body.cp_number) ?? "",
    sss_number: digitsOrNull(body.sss_number) ?? "",
    philhealth_number: digitsOrNull(body.philhealth_number) ?? "",
    pagibig_number: digitsOrNull(body.pagibig_number) ?? "",
    tin_number: digitsOrNull(body.tin_number) ?? "",
    branch_id: normalizeText(body.branch_id),
  };
}

const FIELD_LABELS = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  date_of_birth: "Date of birth",
  sex: "Sex",
  civil_status: "Civil status",
  employee_type: "Employee type",
  employment_type: "Employment type",
  employment_status: "Employment status",
  employee_status: "Account status",
  position: "Position",
  date_hired: "Date hired",
  basic_salary: "Basic salary",
  address: "Home address",
  cp_number: "Contact number",
  sss_number: "SSS number",
  philhealth_number: "PhilHealth number",
  pagibig_number: "Pag-IBIG number",
  tin_number: "TIN",
  branch_id: "Branch",
};

/** Required on every employee record HR saves. */
export const REQUIRED_FIELDS = [
  "first_name", "last_name", "email", "date_of_birth", "sex", "civil_status",
  "employee_type", "employment_type", "employment_status", "employee_status", "position",
  "date_hired", "address", "cp_number", "sss_number", "philhealth_number",
  "pagibig_number", "tin_number",
];

/** Required only when the account is first created. */
export const CREATE_ONLY_REQUIRED_FIELDS = ["basic_salary", "branch_id"];

function isBlank(field, value) {
  if (field === "basic_salary") return !Number.isFinite(value);
  return !normalizeText(value);
}

/**
 * Validate a normalised record. Returns the first problem as a user-facing
 * message, or null when the record is complete and well-formed.
 *
 * @param {ReturnType<typeof normalizeEmployeeFields>} record
 * @param {{ creating?: boolean, today?: Date }} options
 */
export function validateEmployeeRecord(record, { creating = false, today = new Date() } = {}) {
  const required = creating ? [...REQUIRED_FIELDS, ...CREATE_ONLY_REQUIRED_FIELDS] : REQUIRED_FIELDS;
  const notDigits = record.not_digits || [];
  if (notDigits.length) return `${FIELD_LABELS[notDigits[0]]} may contain digits only.`;
  const missing = required.filter((field) => isBlank(field, record[field]));
  if (missing.length) {
    const labels = missing.map((field) => FIELD_LABELS[field] || field);
    return `Please complete the required field${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}.`;
  }

  for (const [field, label] of [["first_name", "First name"], ["last_name", "Last name"]]) {
    if (!NAME_PATTERN.test(record[field])) return `${label} may contain ${PERSON_NAME_RULE}.`;
  }
  // Checked before the account is created: the database refuses a longer
  // name part (is_valid_name_part), which would leave an account with no profile.
  for (const [field, label] of [["first_name", "First name"], ["middle_initial", "Middle name"], ["last_name", "Last name"]]) {
    if (String(record[field] || "").length > NAME_PART_MAX) return `${label} must be at most ${NAME_PART_MAX} characters.`;
  }
  if (record.suffix && !SUFFIX_OPTIONS.includes(record.suffix)) {
    return `Suffix must be one of ${SUFFIX_OPTIONS.join(", ")}, or blank.`;
  }
  if (record.middle_initial && !NAME_PATTERN.test(record.middle_initial)) {
    return `Middle name may contain ${PERSON_NAME_RULE}.`;
  }
  if (record.email.length > EMAIL_MAX) return `Email must be at most ${EMAIL_MAX} characters.`;
  if (!EMAIL_PATTERN.test(record.email) || !normalizeRoleEmail(record.email)) {
    return "Enter a valid email address.";
  }
  if (record.position.length > POSITION_MAX) return `Position must be at most ${POSITION_MAX} characters.`;

  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const birthDate = parseIsoDate(record.date_of_birth);
  if (!birthDate) return "Date of birth is not a valid date.";
  if (birthDate >= todayUtc) return "Date of birth must be in the past.";
  if (yearsBetween(birthDate, todayUtc) < MIN_WORKING_AGE) {
    return `The employee must be at least ${MIN_WORKING_AGE} years old.`;
  }

  const hiredDate = parseIsoDate(record.date_hired);
  if (!hiredDate) return "Date hired is not a valid date.";
  if (yearsBetween(birthDate, hiredDate) < MIN_WORKING_AGE) {
    return `Date hired must be on or after the employee's ${MIN_WORKING_AGE}th birthday.`;
  }

  if (creating || Number.isFinite(record.basic_salary)) {
    if (!(record.basic_salary > 0) || record.basic_salary > SALARY_MAX) {
      return `Basic salary must be greater than 0 and at most ${pesoLimit(SALARY_MAX)}.`;
    }
  }

  if (record.address.length < 5) return "Enter the complete home address.";
  if (record.address.length > 200) return "Home address must be at most 200 characters.";

  if (!/^09\d{9}$/.test(record.cp_number)) {
    return "Contact number must be an 11-digit PH mobile number starting with 09.";
  }
  if (record.sss_number.length !== 10) return "SSS number must be exactly 10 digits.";
  if (record.philhealth_number.length !== 12) return "PhilHealth number must be exactly 12 digits.";
  if (record.pagibig_number.length !== 12) return "Pag-IBIG number must be exactly 12 digits.";
  if (!isTinLength(record.tin_number)) return TIN_RULE;

  return null;
}

/**
 * The fields an edit sends (HR's Edit Employee, PATCH /api/admin/employees),
 * checked by the same rules as a new record. A field left out is not checked;
 * a government number sent blank clears it.
 */
export function validateEmployeePatch(body = {}) {
  for (const field of DIGIT_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue;
    const digits = digitsOrNull(body[field]);
    if (digits === null) return `${FIELD_LABELS[field]} may contain digits only.`;
    if (field === "cp_number") {
      if (digits && !/^09\d{9}$/.test(digits)) return "Contact number must be an 11-digit PH mobile number starting with 09.";
      continue;
    }
    if (!digits) continue;
    if (field === "sss_number" && digits.length !== 10) return "SSS number must be exactly 10 digits.";
    if ((field === "philhealth_number" || field === "pagibig_number") && digits.length !== 12) {
      return `${FIELD_LABELS[field]} must be exactly 12 digits.`;
    }
    if (field === "tin_number" && !isTinLength(digits)) return TIN_RULE;
  }
  if (body.address !== undefined && body.address !== null) {
    const address = normalizeText(body.address);
    if (address && address.length < 5) return "Enter the complete home address.";
    if (address.length > 200) return "Home address must be at most 200 characters.";
  }
  if (body.email !== undefined && normalizeText(body.email).length > EMAIL_MAX) {
    return `Email must be at most ${EMAIL_MAX} characters.`;
  }
  return null;
}
