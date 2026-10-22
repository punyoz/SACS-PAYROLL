/**
 * Per-employee work schedules (Super Admin → System Configuration →
 * Attendance → Employee Work Schedules, and HR → Work Schedules, with the
 * same powers; supabase/migrations/
 * 20261013010000_employee_schedules_cutoffs_early_bird.sql).
 *
 *   GET   schedule profiles (current and upcoming versions), level and
 *         employee assignments, every employee with the schedule they follow
 *         today. Super Admin and HR see every branch, Admin its own.
 *
 *   POST  Super Admin and HR ("create" on work_schedules; every other role
 *         gets 403 here, whatever its screen shows):
 *     { action: "save_schedule", schedule_key?, name, work_start, work_end,
 *       grace_minutes, work_hours, working_days, effective_from, note }
 *         a new profile, or a new version of one from effective_from
 *     { action: "delete_schedule" (or "archive_schedule"), schedule_key, effective_from, note }
 *         deleted from that date: kept as history (no hard deletes), no
 *         longer offered or followed; refused while still assigned
 *     { action: "assign", target: "employee", employee_ids, schedule_key|null, effective_from, note }
 *     { action: "assign", target: "level", level, schedule_key|null, effective_from, note }
 *         schedule_key null = back to the fallback from that date
 *     { action: "set_level", employee_ids, level|null }
 *
 * Every change is effective-dated (today or later, Manila) and append-only,
 * so attendance already judged and payslips already issued never change, and
 * each one is written to Audit & Monitoring (who, their role, what, when).
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { can } from "@/lib/rbac/permissions";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows, forEachInChunk } from "@/lib/supabase/fetch-all";
import { loadAttendanceConfig, resolveAttendancePolicy } from "@/lib/attendance/policy";
import { describeWorkingDays, LEVEL_VALUES, levelLabel, validateScheduleInput } from "@/lib/attendance/work-schedules";
import { isDateKey, manilaDateKey } from "@/lib/payroll/periods";
import { actorName } from "@/lib/payroll/staff";

const NOT_READY = "Employee work schedules are not set up yet: apply supabase/migrations/20261013010000_employee_schedules_cutoffs_early_bird.sql.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID_ROLES = ["employee", "accountant"];

function isMissing(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("42703") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find") || text.includes("schema cache");
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today or later (Manila), and within a year. */
function checkEffectiveDate(value) {
  const key = normalizeText(value);
  const today = manilaDateKey();
  if (!isDateKey(key)) return { error: "Choose the date the change takes effect." };
  if (key < today) return { error: "A schedule change cannot take effect before today: past attendance and payslips are never recalculated." };
  if (key > addDays(today, 366)) return { error: "Choose an effective date within the next year." };
  return { key };
}

const byNewest = (a, b) => String(b.effective_from).localeCompare(String(a.effective_from))
  || String(b.created_at || "").localeCompare(String(a.created_at || ""));

/** The row in force on dateKey among rows sharing one target, newest first. */
function inForce(rows, dateKey) {
  return [...rows].filter((row) => String(row.effective_from) <= dateKey).sort(byNewest)[0] || null;
}

const shortTime = (value) => String(value || "").slice(0, 5);

function shapeVersion(row) {
  return {
    id: row.id,
    schedule_key: row.schedule_key,
    name: row.name,
    work_start: shortTime(row.work_start),
    work_end: shortTime(row.work_end),
    grace_minutes: Number(row.grace_minutes) || 0,
    work_hours: Number(row.work_hours) || 0,
    working_days: (row.working_days || []).map(Number),
    working_days_label: describeWorkingDays(row.working_days),
    effective_from: String(row.effective_from).slice(0, 10),
    archived: row.archived === true,
    note: row.note || null,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
  };
}

async function loadData(supabase) {
  const [versions, assignments] = await Promise.all([
    fetchAllRows(() => supabase.from("work_schedules").select("*").order("created_at", { ascending: true }).order("id", { ascending: true })),
    fetchAllRows(() => supabase.from("work_schedule_assignments").select("*").order("created_at", { ascending: true }).order("id", { ascending: true })),
  ]);
  if (versions.error || assignments.error) {
    const error = versions.error || assignments.error;
    if (isMissing(error)) return { available: false };
    throw new Error(error.message);
  }
  return { available: true, versions: versions.data || [], assignments: assignments.data || [] };
}

