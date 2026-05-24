import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const identity = normalizeText(body.identity);

    if (!identity) {
      return NextResponse.json({ error: "Employee ID or email is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const { data: listData, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (listError) {
      throw new Error(listError.message);
    }

    const lower = identity.toLowerCase();
    const user = (listData.users || []).find((u) => {
      const meta = u.user_metadata || {};
      const empId = normalizeText(meta.employee_id).toLowerCase();
      const fullEmail = normalizeText(u.email).toLowerCase();
      const rawEmail = fullEmail.replace(/^sacs\./, "");
      return empId === lower || fullEmail === lower || rawEmail === lower;
    });

    // Always return success to prevent account enumeration
    const genericSuccess = {
      success: true,
      message:
        "If an account exists for this identity, a password reset link has been sent to the registered email address.",
    };

    if (!user) {
      return NextResponse.json(genericSuccess);
    }

    const role = normalizeText(user.user_metadata?.role).toLowerCase();
    if (role === "admin") {
      // Admin accounts cannot use this reset flow
      return NextResponse.json(genericSuccess);
    }

    if (!anonKey) {
      // Without an anon key we cannot trigger the reset email; respond generically.
      return NextResponse.json(genericSuccess);
    }

    const origin = request.headers.get("origin") || "";
    const redirectTo = `${origin}/reset-password`;

    const anonClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await anonClient.auth.resetPasswordForEmail(user.email, { redirectTo });

    return NextResponse.json(genericSuccess);
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
