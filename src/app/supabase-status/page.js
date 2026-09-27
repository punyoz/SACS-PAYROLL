import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Connectivity diagnostic.
 *
 * This route is NOT in the src/proxy.js matcher, so it never had a session
 * check in front of it — it was reachable by anyone who knew the path, and it
 * printed the raw Postgres/PostgREST error text, which confirms table names and
 * whether RLS is rejecting the anon role. That is free reconnaissance.
 *
 * It is a development aid, so it now simply does not exist in a production
 * build. Adding it to the proxy matcher instead would still expose it to every
 * signed-in employee, which is more access than a diagnostic needs.
 * For a deployed environment use `npm run supabase:check`, which reads the same
 * values from the server without publishing them over HTTP.
 */
export default async function SupabaseStatusPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

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

  // The anon role no longer holds SELECT on any table
  // (20260927040000_manila_log_date_and_anon_reads.sql), so the old profiles
  // count could only ever answer "permission denied". Reachability is checked
  // on endpoints that need no table access instead.
  const [authHealth, restApi] = await Promise.all([
    probe("/auth/v1/health"),
    probe("/rest/v1/"),
  ]);

  return (
    <main className="container">
      <section className="card">
        <h2>Supabase Status</h2>
        <p className="muted">Auth service: {authHealth}</p>
        <p className="muted">Database API: {restApi}</p>
        <p className="muted">Session check: {userError ? "no session" : "ok"}</p>
        <p className="muted">Current user: {userData?.user?.email || "not signed in"}</p>
      </section>
    </main>
  );
}

/** "reachable (HTTP 200)" / "unreachable" for a path on the Supabase project. */
async function probe(path) {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return `reachable (HTTP ${response.status})`;
  } catch {
    return "unreachable";
  }
}
