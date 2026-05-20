import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeRole, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";

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

function buildEmployeeId(currentCount = 0) {
  const next = currentCount + 1;
  return `SACS-${String(next).padStart(3, "0")}`;
}

function parseEmployeeIdNumber(employeeId) {
  const match = /^SACS-(\d+)$/i.exec(String(employeeId || "").trim());
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
  let candidate = `SACS-${String(next).padStart(3, "0")}`;

  while (used.has(candidate.toUpperCase())) {
    next += 1;
    candidate = `SACS-${String(next).padStart(3, "0")}`;
  }

  return candidate;
}

function normalizePositionForRole(positionInput, roleInput) {
  const role = normalizeRole(roleInput);
  const position = normalizeText(positionInput).toLowerCase();

  if (role === "accountant" || position === "accountant" || position.includes("account")) {
    return "Accountant";
  }

  if (role === "hr" || position === "hr officer" || position.includes("hr officer")) {
    return "HR Officer";
  }

  return "Employee";
}

function toTitleCaseWords(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const ALLOWED_NAME_SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];

function normalizeSuffix(value) {
  return normalizeText(value).slice(0, 16);
}

function stripAllowedSuffix(fullName) {
  const tokens = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  const last = tokens[tokens.length - 1];
  if (ALLOWED_NAME_SUFFIXES.includes(last)) {
    return tokens.slice(0, -1).join(" ");
  }
  return tokens.join(" ");
}

function buildFullNameFromParts(body) {
  const first = toTitleCaseWords(body?.first_name);
  const middle = normalizeText(body?.middle_initial);
  const last = toTitleCaseWords(body?.last_name);
  const suffix = normalizeSuffix(body?.suffix);

  if (first && last) {
    return [first, middle, last, suffix].filter(Boolean).join(" ");
  }

  return normalizeText(body?.full_name);
}

function isValidEmployeeName(nameInput) {
  const withoutSuffix = stripAllowedSuffix(normalizeText(nameInput));
  return withoutSuffix.length > 0 && /^[A-Za-z\s]+$/.test(withoutSuffix);
}

function formatDateOfBirthForPassword(dateInput) {
  const raw = normalizeText(dateInput);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return "";

  const [, year, month, day] = match;
  return `${month}${day}${year}`;
}

function buildDefaultPassword(lastNameInput, dateOfBirthInput) {
  const lastName = toTitleCaseWords(lastNameInput).replace(/\s+/g, "");
  const dobDigits = formatDateOfBirthForPassword(dateOfBirthInput);
  if (!lastName || !dobDigits) return "";

  return `${lastName}${dobDigits}`;
}

function shapeEmployee(user, profile, index) {
  const metadata = user.user_metadata || {};
  const fullName = normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email));
  const role = normalizeRole(metadata.role);
  const employeeStatus = normalizeText(
    metadata.employee_status,
    normalizeText(metadata.rfid_status, "Active"),
  );

  return {
    id: user.id,
    role,
    email: normalizeText(profile?.email, user.email),
    full_name: fullName,
    employee_id: normalizeText(metadata.employee_id, buildEmployeeId(index)),
    employee_type: normalizeText(metadata.employee_type, "Teaching"),
    position: normalizePositionForRole(metadata.position, role),
    basic_salary: Number(metadata.basic_salary || 0),
    rfid_status: normalizeText(metadata.rfid_status, "Active"),
    employee_status: employeeStatus,
    employment_status: normalizeText(metadata.employment_status, "Regular"),
    archived: Boolean(metadata.archived),
    date_of_birth: normalizeText(metadata.date_of_birth, ""),
  };
}

