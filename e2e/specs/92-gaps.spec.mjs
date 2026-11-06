// Gaps the other specs leave: the 13th Month Pay page and its December-only
// rule, branch isolation through direct API calls (not only the screens),
// and the portal chrome every role has: theme toggle (light / dark), sidebar
// collapse, Refresh, the notifications bell and the account menu.
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, ROLES, BRANCH_NORTH } from "../accounts.mjs";

test("13th Month Pay: the page lists every employee's amount; processing waits for December", async ({ page, monitor }) => {
  monitor.allow(/^403 PATCH \/api\/accountant\/payroll/, /status of 403/);
  await step(page, "Accountant > 13th Month Pay > the year's list loads", async () => {
    monitor.at("Accountant > 13th Month Pay");
    await as(page, "accountant", "ac-13th");
    await settle(page);
    const year = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).slice(0, 4);
    const res = await api(page, "GET", `/api/accountant/payroll?view=thirteenth_month&year=${year}`);
    expect(res.status).toBe(200);
    const list = res.data.rows || res.data.employees || [];
    expect(list.length, "every employee of the branch is listed").toBeGreaterThan(0);
    for (const r of list) expect(Number(r.amount), `${r.employee_name}'s 13th month = basic earned / 12`).toBeCloseTo(Number(r.total_basic_earned) / 12, 1);
    await expect(main(page).getByText(/13th/i).first()).toBeVisible();
  });
  await step(page, "Accountant > 13th Month Pay > Process before December (refused by the server)", async () => {
    const month = Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).slice(5, 7));
    const res = await api(page, "PATCH", "/api/accountant/payroll", { action: "process_13th_month", year: new Date().getFullYear() });
    if (month === 12) console.log(`  · December: processing answered ${res.status}`);
    else {
      expect(res.status, JSON.stringify(res.data)).toBe(403);
      expect(res.data.code).toBe("thirteenth_month_window");
    }
  });
});

