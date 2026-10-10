/**
 * Licensed-teacher fields (docs/payroll-schedule-loans-awol.md §6.6;
 * profiles.is_licensed_teacher / prc_license_no_enc / license_expires_on /
 * license_verified_*, employee_license_changes, 20261009010000).
 *
 * Off is a normal state: an unlicensed teacher has no PRC fields and no
 * subsidy. HR alone turns it on, edits it and verifies it; any edit to the
 * number, expiry or ID clears verification. Eligible = on + verified +
 * not expired. Admin and Super Admin see a read-only line; Accountant and
 * Employee see nothing (the API never sends them these fields).
 */

export const LICENSE_ACTIONS = Object.freeze(["turn_on", "update_details", "verify", "turn_off"]);
export const DEFAULT_WARNING_DAYS = 60;

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);
}

/**
 * @returns {{ code: "not_licensed"|"pending"|"eligible"|"expiring"|"expired", label: string,
 *   tone: string, days_left: number|null, eligible: boolean }}
 */
export function licenseStatus(profile, today, warningDays = DEFAULT_WARNING_DAYS) {
  if (!profile?.is_licensed_teacher) return { code: "not_licensed", label: "Not licensed", tone: "muted", days_left: null, eligible: false };
  const expires = profile.license_expires_on ? String(profile.license_expires_on).slice(0, 10) : null;
  const daysLeft = expires ? daysBetween(today, expires) : null;
  if (daysLeft !== null && daysLeft < 0) return { code: "expired", label: "Expired", tone: "danger", days_left: daysLeft, eligible: false };
  if (!profile.license_verified_at) return { code: "pending", label: "Pending HR verification", tone: "gold", days_left: daysLeft, eligible: false };
  if (daysLeft !== null && daysLeft <= warningDays) {
    return { code: "expiring", label: `Expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`, tone: "gold", days_left: daysLeft, eligible: true };
  }
  return { code: "eligible", label: "Eligible", tone: "success", days_left: daysLeft, eligible: true };
}

/** "••••3456" */
export function maskedLicense(last4) {
  return last4 ? `••••${last4}` : "";
}

/** Validation for an HR license change. Returns an error message, or null. */
export function validateLicenseChange(action, input, today) {
  if (!LICENSE_ACTIONS.includes(action)) return "Unknown license action.";
  const reason = String(input?.reason || "").trim();
  if (reason.length < 3) return "Give the reason for the change.";
  if (action === "turn_on" || action === "update_details") {
    const number = String(input?.prc_license_no || "").trim();
    if (action === "turn_on" && !number) return "Enter the PRC license number.";
    if (number && !/^[0-9A-Za-z-]{4,20}$/.test(number)) return "The PRC license number has 4 to 20 letters or digits.";
    const expires = String(input?.license_expires_on || "").trim();
    if (action === "turn_on" && !expires) return "Enter the license expiry date.";
    if (expires && (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires <= today)) return "The license expiry date must be after today.";
    if (action === "update_details" && !number && !expires && !input?.document) return "Change the number, expiry date or PRC ID.";
  }
  return null;
}
