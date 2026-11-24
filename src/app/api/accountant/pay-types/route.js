/**
 * The Accountant's own Additional Pay types (2026-11-26, 20261126040000): name, taxable or not, description.
 *   GET                                   every type (active first), with how many items use it
 *   POST   { name, taxable, description } add one (names are unique, any case)
 *   PATCH  { id, name?, taxable?, description?, active? }  edit, deactivate or reactivate
 *   DELETE ?id=                           only a type no item uses; a used one is deactivated instead
 * Items of a type are filed on Additional Pay (kind "custom") and still wait for HR's approval each.
 * Logged in the audit log.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { payTypeProblem } from "@/lib/payroll/pay-types";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "Additional pay types are not set up yet (apply 20261126040000_additional_pay_types.sql).";
const nameOf = (guard) => guard.session?.full_name || guard.session?.email || guard.role;
const text = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

async function usage(supabase, ids) {
  const out = {};
  if (!ids.length) return out;
  const { data } = await supabase.from("payroll_monthly_incentives").select("pay_type_id").in("pay_type_id", ids);
  for (const r of data || []) out[r.pay_type_id] = (out[r.pay_type_id] || 0) + 1;
  return out;
}

export async function GET(request) {
  const guard = await requirePermission(request, "process_payroll", "read");
  if (guard.denied) return guard.denied;
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("additional_pay_types").select("*").order("active", { ascending: false }).order("name", { ascending: true });
    if (error) return NextResponse.json({ error: /does not exist|schema cache/i.test(error.message) ? NOT_READY : sanitizeError(error), types: [] }, { status: /does not exist|schema cache/i.test(error.message) ? 503 : 500 });
    const used = await usage(supabase, (data || []).map((t) => t.id));
    return NextResponse.json({ types: (data || []).map((t) => ({ ...t, used: used[t.id] || 0 })) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "process_payroll", "create");
  if (guard.denied) return guard.denied;
  try {
    const body = await request.json().catch(() => ({}));
    const row = { name: text(body.name, 61), taxable: body.taxable !== false, description: text(body.description, 301) || null };
    const problem = payTypeProblem(row);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("additional_pay_types")
      .insert({ ...row, created_by: guard.userId, created_by_name: nameOf(guard), updated_by_name: nameOf(guard) }).select("*").single();
    if (error) {
      if (String(error.code) === "23505") return NextResponse.json({ error: `A pay type named "${row.name}" already exists.` }, { status: 409 });
      throw error;
    }
    await appendAuditLog({ actor: guard, module: "payroll", action: "pay_type_add", entity_type: "additional_pay_type", entity_id: data.id, status: "success", source: "api",
      description: `Additional pay type "${data.name}" added (${data.taxable ? "taxable" : "not taxable"}).`, metadata: { name: data.name, taxable: data.taxable } });
    return NextResponse.json({ type: { ...data, used: 0 } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "process_payroll", "update");
  if (guard.denied) return guard.denied;
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a pay type." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: current } = await supabase.from("additional_pay_types").select("*").eq("id", id).maybeSingle();
    if (!current) return NextResponse.json({ error: "Pay type not found." }, { status: 404 });
    const next = {
      name: body.name !== undefined ? text(body.name, 61) : current.name,
      taxable: body.taxable !== undefined ? body.taxable !== false : current.taxable,
      description: body.description !== undefined ? text(body.description, 301) || null : current.description,
      active: body.active !== undefined ? body.active !== false : current.active,
    };
    const problem = payTypeProblem(next);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const { data, error } = await supabase.from("additional_pay_types").update({ ...next, updated_by_name: nameOf(guard), updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
    if (error) {
      if (String(error.code) === "23505") return NextResponse.json({ error: `A pay type named "${next.name}" already exists.` }, { status: 409 });
      throw error;
    }
    const what = current.active !== next.active ? (next.active ? "reactivated" : "deactivated") : "edited";
    await appendAuditLog({ actor: guard, module: "payroll", action: `pay_type_${what === "edited" ? "edit" : what === "deactivated" ? "deactivate" : "reactivate"}`, entity_type: "additional_pay_type", entity_id: id,
      status: "success", source: "api", description: `Additional pay type "${data.name}" ${what}.`, metadata: { before: current, after: next } });
    const used = await usage(supabase, [id]);
    return NextResponse.json({ type: { ...data, used: used[id] || 0 } });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(request) {
  const guard = await requirePermission(request, "process_payroll", "update");
  if (guard.denied) return guard.denied;
  try {
    const id = String(new URL(request.url).searchParams.get("id") || "");
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a pay type." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: current } = await supabase.from("additional_pay_types").select("*").eq("id", id).maybeSingle();
    if (!current) return NextResponse.json({ error: "Pay type not found." }, { status: 404 });
    if ((await usage(supabase, [id]))[id]) {
      return NextResponse.json({ error: `"${current.name}" is used by filed items: deactivate it instead (it stays on their payslips).`, code: "pay_type_used" }, { status: 409 });
    }
    const { error } = await supabase.from("additional_pay_types").delete().eq("id", id);
    if (error) throw error;
    await appendAuditLog({ actor: guard, module: "payroll", action: "pay_type_delete", entity_type: "additional_pay_type", entity_id: id, status: "success", source: "api",
      description: `Additional pay type "${current.name}" deleted (never used).`, metadata: { name: current.name } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
