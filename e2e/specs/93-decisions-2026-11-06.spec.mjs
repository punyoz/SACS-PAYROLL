// The user's decisions of 2026-11-06, against the local stack:
//  - an employee downloads their OWN approved payslip as a PDF (employee
//    share only); never someone else's, never through another role;
//  - an Admin always has a branch: the role-change API refuses one without,
//    Branch Assignment cannot unassign an Admin, and the database refuses it;
//  - the unused function payroll_pending_run_count() is gone.
// (The leave-rejection reason is covered in 33-leave-extra.)
// Runs after 20-payroll-flow (Ana's October 1-15 payslip is approved there).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { archiveTestAccount, db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_NORTH } from "../accounts.mjs";

const stamp = Date.now().toString(36).slice(-5);
const letters = stamp.replace(/\d/g, (d) => "abcdefghij"[d]);
const STAFF = { email: `role.change.${stamp}@e2e.test`, last: `Shift${letters.charAt(0).toUpperCase()}${letters.slice(1)}` };

test.afterAll(async () => { await archiveTestAccount(STAFF.email); });

async function pdfOf(page, path) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    let text = "";
    for (let i = 0; i < buf.length; i += 1) text += String.fromCharCode(buf[i]);
    return { status: res.status, type: res.headers.get("content-type") || "", text };
  }, path);
}

