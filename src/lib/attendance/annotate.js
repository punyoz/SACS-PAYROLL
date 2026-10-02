/**
 * Extra labels the attendance tables group and annotate rows by:
 *
 *   employee_code     profiles.employee_id (SACS-003), to tell apart two
 *                     accounts with the same name
 *   group_branch_id   the branch the employee is in NOW (profiles.branch_id),
 *                     the same rule every attendance view scopes by; the
 *                     row's own branch_id when the profile has none
 *   branch_name       that branch's name
 *   last_correction   for a Corrected day: the latest approved correction
 *                     (who, when, why), for "Corrected by … · reason"
 *   tap_after_correction_at  for a Corrected day: a tap came in after the
 *                     correction ("New tap after correction")
 *
 * Never throws: on a read error the rows come back without the labels.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function annotateAttendanceRows(supabase, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const employeeIds = [...new Set(list.map((row) => row.employee_id).filter((id) => UUID_RE.test(String(id || ""))))];
  const correctedIds = list
    .filter((row) => String(row.status || "") === "Corrected" && UUID_RE.test(String(row.id || "")))
    .map((row) => row.id);

  const people = new Map();
  const branchNames = new Map();
  const corrections = new Map();
  const tapFlags = new Map();

  try {
    const [profiles, branches, done] = await Promise.all([
      employeeIds.length
        ? supabase.from("profiles").select("id,employee_id,branch_id").in("id", employeeIds.slice(0, 1000))
        : Promise.resolve({ data: [] }),
      supabase.from("branches").select("id,name"),
      correctedIds.length
        ? supabase
          .from("attendance_corrections")
          .select("log_id,approved_by_name,approved_at,reason,review_note,correction_type,original_time_in,original_time_out")
          .eq("status", "approved")
          .in("log_id", correctedIds.slice(0, 1000))
          .order("approved_at", { ascending: true })
        : Promise.resolve({ data: [] }),
    ]);
    if (!profiles.error) (profiles.data || []).forEach((row) => people.set(row.id, row));
    if (!branches.error) (branches.data || []).forEach((row) => branchNames.set(row.id, row.name));
    // Ascending, so the last one written per log is the latest.
    if (!done.error) (done.data || []).forEach((row) => corrections.set(row.log_id, row));
    // Read on its own: the column only exists once the raw-taps migration is in.
    if (correctedIds.length) {
      const flags = await supabase
        .from("attendance_logs")
        .select("id,tap_after_correction_at")
        .in("id", correctedIds.slice(0, 1000));
      if (!flags.error) (flags.data || []).forEach((row) => tapFlags.set(row.id, row.tap_after_correction_at || null));
    }
  } catch {
    // Labels are a convenience; the rows are still correct without them.
  }

  return list.map((row) => {
    const person = people.get(row.employee_id);
    const groupBranch = person?.branch_id || row.branch_id || null;
    return {
      ...row,
      employee_code: person?.employee_id || row.employee_code || null,
      group_branch_id: groupBranch,
      branch_name: groupBranch ? branchNames.get(groupBranch) || null : null,
      last_correction: corrections.get(row.id) || null,
      tap_after_correction_at: row.tap_after_correction_at || tapFlags.get(row.id) || null,
    };
  });
}
