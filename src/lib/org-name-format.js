/**
 * Organization name formatting, safe for the browser and the server alike
 * (no database access here; the loader is src/lib/org-name.js).
 */

export const DEFAULT_ORG_NAME = "SACS";
export const ORG_NAME_MAX = 60;

/** One line of plain text, at most 60 characters; the default when empty. */
export function normalizeOrgName(value) {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f<>"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ORG_NAME_MAX)
    .trim();
  return name || DEFAULT_ORG_NAME;
}

/** "SACS" -> "SACS Payroll". */
export function systemName(orgName) {
  return `${normalizeOrgName(orgName)} Payroll`;
}
