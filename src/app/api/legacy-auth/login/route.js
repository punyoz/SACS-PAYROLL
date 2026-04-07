import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const roleRoutes = {
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
};

const ADMIN_USERNAME = "bncsadmin";
const ADMIN_PASSWORD = "admin@0123";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeBncsEmail(emailInput) {
  const email = normalizeText(emailInput).toLowerCase();
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return "";
  }

  const localPart = email.slice(0, atIndex);
  const domainPart = email.slice(atIndex + 1);
  const normalizedLocalPart = localPart.startsWith("bncs.")
    ? localPart
    : `bncs.${localPart}`;

  return `${normalizedLocalPart}@${domainPart}`;
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

  // Admin login is intentionally fixed and does not resolve through Supabase.
  if (selectedRole === "admin") {
    const username = normalizeText(identityInput).toLowerCase();
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Invalid login credentials." }, { status: 401 });
    }

    return NextResponse.json({ redirectTo: roleRoutes.admin });
  }

  if (!identityInput || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const resolvedEmail = normalizeBncsEmail(identityInput);
  if (!resolvedEmail) {
    return NextResponse.json({ error: "Use a valid email address to sign in." }, { status: 400 });
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

  if (!actualRole || actualRole !== selectedRole) {
    await supabase.auth.signOut();
    return NextResponse.json(
      {
        error: `Role mismatch. Account role is '${actualRole || "unknown"}', selected '${selectedRole}'.`,
      },
      { status: 403 },
    );
  }

  await supabase.auth.signOut();

  return NextResponse.json({ redirectTo: roleRoutes[selectedRole] });
}
