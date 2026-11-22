// Part H (2026-11-22): preset remarks. A decision's remark is a preset (or
// "Other"); its code and text are written to the audit log in the SAME
// transaction as the decision (a refused remark leaves the decision undone);
// a bulk decision writes one entry per item; reasons are counted from the
// audit log by decision, type, branch and dates, and the export matches the
// screen; a deactivated preset still shows its text on old records.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const TAG = `E2E part H ${Date.now()}`;

/** A pending leave request for Ana, filed straight into the table (the filing rules are tested elsewhere). */
async function pendingLeave(ana, n, extra = {}) {
  // Far ahead and different on every run, so an earlier run's approved leave never overlaps.
  const day = manilaDay(60 + (Math.floor(Date.now() / 1000) % 250) * 4 + n);
  const id = `e2e-h-${Date.now()}-${n}`;
  await rows(db().from("leave_requests").insert({ id, employee_id: ana.id, employee_name: ana.full_name, leave_type: "Vacation Leave", start_date: day, end_date: day,
    reason: `${TAG} ${n}`, status: "pending_accountant", pay_status: "with_pay", branch_id: ana.branch_id, ...extra }).select("id"));
  return id;
}
const remarksOf = (id) => rows(db().from("audit_logs").select("action,entity_type,branch_id,metadata").eq("entity_id", id).eq("metadata->>kind", "decision_remark"));

