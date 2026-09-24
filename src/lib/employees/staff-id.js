/**
 * The ID carried by a Super Admin / Admin / HR account: STAFF-001, STAFF-002...
 *
 * Employees and Accountants have an employee_id (SACS-###, generated in
 * src/app/api/admin/employees/route.js); staff accounts have their own series
 * in profiles.staff_id (supabase/migrations/20260924150000_profiles_staff_id.sql).
 * Kept apart from employee_id because RFID, attendance and payroll match
 * people on employee_id, and a staff login is none of those.
 *
 * Every read of the column tolerates it not existing yet, so the app keeps
 * working until the migration is run -- accounts simply show no ID.
 */

import { STAFF_ROLES } from "@/lib/employees/staff-record";

const STAFF_ID_PATTERN = /^STAFF-(\d+)$/i;

export function isStaffIdRole(role) {
  return STAFF_ROLES.includes(String(role || "").toLowerCase());
}

export function formatStaffId(number) {
  return `STAFF-${String(number).padStart(3, "0")}`;
}

/** Next unused STAFF-### after the highest one already issued. */
export function generateUniqueStaffId(existingIds = []) {
  const used = new Set();
  let max = 0;

  existingIds.forEach((value) => {
    const normalized = String(value || "").trim().toUpperCase();
    if (!normalized) return;
    used.add(normalized);
    const match = STAFF_ID_PATTERN.exec(normalized);
    if (match && Number(match[1]) > max) max = Number(match[1]);
  });

  let next = max + 1;
  while (used.has(formatStaffId(next))) next += 1;
  return formatStaffId(next);
}

/** Every staff_id on file, or null when the column does not exist yet. */
export async function fetchStaffIds(supabase) {
  const { data, error } = await supabase
    .from("profiles")
    .select("staff_id")
    .not("staff_id", "is", null);
  if (error) return null;
  return (data || []).map((row) => row.staff_id);
}

/** Map of profile id -> staff_id for the given ids; empty if the column is missing. */
export async function fetchStaffIdMap(supabase, ids = []) {
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("profiles")
    .select("id,staff_id")
    .in("id", ids);
  if (error) return map;
  (data || []).forEach((row) => {
    if (row.staff_id) map.set(row.id, row.staff_id);
  });
  return map;
}

/**
 * Gives the profile a staff ID if it has none. Retries on a unique-index
 * collision (two accounts created at the same moment). Returns the ID, or ""
 * when the column does not exist yet or every attempt collided.
 */
export async function assignStaffId(supabase, profileId) {
  const { data: current, error: readError } = await supabase
    .from("profiles")
    .select("staff_id")
    .eq("id", profileId)
    .maybeSingle();
  if (readError) return "";
  if (current?.staff_id) return current.staff_id;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await fetchStaffIds(supabase);
    if (!existing) return "";
    const candidate = generateUniqueStaffId(existing);
    const { error } = await supabase
      .from("profiles")
      .update({ staff_id: candidate })
      .eq("id", profileId)
      .is("staff_id", null);
    if (!error) return candidate;
    const collided = String(error.message || "").toLowerCase().includes("staff_id");
    if (!collided) return "";
  }
  return "";
}
