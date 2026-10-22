/**
 * Separation reasons and the request check (client-safe; the server part is
 * src/lib/employees/separation.js).
 */
import { normalizeText } from "@/lib/auth/normalize";

export const SEPARATION_REASONS = ["Resigned", "End of contract", "Retired", "Terminated", "Deceased", "Other"];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A problem with the request, or null. */
export function validateSeparation({ effective, reason, note }, { dateHired = null } = {}) {
  if (!DATE_KEY.test(String(effective || ""))) return "Choose the last day of employment.";
  if (dateHired && String(effective) < String(dateHired).slice(0, 10)) return "The last day cannot be before the date hired.";
  if (!SEPARATION_REASONS.includes(reason)) return "Choose the reason for separation.";
  if ((reason === "Terminated" || reason === "Other") && normalizeText(note).length < 10) {
    return "State the grounds (at least 10 characters).";
  }
  return null;
}