/** Profiles: current version (today), upcoming versions, full history. */
function buildProfiles(versions, today) {
  const byKey = new Map();
  versions.forEach((row) => {
    if (!byKey.has(row.schedule_key)) byKey.set(row.schedule_key, []);
    byKey.get(row.schedule_key).push(row);
  });
  return [...byKey.entries()].map(([key, rows]) => {
    const current = inForce(rows, today);
    const upcoming = rows.filter((row) => String(row.effective_from) > today).sort((a, b) => -byNewest(a, b));
    const latest = [...rows].sort(byNewest)[0];
    return {
      schedule_key: key,
      // Shown as it is today; a profile that only starts later shows its first version.
      ...shapeVersion(current || upcoming[0] || latest),
      starts_on: current ? null : String((upcoming[0] || latest).effective_from).slice(0, 10),
      archived: Boolean((current || latest).archived),
      upcoming: upcoming.map(shapeVersion),
      history: [...rows].sort(byNewest).map(shapeVersion),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function assignmentState(rows, today, profileName) {
  const current = inForce(rows, today);
  const upcoming = rows.filter((row) => String(row.effective_from) > today).sort((a, b) => -byNewest(a, b));
  const shape = (row) => (row ? {
    schedule_key: row.schedule_key || null,
    schedule_name: row.schedule_key ? profileName(row.schedule_key) : null,
    effective_from: String(row.effective_from).slice(0, 10),
    note: row.note || null,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
  } : null);
  return { current: shape(current), upcoming: upcoming.map(shape), history: [...rows].sort(byNewest).map(shape) };
}

async function loadEmployees(supabase, guard) {
  // A fresh query per page: fetchAllRows adds its own range to each.
  const buildQuery = () => {
    let query = supabase.from("profiles")
      .select("id,full_name,employee_id,branch_id,position,employee_type,employee_level,role,archived,employee_status")
      .in("role", PAID_ROLES)
      .eq("archived", false);
    if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId);
    return query.order("full_name", { ascending: true }).order("id", { ascending: true });
  };
  const result = await fetchAllRows(buildQuery);
  if (result.error) {
    if (isMissing(result.error)) return { available: false, rows: [] };
    throw new Error(result.error.message);
  }
  return {
    available: true,
    rows: (result.data || []).filter((row) => String(row.employee_status || "active").toLowerCase() !== "inactive"),
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "work_schedules", "read");
    if (guard.denied) return guard.denied;

    const supabase = getAdminClient();
    const today = manilaDateKey();
    const data = await loadData(supabase);
    const employees = await loadEmployees(supabase, guard);
    if (!data.available || !employees.available) return NextResponse.json({ available: false, error: NOT_READY });

    const profiles = buildProfiles(data.versions, today);
    const profileByKey = new Map(profiles.map((profile) => [profile.schedule_key, profile]));
    const profileName = (key) => profileByKey.get(key)?.name || "Unknown schedule";

    const levelRows = (level) => data.assignments.filter((row) => row.employee_level === level);
    const levels = LEVEL_VALUES.map((level) => ({ level, label: levelLabel(level), ...assignmentState(levelRows(level), today, profileName) }));
    const levelNow = new Map(levels.map((level) => [level.level, level.current]));

    const branchesResult = await supabase.from("branches").select("id,name");
    const branchName = new Map((branchesResult.data || []).map((branch) => [String(branch.id), branch.name]));
    const config = await loadAttendanceConfig(supabase, [...new Set(employees.rows.map((row) => row.branch_id).filter(Boolean))]);

    // Which of the four sources each employee follows today.
    const followed = (row) => {
      const own = assignmentState(data.assignments.filter((a) => a.employee_id === row.id), today, profileName);
      const usable = (assignment) => {
        const profile = assignment?.schedule_key ? profileByKey.get(assignment.schedule_key) : null;
        return profile && !profile.archived && !profile.starts_on ? profile : null;
      };
      const ownProfile = usable(own.current);
      const levelProfile = !ownProfile && row.employee_level ? usable(levelNow.get(row.employee_level)) : null;
      const profile = ownProfile || levelProfile;
      const branch = resolveAttendancePolicy(config, row.branch_id || null);
      const follows = profile
        ? { source: ownProfile ? "employee" : "level", schedule_key: profile.schedule_key, name: profile.name, work_start: profile.work_start, work_end: profile.work_end, grace: profile.grace_minutes, work_hours: profile.work_hours, working_days_label: profile.working_days_label }
        : { source: branch.source === "branch" ? "branch" : "default", schedule_key: null, name: branch.source === "branch" ? `${branchName.get(String(row.branch_id)) || "Branch"} schedule` : "Default schedule", work_start: branch.work_start, work_end: branch.work_end, grace: branch.grace, work_hours: branch.work_hours, working_days_label: describeWorkingDays([1, 2, 3, 4, 5]) };
      return {
        id: row.id,
        full_name: normalizeText(row.full_name, "Employee"),
        employee_code: row.employee_id || null,
        branch_id: row.branch_id || null,
        branch_name: branchName.get(String(row.branch_id)) || null,
        position: row.position || null,
        employee_level: row.employee_level || null,
        level_label: levelLabel(row.employee_level),
        own: own.current,
        own_upcoming: own.upcoming,
        follows,
      };
    };

    return NextResponse.json({
      available: true,
      today,
      can_edit: can(guard.role, "work_schedules", "update"),
      levels_list: LEVEL_VALUES.map((value) => ({ value, label: levelLabel(value) })),
      profiles,
      levels,
      employees: employees.rows.map(followed),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

const ROLE_LABELS = { super_admin: "Super Admin", hr: "HR" };

/** "by Maria Santos (HR)": who made the change and in what role. */
function byWhom(guard) {
  return `by ${actorName(guard) || "unknown"} (${ROLE_LABELS[guard.role] || guard.role})`;
}

function audit(guard, action, description, metadata, entityType = "work_schedule") {
  return appendAuditLog({
    actor: guard,
    module: "work_schedules",
    action,
    entity_type: entityType,
    entity_id: metadata?.schedule_key || metadata?.level || (metadata?.employee_ids || []).join(",").slice(0, 200) || null,
    // Who, what and when (the entry's own time); the role is also in
    // actor_role and the metadata.
    description: `${description.replace(/\.$/, "")}, ${byWhom(guard)}.`,
    status: "success",
    source: "api",
    metadata: { ...metadata, changed_by_role: guard.role, changed_by_name: actorName(guard) },
  });
}

async function saveSchedule(supabase, guard, body, data) {
  const { value, error } = validateScheduleInput(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const date = checkEffectiveDate(body.effective_from);
  if (date.error) return NextResponse.json({ error: date.error }, { status: 400 });

  const requestedKey = normalizeText(body.schedule_key);
  if (requestedKey && !UUID.test(requestedKey)) return NextResponse.json({ error: "Unknown schedule." }, { status: 400 });
  const existing = requestedKey ? data.versions.filter((row) => row.schedule_key === requestedKey) : [];
  if (requestedKey && !existing.length) return NextResponse.json({ error: "Unknown schedule." }, { status: 404 });

  // Names stay unique among profiles still in use.
  const profiles = buildProfiles(data.versions, manilaDateKey());
  const clash = profiles.find((profile) => profile.schedule_key !== requestedKey && !profile.archived
    && profile.name.toLowerCase() === value.name.toLowerCase());
  if (clash) return NextResponse.json({ error: `A schedule named "${clash.name}" already exists.` }, { status: 409 });

  const scheduleKey = requestedKey || crypto.randomUUID();
  const before = existing.length ? shapeVersion(inForce(existing, date.key) || [...existing].sort(byNewest)[0]) : null;
  const row = {
    schedule_key: scheduleKey,
    ...value,
    effective_from: date.key,
    archived: false,
    note: normalizeText(body.note).slice(0, 500) || null,
    created_by: guard.userId || null,
    created_by_name: actorName(guard),
  };
  const result = await supabase.from("work_schedules").insert(row).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  const after = shapeVersion(result.data);
  await audit(guard, requestedKey ? "schedule_update" : "schedule_create",
    requestedKey
      ? `Work schedule "${after.name}" changed from ${date.key}: ${after.work_start}–${after.work_end}, grace ${after.grace_minutes} min, ${after.work_hours} h, ${after.working_days_label}.`
      : `Work schedule "${after.name}" created from ${date.key}: ${after.work_start}–${after.work_end}, grace ${after.grace_minutes} min, ${after.work_hours} h, ${after.working_days_label}.`,
    { schedule_key: scheduleKey, effective_from: date.key, before, after, note: row.note });
  return NextResponse.json({ success: true, schedule: after });
}

async function archiveSchedule(supabase, guard, body, data) {
  const key = normalizeText(body.schedule_key);
  const rows = data.versions.filter((row) => row.schedule_key === key);
  if (!rows.length) return NextResponse.json({ error: "Unknown schedule." }, { status: 404 });
  const date = checkEffectiveDate(body.effective_from);
  if (date.error) return NextResponse.json({ error: date.error }, { status: 400 });

  // Still followed on or after that date: reassign first.
  const targets = new Map();
  data.assignments.forEach((row) => {
    const target = row.employee_id ? `e:${row.employee_id}` : `l:${row.employee_level}`;
    if (!targets.has(target)) targets.set(target, []);
    targets.get(target).push(row);
  });
  const stillUsed = [...targets.values()].filter((list) => {
    const latest = [...list].sort(byNewest)[0];
    const atDate = inForce(list, date.key);
    return latest?.schedule_key === key || atDate?.schedule_key === key;
  }).length;
  if (stillUsed) {
    return NextResponse.json({ error: `This schedule is still assigned (${stillUsed} employee or level assignment${stillUsed === 1 ? "" : "s"}). Assign another schedule before deleting it.` }, { status: 409 });
  }

  const latest = shapeVersion(inForce(rows, date.key) || [...rows].sort(byNewest)[0]);
  const result = await supabase.from("work_schedules").insert({
    schedule_key: key,
    name: latest.name,
    work_start: latest.work_start,
    work_end: latest.work_end,
    grace_minutes: latest.grace_minutes,
    work_hours: latest.work_hours,
    working_days: latest.working_days,
    effective_from: date.key,
    archived: true,
    note: normalizeText(body.note).slice(0, 500) || null,
    created_by: guard.userId || null,
    created_by_name: actorName(guard),
  });
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
  await audit(guard, "schedule_delete", `Work schedule "${latest.name}" deleted from ${date.key} (kept as history)`, { schedule_key: key, effective_from: date.key, before: latest });
  return NextResponse.json({ success: true });
}

async function assign(supabase, guard, body, data) {
  const date = checkEffectiveDate(body.effective_from);
  if (date.error) return NextResponse.json({ error: date.error }, { status: 400 });
  const key = body.schedule_key ? normalizeText(body.schedule_key) : null;
  const profiles = buildProfiles(data.versions, date.key);
  const profile = key ? profiles.find((p) => p.schedule_key === key) : null;
  if (key) {
    const atDate = inForce(data.versions.filter((row) => row.schedule_key === key), date.key);
    if (!profile || !atDate) return NextResponse.json({ error: "That schedule does not exist yet on the effective date." }, { status: 400 });
    if (atDate.archived) return NextResponse.json({ error: "That schedule is deleted on the effective date." }, { status: 400 });
  }
  const note = normalizeText(body.note).slice(0, 500) || null;
  const base = { schedule_key: key, effective_from: date.key, note, created_by: guard.userId || null, created_by_name: actorName(guard) };
  const scheduleName = profile?.name || "the fallback (level, branch or default schedule)";

  if (body.target === "level") {
    const level = normalizeText(body.level);
    if (!LEVEL_VALUES.includes(level)) return NextResponse.json({ error: "Choose an employee level." }, { status: 400 });
    const before = inForce(data.assignments.filter((row) => row.employee_level === level), date.key);
    const result = await supabase.from("work_schedule_assignments").insert({ ...base, employee_level: level });
    if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
    await audit(guard, "schedule_assign_level",
      `${levelLabel(level)} employees follow ${scheduleName} from ${date.key}.`,
      { level, schedule_key: key, effective_from: date.key, before_schedule_key: before?.schedule_key || null, note });
    return NextResponse.json({ success: true });
  }

  const ids = [...new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).map(normalizeText))].filter((id) => UUID.test(id));
  if (!ids.length) return NextResponse.json({ error: "Choose at least one employee." }, { status: 400 });
  if (ids.length > 500) return NextResponse.json({ error: "Assign at most 500 employees at a time." }, { status: 400 });
  const known = await fetchAllIn(() => supabase.from("profiles").select("id,full_name").in("role", PAID_ROLES).order("id", { ascending: true }), "id", ids);
  if (known.error) throw new Error(known.error.message);
  if ((known.data || []).length !== ids.length) return NextResponse.json({ error: "One of the chosen employees was not found." }, { status: 404 });

  const result = await supabase.from("work_schedule_assignments").insert(ids.map((id) => ({ ...base, employee_id: id })));
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
  const names = (known.data || []).map((row) => row.full_name).join(", ");
  await audit(guard, "schedule_assign_employee",
    `${ids.length === 1 ? names : `${ids.length} employees`} follow${ids.length === 1 ? "s" : ""} ${scheduleName} from ${date.key}.`,
    {
      employee_ids: ids,
      employees: names.slice(0, 2000),
      schedule_key: key,
      effective_from: date.key,
      before: Object.fromEntries(ids.map((id) => [id, inForce(data.assignments.filter((row) => row.employee_id === id), date.key)?.schedule_key || null])),
      note,
    });
  return NextResponse.json({ success: true });
}

async function setLevel(supabase, guard, body) {
  const level = body.level ? normalizeText(body.level) : null;
  if (level && !LEVEL_VALUES.includes(level)) return NextResponse.json({ error: "Choose an employee level." }, { status: 400 });
  const ids = [...new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).map(normalizeText))].filter((id) => UUID.test(id));
  if (!ids.length) return NextResponse.json({ error: "Choose at least one employee." }, { status: 400 });
  if (ids.length > 500) return NextResponse.json({ error: "Change at most 500 employees at a time." }, { status: 400 });

  const before = await fetchAllIn(() => supabase.from("profiles").select("id,full_name,employee_level").in("role", PAID_ROLES).order("id", { ascending: true }), "id", ids);
  if (before.error) throw new Error(before.error.message);
  if ((before.data || []).length !== ids.length) return NextResponse.json({ error: "One of the chosen employees was not found." }, { status: 404 });
  const result = await forEachInChunk(ids, (part) => supabase.from("profiles").update({ employee_level: level }).in("id", part));
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  await audit(guard, "employee_level_update",
    `Employee level set to ${levelLabel(level) || "none"} for ${ids.length === 1 ? before.data[0].full_name : `${ids.length} employees`}.`,
    { employee_ids: ids, level, before: Object.fromEntries((before.data || []).map((row) => [row.id, row.employee_level || null])) },
    "employee");
  return NextResponse.json({ success: true });
}

export async function POST(request) {
  try {
    // "create" on work_schedules: Super Admin and HR only (permissions.js).
    const guard = await requirePermission(request, "work_schedules", "create");
    if (guard.denied) return guard.denied;

    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action).toLowerCase();
    const supabase = getAdminClient();

    if (action === "set_level") return await setLevel(supabase, guard, body);

    const data = await loadData(supabase);
    if (!data.available) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    if (action === "save_schedule") return await saveSchedule(supabase, guard, body, data);
    if (action === "delete_schedule" || action === "archive_schedule") return await archiveSchedule(supabase, guard, body, data);
    if (action === "assign") return await assign(supabase, guard, body, data);
    return NextResponse.json({ error: "Action must be save_schedule, delete_schedule, assign or set_level." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
