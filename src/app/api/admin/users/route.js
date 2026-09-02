import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeRole, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";
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

function shapeUser(user, profile) {
  const metadata = user.user_metadata || {};
  const role = normalizeRole(metadata.role);
  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email)),
    role,
    employee_id: normalizeText(metadata.employee_id, ""),
    archived: Boolean(metadata.archived),
    last_sign_in: user.last_sign_in_at || null,
    created_at: user.created_at || null,
  };
}

async function fetchAllUsers(supabase) {
  const usersResult = await listUsersCached(supabase);
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const users = usersResult.data.users || [];
  const userIds = users.map((u) => u.id);
  const profileMap = new Map();

  if (userIds.length) {
    const profileResult = await supabase
      .from("profiles")
      .select("id,email,full_name,role")
      .in("id", userIds);

    if (!profileResult.error) {
      (profileResult.data || []).forEach((p) => profileMap.set(p.id, p));
    }
  }

  return users
    .map((user) => shapeUser(user, profileMap.get(user.id)))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function GET() {
  try {
    const supabase = getAdminClient();
    const users = await fetchAllUsers(supabase);
    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const role = normalizeRole(body.role);
    const email = normalizeRoleEmail(body.email);
    const fullName = normalizeText(body.full_name);
    const password = normalizeText(body.password);

    if (!email || !fullName || !password) {
      return NextResponse.json(
        { error: "full_name, email, and password are required." },
        { status: 400 },
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 },
      );
    }

    const supabase = getAdminClient();
    const metadata = {
      role,
      full_name: fullName,
      archived: false,
    };

    const createResult = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });

    if (createResult.error) {
      return NextResponse.json({ error: sanitizeError(createResult.error) }, { status: 400 });
    }

    invalidateUsersCache();

    const newUser = createResult.data.user;
    await supabase.from("profiles").upsert(
      { id: newUser.id, email, role, full_name: fullName },
      { onConflict: "id" },
    );

    await appendAuditLog({
      module: "users",
      action: "create",
      entity_type: "user",
      entity_id: newUser.id,
      description: `User ${fullName} (${role}) was created by admin.`,
      status: "success",
      source: "api",
      metadata: { user_id: newUser.id, role, email },
    });

    return NextResponse.json(
      { user: shapeUser(newUser, { email, full_name: fullName, role }) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = normalizeText(body.id);
    const action = normalizeText(body.action, "update").toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "User id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const userResult = await supabase.auth.admin.getUserById(id);
    if (userResult.error || !userResult.data?.user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const existingUser = userResult.data.user;
    const currentMetadata = existingUser.user_metadata || {};
    const nextMetadata = { ...currentMetadata };

    if (action === "archive") {
      nextMetadata.archived = true;
    } else if (action === "restore") {
      nextMetadata.archived = false;
    } else {
      nextMetadata.role = normalizeRole(body.role || currentMetadata.role);
      nextMetadata.full_name = normalizeText(
        body.full_name,
        normalizeText(currentMetadata.full_name, existingUser.email),
      );
    }

    const updatePayload = { user_metadata: nextMetadata };

    if (action === "update") {
      const email = normalizeRoleEmail(normalizeText(body.email, existingUser.email));
      if (email) updatePayload.email = email;
      const password = normalizeText(body.password);
      if (password) {
        if (password.length < 6) {
          return NextResponse.json(
            { error: "Password must be at least 6 characters." },
            { status: 400 },
          );
        }
        updatePayload.password = password;
      }
    }

    const updatedResult = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (updatedResult.error) {
      return NextResponse.json({ error: sanitizeError(updatedResult.error) }, { status: 400 });
    }

    invalidateUsersCache();

    if (action === "update") {
      const email = updatePayload.email || existingUser.email;
      await supabase.from("profiles").upsert(
        { id, email, role: nextMetadata.role, full_name: nextMetadata.full_name },
        { onConflict: "id" },
      );
    }

    const updatedUser = updatedResult.data.user;
    await appendAuditLog({
      module: "users",
      action,
      entity_type: "user",
      entity_id: id,
      description: `User ${nextMetadata.full_name || existingUser.email} was ${action}d by admin.`,
      status: "success",
      source: "api",
      metadata: { user_id: id, role: nextMetadata.role, action },
    });

    return NextResponse.json({
      user: shapeUser(updatedUser, {
        email: updatePayload.email || existingUser.email,
        full_name: nextMetadata.full_name,
        role: nextMetadata.role,
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
