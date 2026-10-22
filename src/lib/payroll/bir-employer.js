/**
 * The employer's details printed on BIR Form 2316 and the alphalist
 * (scenario AC-11, 2026-10-22). Saved by the Super Admin under System
 * Configuration → General (system_config section "general"); every field is
 * optional there, and the forms say which ones are still blank.
 *
 * Safe for the browser: no server imports.
 */

export const BIR_EMPLOYER_SECTION = "general";

/** [key, label, placeholder, maxLength] in the order the forms print them. */
export const BIR_EMPLOYER_FIELDS = [
  ["bir_employer_name", "Registered name", "e.g. Shepherd Angels Christian School of Antipolo, Inc.", 200],
  ["bir_employer_tin", "Employer TIN", "000-000-000-00000", 20],
  ["bir_rdo_code", "RDO code", "e.g. 046", 3],
  ["bir_registered_address", "Registered address", "Street, barangay, city / municipality, province", 250],
  ["bir_zip_code", "ZIP code", "e.g. 1870", 4],
  ["bir_signatory_name", "Authorized signatory", "Name of the person who signs the 2316", 120],
  ["bir_signatory_title", "Signatory's title", "e.g. School Director", 120],
];

const digits = (value) => String(value ?? "").replace(/\D/g, "");

/** A TIN as 000-000-000-00000 (the branch code defaults to 00000). Blank stays blank. */
export function formatTin(value) {
  const d = digits(value);
  if (!d) return "";
  const branch = d.slice(9).padEnd(5, "0").slice(0, 5);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), branch].filter(Boolean).join("-");
}

/** { key: message } for values that are filled in but malformed. Blank is allowed. */
export function birEmployerErrors(values = {}) {
  const errors = {};
  const tin = digits(values.bir_employer_tin);
  if (String(values.bir_employer_tin || "").trim() && (tin.length < 9 || tin.length > 14)) errors.bir_employer_tin = "Enter the 9-digit TIN, with or without the branch code.";
  if (String(values.bir_rdo_code || "").trim() && !/^\d{3}$/.test(String(values.bir_rdo_code).trim())) errors.bir_rdo_code = "The RDO code is 3 digits.";
  if (String(values.bir_zip_code || "").trim() && !/^\d{4}$/.test(String(values.bir_zip_code).trim())) errors.bir_zip_code = "The ZIP code is 4 digits.";
  return errors;
}

/** The saved values (from the "general" section), trimmed; the TIN formatted. */
export function birEmployerFrom(general = {}) {
  const out = Object.fromEntries(BIR_EMPLOYER_FIELDS.map(([key]) => [key, String(general?.[key] ?? "").trim()]));
  out.bir_employer_tin = formatTin(out.bir_employer_tin);
  return out;
}

/** Labels of the fields still blank. */
export function missingBirEmployerFields(employer = {}) {
  return BIR_EMPLOYER_FIELDS.filter(([key]) => !String(employer[key] || "").trim()).map(([, label]) => label);
}
