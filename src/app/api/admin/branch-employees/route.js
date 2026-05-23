import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BRANCH_TABLES = {
  main: "employees_branch_main",
  "2":  "employees_branch_2",
  "3":  "employees_branch_3",
  "4":  "employees_branch_4",
};

const BRANCH_LABELS = {
  main: "Main Branch",
  "2":  "2nd Branch",
  "3":  "3rd Branch",
  "4":  "4th Branch",
};

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchAllBranchAssignments(supabase) {
  const assignments = {};
  for (const [key, table] of Object.entries(BRANCH_TABLES)) {
    const { data, error } = await supabase
      .from(table)
      .select("user_id, assigned_by, assigned_at");
    if (!error && data) {
      data.forEach((row) => {
        assignments[row.user_id] = {
          branch: key,
          branch_label: BRANCH_LABELS[key],
          assigned_by: row.assigned_by,
          assigned_at: row.assigned_at,
        };
      });
    }
  }
  return assignments;
}

export async function GET() {
  try {
    const supabase = getAdminClient();

    const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersResult.error) throw new Error(usersResult.error.message);

    const employees = (usersResult.data.users || [])
      .filter((u) => {
        const role = String(u.user_metadata?.role || "employee").toLowerCase();
        return role === "employee" || role === "accountant" || role === "hr";
      })
      .filter((u) => !u.user_metadata?.archived)
      .map((u) => ({
        id: u.id,
        employee_id: normalizeText(u.user_metadata?.employee_id),
        full_name: normalizeText(u.user_metadata?.full_name, u.email),
        email: normalizeText(u.email),
        role: normalizeText(u.user_metadata?.role, "employee"),
        employee_type: normalizeText(u.user_metadata?.employee_type, "Teaching"),
        position: normalizeText(u.user_metadata?.position, "Employee"),
        basic_salary: Number(u.user_metadata?.basic_salary || 0),
        employee_status: normalizeText(u.user_metadata?.employee_status, "Active"),
      }));

    const assignments = await fetchAllBranchAssignments(supabase);

    const enriched = employees.map((e) => ({
      ...e,
      branch: assignments[e.id]?.branch || null,
      branch_label: assignments[e.id]?.branch_label || null,
      assigned_by: assignments[e.id]?.assigned_by || null,
      assigned_at: assignments[e.id]?.assigned_at || null,
    }));

    const summary = {
      total: enriched.length,
      unassigned: enriched.filter((e) => !e.branch).length,
      by_branch: Object.fromEntries(
        Object.entries(BRANCH_LABELS).map(([key, label]) => [
          key,
          { label, count: enriched.filter((e) => e.branch === key).length },
        ]),
      ),
    };

    return NextResponse.json({ employees: enriched, summary });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const userId = normalizeText(body.user_id);
    const branch = normalizeText(body.branch).toLowerCase();
    const assignedBy = normalizeText(body.assigned_by, "admin");

    if (!userId || !branch) {
      return NextResponse.json({ error: "user_id and branch are required." }, { status: 400 });
    }
    if (!BRANCH_TABLES[branch]) {
      return NextResponse.json(
        { error: `Invalid branch. Must be one of: ${Object.keys(BRANCH_TABLES).join(", ")}` },
        { status: 400 },
      );
    }

    const supabase = getAdminClient();

    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const user = userData.user;
    const meta = user.user_metadata || {};

    // Remove from all branch tables first (handles reassignment)
    for (const table of Object.values(BRANCH_TABLES)) {
      await supabase.from(table).delete().eq("user_id", userId);
    }

    // Insert into target branch table
    const { error: insertErr } = await supabase.from(BRANCH_TABLES[branch]).insert({
      user_id: userId,
      employee_id: normalizeText(meta.employee_id, ""),
      full_name: normalizeText(meta.full_name, user.email),
      email: normalizeText(user.email),
      role: normalizeText(meta.role, "employee"),
      employee_type: normalizeText(meta.employee_type, "Teaching"),
      position: normalizeText(meta.position, "Employee"),
      basic_salary: Number(meta.basic_salary || 0),
      employee_status: normalizeText(meta.employee_status, "Active"),
      assigned_by: assignedBy,
      assigned_at: new Date().toISOString(),
    });

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 400 });
    }

    await appendAuditLog({
      module: "employees",
      action: "update",
      entity_type: "branch_assignment",
      entity_id: normalizeText(meta.employee_id, userId),
      description: `Employee ${normalizeText(meta.full_name, user.email)} assigned to ${BRANCH_LABELS[branch]} by ${assignedBy}.`,
      status: "success",
      source: "api",
      metadata: { user_id: userId, branch, branch_label: BRANCH_LABELS[branch] },
    });

    return NextResponse.json({ success: true, branch, branch_label: BRANCH_LABELS[branch] });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const userId = normalizeText(body.user_id);

    if (!userId) {
      return NextResponse.json({ error: "user_id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();

    let removed = null;
    for (const [key, table] of Object.entries(BRANCH_TABLES)) {
      const { data } = await supabase
        .from(table)
        .select("user_id, full_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) {
        removed = { branch: key, label: BRANCH_LABELS[key], full_name: data.full_name };
        await supabase.from(table).delete().eq("user_id", userId);
        break;
      }
    }

    if (!removed) {
      return NextResponse.json(
        { error: "Employee is not assigned to any branch." },
        { status: 404 },
      );
    }

    await appendAuditLog({
      module: "employees",
      action: "update",
      entity_type: "branch_assignment",
      entity_id: userId,
      description: `Employee ${removed.full_name} was removed from ${removed.label}.`,
      status: "success",
      source: "api",
      metadata: { user_id: userId, branch: removed.branch },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
