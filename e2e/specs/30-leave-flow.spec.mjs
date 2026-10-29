// Leave: the Employee files, the branch Admin recommends, HR decides, the
// Employee sees the result. Also the form's empty / invalid submissions.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm, manilaDay, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const REASON = `E2E family event ${Date.now()}`;

// A real 1×1 PNG padded to ~1 MB (bytes after IEND are ignored when it is
// drawn), so the proof is heavy enough to see who downloads it (cleanup
// 2026-10-29: only HR's Leave Requests list reads the proof document).
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PROOF = { name: "medical-certificate.png", mimeType: "image/png", buffer: Buffer.concat([PNG_1X1, Buffer.alloc(1_000_000)]) };

test("leave: employee files → admin recommends → HR approves → employee sees Approved", async ({ page, monitor }) => {
  const start = manilaDay(10);
  const end = manilaDay(11);

  await step(page, "Employee > Leave > submit the empty form (refused)", async () => {
    monitor.at("Employee > Leave");
    await as(page, "employee", "emp-leave");
    const form = main(page).locator("form").first();
    await form.getByRole("button", { name: /Submit/ }).click();
    await expect(form.getByText("Leave type is required.")).toBeVisible();
    await expect(form.getByText("Reason is required.")).toBeVisible();
  });

  await step(page, "Employee > Leave > file Vacation Leave", async () => {
    const form = main(page).locator("form").first();
    await choose(page, form.getByRole("combobox").first(), "Vacation Leave");
    await pickDate(page, form.getByLabel("Start date"), start);
    await pickDate(page, form.getByLabel("End date"), end);
    await form.getByPlaceholder("State the reason for your leave request").fill(REASON);
    await form.locator('input[type="file"]').setInputFiles(PROOF);
    await form.getByRole("button", { name: /Submit/ }).click();
    await settle(page);
    await expect(main(page).getByRole("cell", { name: REASON })).toBeVisible();
    const emp = await profileByEmail(ACCOUNTS.employee.email);
    const saved = await rows(db().from("leave_requests").select("id,status,start_date,proof_url").eq("employee_id", emp.id).eq("reason", REASON));
    expect(saved, "the leave request reached the database").toHaveLength(1);
    expect(saved[0].proof_url, "the proof document was stored").toMatch(/^data:image\/png;base64,/);
    expect(saved[0].proof_url.length).toBeGreaterThan(1_000_000);
    await refresh(page);
    await expect(main(page).getByRole("cell", { name: REASON })).toBeVisible();
  });

  await step(page, "Employee > Leave > the list's data carries no proof document", async () => {
    const res = await api(page, "GET", "/api/employee/leave-requests");
    expect(res.status).toBe(200);
    const mine = res.data.requests.find((r) => r.reason === REASON);
    expect(mine, "the request is listed").toBeTruthy();
    expect(mine).not.toHaveProperty("proof_url");
    expect(JSON.stringify(res.data).length, "the response is small without the proof").toBeLessThan(100_000);
  });

  await step(page, "Admin > Leave Recommendations > Recommend (endorse)", async () => {
    monitor.at("Admin > Leave Recommendations");
    await as(page, "admin", "adm-leaves");
    const row = main(page).locator("tr", { hasText: "Ana" }).filter({ hasText: "Vacation Leave" }).first();
    await row.getByRole("button", { name: "Recommend" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#ov-note").fill("E2E: coverage arranged, recommend approval");
    await dialog.getByRole("button", { name: "Endorse", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    await expect(main(page).getByText("E2E: coverage arranged, recommend approval")).toBeVisible();
  });

  await step(page, "HR > Leave Approval > sees the recommendation, approves", async () => {
    monitor.at("HR > Leave Approval");
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: REASON });
    await expect(card.getByText(/coverage arranged/)).toBeVisible();

    // HR's list is the one screen that shows the proof.
    await card.getByRole("button", { name: "View proof" }).click();
    const viewer = page.getByRole("dialog", { name: "Proof document" });
    const image = viewer.getByRole("img", { name: "Proof document" });
    await expect(image).toBeVisible();
    expect(await image.evaluate((img) => img.naturalWidth), "the proof image renders").toBe(1);
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    const list = await api(page, "GET", "/api/hr/leave-requests?status=pending");
    expect(list.data.requests.find((r) => r.reason === REASON)?.proof_url).toMatch(/^data:image\/png;base64,/);

    // The dashboard's pending count, without downloading any proof.
    const dashboard = await api(page, "GET", "/api/hr/dashboard");
    const body = JSON.stringify(dashboard.data);
    expect(Number(body.match(/"pending_leaves":(\d+)/)?.[1] || 0)).toBeGreaterThanOrEqual(1);
    expect(body).not.toContain("data:image");

    await card.getByRole("button", { name: "Approve" }).click();
    await confirm(page, "Approve");
    const emp = await profileByEmail(ACCOUNTS.employee.email);
    const saved = await rows(db().from("leave_requests").select("status").eq("employee_id", emp.id).eq("reason", REASON).single());
    expect(saved.status).toBe("approved");
    await refresh(page);
    await expect(main(page).locator("li", { hasText: REASON }), "the decided request left the pending list").toHaveCount(0);
  });

  await step(page, "Admin > Leave Recommendations > Decided tab shows Approved", async () => {
    monitor.at("Admin > Leave Recommendations (decided)");
    await as(page, "admin", "adm-leaves");
    await page.getByRole("tab", { name: "Decided" }).click();
    await settle(page);
    await expect(main(page).locator("tr", { hasText: "Ana" }).filter({ hasText: "Approved" }).first()).toBeVisible();
  });

  await step(page, "Employee > Leave > the request shows Approved", async () => {
    monitor.at("Employee > Leave (after decision)");
    await as(page, "employee", "emp-leave");
    await expect(main(page).locator("tr", { hasText: "Vacation Leave" }).filter({ hasText: "Approved" }).first()).toBeVisible();
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: "Vacation Leave" }).filter({ hasText: "Approved" }).first()).toBeVisible();
  });
});
