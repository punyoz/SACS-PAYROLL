/**
 * Per-branch attendance policy (work start/end, late grace, required hours).
 *
 * Stored in public.system_config, one section per scope:
 *
 *   section "attendance"               the default schedule, used by every
 *                                      branch that has no schedule of its own
 *   section "attendance:<branch uuid>" that branch's own schedule
 *
 * Each key (work_start, work_end, grace, work_hours) falls back on its own:
 * a branch that only overrides work_start still inherits the default grace.
 * The Super Admin "Attendance Policy" card writes both kinds of section.
 */

export const ATTENDANCE_SECTION = "attendance";
export const MANILA_TZ = "Asia/Manila";

export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  work_start: "08:00",
  work_end: "17:00",
  grace: 15,
  work_hours: 8,
});

const POLICY_KEYS = Object.keys(DEFAULT_ATTENDANCE_POLICY);

/** The system_config section holding a branch's schedule (default when no branch). */
export function attendanceSectionForBranch(branchId) {
  const id = String(branchId ?? "").trim();
  return id ? `${ATTENDANCE_SECTION}:${id}` : ATTENDANCE_SECTION;
}

/** "HH:MM" -> minutes after midnight, or null when not a valid time. */
export function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function cleanValue(key, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  if (key === "work_start" || key === "work_end") {
    return timeToMinutes(raw) === null ? undefined : String(raw).trim().slice(0, 5).padStart(5, "0");
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve the effective policy for a branch from a config object shaped like
 * GET /api/admin/config's `config` ({ [section]: { [key]: value } }).
 *
 * @returns {{ work_start: string, work_end: string, grace: number,
 *             work_hours: number, branch_id: string|null, source: "branch"|"default" }}
 */
export function resolveAttendancePolicy(config, branchId) {
  const base = (config && config[ATTENDANCE_SECTION]) || {};
  const own = branchId ? (config && config[attendanceSectionForBranch(branchId)]) || {} : {};
  const policy = { ...DEFAULT_ATTENDANCE_POLICY };
  let overridden = false;

  POLICY_KEYS.forEach((key) => {
    const fromDefault = cleanValue(key, base[key]);
    if (fromDefault !== undefined) policy[key] = fromDefault;
    const fromBranch = cleanValue(key, own[key]);
    if (fromBranch !== undefined) {
      policy[key] = fromBranch;
      overridden = true;
    }
  });

  return { ...policy, branch_id: branchId || null, source: overridden ? "branch" : "default" };
}

/**
 * Read the default section plus the given branches' sections from
 * system_config, shaped like GET /api/admin/config's `config`.
 * Never throws: on a read error an empty config (built-in defaults) is returned.
 */
export async function loadAttendanceConfig(supabase, branchIds = []) {
  const sections = [ATTENDANCE_SECTION];
  [...new Set((branchIds || []).filter(Boolean).map(String))]
    .forEach((id) => sections.push(attendanceSectionForBranch(id)));

  try {
    const result = await supabase
      .from("system_config")
      .select("section,key,value")
      .in("section", sections);
    if (result.error) throw result.error;

    const config = {};
    (result.data || []).forEach((row) => {
      if (!config[row.section]) config[row.section] = {};
      config[row.section][row.key] = row.value;
    });
    return config;
  } catch {
    return {};
  }
}

/**
 * Load the effective policy for one branch straight from system_config.
 * Never throws: on a read error the built-in defaults are returned.
 */
export async function getBranchAttendancePolicy(supabase, branchId) {
  const config = await loadAttendanceConfig(supabase, branchId ? [branchId] : []);
  return resolveAttendancePolicy(config, branchId);
}

/** "07:00" -> "07:00 AM", "16:30" -> "04:30 PM" (the timesheet's shift format). */
export function formatPolicyTime12(value) {
  const minutes = timeToMinutes(value);
  if (minutes === null) return null;
  const h24 = Math.floor(minutes / 60);
  const h12 = h24 % 12 || 12;
  return `${String(h12).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Minutes after midnight, Manila time, for an instant. */
export function manilaMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(date));
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

/** Minutes a time-in is past the branch's work start (0 when on time or early). */
export function tardinessMinutes(timeIn, policy) {
  if (!timeIn) return 0;
  const start = timeToMinutes(policy?.work_start ?? DEFAULT_ATTENDANCE_POLICY.work_start);
  const diff = manilaMinutesOfDay(timeIn) - start;
  return diff > 0 ? diff : 0;
}

/** Minutes a time-out is before the branch's work end (0 when on time or later). */
export function undertimeMinutes(timeOut, policy) {
  if (!timeOut) return 0;
  const end = timeToMinutes(policy?.work_end ?? DEFAULT_ATTENDANCE_POLICY.work_end);
  const diff = end - manilaMinutesOfDay(timeOut);
  return diff > 0 ? diff : 0;
}

/** Whether a time-in counts as Late under the branch's start time and grace period. */
export function isLateForPolicy(timeIn, policy) {
  const grace = Number(policy?.grace ?? DEFAULT_ATTENDANCE_POLICY.grace) || 0;
  return tardinessMinutes(timeIn, policy) > grace;
}
