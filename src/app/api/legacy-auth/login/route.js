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

function resolveLoginEmail(identityInput) {
  const identity = normalizeText(identityInput);

  if (!identity) {
    return "";
  }

  const lowered = identity.toLowerCase();
  
  if (lowered === ADMIN_USERNAME) {
    return normalizeRoleEmail(ADMIN_EMAIL, "admin");
  }

  if (lowered.includes("@")) {
    return normalizeRoleEmail(identity, "employee");
  }

  return "";
}

export async function POST(request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase env values are missing." }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const identityInput = body?.employeeId || body?.username;
  const password = body?.password;

  if (!identityInput || !password) {
    return NextResponse.json({ error: "Login identity and password are required." }, { status: 400 });
  }

  const resolvedEmail = resolveLoginEmail(identityInput);
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

  if (!actualRole || !roleRoutes[normalizeRole(actualRole)]) {
    await supabase.auth.signOut();
    return NextResponse.json(
      {
        error: `Could not determine valid role for account. Role is '${actualRole || "unknown"}'.`,
      },
      { status: 403 },
    );
  }

  await supabase.auth.signOut();

  const metadata = data.user.user_metadata || {};

  return NextResponse.json({
    redirectTo: roleRoutes[normalizeRole(actualRole)],
    role: normalizeRole(actualRole),
    profile: {
      role: normalizeRole(actualRole),
      full_name: normalizeText(metadata.full_name),
      email: normalizeText(data.user.email),
      employee_id: normalizeText(metadata.employee_id),
      position: normalizePositionForRole(metadata.position, actualRole),
    },
  });
}
