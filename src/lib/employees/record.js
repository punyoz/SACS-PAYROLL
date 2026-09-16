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
 *   TIN         9 digits, or 12 with the 3-digit branch code   123-456-789-000
 */

import { normalizeDigits, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";

export const SEX_OPTIONS = ["Male", "Female"];
export const CIVIL_STATUS_OPTIONS = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
export const EMPLOYMENT_TYPE_OPTIONS = ["Full-time", "Part-time"];
export const EMPLOYMENT_STATUS_OPTIONS = ["Regular", "Probationary", "Contractual", "Substitute"];
export const EMPLOYEE_TYPE_OPTIONS = ["Teaching", "Non-Teaching"];
export const ACCOUNT_STATUS_OPTIONS = ["Active", "Pending", "On Leave", "Inactive"];

export const MIN_WORKING_AGE = 15;
export const SALARY_MAX = 9_999_999.99;

const NAME_PATTERN = /^[A-Za-z\s]+$/;
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

/** Normalised copies of every field the employee record carries. */
export function normalizeEmployeeFields(body = {}) {
  return {
    first_name: normalizeText(body.first_name),
    middle_initial: normalizeText(body.middle_initial),
    last_name: normalizeText(body.last_name),
    suffix: normalizeText(body.suffix).slice(0, 16),
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
    cp_number: normalizeDigits(body.cp_number),
    sss_number: normalizeDigits(body.sss_number),
    philhealth_number: normalizeDigits(body.philhealth_number),
    pagibig_number: normalizeDigits(body.pagibig_number),
    tin_number: normalizeDigits(body.tin_number),
    bank_name: normalizeText(body.bank_name),
    bank_account_number: normalizeDigits(body.bank_account_number),
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
  bank_name: "Bank name",
  bank_account_number: "Bank account number",
  branch_id: "Branch",
};

/** Required on every employee record HR saves. */
export const REQUIRED_FIELDS = [
  "first_name", "last_name", "email", "date_of_birth", "sex", "civil_status",
  "employee_type", "employment_type", "employment_status", "employee_status", "position",
  "date_hired", "address", "cp_number", "sss_number", "philhealth_number",
  "pagibig_number", "tin_number", "bank_name", "bank_account_number",
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
  const missing = required.filter((field) => isBlank(field, record[field]));
  if (missing.length) {
    const labels = missing.map((field) => FIELD_LABELS[field] || field);
    return `Please complete the required field${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}.`;
  }

  for (const [field, label] of [["first_name", "First name"], ["last_name", "Last name"]]) {
    if (!NAME_PATTERN.test(record[field])) return `${label} must contain letters and spaces only.`;
  }
  if (record.middle_initial && !NAME_PATTERN.test(record.middle_initial)) {
    return "Middle name must contain letters and spaces only.";
  }
  if (!EMAIL_PATTERN.test(record.email) || !normalizeRoleEmail(record.email)) {
    return "Enter a valid email address.";
  }

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
      return "Basic salary must be greater than 0 and at most ₱9,999,999.99.";
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
  if (record.tin_number.length !== 9 && record.tin_number.length !== 12) {
    return "TIN must be 9 digits, or 12 digits including the branch code.";
  }
  if (record.bank_name.length > 50) return "Bank name must be at most 50 characters.";
  if (record.bank_account_number.length < 6 || record.bank_account_number.length > 20) {
    return "Bank account number must be 6 to 20 digits.";
  }

  return null;
}
