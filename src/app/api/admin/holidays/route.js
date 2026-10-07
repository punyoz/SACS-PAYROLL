import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { can, scopeFor, SCOPE_ALL } from "@/lib/rbac/permissions";
import {
  HOLIDAY_NAME_MAX,
  HOLIDAY_TYPE_LABELS,
  describeDayPart,
  isValidDateKey,
  validateHolidayInput,
} from "@/lib/attendance/holidays";
import { manilaDateKey } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

/**
 * Holidays and suspensions (public.attendance_holidays).
 *
 *   GET    ?year=YYYY        the year's holidays, oldest first.
 *          ?upcoming=N       the next N from today (dashboards, calendars).
 *          Anyone who can see attendance may read them.
 *   POST   { holiday_date, name, type, day_part?, cutoff? }   adds one.
 *          { action: "generate", year }   adds the year's holidays fixed by
 *          law or computed (public.attendance_seed_holidays).
 *   DELETE ?date=YYYY-MM-DD  removes one that has not happened yet, or one
 *          added today for today (a mistake caught the same morning). A day
 *          that has passed is kept: attendance and payroll were judged on it.
 *
 * Super Admin (System Configuration) manages every type. HR, which serves
 * every branch's attendance, may add and remove suspensions, from today on,
 * so a typhoon day can be declared the same morning.
 *
 * Adding or removing a day that has already started recomputes that day's
 * attendance records (public.attendance_apply_holiday): an Absent becomes
 * Holiday, and a partial suspension's shorter schedule is applied.
 */

const COLUMNS = "holiday_date,name,type,day_part,cutoff,created_at,created_by_name";

function yearFrom(url) {
  const year = Number(url.searchParams.get("year"));
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : Number(manilaDateKey().slice(0, 4));
}

function shape(row) {
  return {
    ...row,
    holiday_date: String(row.holiday_date).slice(0, 10),
    day_part: row.day_part || "whole",
    cutoff: row.cutoff ? String(row.cutoff).slice(0, 5) : null,
    type_label: HOLIDAY_TYPE_LABELS[row.type] || "Holiday",
    day_part_label: describeDayPart(row),
  };
}

/** What the caller may change: every type (Super Admin) or suspensions only (HR). */
function writeAccess(guard, action) {
  if (can(guard.role, "system_configuration", action)) return "all";
  if (can(guard.role, "attendance", "update") && scopeFor(guard.role, "attendance") === SCOPE_ALL) return "suspension";
  return null;
}

/** "YYYY-MM-DD" Manila date of a timestamp. */
const manilaDayOf = (iso) => (iso ? manilaDateKey(new Date(iso)) : "");

async function applyToDay(supabase, date, guard) {
  if (date > manilaDateKey()) return 0;
  const { data, error } = await supabase.rpc("attendance_apply_holiday", { p_day: date, p_actor: guard.userId || null });
  return error ? 0 : Number(data) || 0;
}

export async function GET(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const url = new URL(request.url);
    const supabase = getAdminClient();
    const today = manilaDateKey();
    const upcoming = Number(url.searchParams.get("upcoming"));

    let query = supabase.from("attendance_holidays").select(COLUMNS).order("holiday_date", { ascending: true });
    let year = null;
    if (Number.isInteger(upcoming) && upcoming > 0) {
      query = query.gte("holiday_date", today).limit(Math.min(upcoming, 20));
    } else {
      year = yearFrom(url);
      query = query.gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);

    return NextResponse.json({
      year,
      today,
      holidays: (result.data || []).map(shape),
      can_manage: writeAccess(guard, "create"),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to load holidays.") }, { status: 500 });
  }
}

async function handleGenerate(supabase, guard, body) {
  if (writeAccess(guard, "create") !== "all") {
    return NextResponse.json({ error: "Only a Super Admin can generate a year's holidays." }, { status: 403 });
  }
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Choose the year to generate." }, { status: 400 });
  }
  const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
  const { data, error } = await supabase.rpc("attendance_seed_holidays", {
    p_year: year,
    p_created_by_name: actorName ? `${actorName} (generated)` : "System (yearly calendar)",
  });
  if (error) return NextResponse.json({ error: sanitizeError(error, "Unable to generate the holidays.") }, { status: 500 });
  const added = Number(data) || 0;

  await appendAuditLog({
    actor: guard,
    module: "system_configuration",
    action: "holiday_generate",
    entity_type: "attendance_holiday",
    entity_id: String(year),
    description: `${year} holidays generated: ${added} added (fixed by law and Holy Week).`,
    status: "success",
    source: "api",
    metadata: { year, added },
  });
  return NextResponse.json({ success: true, year, added });
}

