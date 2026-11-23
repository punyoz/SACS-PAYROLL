// Basic salary per half (2026-11-24, after a full-run failure showed two different
// employees' salaries: the form opens the period's saved draft, which can belong to
// someone else). What payroll uses, read from the same data the Accountant's form loads:
//  - a full-month employee: the same monthly salary in both halves; the 1st half is half of it;
//  - a mid-month new hire: pro-rated by working days from the hire date (daily rate =
//    monthly × 12 ÷ 261), the 1st half capped at half the salary, the month at the salary.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const round = (n) => Math.round(Number(n) * 100) / 100;
const weekdays = (from, to) => {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) if (![0, 6].includes(new Date(t).getUTCDay())) n += 1;
  return n;
};

async function periodRows(page, period) {
  const res = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(period)}`);
  expect(res.status, JSON.stringify(res.data).slice(0, 200)).toBe(200);
  return { rows: res.data.attendance_rows || [], employees: res.data.employees || [] };
}

test("full-month employees: the same monthly salary in both halves; the 1st half pays half of it", async ({ page }) => {
  await as(page, "accountant", "ac-process");
  const first = await periodRows(page, FIRST);
  const second = await periodRows(page, SECOND);
  const people = await rows(db().from("profiles").select("id,full_name,basic_salary,date_hired").in("id", first.rows.map((r) => r.employee_id)));
  const full = people.filter((p) => p.date_hired && p.date_hired <= "2026-11-01");
  expect(full.length, "at least one full-month employee in the Accountant's branch").toBeGreaterThan(0);
  for (const p of full) {
    await step(page, `${p.full_name}: ₱${p.basic_salary} a month in both halves`, async () => {
      const e1 = first.employees.find((e) => e.id === p.id);
      const e2 = second.employees.find((e) => e.id === p.id);
      expect(round(e1.basic_salary), `${p.full_name}: the form's Basic salary, 1st half`).toBe(round(e2.basic_salary));
      const r1 = first.rows.find((r) => r.employee_id === p.id);
      const r2 = second.rows.find((r) => r.employee_id === p.id);
      expect(round(r1.defaults.basic_salary), `${p.full_name}: 1st half = salary ÷ 2`).toBe(round(e1.basic_salary / 2));
      expect(round(r2.defaults.basic_salary), `${p.full_name}: 2nd half settles the whole month`).toBe(round(e2.basic_salary));
    });
  }
});

test("a mid-month new hire is pro-rated from the hire date (daily rate × working days), never more than the salary", async ({ page }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const stamp = Date.now();
  const email = `newhire.${stamp}@e2e.test`;
  const { data, error } = await db().auth.admin.createUser({ email, password: `E2e-Nh#${stamp}`, email_confirm: true, user_metadata: { role: "employee", full_name: "Nina Newhire", branch_id: bea.branch_id } });
  if (error) throw new Error(error.message);
  const { id: _i, email: _e, created_at: _c, updated_at: _u, rfid_uid: _r, photo_path: _p, photo_thumb_path: _t, photo_updated_at: _pu, ...rest } = bea;
  const SALARY = 26100; // daily rate 26,100 × 12 ÷ 261 = 1,200
  const HIRED = "2026-11-10";
  await rows(db().from("profiles").upsert({ ...rest, id: data.user.id, email, first_name: "Nina", last_name: "Newhire", employee_id: `E2E-NH-${stamp}`,
    archived: false, on_payroll: true, basic_salary: SALARY, date_hired: HIRED }, { onConflict: "id" }).select("id"));
  const daily = round((SALARY * 12) / 261);
  expect(daily).toBe(1200);

  await as(page, "accountant", "ac-process");
  // The staff list is cached for 10 s: wait until the new hire is listed.
  let first;
  for (let i = 0; i < 8; i += 1) {
    first = await periodRows(page, FIRST);
    if (first.employees.some((e) => e.id === data.user.id)) break;
    await page.waitForTimeout(2000);
  }
  const second = await periodRows(page, SECOND);
  await step(page, `Hired ${HIRED}: 1st half = ₱1,200 × ${weekdays(HIRED, "2026-11-15")} days; the month = ₱1,200 × ${weekdays(HIRED, "2026-11-30")} days`, async () => {
    const e1 = first.employees.find((e) => e.id === data.user.id);
    const e2 = second.employees.find((e) => e.id === data.user.id);
    expect(round(e1.basic_salary), "the form's Basic salary (monthly) is the contract salary in both halves").toBe(SALARY);
    expect(round(e2.basic_salary)).toBe(SALARY);
    const r1 = first.rows.find((r) => r.employee_id === data.user.id);
    const r2 = second.rows.find((r) => r.employee_id === data.user.id);
    expect(round(r1.defaults.basic_salary), "1st half: 5 working days").toBe(Math.min(daily * weekdays(HIRED, "2026-11-15"), SALARY / 2));
    expect(round(r2.defaults.basic_salary), "the month: 15 working days").toBe(Math.min(daily * weekdays(HIRED, "2026-11-30"), SALARY));
    expect(round(r1.defaults.basic_salary)).toBe(6000);
    expect(round(r2.defaults.basic_salary)).toBe(18000);
  });
});
