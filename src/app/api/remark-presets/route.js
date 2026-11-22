/**
 * Preset remarks (Part H, 2026-11-22; 20261122030000).
 *
 *   GET  ?decision=&entity_type=     the active presets for one decision (any staff decider)
 *   GET  ?all=1                      every preset, deactivated too (HR / Super Admin: Settings)
 *   POST  { decision, entity_type, label, sort_order? }               add (HR / Super Admin)
 *   PATCH { id, label?, sort_order?, active? }                        edit, reorder, (de)activate
 *
 * A preset is never deleted: deactivated ones stay readable on old records.
 * The proxy maps this route to "profile" (every staff role has it); the role
 * checks below decide who may change presets.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { appendAuditLog } from "@/lib/audit/store";
import { sanitizeError } from "@/lib/api-error";
import { DECISIONS, readPresets } from "@/lib/remarks/presets";

const DECIDERS = new Set(["hr", "admin", "super_admin", "accountant"]);
const MANAGERS = new Set(["hr", "super_admin"]);
const ENTITY = /^([a-z_]{3,40}|\*)$/;

const staffOnly = (guard) => (DECIDERS.has(guard.role) ? null : NextResponse.json({ error: "Not allowed." }, { status: 403 }));
const managersOnly = (guard) => (MANAGERS.has(guard.role) ? null : NextResponse.json({ error: "Only HR or the Super Admin manage preset remarks." }, { status: 403 }));

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    const refused = staffOnly(guard);
    if (refused) return refused;
    const url = new URL(request.url);
    const supabase = getServiceClient();
    if (url.searchParams.get("all") === "1") {
      const notManager = managersOnly(guard);
      if (notManager) return notManager;
      return NextResponse.json({ presets: await readPresets(supabase, { includeInactive: true }), decisions: DECISIONS });
    }
    const decision = url.searchParams.get("decision") || "";
    const entityType = url.searchParams.get("entity_type") || "";
    if (!DECISIONS.includes(decision) || !ENTITY.test(entityType)) return NextResponse.json({ error: "Choose a decision and type." }, { status: 400 });
    return NextResponse.json({ presets: await readPresets(supabase, { decision, entityType }) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

function checkFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.label !== undefined) {
    const label = String(body.label || "").trim().replace(/\s+/g, " ");
    if (label.length < 3 || label.length > 120) return { error: "The remark is 3 to 120 characters." };
    out.label = label;
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: "The order is a whole number from 0 to 10000." };
    out.sort_order = n;
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  return { fields: out };
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    const refused = managersOnly(guard);
    if (refused) return refused;
    const body = await request.json().catch(() => ({}));
    const decision = String(body.decision || "");
    const entityType = String(body.entity_type || "*");
    if (!DECISIONS.includes(decision)) return NextResponse.json({ error: "Choose the decision." }, { status: 400 });
    if (!ENTITY.test(entityType)) return NextResponse.json({ error: "Choose the type." }, { status: 400 });
    const checked = checkFields(body);
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
    const slug = checked.fields.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "remark";
    const code = `${decision}.${entityType === "*" ? "" : `${entityType}.`}${slug}.${Date.now().toString(36)}`;
    const supabase = getServiceClient();
    const by = guard.session?.full_name || guard.session?.email || guard.role;
    const { data, error } = await supabase.from("remark_presets")
      .insert({ code, decision, entity_type: entityType, sort_order: 100, ...checked.fields, updated_by: by }).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await appendAuditLog({ actor: guard, module: "config", action: "remark_preset_added", entity_type: "remark_preset", entity_id: data.id,
      description: `Preset remark added (${decision}${entityType === "*" ? "" : `, ${entityType}`}): ${data.label}.`, metadata: { code, decision, entity_type: entityType } });
    return NextResponse.json({ preset: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    const refused = managersOnly(guard);
    if (refused) return refused;
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Choose a preset." }, { status: 400 });
    const checked = checkFields(body, { partial: true });
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
    if (!Object.keys(checked.fields).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    const supabase = getServiceClient();
    const by = guard.session?.full_name || guard.session?.email || guard.role;
    const { data, error } = await supabase.from("remark_presets")
      .update({ ...checked.fields, updated_at: new Date().toISOString(), updated_by: by }).eq("id", id).select("*").maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ error: "Preset not found." }, { status: 404 });
    const what = checked.fields.active === false ? "deactivated" : checked.fields.active === true ? "reactivated" : "changed";
    await appendAuditLog({ actor: guard, module: "config", action: "remark_preset_changed", entity_type: "remark_preset", entity_id: id,
      description: `Preset remark ${what}: ${data.label}.`, metadata: { code: data.code, ...checked.fields } });
    return NextResponse.json({ preset: data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
