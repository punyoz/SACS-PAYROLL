import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";

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

function shapeEmployee(user, profile) {
  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(meta.full_name, user.email)),
    employee_id: normalizeText(meta.employee_id),
    role: normalizeText(meta.role, "employee"),
    employee_type: normalizeText(meta.employee_type, "Teaching"),
    position: normalizeText(meta.position, "Employee"),
    employee_status: normalizeText(meta.employee_status, "Active"),
    date_of_birth: normalizeText(meta.date_of_birth),
    archived: Boolean(meta.archived),
    created_at: user.created_at,
    sss_number: normalizeText(meta.sss_number, ""),
    pagibig_number: normalizeText(meta.pagibig_number, ""),
    philhealth_number: normalizeText(meta.philhealth_number, ""),
    bank_name: normalizeText(meta.bank_name, ""),
    bank_account_number: normalizeText(meta.bank_account_number, ""),
  };
}

export async function GET(request) {
  try {
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("archived") === "true";

    const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersResult.error) throw new Error(usersResult.error.message);

    const allUsers = usersResult.data.users || [];
    const employeeUsers = allUsers.filter((u) => {
      const role = String(u.user_metadata?.role || "employee").toLowerCase();
      return role === "employee" || role === "accountant";
    });

    const userIds = employeeUsers.map((u) => u.id);
    const profileMap = new Map();

    if (userIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id,email,full_name,employee_id,employee_type,position,employee_status")
        .in("id", userIds);
      (profiles || []).forEach((p) => profileMap.set(p.id, p));
    }

    let employees = employeeUsers.map((u) => shapeEmployee(u, profileMap.get(u.id)));

    if (!includeArchived) {
      employees = employees.filter((e) => !e.archived);
    }

    employees.sort((a, b) => a.full_name.localeCompare(b.full_name));

    return NextResponse.json({ employees, total: employees.length });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// HR can update employee status and basic info (not salary)
export async function PATCH(request) {
  try {
    const supabase = getAdminClient();
    const body = await request.json();
    const { id, employee_status, position, employee_type } = body;

    if (!id) {
      return NextResponse.json({ error: "Employee id is required." }, { status: 400 });
    }

    const { data: userData, error: fetchErr } = await supabase.auth.admin.getUserById(id);
    if (fetchErr || !userData?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const currentMeta = userData.user.user_metadata || {};
    const updatedMeta = { ...currentMeta };
    if (employee_status !== undefined) updatedMeta.employee_status = normalizeText(employee_status, currentMeta.employee_status);
    if (position !== undefined) updatedMeta.position = normalizeText(position, currentMeta.position);
    if (employee_type !== undefined) updatedMeta.employee_type = normalizeText(employee_type, currentMeta.employee_type);
    if (body.sss_number !== undefined) updatedMeta.sss_number = normalizeText(body.sss_number, normalizeText(currentMeta.sss_number, ""));
    if (body.pagibig_number !== undefined) updatedMeta.pagibig_number = normalizeText(body.pagibig_number, normalizeText(currentMeta.pagibig_number, ""));
    if (body.philhealth_number !== undefined) updatedMeta.philhealth_number = normalizeText(body.philhealth_number, normalizeText(currentMeta.philhealth_number, ""));
    if (body.bank_name !== undefined) updatedMeta.bank_name = normalizeText(body.bank_name, normalizeText(currentMeta.bank_name, ""));
    if (body.bank_account_number !== undefined) updatedMeta.bank_account_number = normalizeText(body.bank_account_number, normalizeText(currentMeta.bank_account_number, ""));

    const { error: updateErr } = await supabase.auth.admin.updateUserById(id, {
      user_metadata: updatedMeta,
    });
    if (updateErr) throw new Error(updateErr.message);

    // Sync profile table
    const profilePatch = {};
    if (employee_type !== undefined) profilePatch.employee_type = normalizeText(employee_type);
    if (position !== undefined) profilePatch.position = normalizeText(position);
    if (Object.keys(profilePatch).length) {
      await supabase.from("profiles").update(profilePatch).eq("id", id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
