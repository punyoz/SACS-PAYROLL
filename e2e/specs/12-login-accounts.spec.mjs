// Phase 2: signing in and accounts, against the local stack only.
//  - who may create which accounts (Super Admin: Super Admin / Admin / HR;
//    HR: Accountant / Employee; Admin: none), duplicates and bad input;
//  - each new account signs in (password + planted emailed code), is made to
//    replace its issued password, and sees only its own portal;
//  - a new Admin's branch kiosk: unlocked by that Admin's password, it takes
//    its own branch's cards and refuses another branch's;
//  - wrong password, wrong code, expired code, lock-outs, logout, an expired
//    or tampered session, password reset and password change;
//  - deactivate (archive) and reactivate, and an archived user cannot sign in.
// Only throwaway accounts made here are locked out or get new passwords.
// The real Gmail → inbox path is NOT tested (no mail is sent locally).
import crypto from "node:crypto";
import { test, expect } from "../support/test.mjs";
import { as, signOutLocally, waitForPortal } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { archiveTestAccount, db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, TEST_OTP, TEST_SESSION_SECRET, BRANCH_MAIN, BRANCH_NORTH } from "../accounts.mjs";

const stamp = Date.now().toString(36).slice(-5);
const letters = stamp.replace(/\d/g, (d) => "abcdefghij"[d]);
const Tag = letters.charAt(0).toUpperCase() + letters.slice(1);
const branchId = async (name) => (await rows(db().from("branches").select("id").eq("name", name).single())).id;

const NEW = {
  admin: { email: `new.admin.${stamp}@e2e.test`, first: "Nora", last: `Admin${Tag}`, dob: "1988-04-05" },
  hr: { email: `new.hr.${stamp}@e2e.test`, first: "Hugo", last: `Officer${Tag}`, dob: "1990-02-03" },
  accountant: { email: `new.acct.${stamp}@e2e.test`, first: "Celia", last: `Ledger${Tag}`, dob: "1991-07-08" },
  employee: { email: `new.emp.${stamp}@e2e.test`, first: "Dina", last: `Torres${Tag}`, dob: "1995-09-10" },
};
const ISSUED_PASSWORD = "Issued-Temp#2026";
const FINAL_PASSWORD = "Chosen-Pass#2026";
const RESET_PASSWORD = "After-Reset#2026";
const CHANGED_PASSWORD = "After-Change#2026";
const DINA_CARD = `55${String(Date.now()).slice(-8)}`;

function staffBody(who, role, branch) {
  return {
    first_name: who.first, last_name: who.last, email: who.email, role, branch_id: branch, employee_status: "Active",
    date_of_birth: who.dob, date_hired: "2024-01-01", sex: "Female", civil_status: "Single", cp_number: "09171234560",
    address: "12 Rizal St, Pasig City", emergency_contact_name: "Maria Probe", emergency_contact_relationship: "Parent",
    emergency_contact_number: "09181234560", emergency_contact_address: "45 Rizal Ave, Pasig City",
  };
}

function employeeBody(who, role, branch, overrides = {}) {
  return {
    first_name: who.first, last_name: who.last, email: who.email, role, branch_id: branch, password: ISSUED_PASSWORD,
    employee_type: role === "accountant" ? "Non-Teaching" : "Teaching", position: role === "accountant" ? "Accountant" : "Teacher",
    employment_type: "Full-time", employment_status: "Probationary", employee_status: "Active", date_hired: "2026-06-01",
    basic_salary: 20000, date_of_birth: who.dob, sex: "Female", civil_status: "Single", address: "12 Mabini St, Pasig City",
    cp_number: `0917${String(Date.now()).slice(-7)}`, sss_number: "1234567890", philhealth_number: "123456789012",
    pagibig_number: "123456789012", tin_number: "123456789", emergency_contact_name: "Rosa Torres",
    emergency_contact_relationship: "Parent", emergency_contact_address: "12 Mabini St, Pasig City",
    emergency_contact_number: "09181234567", ...overrides,
  };
}

