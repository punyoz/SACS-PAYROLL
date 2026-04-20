import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeRole, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";

const roleRoutes = {
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
};

const ADMIN_USERNAME = normalizeText(process.env.SEED_ADMIN_USERNAME, "bncsadmin").toLowerCase();
const ADMIN_EMAIL = normalizeText(process.env.SEED_ADMIN_EMAIL, "bncs.admin@gmail.com");

function normalizePositionForRole(positionInput, roleInput) {
  const role = normalizeRole(roleInput);
  const position = normalizeText(positionInput).toLowerCase();

  if (role === "accountant" || position === "accountant" || position.includes("account")) {
    return "Accountant";
  }

  return "Employee";
}

function resolveLoginEmail(roleInput, identityInput) {
  const role = normalizeRole(roleInput);
  const identity = normalizeText(identityInput);

  if (!identity) {
    return "";
  }

  if (role === "admin") {
    const lowered = identity.toLowerCase();
    if (lowered.includes("@")) {
      return normalizeRoleEmail(identity, role);
    }

    if (lowered === ADMIN_USERNAME) {
      return normalizeRoleEmail(ADMIN_EMAIL, role);
    }

    return "";
  }

  return normalizeRoleEmail(identity, role);
}

export async function POST(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase env values are missing." }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const selectedRole = body?.role;
  const identityInput = body?.employeeId;
  const password = body?.password;

  if (!selectedRole || !roleRoutes[selectedRole]) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  if (!identityInput || !password) {
    return NextResponse.json({ error: "Login identity and password are required." }, { status: 400 });
  }

  const resolvedEmail = resolveLoginEmail(selectedRole, identityInput);
  if (!resolvedEmail) {
    return NextResponse.json({ error: "Use a valid username or email to sign in." }, { status: 400 });
  }

  const supabase = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email: resolvedEmail, password });

  if (error || !data?.user) {
    return NextResponse.json({ error: error?.message || "Invalid login credentials." }, { status: 401 });
  }

  const actualRole = data.user.user_metadata?.role;

  if (!actualRole || normalizeRole(actualRole) !== normalizeRole(selectedRole)) {
    await supabase.auth.signOut();
    return NextResponse.json(
      {
        error: `Role mismatch. Account role is '${actualRole || "unknown"}', selected '${selectedRole}'.`,
      },
      { status: 403 },
    );
  }

  await supabase.auth.signOut();

  const metadata = data.user.user_metadata || {};

  return NextResponse.json({
    redirectTo: roleRoutes[selectedRole],
    profile: {
      role: normalizeRole(metadata.role || selectedRole),
      full_name: normalizeText(metadata.full_name),
      email: normalizeText(data.user.email),
      employee_id: normalizeText(metadata.employee_id),
      position: normalizePositionForRole(metadata.position, metadata.role || selectedRole),
    },
  });
}
