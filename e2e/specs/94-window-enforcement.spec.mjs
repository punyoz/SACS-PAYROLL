// Processing window enforcement: the Super Admin's testing switch
// (2026-11-06; src/lib/payroll/window-enforcement.js,
// supabase/migrations/20261106090000_payroll_window_enforcement_switch.sql).
//
// Runs on the real date (no time travel). With today = Nov 6, 2026:
//   November 1-15   generation day Mon Nov 16 (Sun 15th -> next working day):
//                   "not_open" -> processing refused while ON
//   October 16-31   window Oct 30 - Nov 3 has closed -> attendance overrides
//                   refused while ON
// Steps follow the user's test list 1-8. Local stack only.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, confirm, manilaDay, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const NOV1 = "November 1-15, 2026";
const OCT2 = "October 16-31, 2026";
const BRANCH = "Main Campus";
const BANNER = "Testing mode: processing window not enforced.";

const banner = (page) => page.getByTestId("testing-mode-banner");
const enforcementCard = (page) => main(page).getByTestId("window-enforcement-section");
const runCard = (page) => main(page).locator("div.rounded-lg.border", { hasText: BRANCH }).filter({ has: page.getByRole("button", { name: /Submit for HR Approval|Resubmit for HR Approval/ }) }).first();

async function enforcementState() {
  const r = await db().rpc("payroll_window_enforcement_state");
  if (r.error) throw new Error(r.error.message);
  return (Array.isArray(r.data) ? r.data[0] : r.data);
}
async function setSwitch(enforced, reason, expires = null) {
  const r = await db().rpc("set_payroll_window_enforcement", { p_enforced: enforced, p_expires_on: expires, p_reason: reason, p_actor: null, p_actor_name: "E2E", p_source: "seed", p_environment: "local" });
  if (r.error) throw new Error(r.error.message);
}
const overrideBody = (employeeId, period, extra = {}) => ({
  action: "save_draft", employee_id: employeeId, pay_period: period,
  deductions: { absences_days: 2, late_days: 0, undertime_minutes: 0, half_days: 0, leave_with_pay_days: 0, leave_without_pay_days: 1 },
  override_reason: "E2E window test: override outside the window",
  ...extra,
});
async function openConfigPayroll(page) {
  await as(page, "super_admin", "sa-config");
  await settle(page);
  await page.getByRole("tab", { name: "Payroll", exact: true }).click();
  await settle(page);
  await enforcementCard(page).scrollIntoViewIfNeeded();
}

