import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { HOLIDAY_NAME_MAX, isValidDateKey, validateHolidayInput } from "@/lib/attendance/holidays";
import { manilaDateKey } from "@/lib/payroll/periods";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

/**
 * Holidays (Super Admin, System Configuration).
 *
 *   GET    ?year=YYYY   the year's holidays, oldest first.
 *   POST   { holiday_date, name, type: "holiday" | "special" }   adds one.
 *   DELETE ?date=YYYY-MM-DD   removes one that has not happened yet. A day
 *          that has passed is kept: attendance and payroll were judged on it.
 *
 * Nobody is marked Absent on a holiday by the nightly close, and payroll
 * never deducts an Absent record dated on one (src/lib/payroll/attendance-pay.js),
 * so a holiday added after the day still stops it being deducted.
 */

const COLUMNS = "holiday_date,name,type,created_at,created_by_name";

function yearFrom(url) {
  const year = Number(url.searchParams.get("year"));
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : Number(manilaDateKey().slice(0, 4));
}

export async function GET(request) {
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;

  try {
    const year = yearFrom(new URL(request.url));
    const supabase = getAdminClient();
    const result = await supabase
      .from("attendance_holidays")
      .select(COLUMNS)
      .gte("holiday_date", `${year}-01-01`)
      .lte("holiday_date", `${year}-12-31`)
      .order("holiday_date", { ascending: true });
    if (result.error) throw new Error(result.error.message);

    return NextResponse.json({
      year,
      today: manilaDateKey(),
      holidays: (result.data || []).map((row) => ({ ...row, holiday_date: String(row.holiday_date).slice(0, 10) })),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to load holidays.") }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "system_configuration", "create");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const input = {
      holiday_date: normalizeText(body.holiday_date),
      name: normalizeText(body.name).slice(0, HOLIDAY_NAME_MAX + 1),
      type: normalizeText(body.type).toLowerCase(),
    };
    const invalid = validateHolidayInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const supabase = getAdminClient();
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

    // Absent records the nightly close already wrote for that day. Payroll
    // no longer deducts them; the count tells the Super Admin they exist.
    const absent = await supabase
      .from("attendance_logs")
      .select("id")
      .eq("log_date", input.holiday_date)
      .eq("status", "Absent")
      .eq("archived_duplicate", false)
      .limit(5000);
    const absentRecords = absent.error ? 0 : (absent.data || []).length;

    await appendAuditLog({
      actor: guard,
      module: "system_configuration",
      action: "holiday_add",
      entity_type: "attendance_holiday",
      entity_id: input.holiday_date,
      description: `Holiday added: ${input.name} (${input.type === "special" ? "Special Non-Working Day" : "Regular Holiday"}), ${input.holiday_date}.`,
      status: "success",
      source: "api",
      metadata: { ...row, absent_records: absentRecords },
    });

    return NextResponse.json({ success: true, holiday: row, absent_records: absentRecords });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to add the holiday.") }, { status: 500 });
  }
}

export async function DELETE(request) {
  const guard = await requirePermission(request, "system_configuration", "delete");
  if (guard.denied) return guard.denied;

  try {
    const date = normalizeText(new URL(request.url).searchParams.get("date"));
    if (!isValidDateKey(date)) return NextResponse.json({ error: "Choose the holiday to remove." }, { status: 400 });
    if (date <= manilaDateKey()) {
      return NextResponse.json(
        { error: "A holiday that has already started is kept: attendance and payroll were judged on it." },
        { status: 409 },
      );
    }

    const supabase = getAdminClient();
    const found = await supabase.from("attendance_holidays").select(COLUMNS).eq("holiday_date", date).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) return NextResponse.json({ error: "Holiday not found." }, { status: 404 });

    const removed = await supabase.from("attendance_holidays").delete().eq("holiday_date", date);
    if (removed.error) throw new Error(removed.error.message);

    await appendAuditLog({
      actor: guard,
      module: "system_configuration",
      action: "holiday_remove",
      entity_type: "attendance_holiday",
      entity_id: date,
      description: `Holiday removed: ${found.data.name}, ${date}.`,
      status: "success",
      source: "api",
      metadata: { holiday_date: date, name: found.data.name, type: found.data.type },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "Unable to remove the holiday.") }, { status: 500 });
  }
}