/** Store a known emailed code (as src/lib/auth/email-otp.js does), with its own lifetime. */
async function plantCode(userId, purpose = "login", ttlSeconds = 300) {
  const key = `${purpose}:${userId}`;
  const hash = crypto.createHmac("sha256", TEST_SESSION_SECRET).update(`email-otp:${key}:${TEST_OTP}`).digest("base64url");
  await db().rpc("auth_email_otp_discard", { p_key: key });
  const issued = await db().rpc("auth_email_otp_issue", { p_key: key, p_hash: hash, p_ttl_seconds: ttlSeconds, p_cooldown_seconds: 60, p_max_attempts: 5 });
  if (issued.error) throw new Error(`plant code: ${issued.error.message}`);
}

/** Clear the database-side sign-in counters for one throwaway email (the shared IP budget stays small). */
function clearThrottle(email) {
  psql(`DELETE FROM public.auth_throttle WHERE key ILIKE '%${email.replace(/'/g, "")}%';`);
}

async function typePassword(page, login, password) {
  await page.goto("/login");
  await page.locator("#login-identity").waitFor();
  for (let i = 0; i < 5; i += 1) {
    await page.fill("#login-identity", login);
    await page.fill("#login-password", password);
    if ((await page.inputValue("#login-identity")) === login && (await page.inputValue("#login-password")) === password) break;
    await page.waitForTimeout(300);
  }
  const res = page.waitForResponse((r) => r.url().includes("/api/legacy-auth/login"), { timeout: 30000 });
  await page.locator("form button[type=submit]").first().click();
  return res;
}

/** Password, then the planted code, through the real screens. */
async function signInAs(page, email, password) {
  const profile = await profileByEmail(email);
  await plantCode(profile.id);
  const res = await typePassword(page, email, password);
  expect(res.status(), `sign-in of ${email}`).toBe(200);
  await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
  await page.locator("#login-code").click();
  await page.keyboard.type(TEST_OTP, { delay: 60 });
}

async function sidebarText(page) {
  // Work groups are collapsible (2026-11-09): open every group, then read the menu.
  const closed = page.locator('[data-nav-group] button[aria-expanded="false"]');
  for (let i = 0; i < 12 && (await closed.count().catch(() => 0)); i += 1) await closed.first().click().catch(() => null);
  return (await page.locator('[data-sidebar="sidebar"]').first().innerText().catch(() => "")).replace(/\s+/g, " ");
}

test.describe.configure({ mode: "serial" });

// The accounts made here leave the branches' headcount as seeded for later specs.
test.afterAll(async () => {
  for (const who of Object.values(NEW)) await archiveTestAccount(who.email);
});