test("processing window enforcement: ON blocks, OFF opens own-branch processing, ON again restores", async ({ page, monitor }) => {
  test.setTimeout(30 * 60 * 1000);
  const today = manilaDay(0);
  test.skip(today < "2026-11-04" || today > "2026-11-15", `dates assume today in Nov 4-15, 2026 (today ${today})`);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const carlo = await profileByEmail(ACCOUNTS.employee3.email);
  const accountant = await profileByEmail(ACCOUNTS.accountant.email);
  const auditCount = async () => (await rows(db().from("audit_logs").select("id").eq("action", "payroll_window_enforcement_changed"))).length;
  await setSwitch(true, "E2E 94: start from ON");
  const auditBefore = await auditCount();

  // ── 1. Switch ON: blocked outside the window, as before ─────────────────
  await step(page, "1. ON > Accountant > Process Payroll November 1-15: no banner, generation refused", async () => {
    monitor.at("Accountant > Process Payroll (ON)");
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(NOV1)}`);
    await settle(page);
    await expect(banner(page)).toHaveCount(0);
    await expect(main(page).getByText(/Payslip generation on Nov 16, 2026/).first()).toBeVisible();
    const gen = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: ana.id, pay_period: NOV1 });
    expect(gen.status, JSON.stringify(gen.data)).toBe(403);
    expect(gen.data?.code).toBe("generation_window");
    const batch = await api(page, "POST", "/api/accountant/payroll", { action: "batch_submit", pay_period: NOV1, entries: [{ employee_id: ana.id }] });
    expect(batch.status, JSON.stringify(batch.data)).toBe(403);
  });

  await step(page, "1. ON > Accountant > override on October 16-31 (window closed): refused and logged", async () => {
    const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, OCT2));
    expect(res.status, JSON.stringify(res.data)).toBe(403);
    expect(res.data?.code).toBe("override_outside_window");
    const blocked = await rows(db().from("audit_logs").select("id").eq("action", "attendance_override_blocked").order("created_at", { ascending: false }).limit(1));
    expect(blocked.length).toBe(1);
  });

  // ── 5. Nobody but the Super Admin sees or changes it ─────────────────────
  for (const role of ["accountant", "hr", "admin"]) {
    await step(page, `5. ${role} > GET / POST /api/admin/window-enforcement refused`, async () => {
      await as(page, role);
      const get = await api(page, "GET", "/api/admin/window-enforcement");
      const post = await api(page, "POST", "/api/admin/window-enforcement", { enforced: false, reason: "attempt", confirm: true });
      expect(get.status, `${role} GET`).toBe(403);
      expect(post.status, `${role} POST`).toBe(403);
      await page.goto("/super-admin?page=sa-config");
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.getByTestId("window-enforcement-section")).toHaveCount(0);
      expect((await enforcementState()).enforced).toBe(true);
    });
  }

  // ── 2. Super Admin turns it OFF (local: no production confirmation) ──────
  await step(page, "2. Super Admin > System Configuration > Payroll > reason required, then Turn OFF", async () => {
    monitor.at("Super Admin > System Configuration (OFF)");
    await openConfigPayroll(page);
    await expect(enforcementCard(page).getByText("ON", { exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await enforcementCard(page).getByRole("button", { name: "Turn OFF (testing mode)" }).click();
    await expect(enforcementCard(page).getByText("A reason is required.")).toBeVisible();
    const noReason = await api(page, "POST", "/api/admin/window-enforcement", { enforced: false, reason: "" });
    expect(noReason.status).toBe(400);
    await page.locator("#we-reason").fill("E2E: final defense rehearsal");
    await pickDate(page, page.locator("#we-expires"), manilaDay(25));
    await enforcementCard(page).getByRole("button", { name: "Turn OFF (testing mode)" }).click();
    await expect(enforcementCard(page).getByText("OFF — testing mode")).toBeVisible();
    await expect(banner(page).first()).toContainText(BANNER);
    await refresh(page);
    await expect(banner(page).first()).toContainText(BANNER);
    const state = await enforcementState();
    expect(state.enforced).toBe(false);
    expect(String(state.expires_on).slice(0, 10)).toBe(manilaDay(25));
  });

  // ── 2. Accountant processes a full cutoff outside the window, submits ───
  await step(page, "2. OFF > Accountant > November 1-15: banner, Process payroll for all", async () => {
    monitor.at("Accountant > Process Payroll (OFF)");
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(NOV1)}`);
    await settle(page);
    await expect(banner(page).first()).toContainText(BANNER);
    await main(page).getByTestId("process-all").click();
    await confirm(page, "Process payroll");
    await expect(page.getByText(/Payroll processed for \d+ employee|No payslips processed/).first()).toBeVisible({ timeout: 90000 });
    const entries = await rows(db().from("payroll_entries").select("id,status,created_in_testing_mode,employee_id").eq("pay_period", NOV1));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.created_in_testing_mode === true)).toBe(true);
  });

  await step(page, "6. OFF > Accountant > another branch and own payslip still refused", async () => {
    const other = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: carlo.id, pay_period: OCT2 });
    expect(other.status, JSON.stringify(other.data)).toBeGreaterThanOrEqual(400);
    expect(other.status).toBeLessThan(500);
    const otherOverride = await api(page, "POST", "/api/accountant/payroll", overrideBody(carlo.id, OCT2));
    expect(otherOverride.status).toBeGreaterThanOrEqual(400);
    expect(otherOverride.status).toBeLessThan(500);
    const own = await api(page, "POST", "/api/accountant/payroll", { ...overrideBody(accountant.id, OCT2), basic_salary: 99999 });
    expect(own.status, JSON.stringify(own.data)).toBe(403);
    expect(String(own.data?.error)).toMatch(/your own payroll/i);
  });

  await step(page, "2. OFF > Accountant > Submit for HR Approval", async () => {
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(NOV1)}`);
    await settle(page);
    await runCard(page).getByRole("button", { name: "Submit for HR Approval" }).click();
    const dialog = page.locator('[role="alertdialog"]:visible, [role="dialog"]:visible').last();
    await expect(dialog).toBeVisible();
    // Partial submission still needs the acknowledgment when someone is left out.
    const ack = dialog.getByRole("checkbox");
    if (await ack.count()) await ack.first().check();
    await confirm(page, "Submit for HR Approval");
    await expect(main(page).getByText("Pending HR Approval").first()).toBeVisible();
    const branch = await rows(db().from("branches").select("id").eq("name", BRANCH).single());
    const run = await rows(db().from("payroll_runs").select("status,created_in_testing_mode").eq("branch_id", branch.id).eq("period_label", NOV1).single());
    expect(run.status).toBe("pending");
    expect(run.created_in_testing_mode).toBe(true);
  });

  await step(page, "2. OFF > HR > Payroll Approval: banner, Testing mode badge, Approve", async () => {
    monitor.at("HR > Payroll Approval (OFF)");
    await as(page, "hr", "hr-payroll-approval");
    await settle(page);
    const back = main(page).getByRole("button", { name: "All runs" });
    if (await back.isVisible().catch(() => false)) { await back.click(); await settle(page); }
    await expect(banner(page).first()).toContainText(BANNER);
    await page.getByRole("tab", { name: /Pending HR Approval/ }).click();
    await settle(page);
    const row = main(page).locator("tr", { hasText: NOV1 }).filter({ hasText: BRANCH }).first();
    await expect(row.getByText("Testing mode")).toBeVisible();
    await row.getByRole("button", { name: "Review" }).click();
    await settle(page);
    await main(page).getByRole("button", { name: "Approve", exact: true }).click();
    await page.locator("#pa-remarks").fill("E2E approved in testing mode");
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    const branch = await rows(db().from("branches").select("id").eq("name", BRANCH).single());
    expect((await rows(db().from("payroll_runs").select("status").eq("branch_id", branch.id).eq("period_label", NOV1).single())).status).toBe("approved");
  });

  // ── 3. Overrides and Leave Without Pay outside the window ────────────────
  let snapshot = null;
  await step(page, "3. OFF > Accountant > October 16-31 override + Leave without pay: reason required, saved, logged", async () => {
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(OCT2)}`);
    await settle(page);
    await expect(banner(page).first()).toContainText(BANNER);
    const noReason = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, OCT2, { action: "submit", override_reason: "" }));
    expect(noReason.status, JSON.stringify(noReason.data)).toBeGreaterThanOrEqual(400);
    const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, OCT2));
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const entry = await rows(db().from("payroll_entries").select("payroll,created_in_testing_mode").eq("employee_id", ana.id).eq("pay_period", OCT2).single());
    expect(entry.created_in_testing_mode).toBe(true);
    const text = JSON.stringify(entry.payroll);
    expect(text).toContain("E2E window test: override outside the window");
    expect(text).toMatch(/leave_without_pay/);
    const logged = await rows(db().from("audit_logs").select("id,description").eq("module", "payroll").ilike("description", "%Ana%").order("created_at", { ascending: false }).limit(1));
    expect(logged.length).toBe(1);
    // Payroll approved in testing mode, before turning it back ON.
    snapshot = await rows(db().from("payroll_entries").select("id,payroll,status,updated_at").eq("pay_period", NOV1).order("id"));
  });

  // ── 4. Switch ON again ──────────────────────────────────────────────────
  await step(page, "4. Super Admin > Turn ON with a reason: banner gone", async () => {
    await openConfigPayroll(page);
    await page.locator("#we-reason").fill("E2E: rehearsal finished");
    await enforcementCard(page).getByRole("button", { name: "Turn ON (enforce the window)" }).click();
    await expect(enforcementCard(page).getByText("ON", { exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(main(page).getByTestId("window-enforcement-history")).toContainText("E2E: rehearsal finished");
    expect((await enforcementState()).enforced).toBe(true);
  });

  await step(page, "4. ON > Accountant blocked again; approved November 1-15 unchanged", async () => {
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(OCT2)}`);
    await settle(page);
    await expect(banner(page)).toHaveCount(0);
    const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, OCT2));
    expect(res.status).toBe(403);
    expect(res.data?.code).toBe("override_outside_window");
    const gen = await api(page, "PATCH", "/api/accountant/payroll", { action: "generate", employee_id: ana.id, pay_period: "December 1-15, 2026" });
    expect(gen.status).toBe(403);
    expect(gen.data?.code).toBe("generation_window");
    const after = await rows(db().from("payroll_entries").select("id,payroll,status,updated_at").eq("pay_period", NOV1).order("id"));
    expect(after).toEqual(snapshot);
    // Records from before the test were never marked.
    const oldMarked = await rows(db().from("payroll_entries").select("id").eq("created_in_testing_mode", true).not("pay_period", "in", `("${NOV1}","${OCT2}")`));
    expect(oldMarked.length).toBe(0);
  });

  // ── 7. Audit log has every change ───────────────────────────────────────
  await step(page, "7. Audit log: OFF and ON, with who, old, new and reason", async () => {
    const audit = await rows(db().from("audit_logs").select("description,metadata,actor_id,actor_role,created_at").eq("action", "payroll_window_enforcement_changed").order("created_at", { ascending: true }));
    expect(audit.length).toBe(auditBefore + 2);
    const [off, on] = audit.slice(-2);
    expect(off.actor_role).toBe("super_admin");
    expect(off.actor_id).toBeTruthy();
    expect(off.metadata.old_value.enforced).toBe(true);
    expect(off.metadata.new_value.enforced).toBe(false);
    expect(off.metadata.reason).toBe("E2E: final defense rehearsal");
    expect(on.metadata.new_value.enforced).toBe(true);
    expect(on.metadata.reason).toBe("E2E: rehearsal finished");
    const changes = await rows(db().from("payroll_window_enforcement_changes").select("source,new_enforced,reason").eq("source", "super_admin").order("changed_at"));
    expect(changes.slice(-2).map((c) => c.new_enforced)).toEqual([false, true]);
  });

  // ── 8. Auto-expiry ──────────────────────────────────────────────────────
  await step(page, "8. Auto-expiry: OFF until a date; once the date arrives it reads ON (before the nightly job)", async () => {
    await setSwitch(false, "E2E 94: auto-expiry check", manilaDay(1));
    await as(page, "accountant", `ac-process&period=${encodeURIComponent(NOV1)}`);
    await settle(page);
    await expect(banner(page).first()).toContainText(BANNER);
    // The date arrives: written straight into the row (the database clock
    // cannot be moved), the nightly job has NOT run yet.
    psql(`UPDATE public.payroll_window_enforcement SET expires_on = (now() AT TIME ZONE 'Asia/Manila')::date WHERE id = 1;`);
    const state = await enforcementState();
    expect(state.stored_enforced).toBe(false);
    expect(state.enforced).toBe(true);
    await refresh(page);
    await expect(banner(page)).toHaveCount(0);
    const res = await api(page, "POST", "/api/accountant/payroll", overrideBody(ana.id, OCT2));
    expect(res.status).toBe(403);
    // The nightly job then writes it back ON and logs it.
    expect(psql("SELECT public.payroll_window_auto_expire();")).toBe("t");
    expect((await enforcementState()).stored_enforced).toBe(true);
    const last = await rows(db().from("payroll_window_enforcement_changes").select("source,new_enforced").order("changed_at", { ascending: false }).limit(1));
    expect(last[0]).toMatchObject({ source: "auto_expiry", new_enforced: true });
  });
});
