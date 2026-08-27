import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeRole, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";

const roleRoutes = {
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
  hr: "/hr",
};

const ADMIN_USERNAME = normalizeText(process.env.SEED_ADMIN_USERNAME, "sacsadmin").toLowerCase();
const ADMIN_EMAIL = normalizeText(process.env.SEED_ADMIN_EMAIL, "admin@example.com");
const HR_USERNAME = normalizeText(process.env.SEED_HR_USERNAME, "sacshr").toLowerCase();
const HR_EMAIL = normalizeText(process.env.SEED_HR_EMAIL, "hr@example.com");

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function toTitleCaseWords(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferNameFromEmail(email) {
  const raw = normalizeText(email);
  const localPart = raw.includes("@") ? raw.split("@")[0] : raw;
  if (!localPart) return "";

  const cleaned = localPart.replace(/[._-]+/g, " ");
  return toTitleCaseWords(cleaned);
}

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
    return normalizeRoleEmail(ADMIN_EMAIL);
  }

  if (lowered === HR_USERNAME) {
    return normalizeRoleEmail(HR_EMAIL);
  }

  if (lowered.includes("@")) {
    return normalizeRoleEmail(identity);
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

  let profileRow = null;
  if (SERVICE_ROLE_KEY) {
    const adminClient = createClient(url, SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const profileResult = await adminClient
      .from("profiles")
      .select("id,email,full_name,role,employee_id,employee_type,position")
      .eq("id", data.user.id)
      .maybeSingle();

    if (!profileResult.error) {
      profileRow = profileResult.data || null;
    }
  }

  const resolvedEmailOutput = normalizeText(profileRow?.email, normalizeText(data.user.email));
  const resolvedFullName = normalizeText(
    profileRow?.full_name,
    normalizeText(metadata.full_name, inferNameFromEmail(resolvedEmailOutput)),
  );
  const resolvedRole = normalizeRole(profileRow?.role || actualRole);
  const resolvedEmployeeId = normalizeText(profileRow?.employee_id, normalizeText(metadata.employee_id));
  const resolvedEmployeeType = normalizeText(profileRow?.employee_type, normalizeText(metadata.employee_type));
  const resolvedPosition = normalizeText(
    profileRow?.position,
    normalizeText(metadata.position, normalizePositionForRole(metadata.position, resolvedRole)),
  );

  return NextResponse.json({
    redirectTo: roleRoutes[resolvedRole],
    role: resolvedRole,
    profile: {
      role: resolvedRole,
      full_name: resolvedFullName,
      email: resolvedEmailOutput,
      employee_id: resolvedEmployeeId,
      employee_type: resolvedEmployeeType,
      position: resolvedPosition,
      bank_name: normalizeText(metadata.bank_name, ""),
      bank_account_number: normalizeText(metadata.bank_account_number, ""),
    },
  });
}
