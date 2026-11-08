/**
 * Demo data (profiles.is_demo, 20261108040000; decided 2026-11-08).
 *
 * Only the demo seed (e2e/scale/demo-60.sql) marks a person as demo.
 * Exports and reports skip demo people and every row that belongs to them;
 * the screens people work in (processing payroll, attendance, approvals)
 * are unchanged, so a demo environment still works end to end.
 *
 *   const demo = await loadDemoIds(supabase);
 *   rows.filter(notDemo(demo))                 // row.employee_id
 *   rows.filter(notDemo(demo, (r) => r.id))    // a profile row
 */

/** The ids of every demo person. Empty when the column is not there yet. */
export async function loadDemoIds(supabase) {
  try {
    const { data, error } = await supabase.from("profiles").select("id").eq("is_demo", true).limit(10000);
    if (error) return new Set();
    return new Set((data || []).map((row) => String(row.id)));
  } catch {
    return new Set();
  }
}

/** A filter keeping rows that are not a demo person's. */
export function notDemo(demoIds, idOf = (row) => row?.employee_id) {
  return (row) => !demoIds?.size || !demoIds.has(String(idOf(row) ?? ""));
}