test("employee payslip PDF: own approved payslip only, employee share only", async ({ page, monitor }) => {
  monitor.allow(/^40[34] GET \/api\/employee\/payslips/, /status of 40[34]/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const [beaSlip] = await rows(db().from("payroll_entries").select("id").eq("employee_id", bea.id).eq("status", "paid").limit(1));

  await step(page, "Employee Ana > Payslips > Download PDF (her approved payslip)", async () => {
    monitor.at("Employee > Payslips (PDF)");
    await as(page, "employee", "emp-payslips");
    await settle(page);
    const list = await api(page, "GET", "/api/employee/payslips");
    const mine = (list.data.payslips || [])[0];
    test.skip(!mine, "needs an approved payslip from 20-payroll-flow");
    const downloading = page.waitForEvent("download", { timeout: 30000 });
    await main(page).getByRole("button", { name: "Download PDF" }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/^payslip-.*\.pdf$/);
    const pdf = await pdfOf(page, `/api/employee/payslips?format=pdf&entry_id=${mine.id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain("application/pdf");
    expect(pdf.text.startsWith("%PDF-")).toBe(true);
    expect(pdf.text, "the school seal is embedded").toContain("/DCTDecode");
    if (mine.payslip_no) expect(pdf.text).toContain(mine.payslip_no);
    expect(pdf.text, "no employer share on the employee's payslip").not.toMatch(/employer/i);
    const [entry] = await rows(db().from("payroll_entries").select("employee_id").eq("id", mine.id));
    expect(entry.employee_id).toBe(ana.id);
  });

  await step(page, "Employee Ana > Bea's payslip id in the address (refused: not hers)", async () => {
    test.skip(!beaSlip, "needs a payslip of Bea's");
    const other = await pdfOf(page, `/api/employee/payslips?format=pdf&entry_id=${beaSlip.id}`);
    expect(other.status).toBe(404);
    expect(other.text.startsWith("%PDF-")).toBe(false);
  });

  await step(page, "HR > the employee PDF route for Ana (refused: own payslips only)", async () => {
    monitor.at("HR > employee PDF route");
    await as(page, "hr");
    const res = await pdfOf(page, `/api/employee/payslips?email=${encodeURIComponent(ACCOUNTS.employee.email)}&format=pdf&entry_id=${beaSlip?.id || "00000000-0000-0000-0000-000000000000"}`);
    expect(res.status).toBe(403);
  });
});

test("an Admin always has a branch: API, Branch Assignment and the database refuse a branchless Admin", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d (PATCH|DELETE) \/api\/admin\/(users|branch-employees)/, /status of 4/);
  const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single())).id;

  await step(page, "Super Admin > creates a throwaway HR account", async () => {
    monitor.at("Super Admin > Admin & HR Accounts");
    await as(page, "super_admin", "sa-accounts");
    const made = await api(page, "POST", "/api/admin/staff-accounts", {
      first_name: "Rita", last_name: STAFF.last, email: STAFF.email, role: "hr", employee_status: "Active",
      date_of_birth: "1990-05-05", date_hired: "2024-01-01", sex: "Female", civil_status: "Single", cp_number: "09171234560",
      address: "12 Rizal St, Pasig City", emergency_contact_name: "Maria Probe", emergency_contact_relationship: "Parent",
      emergency_contact_number: "09181234560", emergency_contact_address: "45 Rizal Ave, Pasig City",
    });
    expect([200, 201], JSON.stringify(made.data)).toContain(made.status);
  });

  await step(page, "Super Admin > HR → Admin with no branch (refused, nothing saved)", async () => {
    const staff = await profileByEmail(STAFF.email);
    const res = await api(page, "PATCH", "/api/admin/users", { id: staff.id, action: "update", role: "admin" });
    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.data.code).toBe("admin_branch_required");
    expect((await profileByEmail(STAFF.email)).role).toBe("hr");
  });

  await step(page, "Super Admin > HR → Admin with North branch (saved with its branch everywhere)", async () => {
    const staff = await profileByEmail(STAFF.email);
    const res = await api(page, "PATCH", "/api/admin/users", { id: staff.id, action: "update", role: "admin", branch_id: north });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const after = await profileByEmail(STAFF.email);
    expect(after.role).toBe("admin");
    expect(after.branch_id).toBe(north);
    const assignment = await rows(db().from("employee_branch_assignments").select("branch_id").eq("user_id", staff.id));
    expect(assignment[0]?.branch_id).toBe(north);
    const { data } = await db().auth.admin.getUserById(staff.id);
    expect(data.user.user_metadata.branch_id).toBe(north);
  });

  await step(page, "Super Admin > Branch Assignment > remove the Admin's branch (refused)", async () => {
    const staff = await profileByEmail(STAFF.email);
    const res = await api(page, "DELETE", "/api/admin/branch-employees", { user_id: staff.id });
    // The proxy already refuses this DELETE for every role (no role holds
    // "delete" on branch_assignment: 403); the route itself refuses an
    // Admin too (409), should that ever change.
    expect([403, 409], JSON.stringify(res.data)).toContain(res.status);
    expect((await profileByEmail(STAFF.email)).branch_id).toBe(north);
  });

  await step(page, "Database > an Admin without a branch is refused (profiles_admin_has_branch)", async () => {
    const staff = await profileByEmail(STAFF.email);
    let refused = "";
    try {
      psql(`update public.profiles set branch_id = null where id = '${staff.id}';`);
    } catch (error) {
      refused = String(error.message || error);
    }
    expect(refused).toContain("profiles_admin_has_branch");
    expect((await profileByEmail(STAFF.email)).branch_id).toBe(north);
  });

  await step(page, "Super Admin > Admin → HR clears the branch (allowed)", async () => {
    const staff = await profileByEmail(STAFF.email);
    const res = await api(page, "PATCH", "/api/admin/users", { id: staff.id, action: "update", role: "hr" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const after = await profileByEmail(STAFF.email);
    expect(after.role).toBe("hr");
    expect(after.branch_id).toBeNull();
  });
});

test("the unused function payroll_pending_run_count() is removed", async ({ page }) => {
  await step(page, "Database > payroll_pending_run_count() no longer exists", async () => {
    expect(psql("select count(*) from pg_proc where proname = 'payroll_pending_run_count';")).toBe("0");
    const call = await db().rpc("payroll_pending_run_count");
    expect(call.error, "calling it fails").toBeTruthy();
  });
});
