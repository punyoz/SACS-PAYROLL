// The Super Admin's emergency override of an approved Final payslip
// (decision 2026-10-29, 20261029040000). Backend only: called directly, as
// a recovery would be. Needs the approved October runs and the BIR files the
// earlier specs leave (20-payroll-flow, 96-year-end-tax).
//
//   - the Accountant, HR, the Admin and an Employee are refused;
//   - no reason, no override;
//   - the override rewrites the approved payslip, keeps its own record (who,
//     which payslip, old and new values, reason, when) and an audit entry
//     of its own module, shown on the Super Admin's Audit & Monitoring;
//   - the run, the BIR 2316 / alphalist and the annualization that used the
//     old figures are flagged for review, the Accountant and HR notified,
//     and the Accountant marks its flag reviewed.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

// The month's 2nd half: it settles the month (contributions, tax), so the 1st
// half of a settled month is never recomputed, not even by an override.
const PERIOD = "October 16-31, 2026";
const REASON = `E2E: a missed absence on Oct 20 confirmed after HR review ${Date.now()}`;

// October 16-31 is generated on the 30th; the test runs before that, so a
// schedule with October's 2nd half today is planted (as in 96) and removed.
let planted = null;
test.afterEach(() => {
  if (planted) psql(`set session_replication_role = replica; delete from payroll_schedule_settings where id = '${planted}';`);
  planted = null;
});

