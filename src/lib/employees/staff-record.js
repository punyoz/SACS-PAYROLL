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
 * asked for one either, so leaving it out keeps the two account-creation
 * flows consistent.
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
 * Mirrors src/lib/employees/record.js in shape and validation style; kept
 * separate rather than parameterised because the two field sets, their
 * required lists and their reasons for existing all differ.
 */

import { normalizeText, normalizeDigits } from "@/lib/auth/normalize";

/** Roles this flow can mint. Super Admin only -- enforced in the route. */
export const STAFF_ROLES = ["super_admin", "admin", "hr"];

/** Super Admin is the one role that is not pinned to a branch. */
export const STAFF_BRANCH_REQUIRED_ROLES = ["admin", "hr"];

export const SEX_OPTIONS = ["Male", "Female"];
export const CIVIL_STATUS_OPTIONS = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
export const ACCOUNT_STATUS_OPTIONS = ["Active", "Pending", "On Leave", "Inactive"];

/** Same floor the employee record uses. */
export const MIN_WORKING_AGE = 15;

function pickOption(value, options) {
  const text = normalizeText(value);
  return options.find((option) => option.toLowerCase() === text.toLowerCase()) || "";
}

/** Normalised copies of every field a staff account carries. */
export function normalizeStaffFields(body = {}) {
  return {
    full_name: normalizeText(body.full_name),
    email: normalizeText(body.email).toLowerCase(),
    role: normalizeText(body.role).toLowerCase(),
    branch_id: normalizeText(body.branch_id),
    date_of_birth: normalizeText(body.date_of_birth),
    sex: pickOption(body.sex, SEX_OPTIONS),
    civil_status: pickOption(body.civil_status, CIVIL_STATUS_OPTIONS),
    date_hired: normalizeText(body.date_hired),
    employee_status: pickOption(body.employee_status, ACCOUNT_STATUS_OPTIONS),
    address: normalizeText(body.address),
    cp_number: normalizeDigits(body.cp_number),
  };
}

const FIELD_LABELS = {
  full_name: "Full name",
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
  "full_name", "email", "role", "date_of_birth", "sex", "civil_status",
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

  if (!STAFF_ROLES.includes(record.role)) {
    return "Select a valid role: Super Admin, Admin, or HR.";
  }

  // Admin and HR work inside one branch and cannot exist without one. Super
  // Admin reaches every branch, so a branch on it would be meaningless.
  if (STAFF_BRANCH_REQUIRED_ROLES.includes(record.role) && !record.branch_id) {
    return "Select the branch this account belongs to.";
  }

  if (!/^[A-Za-z\s.'-]+$/.test(record.full_name)) {
    return "Full name must contain letters and spaces only.";
  }

  // Deliberately permissive, matching the employee flow: the address is
  // confirmed by Supabase when the account is created, not by a regex here.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(record.email)) {
    return "Enter a valid email address.";
  }

  const birthDate = parseDate(record.date_of_birth);
  if (!birthDate) return "Enter a valid date of birth.";

  const hiredDate = parseDate(record.date_hired);
  if (!hiredDate) return "Enter a valid date hired.";

  const todayUtc = parseDate(new Date().toISOString().slice(0, 10));

  if (birthDate > todayUtc) return "Date of birth cannot be in the future.";

  if (yearsBetween(birthDate, todayUtc) < MIN_WORKING_AGE) {
    return `The account holder must be at least ${MIN_WORKING_AGE} years old.`;
  }

  if (yearsBetween(birthDate, hiredDate) < MIN_WORKING_AGE) {
    return `Date hired must be on or after the account holder's ${MIN_WORKING_AGE}th birthday.`;
  }

  if (record.cp_number.length < 7 || record.cp_number.length > 15) {
    return "Enter a valid contact number.";
  }

  return null;
}

/**
 * The last name the issued default password is built from.
 *
 * This flow collects one "Full name" box rather than HR's split first/middle/
 * last fields, so the last name has to be recovered from it: the final word,
 * ignoring a generational suffix. That is the same word
 * isDefaultPassword()'s first candidate checks against
 * (src/lib/auth/password-policy.js), so a password generated from it is
 * recognised as the default at sign-in and the account is correctly forced to
 * change it.
 */
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

export function lastNameFromFullName(fullName) {
  const tokens = normalizeText(fullName).split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens.length ? tokens[tokens.length - 1] : "";
}