test("accounts: who may create whom, duplicates and bad input", async ({ page, monitor }) => {
  monitor.allow(/^40[0-9] POST \/api\/admin\/(staff-accounts|employees)/, /status of 40/);
  const main_ = await branchId(BRANCH_MAIN);
  const north = await branchId(BRANCH_NORTH);

  await step(page, "Admin > tries to create an employee and a staff account (refused: Admin creates no accounts)", async () => {
    monitor.at("Admin > account creation (refused)");
    await as(page, "admin");
    const a = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, email: `x1.${stamp}@e2e.test` }, "employee", main_));
    const b = await api(page, "POST", "/api/admin/staff-accounts", staffBody({ ...NEW.hr, email: `x2.${stamp}@e2e.test` }, "hr", null));
    expect(a.status, JSON.stringify(a.data)).toBe(403);
    expect(b.status, JSON.stringify(b.data)).toBe(403);
  });

  await step(page, "HR > tries to create an Admin and an HR account (refused: HR makes Accountant and Employee only)", async () => {
    monitor.at("HR > account creation (refused)");
    await as(page, "hr", "hr-employees");
    const a = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.admin, email: `x3.${stamp}@e2e.test` }, "admin", main_));
    const b = await api(page, "POST", "/api/admin/staff-accounts", staffBody({ ...NEW.hr, email: `x4.${stamp}@e2e.test` }, "hr", null));
    expect(a.status, JSON.stringify(a.data)).toBe(403);
    expect(b.status, JSON.stringify(b.data)).toBe(403);
  });

  await step(page, `HR > creates Accountant ${NEW.accountant.first} (Main) and Employee ${NEW.employee.first} (North)`, async () => {
    const acct = await api(page, "POST", "/api/admin/employees", employeeBody(NEW.accountant, "accountant", main_));
    expect(acct.status, JSON.stringify(acct.data)).toBe(201);
    const emp = await api(page, "POST", "/api/admin/employees", employeeBody(NEW.employee, "employee", north));
    expect(emp.status, JSON.stringify(emp.data)).toBe(201);
    const a = await profileByEmail(NEW.accountant.email);
    const e = await profileByEmail(NEW.employee.email);
    expect(a.role).toBe("accountant");
    expect(e.branch_id).toBe(north);
    expect(a.employee_id && e.employee_id && a.employee_id !== e.employee_id, "each gets its own Employee ID").toBe(true);
  });

  await step(page, "HR > same email again (refused) and the same name + birth date (asks to confirm a duplicate)", async () => {
    const sameEmail = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, first: "Other", last: `Person${Tag}` }, "employee", north));
    expect([400, 409], JSON.stringify(sameEmail.data)).toContain(sameEmail.status);
    const twin = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, email: `twin.${stamp}@e2e.test` }, "employee", north));
    expect(twin.status, JSON.stringify(twin.data)).toBe(409);
    expect(twin.data.code).toBe("possible_duplicate");
    const count = await rows(db().from("profiles").select("id").ilike("email", `%${stamp}@e2e.test`));
    expect(count.length, "no extra account was made").toBe(2);
  });

  await step(page, "HR > invalid input: no last name, letters in the contact number, a 2-character address (all refused)", async () => {
    const noLast = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, last: "", email: `bad1.${stamp}@e2e.test` }, "employee", north));
    const badPhone = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, email: `bad2.${stamp}@e2e.test` }, "employee", north, { cp_number: "0917abc4567" }));
    const badAddr = await api(page, "POST", "/api/admin/employees", employeeBody({ ...NEW.employee, email: `bad3.${stamp}@e2e.test` }, "employee", north, { address: "ab" }));
    for (const r of [noLast, badPhone, badAddr]) expect(r.status, JSON.stringify(r.data)).toBe(400);
  });

  await step(page, "Super Admin > creates Admin Nora (North branch) and HR Hugo", async () => {
    monitor.at("Super Admin > Admin & HR Accounts");
    await as(page, "super_admin");
    const admin = await api(page, "POST", "/api/admin/staff-accounts", staffBody(NEW.admin, "admin", north));
    expect([200, 201], JSON.stringify(admin.data)).toContain(admin.status);
    expect(admin.data.temporary_password, "the issued password is shown once").toBeTruthy();
    NEW.admin.issued = admin.data.temporary_password;
    const hr = await api(page, "POST", "/api/admin/staff-accounts", staffBody(NEW.hr, "hr", null));
    expect([200, 201], JSON.stringify(hr.data)).toContain(hr.status);
    NEW.hr.issued = hr.data.temporary_password;
    const again = await api(page, "POST", "/api/admin/staff-accounts", staffBody(NEW.hr, "hr", null));
    expect(again.status, "the same email twice is refused").toBeGreaterThanOrEqual(400);
    expect((await profileByEmail(NEW.admin.email)).branch_id).toBe(north);
  });

  await step(page, "Super Admin > User oversight lists the new Admin and HR", async () => {
    const list = await api(page, "GET", "/api/admin/users");
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.data);
    expect(text).toContain(NEW.admin.email);
    expect(text).toContain(NEW.hr.email);
  });
});

