// Part J (2026-11-22): the HR dashboard's combined chart is split in two:
// Staff breakdown (Teaching / Non-Teaching) and Today's attendance (Present /
// Late / Absent / On leave / Not tapped yet), each with its own title and a
// legend whose entries link to the filtered list behind the bar.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";

test("HR dashboard: two charts, own titles and legends, each entry links to its list", async ({ page }) => {
  await as(page, "hr", "hr-dashboard");
  await settle(page);
  const data = (await api(page, "GET", "/api/hr/dashboard")).data;
  const today = manilaDay(0);
  const legend = (card, label) => card.getByRole("listitem").filter({ hasText: new RegExp(`^\\s*${label}\\s+\\d+\\s*$`) }).getByRole("link");

  await step(page, "Staff breakdown: Teaching and Non-Teaching only, linking to User Management filtered", async () => {
    const card = main(page).getByTestId("chart-staff");
    await expect(card.getByText("Staff breakdown", { exact: true })).toBeVisible();
    await expect(card.getByRole("listitem")).toHaveCount(2);
    await expect(legend(card, "Teaching")).toContainText(String(data.teaching_staff));
    await expect(legend(card, "Teaching")).toHaveAttribute("href", /page=hr-employees.*emp_filter=teaching/);
    await expect(legend(card, "Non-Teaching")).toContainText(String(data.non_teaching_staff));
    await expect(legend(card, "Non-Teaching")).toHaveAttribute("href", /emp_filter=non-teaching/);
    await expect(card.getByText(/Late/)).toHaveCount(0);
  });

  await step(page, "Today's attendance: five statuses with the server's counts, linking to Attendance for today", async () => {
    const card = main(page).getByTestId("chart-today");
    await expect(card.getByText("Today's attendance", { exact: true })).toBeVisible();
    const expected = {
      Present: Math.max(0, data.present_today - data.late_today), Late: data.late_today, Absent: data.absent_marked_today,
      "On leave": data.on_leave_today, "Not tapped yet": data.absent_today,
    };
    const status = { Present: "Present", Late: "Late", Absent: "Absent", "On leave": "On\\+Leave|On%20Leave", "Not tapped yet": "Not\\+tapped\\+yet|Not%20tapped%20yet" };
    for (const [label, count] of Object.entries(expected)) {
      const link = legend(card, label);
      await expect(link).toContainText(String(count));
      await expect(link).toHaveAttribute("href", new RegExp(`page=hr-attendance.*hr_att_status=(${status[label]})`));
      await expect(link).toHaveAttribute("href", new RegExp(`hr_att_from=${today}`));
    }
  });

  await step(page, "A legend link opens its filtered list", async () => {
    await legend(main(page).getByTestId("chart-staff"), "Teaching").click();
    await expect(page).toHaveURL(/page=hr-employees.*emp_filter=teaching/);
    await settle(page);
  });
});
