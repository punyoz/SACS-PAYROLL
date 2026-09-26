// Supabase Edge Function: attendance-nightly
//
// Closes attendance days:
//   * a record with a time in but no time out after its shift ended becomes
//     Incomplete (it is then kept out of payroll until it is resolved);
//   * an active employee with no tap and no approved leave on a working day
//     gets an Absent record, so every absence deduction traces to a log.
//
// All the rules live in the database function public.attendance_close_days()
// (supabase/migrations/20260926010000_attendance_status_engine.sql); this
// function only calls it. The payroll and attendance screens call the same
// function for the days they show, so a missed night never produces a wrong
// payroll -- it only delays the Incomplete queue.
//
// The nightly run itself is a pg_cron job that calls the database function
// directly (supabase/migrations/20260926030000_schedule_attendance_nightly.sql),
// so no key has to be stored in the database. This Edge Function is for
// running it on demand, e.g. to re-close a range of days.
//
// Deploy:   supabase functions deploy attendance-nightly
//
// Body (optional): { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } to re-run a
// range. Default: the last 7 days up to yesterday (Manila).
//
// Requires the service-role key (SUPABASE_SERVICE_ROLE_KEY is provided to
// Edge Functions automatically). Callers must send the same key as a Bearer
// token, so the endpoint cannot be triggered anonymously.

import { createClient } from "npm:@supabase/supabase-js@2";

const DAY_MS = 24 * 60 * 60 * 1000;

function manilaDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

Deno.serve(async (request: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return Response.json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  }

  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const now = new Date();
  const to = isDateKey(body?.to) ? body.to : manilaDateKey(new Date(now.getTime() - DAY_MS));
  const from = isDateKey(body?.from) ? body.from : manilaDateKey(new Date(now.getTime() - 7 * DAY_MS));

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc("attendance_close_days", { p_from: from, p_to: to });
  if (error) {
    return Response.json({ error: error.message, from, to }, { status: 500 });
  }

  return Response.json({ success: true, from, to, result: data });
});
