// Part E step 5 (2026-11-23): transfers with an effective date. HR sees the
// system's checks before confirming; a transfer for a later date is approved
// at once but applied that morning by the system (branch, sign-in account,
// active RFID card); today's applies at once, as before.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_NORTH } from "../accounts.mjs";

test("transfer for a later date: checks first; approved now, applied by the system on its date; back today at once", async ({ page, monitor }) => {
  monitor.at("HR > Transfer Requests (effective date)");
  monitor.allow(/^400 POST \/api\/admin\/transfer-requests/, /status of 400/);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const home = bea.branch_id;
  const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single())).id;
  const tomorrow = manilaDay(1);
  await db().from("system_config").update({ value: "false" }).eq("section", "automation").eq("key", "paused");
  await as(page, "hr", "hr-transfers");

  let transferId;
  await step(page, "HR: the system's checks for the move; a past date is refused", async () => {
    const pre = await api(page, "GET", `/api/admin/transfer-requests?precheck=1&employee_id=${bea.id}&to_branch_id=${north}&effective_date=${tomorrow}`);
    expect(pre.status, JSON.stringify(pre.data)).toBe(200);
    expect(pre.data.check).toMatchObject({ decision: "endorse", effective_date: tomorrow, label: expect.stringMatching(/^Recommend endorsing/) });
    const past = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: bea.id, to_branch_id: north, remarks: "E2E past", effective_date: manilaDay(-1) });
    expect(past.status).toBe(400);
  });

  await step(page, "HR transfers Bea from tomorrow: approved now, she has not moved yet", async () => {
    const res = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: bea.id, to_branch_id: north, remarks: "E2E effective tomorrow", effective_date: tomorrow });
    expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
    const [row] = await rows(db().from("transfer_requests").select("id,status,applied_at,effective_date").eq("employee_id", bea.id).eq("remarks", "E2E effective tomorrow"));
    transferId = row.id;
    expect(row).toMatchObject({ status: "approved", applied_at: null, effective_date: tomorrow });
    expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id).toBe(home);
  });

  await step(page, "Its date: the system moves her (branch, sign-in account, active card), logged; once", async () => {
    const { data, error } = await db().rpc("transfer_apply_due", { p_today: tomorrow });
    expect(error).toBeNull();
    expect(data.applied).toBeGreaterThanOrEqual(1);
    expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id).toBe(north);
    const { data: u } = await db().auth.admin.getUserById(bea.id);
    expect(u.user.user_metadata.branch_id).toBe(north);
    const cards = await rows(db().from("rfid_cards").select("branch_id").eq("employee_id", bea.id).eq("status", "active"));
    for (const c of cards) expect(c.branch_id).toBe(north);
    expect((await rows(db().from("transfer_requests").select("applied_at").eq("id", transferId).single())).applied_at).toBeTruthy();
    await db().rpc("transfer_apply_due", { p_today: tomorrow });
    expect(await rows(db().from("automation_actions").select("id").eq("entity_type", "transfer_request_applied").eq("entity_id", transferId))).toHaveLength(1);
  });

  await step(page, "Back home today: applied at once, as before", async () => {
    const back = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: bea.id, to_branch_id: home, remarks: "E2E back today" });
    expect([200, 201], JSON.stringify(back.data)).toContain(back.status);
    expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id).toBe(home);
  });
});
