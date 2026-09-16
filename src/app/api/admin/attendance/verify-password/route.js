/**
 * POST /api/admin/attendance/verify-password
 *
 * Confirms the signed-in Admin's own password, without creating or changing
 * any session. This is the lock/unlock check for the RFID Terminal
 * (public/legacy/rfid-terminal.html): opening the terminal and leaving it
 * both require the same Admin who opened it to re-type their password, so a
 * kiosk left unattended near the RFID reader cannot be walked away from or
 * closed by anyone else who happens to be at the desk.
 *
 * The account checked is always the one already in the signed session cookie
 * — the request body carries only the password to verify, never an email.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function POST(request) {
  const guard = await requirePermission(request, "attendance", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const email = String(guard.session?.email || "").trim().toLowerCase();
    const password = String(body.password ?? "").trim();

    if (!email) {
      return NextResponse.json({ error: "Unable to identify your account. Please sign in again." }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ error: "Password is required." }, { status: 400 });
    }
    if (!projectUrl || !anonKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const authClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
      email,
      password,
    });
    if (!signInError && signInData?.user) {
      await authClient.auth.signOut();
    }

    const valid = !signInError && signInData?.user?.id === guard.userId;
    return NextResponse.json({ valid });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
