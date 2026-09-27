/**
 * Government IDs and bank account numbers -- the personal identifiers kept
 * encrypted in profiles (supabase/migrations/20260927080000_profiles_pii_encryption.sql
 * and 20260927090000_retire_plaintext_pii.sql).
 *
 * Writing: put the plain value in the profiles column of the same name
 * (sss_number, philhealth_number, pagibig_number, tin_number,
 * bank_account_number). The profiles_protect_pii trigger encrypts it into
 * <field>_enc, keeps the last four digits in <field>_last4 and discards the
 * plain text. An empty string clears the value; NULL (or leaving the column
 * out) keeps what is stored.
 *
 * Reading: the full numbers come only from fetchProfilesPii() -- for a route
 * that has passed its RBAC check and genuinely needs them (HR's employee
 * records). Everything else shows maskedPii(): "••••1234".
 *
 * None of these may be written to Auth user_metadata: Supabase copies
 * user_metadata into every access token.
 */

export const PII_FIELDS = [
  "sss_number",
  "philhealth_number",
  "pagibig_number",
  "tin_number",
  "bank_account_number",
];

/** The profiles columns maskedPii() reads, for a .select() list. */
export const PII_LAST4_COLUMNS = PII_FIELDS.map((field) => `${field}_last4`).join(",");

export const PII_MASK = "••••";

export function maskLast4(last4) {
  return last4 ? `${PII_MASK}${last4}` : "";
}

/** { sss_number: "••••7890", ... } from a profiles row with the _last4 columns. */
export function maskedPii(profile) {
  const masked = {};
  for (const field of PII_FIELDS) masked[field] = maskLast4(profile?.[`${field}_last4`]);
  return masked;
}

/**
 * Full numbers for the given profile ids, as Map<id, { sss_number, ... }>.
 * Decrypts through public.get_profiles_pii(), which only service_role may
 * call. Throws on a database error so a caller never mistakes a failed read
 * for "no numbers on file".
 */
export async function fetchProfilesPii(supabase, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const byId = new Map();
  if (!unique.length) return byId;
  const { data, error } = await supabase.rpc("get_profiles_pii", { p_profile_ids: unique });
  if (error) throw error;
  for (const row of data || []) {
    const values = {};
    for (const field of PII_FIELDS) values[field] = row[field] || "";
    byId.set(row.id, values);
  }
  return byId;
}

/** A copy of Auth user_metadata with every PII key removed. */
export function withoutPiiMetadata(metadata = {}) {
  const copy = { ...metadata };
  for (const field of PII_FIELDS) delete copy[field];
  return copy;
}