test("override: Super Admin only, reason required, logged on its own, downstream records flagged", async ({ page, monitor }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const sa = await profileByEmail(ACCOUNTS.super_admin.email);
  const acct = await profileByEmail(ACCOUNTS.accountant.email);
  const body = { action: "override_final", employee_id: bea.id, pay_period: PERIOD };
  const before = await rows(db().from("payroll_entries").select("id,net_pay,payslip_no,status,branch_id").eq("employee_id", bea.id).eq("pay_period", PERIOD).single());
  const run = await rows(db().from("payroll_runs").select("id,status").eq("branch_id", before.branch_id).eq("period_label", PERIOD).single());
  expect(before.status, "an approved Final payslip to correct").toBe("paid");
  expect(run.status).toBe("approved");

  await step(page, "Accountant, HR, Admin, Employee > override called directly (refused)", async () => {
    for (const role of ["accountant", "hr", "admin", "employee"]) {
      monitor.at(`${role} > override`);
      await as(page, role);
      const res = await api(page, "PATCH", "/api/accountant/payroll", { ...body, reason: REASON });
      expect(res.status, `${role} is refused`).toBe(403);
      expect((await api(page, "GET", "/api/payroll/overrides")).status, `${role} cannot read the override log`).toBe(403);
    }
  });

  await step(page, "Super Admin > override without a reason (refused)", async () => {
    monitor.at("Super Admin > override");
    await as(page, "super_admin");
    for (const reason of [undefined, "", "fix"]) {
      const res = await api(page, "PATCH", "/api/accountant/payroll", { ...body, reason });
      expect(res.status).toBe(400);
      expect(res.data.code).toBe("override_reason_required");
    }
    const after = await rows(db().from("payroll_entries").select("net_pay,payslip_no").eq("id", before.id).single());
    expect(after).toMatchObject({ net_pay: before.net_pay, payslip_no: before.payslip_no });
    expect(await rows(db().from("payroll_final_overrides").select("id").eq("employee_id", bea.id))).toHaveLength(0);
  });

  await step(page, "Super Admin > the Super Admin still cannot generate payroll", async () => {
    const res = await api(page, "PATCH", "/api/accountant/payroll", { ...body, action: "generate", reprocess: true });
    expect(res.status).toBe(403);
  });

  await step(page, "Super Admin > override the approved payslip (an absence found after approval)", async () => {
    planted = psql(`set session_replication_role = replica;
      insert into payroll_schedule_settings (effective_from, first_half_day, second_half_day, window_days, note, created_by_name)
      values ('2026-10-16', 15, ${Number(new Date().toLocaleString("en-CA", { timeZone: "Asia/Manila" }).slice(8, 10))}, 5, 'E2E: October 2nd half generated today', 'E2E') returning id;`).split(/s+/).pop();
    // HR confirmed afterwards that Bea was absent on Oct 20.
    psql(`update public.attendance_logs set time_in = null, time_out = null, total_hours = 0 where employee_id = '${bea.id}' and log_date = '2026-10-20';`);
    const res = await api(page, "PATCH", "/api/accountant/payroll", { ...body, reason: REASON, confirm_incomplete: true });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const { override } = res.data;
    expect(override.old_payslip_no).toBe(before.payslip_no);
    expect(override.payslip_no).not.toBe(before.payslip_no);
    expect(Number(override.old_values.net_pay)).toBe(Number(before.net_pay));
    expect(Number(override.new_values.net_pay)).toBeLessThan(Number(before.net_pay));
    expect(override.changed_fields).toContain("net_pay");

    // The payslip itself: rewritten, still approved, the old record archived.
    const after = await rows(db().from("payroll_entries").select("net_pay,payslip_no,status").eq("id", before.id).single());
    expect(after).toMatchObject({ status: "paid", payslip_no: override.payslip_no });
    expect(Number(after.net_pay)).toBe(Number(override.new_values.net_pay));
    const records = await rows(db().from("payroll_records").select("payslip_no,archived").eq("employee_id", bea.id).eq("period_label", PERIOD));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ payslip_no: before.payslip_no, archived: true }),
      expect.objectContaining({ payslip_no: override.payslip_no, archived: false }),
    ]));
    expect((await rows(db().from("payroll_runs").select("status").eq("id", run.id).single())).status).toBe("approved");

    // Its own record: who, which payslip, old and new, why, when.
    const record = await rows(db().from("payroll_final_overrides").select("*").eq("id", override.id).single());
    expect(record).toMatchObject({
      actor_id: sa.id, actor_role: "super_admin", employee_id: bea.id, pay_period: PERIOD, entry_id: before.id,
      run_id: run.id, run_status: "approved", reason: REASON, old_payslip_no: before.payslip_no, new_payslip_no: override.payslip_no,
    });
    expect(Number(record.old_values.net_pay)).toBe(Number(before.net_pay));
    expect(Number(record.new_values.net_pay)).toBe(Number(after.net_pay));
    expect(record.created_at).toBeTruthy();

    // An audit entry of its own module, apart from payroll processing.
    const audit = await rows(db().from("audit_logs").select("module,action,actor_id,metadata,description").eq("action", "payslip_override").eq("entity_id", before.id));
    expect(audit).toEqual([expect.objectContaining({ module: "payroll_override", actor_id: sa.id })]);
    expect(audit[0].metadata).toMatchObject({ override_id: override.id, reason: REASON, replaced_payslip_no: before.payslip_no });
    expect(audit[0].description).toContain(REASON);

    // What used the old figures is flagged, not changed.
    const kinds = override.review_flags.map((f) => f.kind);
    expect(kinds).toContain("payroll_run");
    expect(kinds).toContain("bir_2316");
    const annualized = await rows(db().from("payroll_tax_annualizations").select("id").eq("employee_id", bea.id).eq("tax_year", 2026));
    if (annualized.length) expect(kinds).toContain("tax_annualization");
    const bir = await rows(db().from("payroll_bir_exports").select("id,kind,rows").eq("employee_id", bea.id));
    expect(bir.length, "the 2316 generated earlier is kept as generated").toBeGreaterThan(0);
    const notified = await rows(db().from("notifications").select("recipient_id").eq("kind", "payroll_review"));
    expect(notified.map((n) => n.recipient_id)).toContain(acct.id);
  });

  await step(page, "Employee > the payslip shows the corrected net pay", async () => {
    monitor.at("Employee > payslips");
    await as(page, "employee2");
    const res = await api(page, "GET", `/api/employee/payslips?email=${encodeURIComponent(ACCOUNTS.employee2.email)}`);
    const slip = res.data.payslips.find((p) => p.period_label === PERIOD);
    const after = await rows(db().from("payroll_entries").select("net_pay").eq("id", before.id).single());
    expect(Number(slip.net_pay)).toBe(Number(after.net_pay));
  });

  await step(page, "Super Admin > Audit & Monitoring > Payslip overrides shows it", async () => {
    monitor.at("Super Admin > Audit & Monitoring");
    await as(page, "super_admin", "sa-audit");
    await choose(page, page.locator("#adm-audit-module"), "Payslip overrides");
    await settle(page);
    await expect(main(page).getByText(REASON, { exact: false }).first()).toBeVisible();
    const log = await api(page, "GET", "/api/payroll/overrides");
    expect(log.status).toBe(200);
    expect(log.data.overrides[0]).toMatchObject({ reason: REASON, actor_role: "super_admin" });
    expect(log.data.overrides[0].review_flags.length).toBeGreaterThan(0);
  });

  await step(page, "Super Admin > cannot mark its own override's flags reviewed", async () => {
    const flags = (await api(page, "GET", "/api/payroll/review-flags")).data.flags;
    const res = await api(page, "PATCH", "/api/payroll/review-flags", { id: flags[0].id, note: "Looks fine to me" });
    expect(res.status).toBe(403);
  });

  await step(page, "HR > sees the run flag", async () => {
    monitor.at("HR > review flags");
    await as(page, "hr");
    const res = await api(page, "GET", "/api/payroll/review-flags");
    expect(res.data.flags.map((f) => f.kind)).toEqual(["payroll_run"]);
  });

  await step(page, "Accountant > sees the BIR flag, regenerates nothing silently, marks it reviewed", async () => {
    monitor.at("Accountant > review flags");
    await as(page, "accountant");
    const res = await api(page, "GET", "/api/payroll/review-flags");
    const flag = res.data.flags.find((f) => f.kind === "bir_2316");
    expect(flag, "the 2316 flag").toBeTruthy();
    expect(flag.message).toContain("generate it again");
    const done = await api(page, "PATCH", "/api/payroll/review-flags", { id: flag.id, note: "Regenerated Bea's 2026 BIR 2316" });
    expect(done.status).toBe(200);
    expect(done.data.flag).toMatchObject({ status: "reviewed", reviewed_by_name: expect.any(String) });
  });
});
