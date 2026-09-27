import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { SECURITY_SECTION, invalidateSecuritySettings } from "@/lib/auth/security-settings";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

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

    const supabase = getAdminClient();
    const now = new Date().toISOString();

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

    await appendAuditLog({
      actor: guard,
      module: "config",
      action: "update",
      entity_type: "system_config",
      entity_id: section,
      description: `System configuration section "${section}" was updated.`,
      status: "success",
      source: "api",
      metadata: { section, keys: entries.map(([k]) => k) },
    });

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
