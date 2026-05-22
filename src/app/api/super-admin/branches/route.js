import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

function shapeBranch(row) {
  return {
    id: row.id,
    name: normalizeText(row.name),
    location: normalizeText(row.location),
    code: normalizeText(row.code),
    status: normalizeText(row.status, "Active"),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const result = await supabase
      .from("branches")
      .select("*")
      .order("created_at", { ascending: true });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    return NextResponse.json({ branches: (result.data || []).map(shapeBranch) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const name = normalizeText(body.name);
    const location = normalizeText(body.location);
    const code = normalizeText(body.code);
    const status = normalizeText(body.status, "Active");

    if (!name) {
      return NextResponse.json({ error: "Branch name is required." }, { status: 400 });
    }
    if (!location) {
      return NextResponse.json({ error: "Branch location is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const result = await supabase
      .from("branches")
      .insert({ name, location, code: code || null, status, updated_at: new Date().toISOString() })
      .select("*")
      .maybeSingle();

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }

    await appendAuditLog({
      module: "branches",
      action: "create",
      entity_type: "branch",
      entity_id: result.data?.id,
      description: `Branch "${name}" was created.`,
      status: "success",
      source: "api",
      metadata: { name, location, code, status },
    });

    return NextResponse.json({ branch: shapeBranch(result.data) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = normalizeText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Branch id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const existing = await supabase.from("branches").select("*").eq("id", id).maybeSingle();
    if (existing.error || !existing.data) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }

    const name = normalizeText(body.name, existing.data.name);
    const location = normalizeText(body.location, existing.data.location);
    const code = body.code !== undefined ? normalizeText(body.code) : existing.data.code;
    const status = normalizeText(body.status, existing.data.status);

    if (!name) return NextResponse.json({ error: "Branch name is required." }, { status: 400 });
    if (!location) return NextResponse.json({ error: "Branch location is required." }, { status: 400 });

    const result = await supabase
      .from("branches")
      .update({ name, location, code: code || null, status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }

    await appendAuditLog({
      module: "branches",
      action: "update",
      entity_type: "branch",
      entity_id: id,
      description: `Branch "${name}" was updated.`,
      status: "success",
      source: "api",
      metadata: { name, location, code, status },
    });

    return NextResponse.json({ branch: shapeBranch(result.data) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = normalizeText(searchParams.get("id"));

    if (!id) {
      return NextResponse.json({ error: "Branch id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const existing = await supabase.from("branches").select("name").eq("id", id).maybeSingle();
    if (existing.error || !existing.data) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }

    const result = await supabase.from("branches").delete().eq("id", id);
    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }

    await appendAuditLog({
      module: "branches",
      action: "delete",
      entity_type: "branch",
      entity_id: id,
      description: `Branch "${existing.data.name}" was deleted.`,
      status: "success",
      source: "api",
      metadata: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
