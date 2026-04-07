import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  return createClient(projectUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeRole(value) {
  const role = normalizeText(value).toLowerCase();
  if (role === "accountant") return "accountant";
  return "employee";
}

function normalizeRoleEmail(emailInput, roleInput) {
  const role = normalizeRole(roleInput);
  const email = normalizeText(emailInput).toLowerCase();
  if (!email) return "";

  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return email;
  }

  if (role === "employee" || role === "accountant") {
    const localPart = email.slice(0, atIndex);
    const domainPart = email.slice(atIndex + 1);
    const normalizedLocalPart = localPart.startsWith("bncs.")
      ? localPart
      : `bncs.${localPart}`;
    return `${normalizedLocalPart}@${domainPart}`;
  }

  return email;
}

function buildEmployeeId(currentCount = 0) {
  const next = currentCount + 1;
  return `BNCS-${String(next).padStart(3, "0")}`;
}

function parseEmployeeIdNumber(employeeId) {
  const match = /^BNCS-(\d+)$/i.exec(String(employeeId || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

function generateUniqueEmployeeId(existingEmployees = []) {
  const used = new Set();
  let max = 0;

  existingEmployees.forEach((employee) => {
    const normalized = normalizeText(employee.employee_id).toUpperCase();
    if (!normalized) return;
    used.add(normalized);

    const parsed = parseEmployeeIdNumber(normalized);
    if (parsed && parsed > max) {
      max = parsed;
    }
  });

  let next = max + 1;
  let candidate = `BNCS-${String(next).padStart(3, "0")}`;

  while (used.has(candidate.toUpperCase())) {
    next += 1;
    candidate = `BNCS-${String(next).padStart(3, "0")}`;
  }

  return candidate;
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};
  const fullName = normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email));
  const role = normalizeRole(metadata.role);

  return {
    id: user.id,
    role,
    email: normalizeText(profile?.email, user.email),
    full_name: fullName,
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizeText(metadata.position, "Staff"),
    basic_salary: Number(metadata.basic_salary || 0),
    rfid_status: normalizeText(metadata.rfid_status, "Active"),
    employment_status: normalizeText(metadata.employment_status, "Regular"),
    archived: Boolean(metadata.archived),
  };
}

async function fetchEmployees(supabase) {
  const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const employeeUsers = (usersResult.data.users || []).filter((user) => {
    const role = String(user.user_metadata?.role || "employee").toLowerCase();
    return role === "employee" || role === "accountant";
  });

  const userIds = employeeUsers.map((user) => user.id);
  const profileMap = new Map();

  if (userIds.length) {
    const profileResult = await supabase
      .from("profiles")
      .select("id,email,full_name,role")
      .in("id", userIds);

    if (profileResult.error) {
      throw new Error(`Failed to fetch profiles: ${profileResult.error.message}`);
    }

    (profileResult.data || []).forEach((profile) => {
      profileMap.set(profile.id, profile);
    });
  }

  return employeeUsers
    .map((user, index) => shapeEmployee(user, profileMap.get(user.id), index))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const employees = await fetchEmployees(supabase);
    return NextResponse.json({ employees });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const role = normalizeRole(body.role);
    const email = normalizeRoleEmail(body.email, role);
    const password = normalizeText(body.password);
    const fullName = normalizeText(body.full_name);

    if (!email || !password || !fullName) {
      return NextResponse.json(
        { error: "full_name, email, and password are required." },
        { status: 400 },
      );
    }

    const supabase = getAdminClient();
    const employeesBefore = await fetchEmployees(supabase);
    const autoEmployeeId = generateUniqueEmployeeId(employeesBefore);

    const metadata = {
      role,
      full_name: fullName,
      employee_id: autoEmployeeId,
      employee_type: normalizeText(body.employee_type, "Teaching"),
      position: normalizeText(body.position, "Staff"),
      basic_salary: Number(body.basic_salary || 0),
      rfid_status: "Active",
      employment_status: "Regular",
      archived: false,
    };

    const createUserResult = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });

    if (createUserResult.error) {
      return NextResponse.json({ error: createUserResult.error.message }, { status: 400 });
    }

    const newUser = createUserResult.data.user;
    const profileResult = await supabase.from("profiles").upsert(
      {
        id: newUser.id,
        email,
        role,
        full_name: fullName,
      },
      {
        onConflict: "id",
      },
    );

    if (profileResult.error) {
      return NextResponse.json({ error: profileResult.error.message }, { status: 400 });
    }

    const employee = shapeEmployee(newUser, {
      id: newUser.id,
      email,
      full_name: fullName,
      role,
    }, employeesBefore.length);

    return NextResponse.json({ employee }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = normalizeText(body.id);
    const action = normalizeText(body.action, "update").toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "Employee id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const listResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });

    if (listResult.error) {
      return NextResponse.json({ error: listResult.error.message }, { status: 400 });
    }

    const existingUser = (listResult.data.users || []).find((user) => user.id === id);
    if (!existingUser) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const currentMetadata = existingUser.user_metadata || {};
    const currentRole = normalizeRole(currentMetadata.role);
    const nextRole = action === "update"
      ? normalizeRole(body.role || currentRole)
      : currentRole;
    const nextMetadata = {
      ...currentMetadata,
      role: nextRole,
    };

    if (action === "archive") {
      nextMetadata.archived = true;
    } else if (action === "restore") {
      nextMetadata.archived = false;
    } else {
      const currentEmployeeId = normalizeText(currentMetadata.employee_id, "");
      if (!currentEmployeeId) {
        return NextResponse.json({ error: "Employee ID is required." }, { status: 400 });
      }

      nextMetadata.full_name = normalizeText(body.full_name, normalizeText(currentMetadata.full_name, existingUser.email));
      nextMetadata.employee_id = currentEmployeeId;
      nextMetadata.employee_type = normalizeText(body.employee_type, normalizeText(currentMetadata.employee_type, "Teaching"));
      nextMetadata.position = normalizeText(body.position, normalizeText(currentMetadata.position, "Staff"));
      nextMetadata.basic_salary = Number(body.basic_salary ?? currentMetadata.basic_salary ?? 0);
      if (typeof currentMetadata.archived !== "boolean") {
        nextMetadata.archived = false;
      }
    }

    const email = action === "update"
      ? normalizeRoleEmail(normalizeText(body.email, existingUser.email), nextRole)
      : existingUser.email;

    const updatePayload = {
      email,
      user_metadata: nextMetadata,
    };

    if (action === "update") {
      const password = normalizeText(body.password);
      if (password) {
        updatePayload.password = password;
      }
    }

    const updatedResult = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (updatedResult.error) {
      return NextResponse.json({ error: updatedResult.error.message }, { status: 400 });
    }

    if (action === "update") {
      const profileResult = await supabase.from("profiles").upsert(
        {
          id,
          email,
          role: nextRole,
          full_name: nextMetadata.full_name,
        },
        {
          onConflict: "id",
        },
      );

      if (profileResult.error) {
        return NextResponse.json({ error: profileResult.error.message }, { status: 400 });
      }
    }

    const updatedUser = updatedResult.data.user;
    const employee = shapeEmployee(updatedUser, {
      id,
      email,
      role: nextRole,
      full_name: nextMetadata.full_name || existingUser.user_metadata?.full_name || existingUser.email,
    }, 0);

    return NextResponse.json({ employee });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
