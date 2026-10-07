/**
 * The browser-side display context the legacy portals read after sign-in.
 *
 * public/legacy/js/app.js's saveAuthContext() writes this object to
 * localStorage["sacs-auth-context"] and every portal reads it for names,
 * the role and the must-change-password gate (public/legacy/index.html). The
 * React sign-in screen has to leave exactly the same thing behind, so this is
 * a line-for-line port of that function and its two name helpers. Keep the
 * two in step.
 *
 * Display only: the signed HttpOnly session cookie is what authorizes
 * anything (src/proxy.js).
 */

export const AUTH_CONTEXT_KEY = "sacs-auth-context";

function toTitleCase(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function inferNameFromIdentity(identity) {
  const raw = String(identity || "").trim();
  if (!raw) return "";
  const fromEmail = raw.includes("@") ? raw.split("@")[0] : raw;
  return toTitleCase(fromEmail.replace(/[._-]+/g, " "));
}

const text = (value) => String(value || "").trim();

/** @param {object} result a sign-in / verify / reset reply carrying `profile` */
export function buildAuthContext(result, role, identityInput) {
  const profile = result?.profile || {};
  const resolvedRole = String(profile.role || role || "employee").toLowerCase();
  const fullName = text(profile.full_name) || inferNameFromIdentity(profile.email || identityInput);

  return {
    role: resolvedRole,
    full_name: fullName,
    first_name: text(profile.first_name),
    middle_name: text(profile.middle_name),
    last_name: text(profile.last_name),
    suffix: text(profile.suffix),
    emergency_contact_name: text(profile.emergency_contact_name),
    emergency_contact_relationship: text(profile.emergency_contact_relationship),
    emergency_contact_address: text(profile.emergency_contact_address),
    emergency_contact_number: text(profile.emergency_contact_number),
    email: text(profile.email),
    employee_id: text(profile.employee_id),
    staff_id: text(profile.staff_id),
    employee_type: text(profile.employee_type),
    position: text(profile.position),
    address: text(profile.address),
    sss_number: text(profile.sss_number),
    pagibig_number: text(profile.pagibig_number),
    philhealth_number: text(profile.philhealth_number),
    tin_number: text(profile.tin_number),
    bank_name: text(profile.bank_name),
    bank_account_number: text(profile.bank_account_number),
    cp_number: text(profile.cp_number),
    date_hired: text(profile.date_hired),
    date_of_birth: text(profile.date_of_birth),
    sex: text(profile.sex),
    civil_status: text(profile.civil_status),
    employment_type: text(profile.employment_type),
    employment_status: text(profile.employment_status),
    branch_id: profile.branch_id || null,
    must_change_password: result?.must_change_password === true || profile.must_change_password === true,
  };
}

export function saveAuthContext(result, role, identityInput) {
  try {
    localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(buildAuthContext(result, role, identityInput)));
  } catch {
    // Private mode / storage blocked: the portal re-reads what it needs from
    // /api/rbac/me, and the session cookie is what authorizes anyway.
  }
}

export function readAuthContext() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_CONTEXT_KEY) || "null");
  } catch {
    return null;
  }
}

export function clearAuthContext() {
  try {
    localStorage.removeItem(AUTH_CONTEXT_KEY);
  } catch {
    // ignore
  }
}

/** Same rules as the legacy evaluatePasswordShape() and the server's policy. */
export const PASSWORD_MIN_LENGTH = 8;

export function evaluatePasswordShape(next, confirm) {
  const value = String(next || "");
  return {
    length: value.length >= PASSWORD_MIN_LENGTH && value.length <= 72,
    mix: /[A-Za-z]/.test(value) && /\d/.test(value),
    upper: /[A-Z]/.test(value),
    symbol: /[^A-Za-z0-9\s]/.test(value),
    spaces: value.length > 0 && !/\s/.test(value),
    match: value.length > 0 && value === String(confirm || ""),
  };
}

export const ROLE_ROUTES = {
  super_admin: "/super-admin",
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
  hr: "/hr",
};

export const LOGIN_REASON_MESSAGES = {
  signed_in_elsewhere: "You were signed out because your account signed in on another device or browser. Only one active sign-in is allowed per account.",
  account_archived: "This account has been archived and can no longer sign in.",
  account_changed: "Your role or branch was changed by an administrator. Please sign in again.",
  session_expired: "Your session has expired. Please sign in again.",
  password_reset: "Your password has been reset. Sign in with your new password.",
};
