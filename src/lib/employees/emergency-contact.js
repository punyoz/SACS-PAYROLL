/**
 * Emergency contact: the person to reach if something happens to the account
 * holder at work. Collected when any account is created -- HR's Add Employee
 * (POST /api/admin/employees) and Super Admin's Add Staff Account
 * (POST /api/admin/staff-accounts) -- and stored on profiles
 * (supabase/migrations/20260924134806_profiles_emergency_contact.sql, whose
 * CHECK constraints repeat these rules).
 *
 * It is corrected through HR's Edit Employee (PATCH /api/hr/employees) and
 * Super Admin's Edit Account (PATCH /api/admin/users), see
 * validateEmergencyContactUpdate(), and shown read-only on every portal's
 * Profile page (GET /api/legacy-auth/update-profile).
 *
 *   emergency_contact_name          1-100 chars, letters, spaces, - ' .
 *   emergency_contact_relationship  one of EMERGENCY_RELATIONSHIP_OPTIONS
 *   emergency_contact_address       5-200 chars
 *   emergency_contact_number        11-digit PH mobile, 09XXXXXXXXX, not the
 *                                   account holder's own number
 *
 * The option list must match the <select> options in hr.html and
 * super-admin.html.
 */

import { normalizeDigits, normalizeText } from "@/lib/auth/normalize";

export const EMERGENCY_RELATIONSHIP_OPTIONS = [
  "Spouse", "Parent", "Child", "Sibling", "Guardian", "Relative", "Partner", "Friend", "Other",
];

/** The four request / profiles fields, in form order. */
export const EMERGENCY_CONTACT_FIELDS = [
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_address",
  "emergency_contact_number",
];

export const EMERGENCY_NAME_MAX = 100;
export const EMERGENCY_ADDRESS_MIN = 5;
export const EMERGENCY_ADDRESS_MAX = 200;

const NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .'-]*$/;
const MOBILE_PATTERN = /^09\d{9}$/;

function collapseSpaces(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

/** Normalised emergency-contact fields from a request body. */
export function normalizeEmergencyContact(body = {}) {
  const relationship = normalizeText(body.emergency_contact_relationship).toLowerCase();
  return {
    emergency_contact_name: collapseSpaces(body.emergency_contact_name),
    emergency_contact_relationship:
      EMERGENCY_RELATIONSHIP_OPTIONS.find((option) => option.toLowerCase() === relationship) || "",
    emergency_contact_address: collapseSpaces(body.emergency_contact_address),
    emergency_contact_number: normalizeDigits(body.emergency_contact_number),
  };
}

/**
 * Returns the first problem as a user-facing message, or null. `ownNumber` is
 * the account holder's contact number: the emergency number must differ.
 */
export function validateEmergencyContact(contact, ownNumber = "") {
  const name = contact.emergency_contact_name;
  if (!name) return "Emergency contact name is required.";
  if (name.length > EMERGENCY_NAME_MAX) return `Emergency contact name must be at most ${EMERGENCY_NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(name)) {
    return "Emergency contact name may contain letters, spaces, hyphens, apostrophes and periods only.";
  }

  if (!contact.emergency_contact_relationship) {
    return `Select the emergency contact's relationship: ${EMERGENCY_RELATIONSHIP_OPTIONS.join(", ")}.`;
  }

  const address = contact.emergency_contact_address;
  if (!address) return "Emergency contact address is required.";
  if (address.length < EMERGENCY_ADDRESS_MIN) return "Enter the emergency contact's complete address.";
  if (address.length > EMERGENCY_ADDRESS_MAX) {
    return `Emergency contact address must be at most ${EMERGENCY_ADDRESS_MAX} characters.`;
  }

  const number = contact.emergency_contact_number;
  if (!number) return "Emergency contact number is required.";
  if (!MOBILE_PATTERN.test(number)) {
    return "Emergency contact number must be an 11-digit PH mobile number starting with 09.";
  }
  if (ownNumber && number === normalizeDigits(ownNumber)) {
    return "Emergency contact number must be different from the account holder's own number.";
  }
  return null;
}

function isEmpty(contact) {
  return !contact.emergency_contact_name
    && !contact.emergency_contact_relationship
    && !contact.emergency_contact_address
    && !contact.emergency_contact_number;
}

/**
 * The rule for an Edit dialog (HR's Edit Employee, Super Admin's Edit
 * Account). Accounts created before the contact was collected have none, so
 * all four fields blank is accepted -- unless one is already on file
 * (`hasExisting`), which may be changed but not removed. Otherwise the same
 * rules as creation apply.
 */
export function validateEmergencyContactUpdate(contact, ownNumber = "", hasExisting = false) {
  if (isEmpty(contact)) {
    return hasExisting
      ? "The emergency contact cannot be removed. Update it with the new details instead."
      : null;
  }
  return validateEmergencyContact(contact, ownNumber);
}

/** The profiles columns for a validated contact. */
export function emergencyContactColumns(contact) {
  return {
    emergency_contact_name: contact.emergency_contact_name || null,
    emergency_contact_relationship: contact.emergency_contact_relationship || null,
    emergency_contact_address: contact.emergency_contact_address || null,
    emergency_contact_number: contact.emergency_contact_number || null,
  };
}