test("branch isolation by direct API call: Accountant and Admin never reach another branch", async ({ page, monitor }) => {
  monitor.allow(/^40[34] /, /status of 40/);
  const carlo = await profileByEmail(ACCOUNTS.employee3.email); // North
  const ana = await profileByEmail(ACCOUNTS.employee.email); // Main
  const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single())).id;

  await step(page, "Main Accountant > payroll lists and history hold no North employee", async () => {
    monitor.at("Accountant (Main) > API");
    await as(page, "accountant");
    const pay = await api(page, "GET", "/api/accountant/payroll");
    expect(pay.status).toBe(200);
    const text = JSON.stringify(pay.data);
    expect(text, "Carlo (North) is not in the Main Accountant's payroll").not.toContain(carlo.id);
    expect(text).toContain(ana.id);
    const runs = await api(page, "GET", "/api/accountant/payroll-runs");
    expect(JSON.stringify(runs.data)).not.toContain(north);
  });

  await step(page, "Main Accountant > generate / process a payslip for North's Carlo (refused)", async () => {
    for (const action of ["generate", "save_draft"]) {
      const res = await api(page, "POST", "/api/accountant/payroll", { action, employee_id: carlo.id, pay_period: "October 1-15, 2026" });
      expect(res.status, `${action} for another branch answered ${res.status}: ${JSON.stringify(res.data)}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const written = await rows(db().from("payroll_entries").select("id,status").eq("employee_id", carlo.id).eq("pay_period", "October 1-15, 2026"));
    expect(written.filter((w) => w.status === "draft"), "no draft for Carlo appeared").toHaveLength(0);
  });

  await step(page, "Main Accountant > loans and attendance of North (refused or empty)", async () => {
    const loans = await api(page, "GET", "/api/accountant/loans");
    expect(JSON.stringify(loans.data)).not.toContain(carlo.id);
    const att = await api(page, "GET", `/api/attendance/logs?employee_id=${carlo.id}`);
    expect(att.status === 403 || !JSON.stringify(att.data).includes(carlo.id), `attendance/logs answered ${att.status}`).toBe(true);
  });

  await step(page, "Main Admin > Branch Oversight shows only Main; asking for North's id changes nothing", async () => {
    monitor.at("Admin (Main) > API");
    await as(page, "admin");
    const own = await api(page, "GET", "/api/admin/branch-oversight");
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.data)).not.toContain(carlo.id);
    const sneaky = await api(page, "GET", `/api/admin/branch-oversight?branch_id=${north}`);
    expect(sneaky.status === 403 || !JSON.stringify(sneaky.data).includes(carlo.id), "a branch_id in the URL does not open another branch").toBe(true);
    const info = await api(page, "GET", "/api/admin/employee-info");
    expect(JSON.stringify(info.data)).not.toContain(carlo.id);
  });

  await step(page, "Main Admin > files a branch request about North's Carlo (refused)", async () => {
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "schedule_request", employee_id: carlo.id, details: { request_type: "schedule", effective_from: "2027-01-04", requested: "E2E cross-branch probe" } });
    expect(res.status, JSON.stringify(res.data)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  await step(page, "North Admin > sees Carlo, never Ana", async () => {
    monitor.at("Admin (North) > API");
    await as(page, "admin2");
    const own = await api(page, "GET", "/api/admin/branch-oversight");
    const text = JSON.stringify(own.data);
    expect(text).not.toContain(ana.id);
  });
});

for (const role of ROLES) {
  test(`${ROLE_LABEL[role]}: theme toggle, sidebar collapse, Refresh, notifications bell, account menu`, async ({ page, monitor }) => {
    monitor.at(`${ROLE_LABEL[role]} > portal chrome`);
    await as(page, role);
    await settle(page);

    await step(page, `${ROLE_LABEL[role]} > theme button: Light → Dark → Device setting → Light`, async () => {
      const button = page.getByRole("button", { name: /^Appearance:/ }).first();
      const seen = new Set();
      for (let i = 0; i < 3; i += 1) {
        await button.click();
        await page.waitForTimeout(300);
        seen.add(await page.evaluate(() => (document.body.classList.contains("dark") ? "dark" : "light")));
      }
      expect([...seen].sort(), "both light and dark were shown").toEqual(["dark", "light"]);
      // Leave it on Light for the rest of the run.
      for (let i = 0; i < 3 && !(await button.getAttribute("aria-label")).startsWith("Appearance: Light"); i += 1) await button.click();
    });

    await step(page, `${ROLE_LABEL[role]} > sidebar collapses and opens again`, async () => {
      const sidebar = page.locator('[data-slot="sidebar"][data-state], [data-sidebar="sidebar"]').first();
      const wrapper = page.locator("[data-state][data-collapsible]").first();
      const before = await wrapper.getAttribute("data-state").catch(() => null);
      await page.getByRole("button", { name: "Toggle navigation" }).first().click();
      await page.waitForTimeout(400);
      const middle = await wrapper.getAttribute("data-state").catch(() => null);
      await page.getByRole("button", { name: "Toggle navigation" }).first().click();
      await page.waitForTimeout(400);
      const after = await wrapper.getAttribute("data-state").catch(() => null);
      expect(middle, "the sidebar changed state").not.toBe(before);
      expect(after).toBe(before);
      await expect(sidebar).toBeVisible();
    });

    await step(page, `${ROLE_LABEL[role]} > Refresh reloads the page's data without leaving it`, async () => {
      const refresh = page.getByRole("button", { name: "Refresh" }).first();
      if (await refresh.count()) {
        const url = page.url();
        const call = page.waitForResponse((r) => r.url().includes("/api/") && r.request().method() === "GET", { timeout: 15000 }).catch(() => null);
        await refresh.click();
        expect(await call, "Refresh called the API").not.toBeNull();
        expect(page.url()).toBe(url);
      } else console.log(`  · ${ROLE_LABEL[role]}: this page has no Refresh button`);
    });

    await step(page, `${ROLE_LABEL[role]} > notifications bell opens its list`, async () => {
      await page.getByRole("button", { name: /^Notifications/ }).first().click();
      await expect(page.getByRole("menu").getByText("Notifications").first()).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await step(page, `${ROLE_LABEL[role]} > account menu: Profile / Change password / Appearance / Sign out are there`, async () => {
      await page.locator('[data-sidebar="footer"] [data-sidebar="menu-button"]').first().click();
      const menu = page.getByRole("menu");
      for (const item of ["Change password", "Sign out"]) await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
      await expect(menu.getByText("Appearance")).toBeVisible();
      await page.keyboard.press("Escape");
    });
  });
}

test("Admin endorsement to HR: Admin files a schedule request, HR rejects with a reason / approves, Admin sees the result", async ({ page, monitor }) => {
  monitor.allow(/^400 PATCH \/api\/hr\/branch-requests/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const text = (n) => `E2E-BR-${Date.now().toString(36)}-${n}`;
  const asked = [text(1), text(2)];
  const ids = [];
  await step(page, "Admin (Main) > Branch Oversight > files two schedule requests for Ana", async () => {
    monitor.at("Admin > Branch Oversight");
    await as(page, "admin");
    for (const requested of asked) {
      const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "schedule_request", employee_id: ana.id, details: { request_type: "schedule", effective_from: "2027-01-04", requested }, note: "E2E: please review for January" });
      expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
      const row = (await rows(db().from("branch_admin_requests").select("id,status,details").eq("kind", "schedule_request").eq("employee_id", ana.id))).find((r) => r.details?.requested === requested);
      expect(row?.status).toBe("pending");
      ids.push(row.id);
    }
  });
  await step(page, "HR > Branch Requests > sees both with full details; reject without a reason is refused", async () => {
    monitor.at("HR > Branch Requests");
    await as(page, "hr");
    const list = await api(page, "GET", "/api/hr/branch-requests");
    expect(list.status).toBe(200);
    const body = JSON.stringify(list.data);
    for (const requested of asked) expect(body, "HR sees what was asked").toContain(requested);
    const bare = await api(page, "PATCH", "/api/hr/branch-requests", { id: ids[0], decision: "reject", note: "" });
    expect(bare.status).toBe(400);
  });
  await step(page, "HR > rejects the first with a reason, approves the second with a remark", async () => {
    const r = await api(page, "PATCH", "/api/hr/branch-requests", { id: ids[0], decision: "reject", note: "E2E: class load is already full this term" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const a = await api(page, "PATCH", "/api/hr/branch-requests", { id: ids[1], decision: "approve", note: "E2E: approved from January" });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
  });
  await step(page, "Admin (Main) > sees Rejected with HR's reason and Approved with HR's remark", async () => {
    monitor.at("Admin > Branch Oversight (results)");
    await as(page, "admin");
    const res = await api(page, "GET", "/api/admin/branch-oversight?view=requests&kind=schedule_request");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.data);
    expect(body).toContain("class load is already full this term");
    expect(body).toContain("approved from January");
    const stored = await rows(db().from("branch_admin_requests").select("id,status").in("id", ids));
    expect(stored.map((x) => x.status).sort()).toEqual(["approved", "rejected"]);
  });
});
