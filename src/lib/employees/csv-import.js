/**
 * Onboarding employees from a CSV file (HR → User Management → Import CSV,
 * scenarios SC-10 / HR-02, 2026-10-22). One row per new employee, the same
 * fields as the Add employee form; every row is checked by the same rules
 * the form uses (src/lib/employees/record.js) and created by the same route
 * (POST /api/admin/employees), so an imported employee is exactly like one
 * added by hand.
 */

export const IMPORT_MAX_ROWS = 500;
export const IMPORT_BATCH_SIZE = 20;

/** The template's columns, in order. Required ones end in *. */
export const IMPORT_COLUMNS = [
  ["first_name", "First name *"],
  ["middle_initial", "Middle initial"],
  ["last_name", "Last name *"],
  ["suffix", "Suffix"],
  ["email", "Email *"],
  ["role", "Role (employee or accountant)"],
  ["branch", "Branch *"],
  ["employee_type", "Employee type * (Teaching / Non-Teaching)"],
  ["position", "Position *"],
  ["employment_type", "Employment type *"],
  ["employment_status", "Employment status *"],
  ["employee_status", "Account status (default Active)"],
  ["date_hired", "Date hired * (YYYY-MM-DD)"],
  ["basic_salary", "Basic salary (monthly) *"],
  ["date_of_birth", "Date of birth * (YYYY-MM-DD)"],
  ["sex", "Sex *"],
  ["civil_status", "Civil status *"],
  ["address", "Home address *"],
  ["cp_number", "Contact number * (09xxxxxxxxx)"],
  ["sss_number", "SSS number *"],
  ["philhealth_number", "PhilHealth number *"],
  ["pagibig_number", "Pag-IBIG number *"],
  ["tin_number", "TIN *"],
  ["emergency_contact_name", "Emergency contact name *"],
  ["emergency_contact_relationship", "Emergency contact relationship *"],
  ["emergency_contact_address", "Emergency contact address *"],
  ["emergency_contact_number", "Emergency contact number *"],
];

const KEY_BY_HEADER = new Map(IMPORT_COLUMNS.flatMap(([key, label]) => [
  [key, key],
  [label.toLowerCase(), key],
  [label.replace(/\s*\*.*$|\s*\(.*$/, "").trim().toLowerCase(), key],
]));

/** RFC 4180 CSV: quoted fields, "" inside quotes, commas and line breaks in quotes, CRLF, a BOM. */
export function parseCsv(text) {
  const source = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === "\"") {
        if (source[i + 1] === "\"") { field += "\""; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * The file's rows as objects keyed by template column, with the line number
 * each came from. Unknown columns are reported, never guessed.
 */
export function readImportFile(text) {
  const [header = [], ...body] = parseCsv(text);
  const keys = header.map((h) => KEY_BY_HEADER.get(String(h).trim().toLowerCase()) || null);
  const unknown = header.filter((h, i) => String(h).trim() && !keys[i]);
  const missing = IMPORT_COLUMNS.filter(([key, label]) => label.includes("*") && !keys.includes(key)).map(([, label]) => label.replace(/\s*\*.*$/, ""));
  const rows = body.map((cells, index) => {
    const values = {};
    keys.forEach((key, i) => { if (key) values[key] = String(cells[i] ?? "").trim(); });
    return { line: index + 2, values };
  });
  return { rows, unknown, missing };
}

/**
 * One row as the body POST /api/admin/employees takes. `branches` is
 * [{ id, name }]; the branch is matched by name (any case) or id.
 */
export function rowToEmployeeBody(values, branches = []) {
  const wanted = String(values.branch || "").trim().toLowerCase();
  const branch = branches.find((b) => String(b.name || "").toLowerCase() === wanted || String(b.id) === values.branch);
  const role = String(values.role || "employee").trim().toLowerCase() === "accountant" ? "accountant" : "employee";
  // A new hire's account is Active unless the file says otherwise.
  const body = { ...values, employee_status: values.employee_status || "Active", role, branch_id: branch?.id || "", basic_salary: values.basic_salary === "" ? "" : Number(String(values.basic_salary).replace(/[,₱\s]/g, "")) };
  delete body.branch;
  return { body, branch: branch || null };
}

/** The empty template, as CSV text. */
export function importTemplateCsv() {
  return `${IMPORT_COLUMNS.map(([, label]) => (label.includes(",") ? `"${label}"` : label)).join(",")}\n`;
}