test("new accounts: first sign-in replaces the issued password; each sees only its own portal", async ({ page, monitor }) => {
  const cases = [
    ["admin", NEW.admin, () => NEW.admin.issued, "/admin", { has: ["Dashboard"], not: ["Process Payroll", "Payroll Approval", "System Configuration"] }],
    ["hr", NEW.hr, () => NEW.hr.issued, "/hr", { has: ["Payroll Approval"], not: ["Process Payroll", "System Configuration"] }],
    ["accountant", NEW.accountant, () => ISSUED_PASSWORD, "/accountant", { has: ["Process Payroll"], not: ["Payroll Approval", "System Configuration"] }],
    ["employee", NEW.employee, () => ISSUED_PASSWORD, "/employee", { has: ["Payslips"], not: ["Process Payroll", "Payroll Approval"] }],
  ];
  for (const [role, who, issued, portal, menu] of cases) {
    await step(page, `New ${role} ${who.first} > sign in with the issued password + code > must choose a new password`, async () => {
      monitor.at(`New ${role} > first sign-in`);
      await signOutLocally(page);
      await signInAs(page, who.email, issued());
      await page.locator("#cp-current").waitFor({ timeout: 60000 });
      await page.fill("#cp-current", issued());
      await page.fill("#cp-new", FINAL_PASSWORD);
      await page.fill("#cp-confirm", FINAL_PASSWORD);
      await page.locator("form button[type=submit]").first().click();
      await page.waitForURL((u) => u.pathname.startsWith(portal), { timeout: 60000 });
      await waitForPortal(page);
    });
    await step(page, `New ${role} ${who.first} > sidebar shows only ${role} pages; other portals send back`, async () => {
      await settle(page);
      const text = await sidebarText(page);
      for (const label of menu.has) expect(text, `${role} sidebar has ${label}`).toContain(label);
      for (const label of menu.not) expect(text, `${role} sidebar must not have ${label}`).not.toContain(label);
      for (const other of ["/super-admin", "/admin", "/hr", "/accountant", "/employee"].filter((p) => p !== portal)) {
        await page.goto(other);
        await page.waitForURL((u) => u.pathname.startsWith(portal), { timeout: 30000 }).catch(() => {});
        expect(new URL(page.url()).pathname.startsWith(portal), `${role} reached ${other}`).toBe(true);
      }
    });
  }
});

test("new Admin's branch kiosk: unlocked by the Admin's password, own branch's card only", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d POST \/api\/admin\/attendance/, /^4\d\d POST \/api\/rfid\/cards/, /status of 4/);
  const dina = await profileByEmail(NEW.employee.email);
  await step(page, `HR > RFID Cards > register card for new North employee ${NEW.employee.first}`, async () => {
    monitor.at("HR > RFID Cards");
    await as(page, "hr", "hr-rfid-cards");
    const res = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: dina.id, uid: DINA_CARD, reason: "E2E new card" });
    expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
    expect((await profileByEmail(NEW.employee.email)).rfid_uid).toBe(DINA_CARD);
  });

  await step(page, "New Admin Nora > Open RFID Terminal > wrong password (refused), then her password unlocks it", async () => {
    monitor.at("New Admin > RFID Terminal");
    await signOutLocally(page);
    await signInAs(page, NEW.admin.email, FINAL_PASSWORD);
    await page.waitForURL(/\/admin/, { timeout: 60000 });
    await waitForPortal(page);
    await page.goto("/rfid-terminal");
    await page.locator("#rt-lock-password").fill("not-her-password");
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator("#rt-scan-input")).toHaveCount(0);
    await page.locator("#rt-lock-password").fill(FINAL_PASSWORD);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
  });

  const tap = async (uid) => {
    const response = page.waitForResponse((r) => r.url().includes("/api/admin/attendance") && r.request().method() === "POST", { timeout: 30000 });
    await page.locator("#rt-scan-input").click();
    await page.keyboard.type(uid, { delay: 20 });
    await page.keyboard.press("Enter");
    const res = await response;
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  };

  await step(page, `Kiosk (North) > tap ${NEW.employee.first}'s card: time in, recorded for North`, async () => {
    const res = await tap(DINA_CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(["time_in", "duplicate"]).toContain(res.body.tap);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    const logs = await rows(db().from("attendance_logs").select("branch_id,time_in").eq("employee_id", dina.id).eq("log_date", today));
    expect(logs.length).toBe(1);
    expect(logs[0].branch_id).toBe(await branchId(BRANCH_NORTH));
  });

  await step(page, "Kiosk (North) > tap Bea's Main Campus card (refused: another branch)", async () => {
    const res = await tap("1000000002");
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe("wrong_branch");
  });
});

