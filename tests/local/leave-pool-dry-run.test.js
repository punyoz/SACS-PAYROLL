// LOCAL ONLY dry run (2026-11-24): every employee's leave credits with the rules on the local copy of live,
// written to $DRY_RUN_OUT. Skipped unless DRY_RUN=1.
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";
import { leaveBalances } from "@/lib/employees/classification-server";
import { localSupabase } from "../../e2e/local-env.mjs";

describe.skipIf(process.env.DRY_RUN !== "1")("leave credits dry run", () => {
  it("writes every on-payroll employee's credits", async () => {
    const s = localSupabase();
    const supabase = createClient(s.url, s.serviceKey, { auth: { persistSession: false } });
    const { data: people } = await supabase.from("profiles").select("id,full_name,employee_id,employment_status,employee_type,date_hired").eq("archived", false).eq("on_payroll", true).order("full_name");
    const b = await leaveBalances(supabase, people.map((p) => p.id), 2026);
    const out = people.map((p) => ({ name: p.full_name, id: p.employee_id, status: p.employment_status, hired: p.date_hired,
      allotment: b[p.id]?.with_pay_allotment, used: b[p.id]?.with_pay_used, remaining: b[p.id]?.with_pay_remaining,
      by_type: Object.fromEntries(Object.entries(b[p.id]?.by_type || {}).map(([t, v]) => [t, `${v.used}/${v.allotment}`])) }));
    writeFileSync(process.env.DRY_RUN_OUT, JSON.stringify(out, null, 1));
  }, 120000);
});
