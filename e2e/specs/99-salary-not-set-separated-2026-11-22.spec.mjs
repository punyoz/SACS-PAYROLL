// User decisions 2026-11-22:
//   - HR's Action needed lists "Salary not set" (every on-payroll account with
//     a ₱0 salary), each name opening that employee's record.
//   - A separated (not archived) employee sees "You can't file new requests
//     after separation." instead of the leave and overtime forms; the server
//     refuses a filing too.
// Both states are set on the local stack for the test and put back after.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, psql, profileByEmail } from "../support/db.mjs";

const OUT = join(process.cwd(), "screenshots", "2026-11-22-followups");
mkdirSync(OUT, { recursive: true });

test("Action needed: Salary not set lists ₱0-salary accounts and opens the record", async ({ page }) => {
  const carlo = await profileByEmail("emp3@e2e.test");
  await db().from("profiles").update({ basic_salary: 0 }).eq("id", carlo.id);
  try {
    await as(page, "hr", "hr-dashboard");
    await settle(page);
    const card = main(page).getByTestId("action-salary");
    await expect(card).toContainText("Salary not set");
    const link = card.getByRole("link", { name: carlo.full_name });
    await expect(link).toHaveAttribute("href", new RegExp(`emp_open=${carlo.id}`));
    await card.screenshot({ path: join(OUT, "hr-salary-not-set.png") });
    await link.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // The name sits in the form boxes (values, not text): the record opened is Carlo's.
    await expect(page.getByRole("dialog").getByLabel(/^Email/).first()).toHaveValue(carlo.email);
  } finally {
    await db().from("profiles").update({ basic_salary: carlo.basic_salary }).eq("id", carlo.id);
  }
});

test("separated: the leave and overtime forms give way to one line; the server refuses a filing", async ({ page }) => {
  const bea = await profileByEmail("emp2@e2e.test");
  psql(`update profiles set employee_status = 'Separated' where id = '${bea.id}';`);
  try {
    await as(page, "employee2", "emp-leave");
    await settle(page);
    const notes = main(page).getByTestId("separated-note");
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toHaveText("You can't file new requests after separation.");
    await expect(main(page).getByRole("button", { name: "File overtime request" })).toHaveCount(0);
    await main(page).screenshot({ path: join(OUT, "separated-leave-page.png") });
    const filed = await api(page, "POST", "/api/me/overtime-requests", { request_date: "2026-12-01", planned_start: "17:00", planned_end: "18:00", reason: "After separation" });
    expect(filed.status).toBe(403);
  } finally {
    psql(`update profiles set employee_status = '${bea.employee_status || "Active"}' where id = '${bea.id}';`);
  }
});
