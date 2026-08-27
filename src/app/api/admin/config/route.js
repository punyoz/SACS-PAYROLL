import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

export async function GET() {
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
  try {
    const body = await request.json();
    const section = normalizeText(body.section);
    const fields = body.fields && typeof body.fields === "object" ? body.fields : {};

    if (!section) {
      return NextResponse.json({ error: "section is required." }, { status: 400 });
    }

    const entries = Object.entries(fields);
    if (!entries.length) {
      return NextResponse.json({ error: "No fields provided." }, { status: 400 });
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

    await appendAuditLog({
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
