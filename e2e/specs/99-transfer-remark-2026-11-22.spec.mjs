// Batch 2 (2026-11-22): HR approves / rejects a transfer with a preset remark
// (required to reject), stored as the decision note and audited with the
// decision (Part H's decision_remark_audit).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_NORTH } from "../accounts.mjs";

const remarksOf = (id) => rows(db().from("audit_logs").select("action,entity_type,metadata").eq("entity_id", id).eq("metadata->>kind", "decision_remark"));

test("transfer decisions take a preset remark: required to reject, optional to approve, audited", async ({ page, monitor }) => {
  monitor.allow(/^400 PATCH \/api\/admin\/transfer-requests/, /status of 400/);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const north = await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single());
  const home = bea.branch_id;
  const TAG = `E2E transfer remark ${Date.now()}`;

  await as(page, "hr", "hr-transfers");
  // A pending request as a branch Admin's arrives (HR's own apply at once, 2026-11-09 #8).
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  const pending = async (note) => {
    const [row] = await rows(db().from("transfer_requests").insert({ employee_id: bea.id, from_branch_id: home, to_branch_id: north.id, requested_by: admin.id, status: "pending", remarks: note }).select("id"));
    return row.id;
  };

  await step(page, "HR > Transfer Requests > Reject: no remark refused, then a preset; the note and the audit entry are saved", async () => {
    const id = await pending(`${TAG} reject`);
    expect((await api(page, "PATCH", "/api/admin/transfer-requests", { id, action: "reject" })).status, "no remark refused").toBe(400);
    await page.reload();
    await settle(page);
    const row = main(page).locator("tr", { hasText: `${TAG} reject` });
    await row.getByRole("button", { name: "Reject" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog.getByText("Choose a remark (a reason is required).")).toBeVisible();
    await writeRemark(page, "tr-remark", "the receiving branch is full", { preset: "Not allowed by policy" });
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const saved = await rows(db().from("transfer_requests").select("status,decision_note").eq("id", id).single());
    expect(saved).toEqual({ status: "rejected", decision_note: "Not allowed by policy: the receiving branch is full" });
    expect(await remarksOf(id)).toEqual([expect.objectContaining({ action: "reject", entity_type: "transfer_request", metadata: expect.objectContaining({ remark_code: "reject.policy" }) })]);
    await settle(page);
    await expect(main(page).locator("tr", { hasText: `${TAG} reject` })).toContainText("HR: Not allowed by policy: the receiving branch is full");
  });

  await step(page, "HR > Approve with an optional preset (audited); Bea moves, then back", async () => {
    const id = await pending(`${TAG} approve`);
    const ok = await api(page, "PATCH", "/api/admin/transfer-requests", { id, action: "approve", remark: { code: "approve.as_requested" } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id).toBe(north.id);
    expect(await remarksOf(id)).toEqual([expect.objectContaining({ action: "approve", metadata: expect.objectContaining({ remark_code: "approve.as_requested", remark_text: "Approved as requested" }) })]);
    const back = await api(page, "POST", "/api/admin/transfer-requests", { employee_id: bea.id, to_branch_id: home, remarks: `${TAG} (back)` });
    expect([200, 201]).toContain(back.status);
    expect((await profileByEmail(ACCOUNTS.employee2.email)).branch_id).toBe(home);
  });
});