test("sessions: logout, an expired session and a tampered session", async ({ page, monitor }) => {
  monitor.allow(/^401 /, /status of 401/);
  await step(page, "Accountant > Sign out from the account menu > back on the login page", async () => {
    monitor.at("Logout");
    await as(page, "accountant");
    const before = (await page.context().cookies()).find((c) => c.name === "sacs-session");
    expect(before, "signed in").toBeTruthy();
    await page.locator('[data-sidebar="footer"] [data-sidebar="menu-button"]').first().click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    const confirmBtn = page.getByRole("alertdialog").getByRole("button", { name: "Sign out" });
    if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
    await page.waitForURL(/\/login/, { timeout: 30000 });
    expect((await api(page, "GET", "/api/rbac/me")).status).toBe(401);
    // The old cookie, put back after logout, must not work any more.
    // The proxy may answer a matching session from its 5-second cache.
    await page.waitForTimeout(6000);
    await page.context().addCookies([before]);
    const reused = await api(page, "GET", "/api/rbac/me");
    console.log(`  · reusing the signed-out session cookie answered ${reused.status}`);
    expect(reused.status, "a signed-out session cannot be replayed").toBe(401);
  });

  await step(page, "Employee > the session cookie expires > the portal returns to login and the API says 401", async () => {
    monitor.at("Session expiry");
    await as(page, "employee");
    const cookie = (await page.context().cookies()).find((c) => c.name === "sacs-session");
    const [payloadPart] = cookie.value.split(".");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const forge = (p) => {
      const part = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
      return `${part}.${crypto.createHmac("sha256", TEST_SESSION_SECRET).update(part).digest("base64url")}`;
    };
    await page.context().addCookies([{ ...cookie, value: forge({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }) }]);
    expect((await api(page, "GET", "/api/employee/payslips")).status).toBe(401);
    await page.goto("/employee");
    await page.waitForURL(/\/login/, { timeout: 30000 });

    await step(page, "Employee > a tampered session (role changed to super_admin, signature not redone) is refused");
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, role: "super_admin" }), "utf8").toString("base64url")}.${cookie.value.split(".")[1]}`;
    await page.context().addCookies([{ ...cookie, value: tampered }]);
    expect((await api(page, "GET", "/api/admin/config")).status).toBe(401);
  });
});

test("password reset and password change (throwaway account)", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d POST \/api\/legacy-auth\//, /status of 4/);
  const dina = await profileByEmail(NEW.employee.email);
  clearThrottle(NEW.employee.email);

  await step(page, "Login > Forgot password? > Send code > Verify code > set a new password", async () => {
    monitor.at("Login > Reset password");
    await signOutLocally(page);
    await plantCode(dina.id, "reset");
    await page.goto("/login");
    await page.getByText("Forgot password?").click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#reset-identity").fill(NEW.employee.email);
    await dialog.getByRole("button", { name: "Send code" }).click();
    await dialog.locator("#reset-code").waitFor({ timeout: 30000 });
    await dialog.locator("#reset-code").click();
    await page.keyboard.type(TEST_OTP, { delay: 60 });
    const verifyBtn = dialog.getByRole("button", { name: "Verify code" });
    if (await verifyBtn.isVisible().catch(() => false) && await verifyBtn.isEnabled().catch(() => false)) await verifyBtn.click();
    await dialog.locator("#reset-new").waitFor({ timeout: 30000 });
    await dialog.locator("#reset-new").fill(RESET_PASSWORD);
    await dialog.locator("#reset-confirm").fill(RESET_PASSWORD);
    await dialog.getByRole("button", { name: "Reset password" }).click();
    await page.waitForTimeout(2000);
  });

  await step(page, "Login > the old password is refused, the new one works", async () => {
    await signOutLocally(page);
    const old = await typePassword(page, NEW.employee.email, FINAL_PASSWORD);
    expect(old.status()).toBe(401);
    clearThrottle(NEW.employee.email);
    await signOutLocally(page);
    await signInAs(page, NEW.employee.email, RESET_PASSWORD);
    await page.waitForURL(/\/employee/, { timeout: 60000 });
    await waitForPortal(page);
  });

  await step(page, "Employee > account menu > Change password: wrong current password refused, then current + emailed code + new", async () => {
    monitor.at("Employee > Change password");
    await page.locator('[data-sidebar="footer"] [data-sidebar="menu-button"]').first().click();
    await page.getByRole("menuitem", { name: "Change password" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#cp-current").fill("Not-The-Current#1");
    await dialog.locator("button[type=submit], button:has-text('Send code'), button:has-text('Continue')").first().click();
    await page.waitForTimeout(1500);
    await expect(dialog.locator("#cp-code")).toHaveCount(0);
    await plantCode(dina.id, "pwchange");
    await dialog.locator("#cp-current").fill(RESET_PASSWORD);
    await dialog.locator("button[type=submit], button:has-text('Send code'), button:has-text('Continue')").first().click();
    await dialog.locator("#cp-code").waitFor({ timeout: 30000 });
    await dialog.locator("#cp-code").click();
    await page.keyboard.type(TEST_OTP, { delay: 60 });
    await dialog.locator("#cp-new").waitFor({ timeout: 30000 });
    await dialog.locator("#cp-new").fill(CHANGED_PASSWORD);
    await dialog.locator("#cp-confirm").fill(CHANGED_PASSWORD);
    await dialog.locator("button[type=submit]").last().click();
    await page.waitForTimeout(2500);
  });

  await step(page, "Login > the changed password works", async () => {
    await signOutLocally(page);
    await signInAs(page, NEW.employee.email, CHANGED_PASSWORD);
    await page.waitForURL(/\/employee/, { timeout: 60000 });
  });
});

test("deactivate and reactivate: an archived user cannot sign in, a restored one can", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d POST \/api\/(legacy-auth|admin\/attendance)/, /status of 4/);
  const dina = await profileByEmail(NEW.employee.email);
  const nora = await profileByEmail(NEW.admin.email);

  await step(page, `HR > edits ${NEW.employee.first}'s address, then archives (deactivates) her`, async () => {
    monitor.at("HR > User Management > archive");
    await as(page, "hr", "hr-employees");
    const list = await api(page, "GET", "/api/hr/employees");
    const row = list.data.employees.find((e) => e.email === NEW.employee.email);
    const north = await branchId(BRANCH_NORTH);
    const { password: _pw, ...record } = employeeBody(NEW.employee, "employee", north, { cp_number: row?.cp_number || undefined });
    const edit = await api(page, "PATCH", "/api/hr/employees", { ...record, cp_number: row?.cp_number || record.cp_number, id: dina.id, expected_updated_at: row?.updated_at, address: "99 Edited St, Pasig City" });
    expect([200, 201], JSON.stringify(edit.data)).toContain(edit.status);
    const after = (await api(page, "GET", "/api/hr/employees")).data.employees.find((e) => e.email === NEW.employee.email);
    expect(after?.address || "").toContain("99 Edited St");
    const arch = await api(page, "PATCH", "/api/admin/employees", { id: dina.id, action: "archive", reason: "E2E separation test" });
    expect([200, 201], JSON.stringify(arch.data)).toContain(arch.status);
    expect((await profileByEmail(NEW.employee.email)).archived).toBe(true);
  });

  await step(page, `Login > archived ${NEW.employee.first} is refused ("archived and can no longer sign in")`, async () => {
    monitor.at("Login > archived account");
    await signOutLocally(page);
    clearThrottle(NEW.employee.email);
    const res = await typePassword(page, NEW.employee.email, CHANGED_PASSWORD);
    expect(res.status()).toBe(403);
    await expect(page.getByText(/archived/i).first()).toBeVisible();
  });

  await step(page, "Super Admin > archives new Admin Nora; she cannot sign in", async () => {
    monitor.at("Super Admin > archive staff");
    await as(page, "super_admin");
    const arch = await api(page, "PATCH", "/api/admin/users", { id: nora.id, action: "archive", reason: "E2E" });
    expect([200, 201], JSON.stringify(arch.data)).toContain(arch.status);
    await signOutLocally(page);
    clearThrottle(NEW.admin.email);
    expect((await typePassword(page, NEW.admin.email, FINAL_PASSWORD)).status()).toBe(403);
  });

  await step(page, `HR > restores ${NEW.employee.first}; she signs in again`, async () => {
    monitor.at("HR > restore");
    await as(page, "hr", "hr-employees");
    const back = await api(page, "PATCH", "/api/admin/employees", { id: dina.id, action: "restore" });
    expect([200, 201], JSON.stringify(back.data)).toContain(back.status);
    expect((await profileByEmail(NEW.employee.email)).archived).toBe(false);
    await signOutLocally(page);
    clearThrottle(NEW.employee.email);
    await signInAs(page, NEW.employee.email, CHANGED_PASSWORD);
    await page.waitForURL(/\/employee/, { timeout: 60000 });
  });
});

