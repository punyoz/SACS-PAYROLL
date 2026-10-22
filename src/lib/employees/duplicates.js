/**
 * Likely duplicates of a new employee (scenario EM-11, 2026-10-22): the same
 * first and last name AND the same date of birth as an existing account,
 * archived ones included (a re-hire should be restored, not created twice).
 * The same name alone is common and never blocks; the employee ID and email
 * keep such people apart.
 */

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const key = (value) => String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * @param {{ first_name, last_name, date_of_birth }} record the new employee
 * @param {Array<{ id, email, user_metadata, archived? }>} users every account (listUsersCached)
 * @returns {Array<{ id, full_name, employee_id, archived }>}
 */
export function findLikelyDuplicates(record, users) {
  const first = key(record?.first_name);
  const last = key(record?.last_name);
  const born = String(record?.date_of_birth || "").trim();
  if (!first || !last || !born) return [];
  return (users || [])
    .filter((user) => {
      const meta = user.user_metadata || {};
      // The full name is "First [Middle] Last [Suffix]"; a last name may be
      // more than one word ("Dela Cruz"), so it is matched as a whole at the end.
      const words = key(meta.full_name).replace(/[.,]/g, "").split(" ");
      while (words.length && SUFFIXES.has(words[words.length - 1])) words.pop();
      const full = words.join(" ");
      const sameName = (key(meta.first_name) === first && key(meta.last_name) === last)
        || full === `${first} ${last}` || (full.startsWith(`${first} `) && full.endsWith(` ${last}`));
      return sameName && String(meta.date_of_birth || "").trim() === born;
    })
    .map((user) => ({
      id: user.id,
      full_name: user.user_metadata?.full_name || user.email,
      employee_id: user.user_metadata?.employee_id || null,
      archived: Boolean(user.user_metadata?.archived),
    }));
}