export async function POST(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    if (normalizeText(body.action).toLowerCase() === "generate") return await handleGenerate(supabase, guard, body);

    const access = writeAccess(guard, "create");
    if (!access) return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });

    const input = {
      holiday_date: normalizeText(body.holiday_date),
      name: normalizeText(body.name).slice(0, HOLIDAY_NAME_MAX + 1),
      type: normalizeText(body.type).toLowerCase(),
      day_part: normalizeText(body.day_part, "whole").toLowerCase(),
      cutoff: normalizeText(body.cutoff).slice(0, 5) || null,
    };
    const invalid = validateHolidayInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if (access === "suspension") {
      if (input.type !== "suspension") {
        return NextResponse.json({ error: "HR can add suspensions; holidays are added by a Super Admin." }, { status: 403 });
      }
      if (input.holiday_date < manilaDateKey()) {
        return NextResponse.json({ error: "A suspension can be added for today or a later day." }, { status: 400 });
      }
    }
    if (input.day_part === "whole") input.cutoff = null;

    const existing = await supabase
      .from("attendance_holidays")
      .select("holiday_date,name")
      .eq("holiday_date", input.holiday_date)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      return NextResponse.json({ error: `${input.holiday_date} is already a holiday (${existing.data.name}).` }, { status: 409 });
    }

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const row = {
      holiday_date: input.holiday_date,
      name: input.name,
      type: input.type,
      day_part: input.day_part,
      cutoff: input.cutoff,
      created_by: guard.userId || null,
      created_by_name: actorName || null,
    };
    const inserted = await supabase.from("attendance_holidays").insert(row);
    if (inserted.error) {
      const duplicate = String(inserted.error.code || "") === "23505";
      return NextResponse.json(
        { error: duplicate ? `${input.holiday_date} is already a holiday.` : sanitizeError(inserted.error) },
        { status: duplicate ? 409 : 500 },
      );
    }

    // A day already started: its records are recomputed now (Absent ->
    // Holiday, or the partial suspension's schedule). Payroll never deducts
    // an Absent on a holiday either way.
    const remarked = await applyToDay(supabase, input.holiday_date, guard);
    const label = `${HOLIDAY_TYPE_LABELS[input.type]}${describeDayPart(row) ? `, ${describeDayPart(row).toLowerCase()}` : ""}`;

    await appendAuditLog({
      actor: guard,
      module: "system_configuration",
      action: input.type === "suspension" ? "suspension_add" : "holiday_add",
      entity_type: "attendance_holiday",
      entity_id: input.holiday_date,
      description: `${input.type === "suspension" ? "Suspension" : "Holiday"} added: ${input.name} (${label}), ${input.holiday_date}.`,
      status: "success",
      source: "api",
      metadata: { ...row, remarked_records: remarked },
    });

    return NextResponse.json({ success: true, holiday: shape(row), remarked_records: remarked, absent_records: remarked });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to add the holiday.") }, { status: 500 });
  }
}

export async function DELETE(request) {
  const guard = await requirePermission(request, "attendance", "read");
  if (guard.denied) return guard.denied;

  try {
    const access = writeAccess(guard, "delete");
    if (!access) return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });

    const date = normalizeText(new URL(request.url).searchParams.get("date"));
    if (!isValidDateKey(date)) return NextResponse.json({ error: "Choose the holiday to remove." }, { status: 400 });

    const supabase = getAdminClient();
    const found = await supabase.from("attendance_holidays").select(COLUMNS).eq("holiday_date", date).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
    if (access === "suspension" && found.data.type !== "suspension") {
      return NextResponse.json({ error: "HR can remove suspensions; holidays are removed by a Super Admin." }, { status: 403 });
    }

    const today = manilaDateKey();
    const addedTodayForToday = date === today && manilaDayOf(found.data.created_at) === today;
    if (date < today || (date === today && !addedTodayForToday)) {
      return NextResponse.json(
        { error: "A holiday that has already started is kept: attendance and payroll were judged on it." },
        { status: 409 },
      );
    }

    const removed = await supabase.from("attendance_holidays").delete().eq("holiday_date", date);
    if (removed.error) throw new Error(removed.error.message);
    const remarked = await applyToDay(supabase, date, guard);

    await appendAuditLog({
      actor: guard,
      module: "system_configuration",
      action: found.data.type === "suspension" ? "suspension_remove" : "holiday_remove",
      entity_type: "attendance_holiday",
      entity_id: date,
      description: `${found.data.type === "suspension" ? "Suspension" : "Holiday"} removed: ${found.data.name}, ${date}.`,
      status: "success",
      source: "api",
      metadata: { holiday_date: date, name: found.data.name, type: found.data.type, remarked_records: remarked },
    });

    return NextResponse.json({ success: true, remarked_records: remarked });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to remove the holiday.") }, { status: 500 });
  }
}
