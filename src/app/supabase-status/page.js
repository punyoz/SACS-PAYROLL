import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SupabaseStatusPage() {
  const hasEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!hasEnv) {
    return (
      <main className="container">
        <section className="card">
          <h2>Supabase Status</h2>
          <p className="muted">Missing env values. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.</p>
        </section>
      </main>
    );
  }

  const supabase = await createClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const { count, error: profileError } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true });

  return (
    <main className="container">
      <section className="card">
        <h2>Supabase Status</h2>
        <p className="muted">Auth check: {userError ? "failed" : "ok"}</p>
        <p className="muted">Current user: {userData?.user?.email || "not signed in"}</p>
        <p className="muted">Profiles count query: {profileError ? profileError.message : String(count ?? 0)}</p>
      </section>
    </main>
  );
}
