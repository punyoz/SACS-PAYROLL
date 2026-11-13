import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { SECURITY_SECTION, invalidateSecuritySettings } from "@/lib/auth/security-settings";
import { ORG_NAME_SECTION, invalidateOrgName } from "@/lib/org-name";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { DUPLICATE_TAP_KEY, duplicateTapSecondsError } from "@/lib/attendance/taps";
import { LEAVE_WITH_PAY_KEY, parseLeaveWithPayDays } from "@/lib/leave-requests/store";
import { BIR_EMPLOYER_KEYS, BIR_EMPLOYER_SECTION, birEmployerErrors, birEmployerStoredValue } from "@/lib/payroll/bir-employer";

/**
 * The sections the Super Admin's System Configuration screen writes:
 * General, Payroll, Security, the default Attendance schedule and each
 * branch's own schedule ("attendance:<branch uuid>", src/lib/attendance/
 * policy.js). Anything else is refused rather than written into the table
 * the security settings and attendance engine read from.
 */
const FIXED_SECTIONS = new Set(["general", "payroll", "security", "attendance"]);
const BRANCH_ATTENDANCE_SECTION = /^attendance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 10_000;

function isAllowedSection(section) {
  return FIXED_SECTIONS.has(section) || BRANCH_ATTENDANCE_SECTION.test(section);
}

function rowsToConfig(rows) {
  const config = {};
  for (const row of rows) {
    const section = normalizeText(row.section);
    const key = normalizeText(row.key);
    if (!section || !key) continue;
    if (!config[section]) config[section] = {};
    config[section][key] = row.value ?? null;
  }
  return config;
}

export async function GET(request) {
  // src/proxy.js already limits this path to System Configuration; checked
  // here too so the route is not guarded by the proxy alone.
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const result = await supabase
      .from("system_config")
      .select("section,key,value,updated_at")
      .order("section")
      .order("key");

    if (result.error) {
      return NextResponse.json({ error: sanitizeError(result.error) }, { status: 500 });
    }

    return NextResponse.json({ config: rowsToConfig(result.data || []) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "system_configuration", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json();
    const section = normalizeText(body.section);
    const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : {};

    if (!section) {
      return NextResponse.json({ error: "section is required." }, { status: 400 });
    }
    if (!isAllowedSection(section)) {
      return NextResponse.json({ error: "Unknown configuration section." }, { status: 400 });
    }

    const entries = Object.entries(fields);
    if (!entries.length) {
      return NextResponse.json({ error: "No fields provided." }, { status: 400 });
    }
    const badKey = entries.find(([key]) => !KEY_PATTERN.test(normalizeText(key)));
    if (badKey) {
      return NextResponse.json({ error: `Invalid setting name: ${String(badKey[0]).slice(0, 64)}` }, { status: 400 });
    }
    const tooLong = entries.find(([, value]) => value !== undefined && value !== null && String(value).length > MAX_VALUE_LENGTH);
    if (tooLong) {
      return NextResponse.json({ error: `Setting ${tooLong[0]} is too long.` }, { status: 400 });
    }

    // The duplicate-tap window (alpha test C1): whole seconds, 3 to 10; the
    // default section only (one setting for every terminal).
    const dupEntry = entries.find(([key]) => normalizeText(key) === DUPLICATE_TAP_KEY);
    if (dupEntry) {
      if (section !== "attendance") return NextResponse.json({ error: "The duplicate tap window is one setting for every branch (default attendance section)." }, { status: 400 });
      const dupError = duplicateTapSecondsError(dupEntry[1]);
      if (dupError) return NextResponse.json({ error: dupError }, { status: 400 });
    }

    // The BIR employer details (General section): the same rules as the boxes
    // (src/lib/payroll/bir-employer.js), so a direct call with letters in a
    // number field, or digits in a name, is refused with a clear message.
    const birEntries = entries.filter(([key]) => BIR_EMPLOYER_KEYS.includes(normalizeText(key)));
    if (birEntries.length) {
      if (section !== BIR_EMPLOYER_SECTION) return NextResponse.json({ error: "The BIR employer details belong to the General section." }, { status: 400 });
      const birErrors = birEmployerErrors(Object.fromEntries(birEntries.map(([key, value]) => [normalizeText(key), value])));
      const firstKey = Object.keys(birErrors)[0];
      if (firstKey) return NextResponse.json({ error: birErrors[firstKey], code: "invalid_bir_employer", field: firstKey, errors: birErrors }, { status: 400 });
      for (const entry of birEntries) entry[1] = birEmployerStoredValue(normalizeText(entry[0]), entry[1]);
    }

    const supabase = getAdminClient();
    const now = new Date().toISOString();

    // Leave with pay per year (2026-11-12): whole days 0 to 30, Payroll
    // section, and a reason; old and new value go to the audit log.
    const leaveEntry = entries.find(([key]) => normalizeText(key) === LEAVE_WITH_PAY_KEY);
    let leaveChange = null;
    if (leaveEntry) {
      if (section !== "payroll") return NextResponse.json({ error: "Leave with pay per year belongs to the Payroll section." }, { status: 400 });
      const days = parseLeaveWithPayDays(leaveEntry[1]);
      if (days === null) return NextResponse.json({ error: "Leave with pay per year: a whole number of days from 0 to 30." }, { status: 400 });
      const reason = normalizeText(body.reason);
      if (reason.length < 5) return NextResponse.json({ error: "Give the reason for the change (at least 5 characters).", code: "reason_required" }, { status: 400 });
      if (reason.length > 300) return NextResponse.json({ error: "The reason can be at most 300 characters." }, { status: 400 });
      const old = await supabase.from("system_config").select("value").eq("section", "payroll").eq("key", LEAVE_WITH_PAY_KEY).maybeSingle();
      leaveEntry[1] = String(days);
      leaveChange = { from: old.data?.value ?? null, to: String(days), reason };
    }

    const upserts = entries.map(([key, value]) => ({
      section,
      key: normalizeText(key),
      value: value !== undefined && value !== null ? String(value) : null,
      updated_at: now,
    }));

    const result = await supabase
      .from("system_config")
      .upsert(upserts, { onConflict: "section,key" })
      .select("section,key,value,updated_at");

    if (result.error) {
      return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
    }
    // Enforced from the next request here; other server instances pick it up
    // within a minute (src/lib/auth/security-settings.js).
    if (section === SECURITY_SECTION) invalidateSecuritySettings();
    if (section === ORG_NAME_SECTION) invalidateOrgName();

    await appendAuditLog({
      actor: guard,
      module: "config",
      action: "update",
      entity_type: "system_config",
      entity_id: section,
      description: `System configuration section "${section}" was updated.`,
      status: "success",
      source: "api",
      metadata: { section, keys: entries.map(([k]) => k), ...(leaveChange ? { leave_with_pay_days: leaveChange } : {}) },
    });
    if (leaveChange) {
      await appendAuditLog({
        actor: guard, module: "config", action: "leave_with_pay_days_changed", entity_type: "system_config", entity_id: `payroll.${LEAVE_WITH_PAY_KEY}`,
        description: `Leave with pay per year changed from ${leaveChange.from ?? "the default"} to ${leaveChange.to} days. Reason: ${leaveChange.reason}`,
        status: "success", source: "api", metadata: leaveChange,
      });
    }

    const allResult = await supabase
      .from("system_config")
      .select("section,key,value,updated_at")
      .order("section")
      .order("key");

    return NextResponse.json({
      config: rowsToConfig(allResult.data || result.data || []),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