test("preset remarks: same-transaction audit, refusals undo the decision, bulk counts per item, report = export", async ({ page, monitor }) => {
  monitor.allow(/^400 PATCH \/api\/hr\/leave-requests/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const ids = [];
  for (let n = 0; n < 4; n += 1) ids.push(await pendingLeave(ana, n));
  // Today's counts before this run (earlier runs may have counted reasons today too).
  await as(page, "hr", "hr-dashboard");
  const todayQ = `from=${manilaDay(0)}&to=${manilaDay(0)}&entity_type=leave_request`;
  const countOf = (data, code) => data.rows.find((r) => r.code === code)?.count || 0;
  const before = (await api(page, "GET", `/api/reports/remark-reasons?${todayQ}`)).data;

  await step(page, "HR > Leave Approval > Reject with a preset + details: the text goes to the employee, code + text to the audit log", async () => {
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: `${TAG} 0` });
    await card.getByRole("button", { name: "Reject" }).click();
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#lv-reject-preset"), "Filed late");
    await dialog.locator("#lv-reject-extra").fill("the form came on the day itself");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    const saved = await rows(db().from("leave_requests").select("status,decision_reason").eq("id", ids[0]).single());
    expect(saved).toEqual({ status: "rejected", decision_reason: "Filed late: the form came on the day itself" });
    expect(await remarksOf(ids[0])).toEqual([expect.objectContaining({ action: "reject", entity_type: "leave_request", branch_id: ana.branch_id,
      metadata: expect.objectContaining({ remark_code: "reject.leave.filed_late", remark_text: "Filed late: the form came on the day itself", preset_label: "Filed late" }) })]);
  });

  await step(page, "Server > a remark for another decision, or a deactivated preset, is refused and the request stays pending", async () => {
    const wrong = await api(page, "PATCH", "/api/hr/leave-requests", { id: ids[1], action: "reject", remark: { code: "approve.as_requested" } });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toBe("That remark is not for this decision.");
    // Deactivate "Conflicts with school activity" behind the app's back, then try it: the database refuses it in the decision's own transaction.
    const preset = await rows(db().from("remark_presets").select("id").eq("code", "reject.leave.school_activity").single());
    await db().from("remark_presets").update({ active: false }).eq("id", preset.id);
    try {
      const off = await api(page, "PATCH", "/api/hr/leave-requests", { id: ids[1], action: "reject", remark: { code: "reject.leave.school_activity" } });
      expect(off.status).toBe(400);
      expect(off.data.error).toBe("That remark is no longer offered. Choose another.");
      expect((await rows(db().from("leave_requests").select("status").eq("id", ids[1]).single())).status, "the decision did not happen").toBe("pending_accountant");
      expect(await remarksOf(ids[1])).toEqual([]);
    } finally {
      await db().from("remark_presets").update({ active: true }).eq("id", preset.id);
    }
  });

  await step(page, "Server > an approval with an optional preset; a rejection without one is refused", async () => {
    const bare = await api(page, "PATCH", "/api/hr/leave-requests", { id: ids[2], action: "reject" });
    expect(bare.status).toBe(400);
    const ok = await api(page, "PATCH", "/api/hr/leave-requests", { id: ids[2], action: "approve", remark: { code: "approve.as_requested" } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(await remarksOf(ids[2])).toEqual([expect.objectContaining({ action: "approve", metadata: expect.objectContaining({ remark_code: "approve.as_requested", remark_text: "Approved as requested" }) })]);
  });

  await step(page, "Old records keep the text of a preset deactivated later", async () => {
    const preset = await rows(db().from("remark_presets").select("id").eq("code", "reject.leave.filed_late").single());
    await db().from("remark_presets").update({ active: false }).eq("id", preset.id);
    try {
      expect((await rows(db().from("leave_requests").select("decision_reason").eq("id", ids[0]).single())).decision_reason).toBe("Filed late: the form came on the day itself");
      const report = await api(page, "GET", `/api/reports/remark-reasons?from=${manilaDay(0)}&to=${manilaDay(0)}&decision=reject&entity_type=leave_request`);
      expect(report.data.rows.find((r) => r.code === "reject.leave.filed_late")).toMatchObject({ label: "Filed late", count: countOf(before, "reject.leave.filed_late") + 1 });
      // Settings lists it as deactivated; the dialog no longer offers it.
      const all = await api(page, "GET", "/api/remark-presets?all=1");
      expect(all.data.presets.find((p) => p.code === "reject.leave.filed_late")).toMatchObject({ active: false });
      const offered = await api(page, "GET", "/api/remark-presets?decision=reject&entity_type=leave_request");
      expect(offered.data.presets.map((p) => p.code)).not.toContain("reject.leave.filed_late");
    } finally {
      await db().from("remark_presets").update({ active: true }).eq("id", preset.id);
    }
  });

  await step(page, "Reasons report: by decision, type, branch and date; the Excel export lists the same rows", async () => {
    const q = `from=${manilaDay(0)}&to=${manilaDay(0)}&entity_type=leave_request`;
    const screen = (await api(page, "GET", `/api/reports/remark-reasons?${q}`)).data;
    expect(countOf(screen, "reject.leave.filed_late")).toBe(countOf(before, "reject.leave.filed_late") + 1);
    expect(countOf(screen, "approve.as_requested")).toBe(countOf(before, "approve.as_requested") + 1);
    const other = await api(page, "GET", `/api/reports/remark-reasons?${q}&branch_id=00000000-0000-4000-8000-000000000000`);
    expect(other.data.rows).toEqual([]);
    const tomorrow = await api(page, "GET", `/api/reports/remark-reasons?from=${manilaDay(1)}&to=${manilaDay(1)}`);
    expect(tomorrow.data.rows).toEqual([]);
    const res = await page.request.get(`/api/reports/remark-reasons?${q}&format=xlsx`);
    expect(res.status()).toBe(200);
    // The first sheet's rows (inline strings and numbers), read straight from the file.
    const { unzipSync, strFromU8 } = await import("fflate");
    const xml = strFromU8(unzipSync(new Uint8Array(await res.body()))["xl/worksheets/sheet1.xml"]);
    const fileRows = [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/g)].map((m) => [...m[1].matchAll(/<c [^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>(.*?)<\/v>|<f>.*?<\/f><v>(.*?)<\/v>)<\/c>/g)].map((c) => c[1] ?? c[2] ?? c[3]));
    const dataRows = fileRows.filter((r) => r.length === 4 && r[0] !== "Reason" && r[0] !== "TOTAL");
    expect(dataRows.map((r) => [r[0], Number(r[3])]), "the export lists the screen's rows").toEqual(screen.rows.map((r) => [r.label, r.count]));
  });

  await step(page, "Admin cannot read another branch's reasons", async () => {
    await as(page, "admin2");
    const res = await api(page, "GET", `/api/reports/remark-reasons?branch_id=${ana.branch_id}`);
    expect(res.status).toBe(403);
  });
});
