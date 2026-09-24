/**
 * Mirror an archive / restore onto profiles.
 *
 * user_metadata.archived is what sign-in, the session check and the RFID scan
 * enforce; profiles.archived is what branch reports and database-side readers
 * use. Both archive routes (/api/admin/employees for employee and accountant
 * records, /api/admin/users for staff accounts) write the metadata first and
 * then call this so the two never disagree. archived_at / archived_by are
 * cleared by the profiles_archive_stamp trigger on restore (see
 * supabase/migrations/20260924085321_profiles_archive_tracking.sql).
 *
 * @returns {Promise<string|null>} an error message, or null on success
 */
export async function syncProfileArchive(supabase, id, archived, actorId) {
  const patch = archived
    ? { archived: true, archived_at: new Date().toISOString(), archived_by: actorId || null }
    : { archived: false };
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
  return error ? error.message : null;
}
