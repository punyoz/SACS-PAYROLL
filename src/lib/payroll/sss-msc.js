/**
 * SSS monthly salary credit (MSC) table (public.payroll_sss_msc_brackets,
 * 20261026020000_sss_msc_brackets.sql). SSS does not take a % of the raw
 * salary: the salary falls in a bracket, and the employee share is sss_pct %
 * of that bracket's credit. A version is the rows saved together from one
 * effective date; payroll uses the version in force on the pay period's
 * first day, like the withholding tax table, so a new schedule never changes
 * a payslip already processed.
 *
 *   row { salary_from, msc }: a salary of salary_from or more (up to the next
 *   row's salary_from) has this credit. The first row starts at 0.
 *
 * Seeded with the SSS schedule from January 2025 (RA 11199, 15% of MSC:
 * employee 5%, employer 10%): below ₱5,250 → ₱5,000, then ₱500 steps, up to
 * ₱34,750 and above → ₱35,000.
 */

import { resolveTaxTableRows } from "@/lib/payroll/semi-monthly";
import { CONTRIBUTION_MAX, pesoLimit } from "@/lib/input-limits";

export const MSC_COLUMNS = "id,version_id,effective_date,salary_from,msc,note,created_by_name,created_at";
export const MAX_MSC_ROWS = 200;

/** Rows of one version -> [{ from, msc }] by salary_from. */
export function mscTableFromRows(rows) {
  return (rows || [])
    .map((row) => ({ from: Number(row.salary_from) || 0, msc: Number(row.msc) || 0 }))
    .sort((a, b) => a.from - b.from);
}

/** The table in force on dateKey ("YYYY-MM-DD"), or null when none is saved. */
export function mscTableOn(rows, dateKey) {
  const table = mscTableFromRows(resolveTaxTableRows(rows, dateKey));
  return table.length ? table : null;
}

/**
 * Every version, newest first, for the Super Admin's editor. Never throws:
 * `available` is false when the table is not set up yet, and payroll then
 * uses the ₱500-step formula (src/lib/payroll/statutory.js).
 */
export async function loadSssMscRows(supabase) {
  try {
    const result = await supabase.from("payroll_sss_msc_brackets").select(MSC_COLUMNS).order("effective_date", { ascending: false });
    if (result.error) throw result.error;
    return { rows: result.data || [], available: true };
  } catch (error) {
    return { rows: [], available: false, error: error?.message || String(error) };
  }
}

/** Versions of the table, newest first, each with its rows. */
export function mscVersions(rows) {
  const byVersion = new Map();
  (rows || []).forEach((row) => {
    if (!byVersion.has(row.version_id)) {
      byVersion.set(row.version_id, {
        version_id: row.version_id, effective_date: row.effective_date, note: row.note || null,
        created_by_name: row.created_by_name || null, created_at: row.created_at, rows: [],
      });
    }
    byVersion.get(row.version_id).rows.push({ salary_from: Number(row.salary_from), msc: Number(row.msc) });
  });
  return [...byVersion.values()]
    .map((version) => ({ ...version, rows: version.rows.sort((a, b) => a.salary_from - b.salary_from) }))
    .sort((a, b) => (String(b.effective_date).localeCompare(String(a.effective_date)) || String(b.created_at).localeCompare(String(a.created_at))));
}

/** Checks for a new version. Returns an error message, or null. */
export function validateMscRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "Add at least one salary bracket.";
  if (rows.length > MAX_MSC_ROWS) return `An SSS salary credit table has at most ${MAX_MSC_ROWS} brackets.`;
  const parsed = rows.map((row) => ({ from: Number(row.salary_from), msc: Number(row.msc) }));
  if (parsed.some((r) => !Number.isFinite(r.from) || !Number.isFinite(r.msc) || r.from < 0)) return "Every amount must be a number, 0 or more.";
  if (parsed.some((r) => r.msc <= 0)) return "Every salary credit must be more than 0.";
  // numeric(12,2) columns: a larger amount would fail as a database error.
  if (parsed.some((r) => r.from > CONTRIBUTION_MAX || r.msc > CONTRIBUTION_MAX)) return `Every amount must be at most ${pesoLimit(CONTRIBUTION_MAX)}.`;
  if (parsed[0].from !== 0) return "The first bracket must start at a salary of 0.";
  if (parsed.some((r, i) => i > 0 && r.from <= parsed[i - 1].from)) return "Each bracket must start above the one before it.";
  if (parsed.some((r, i) => i > 0 && r.msc < parsed[i - 1].msc)) return "A higher salary bracket cannot have a lower salary credit.";
  return null;
}