// Last: it locks the throwaway account out (the dev server's in-memory
// counters cannot be cleared from here).
test("sign-in refusals: wrong password, wrong / expired code, lock-outs", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d POST \/api\/legacy-auth\//, /status of 4/);
  const dina = await profileByEmail(NEW.employee.email);
  await signOutLocally(page);

  await step(page, `Login > ${NEW.employee.first} with a wrong password (refused, no code screen)`, async () => {
    monitor.at("Login > wrong password");
    const res = await typePassword(page, NEW.employee.email, "Wrong-Pass#2026");
    expect(res.status()).toBe(401);
    await expect(page.getByText("Check your email")).toHaveCount(0);
    await expect(page.locator("form").getByText(/incorrect|invalid|wrong/i).first()).toBeVisible();
  });

  await step(page, "Login > right password, wrong code (refused: 'Incorrect or expired code')", async () => {
    monitor.at("Login > wrong code");
    await plantCode(dina.id);
    const res = await typePassword(page, NEW.employee.email, CHANGED_PASSWORD);
    expect(res.status()).toBe(200);
    await page.locator("#login-code").click();
    const verify = page.waitForResponse((r) => r.url().includes("verify-login-otp"));
    await page.keyboard.type("111111", { delay: 60 });
    expect((await verify).status()).toBe(400);
    await expect(page.getByText("Incorrect or expired code.").first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  await step(page, "Login > an expired code (planted with a 1-second life) is refused", async () => {
    monitor.at("Login > expired code");
    await signOutLocally(page);
    clearThrottle(NEW.employee.email);
    const res = await typePassword(page, NEW.employee.email, CHANGED_PASSWORD);
    expect(res.status()).toBe(200);
    await plantCode(dina.id, "login", 1);
    await page.waitForTimeout(2500);
    await page.locator("#login-code").click();
    const verify = page.waitForResponse((r) => r.url().includes("verify-login-otp"));
    await page.keyboard.type(TEST_OTP, { delay: 60 });
    expect((await verify).status()).toBe(400);
    await expect(page).toHaveURL(/\/login/);
  });

  await step(page, "Login > five wrong codes lock the code step ('Too many incorrect codes')", async () => {
    monitor.at("Login > code lock-out");
    await signOutLocally(page);
    await plantCode(dina.id);
    await typePassword(page, NEW.employee.email, CHANGED_PASSWORD);
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      last = await page.evaluate(async () => (await fetch("/api/legacy-auth/verify-login-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "999999" }) })).status);
      if (last === 429) break;
    }
    expect(last, "the code step locks").toBe(429);
    // Even the right code is refused now.
    const right = await page.evaluate(async (code) => (await fetch("/api/legacy-auth/verify-login-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })).status, TEST_OTP);
    expect([401, 429]).toContain(right);
  });

  await step(page, "Login > five wrong passwords lock the account; the right one is refused too (429)", async () => {
    monitor.at("Login > password lock-out");
    await signOutLocally(page);
    let status = 0;
    for (let i = 0; i < 5; i += 1) status = (await typePassword(page, NEW.employee.email, `Wrong-${i}#2026`)).status();
    const locked = await typePassword(page, NEW.employee.email, CHANGED_PASSWORD);
    expect(locked.status(), `after 5 wrong passwords (last answered ${status})`).toBe(429);
    await expect(page.getByText(/Too many sign-in attempts/).first()).toBeVisible();
  });
  clearThrottle(NEW.employee.email);
});