async function fetchEmployees(supabase) {
  const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const employeeUsers = (usersResult.data.users || []).filter((user) => {
    const role = String(user.user_metadata?.role || "employee").toLowerCase();
    return role === "employee" || role === "accountant" || role === "hr";
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
    const email = normalizeRoleEmail(body.email);
    const defaultPassword = buildDefaultPassword(body.last_name, body.date_of_birth);
    const password = normalizeText(body.password, defaultPassword);
    const fullName = buildFullNameFromParts(body);
    const dateOfBirth = normalizeText(body.date_of_birth);

    if (!email || !password || !fullName || !dateOfBirth) {
      return NextResponse.json(
        { error: "full_name, email, and date_of_birth are required." },
        { status: 400 },
      );
    }

    if (!defaultPassword) {
      return NextResponse.json(
        { error: "Default password could not be generated. Check last name and date of birth." },
        { status: 400 },
      );
    }

    if (!isValidEmployeeName(fullName)) {
      return NextResponse.json(
        { error: "Full name must contain letters and spaces only." },
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
      position: normalizePositionForRole(body.position, role),
      basic_salary: Number(body.basic_salary || 0),
      date_of_birth: dateOfBirth,
      rfid_status: normalizeText(body.employee_status, "Active"),
      employee_status: normalizeText(body.employee_status, "Active"),
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

    await appendAuditLog({
      module: "employees",
      action: "create",
      entity_type: "employee",
      entity_id: employee.employee_id,
      description: `Employee ${employee.full_name} was created by admin.`,
      status: "success",
      source: "api",
      metadata: {
        user_id: employee.id,
        role: employee.role,
        employee_type: employee.employee_type,
      },
    });

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

      if (!isValidEmployeeName(nextMetadata.full_name)) {
        return NextResponse.json(
          { error: "Full name must contain letters and spaces only." },
          { status: 400 },
        );
      }

      nextMetadata.employee_id = currentEmployeeId;
      nextMetadata.employee_type = normalizeText(body.employee_type, normalizeText(currentMetadata.employee_type, "Teaching"));
      nextMetadata.position = normalizePositionForRole(body.position, nextRole);
      nextMetadata.basic_salary = Number(body.basic_salary ?? currentMetadata.basic_salary ?? 0);
      nextMetadata.employee_status = normalizeText(
        body.employee_status,
        normalizeText(currentMetadata.employee_status, normalizeText(currentMetadata.rfid_status, "Active")),
      );
      nextMetadata.rfid_status = nextMetadata.employee_status;
      if (body.date_of_birth !== undefined) {
        nextMetadata.date_of_birth = normalizeText(body.date_of_birth, normalizeText(currentMetadata.date_of_birth, ""));
      }
      if (typeof currentMetadata.archived !== "boolean") {
        nextMetadata.archived = false;
      }
    }

    const email = action === "update"
      ? normalizeRoleEmail(normalizeText(body.email, existingUser.email))
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

    const actionLabel = action === "archive"
      ? "archive"
      : action === "restore"
        ? "restore"
        : "update";

    await appendAuditLog({
      module: "employees",
      action: actionLabel,
      entity_type: "employee",
      entity_id: employee.employee_id,
      description: `Employee ${employee.full_name} was ${actionLabel}d by admin.`,
      status: "success",
      source: "api",
      metadata: {
        user_id: employee.id,
        role: employee.role,
        employee_type: employee.employee_type,
        archived: employee.archived,
      },
    });

    return NextResponse.json({ employee });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Employee id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const deleteProfile = await supabase.from("profiles").delete().eq("id", id);
    if (deleteProfile.error) {
      return NextResponse.json({ error: deleteProfile.error.message }, { status: 400 });
    }

    const deleteUser = await supabase.auth.admin.deleteUser(id);
    if (deleteUser.error) {
      return NextResponse.json({ error: deleteUser.error.message }, { status: 400 });
    }

    await appendAuditLog({
      module: "employees",
      action: "delete",
      entity_type: "employee",
      entity_id: id,
      description: "Employee account was deleted by admin.",
      status: "success",
      source: "api",
      metadata: {
        user_id: id,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
