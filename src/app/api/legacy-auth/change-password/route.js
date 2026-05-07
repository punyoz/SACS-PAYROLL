import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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
    const email = normalizeText(body.email);
    const currentPassword = normalizeText(body.current_password);
    const newPassword = normalizeText(body.new_password);

    if (!email || !currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Email, current password, and new password are required." },
        { status: 400 },
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters." },
        { status: 400 },
      );
    }

    if (!projectUrl || !anonKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    // Verify current credentials
    const authClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (signInError || !signInData?.user) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
    }

    const userId = signInData.user.id;
    const role = normalizeText(signInData.user.user_metadata?.role).toLowerCase();

    await authClient.auth.signOut();

    if (role === "admin") {
      return NextResponse.json(
        { error: "Password change is not available for admin accounts via this feature." },
        { status: 403 },
      );
    }

    const adminClient = getAdminClient();
    const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ success: true, message: "Password updated successfully." });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
