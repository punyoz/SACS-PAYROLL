// Separated staff are not "missing" after their last day (20261114020000).
// Local stack only; the test employee is restored afterwards.
import { test, expect } from "../support/test.mjs";
import { ACCOUNTS } from "../accounts.mjs";
import { db, profileByEmail } from "../support/db.mjs";

const LAST_DAY = "2026-11-10"; // Tue
const FROM = "2026-11-02";
const TO = "2026-11-13";

test("a separated employee is missing only up to the last day; the close writes nothing after it", async () => {
  const person = await profileByEmail(ACCOUNTS.employee3.email);
  const original = { employee_status: person.employee_status, separated_on: person.separated_on };
  const logsOf = async () => (await db().from("attendance_logs").select("id,log_date,status,time_in,time_out,updated_at").eq("employee_id", person.id).gte("log_date", FROM).lte("log_date", TO).order("log_date")).data || [];
  try {
    const before = await logsOf();
    const upd = await db().from("profiles").update({ employee_status: "Separated", separated_on: LAST_DAY }).eq("id", person.id);
    expect(upd.error).toBeNull();

    const missing = await db().rpc("attendance_missing_days", { p_from: FROM, p_to: TO });
    expect(missing.error).toBeNull();
    const days = missing.data.filter((r) => r.employee_id === person.id).map((r) => r.day);
    expect(days.every((d) => d <= LAST_DAY), `listed only up to ${LAST_DAY}: ${days.join(", ")}`).toBe(true);
    // "Absent today" on a working day after the last day: not listed.
    const after = await db().rpc("attendance_missing_days", { p_from: "2026-11-12", p_to: "2026-11-12" });
    expect(after.data.some((r) => r.employee_id === person.id)).toBe(false);

    const closed = await db().rpc("attendance_close_days", { p_from: FROM, p_to: TO });
    expect(closed.error).toBeNull();
    const now = await logsOf();
    expect(now.filter((l) => l.log_date > LAST_DAY && !before.some((b) => b.id === l.id)), "no Absent record written after the last day").toEqual([]);
    for (const b of before) expect(now.find((l) => l.id === b.id), `record ${b.log_date} unchanged`).toMatchObject({ log_date: b.log_date, status: b.status, time_in: b.time_in, time_out: b.time_out });
    console.log(`  separated ${ACCOUNTS.employee3.email}: missing days listed ${days.length} (all <= ${LAST_DAY}); records before ${before.length}, after close ${now.length}`);
  } finally {
    await db().from("profiles").update(original).eq("id", person.id);
  }
});
