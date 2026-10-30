// Announcements for HR and branch Admins (2026-10-30), live: HR posts to the
// whole school or a branch, edits and deletes; an Admin only to its own
// branch and only its own posts; Accountant and Employee read only; the
// Super Admin deletes (moderation) but does not post. Every refusal is also
// tried as a direct API call; the database's own guard is tried in SQL.
//
//   E2E_SLOWMO=500 npx playwright test e2e/specs/99-announcements.spec.mjs
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, confirm } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_MAIN, BRANCH_NORTH } from "../accounts.mjs";

test.use({ viewport: { width: 1280, height: 800 } });

const clock = () => new Date().toLocaleTimeString("en-PH", { hour12: false, timeZone: "Asia/Manila" });
let n = 0;
const results = [];
const say = (t) => { n += 1; console.log(`  [#${n} ${clock()}] ${t}`); };
function check(where, ok, text) {
  results.push({ where, ok, text, step: n + 1, time: clock() });
  say(`${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  return ok;
}
const STAMP = Date.now().toString(36).slice(-4);
const T = {
  school: `E2E school-wide ${STAMP}`,
  north: `E2E North only ${STAMP}`,
  main: `E2E Main admin ${STAMP}`,
  northAdmin: `E2E North admin ${STAMP}`,
  expired: `E2E expired ${STAMP}`,
};

async function openPage(page, role, id) {
  await as(page, role, id);
  await settle(page);
}

/** Post through the form (HR picks the audience; an Admin's is fixed). */
async function postThroughForm(page, { title, body, audience }) {
  say(`Clicking Post announcement: "${title}"${audience ? ` for ${audience}` : ""}…`);
  await main(page).getByRole("button", { name: "Post announcement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#an-title").fill(title);
  await dialog.locator("#an-body").fill(body);
  if (audience) {
    await dialog.locator("#an-audience").click();
    await page.getByRole("option", { name: audience, exact: true }).click();
  }
  await dialog.getByRole("button", { name: "Post", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20000 });
  await settle(page);
}

const row = (page, title) => main(page).locator("tr", { hasText: title }).first();
const feedTitles = async (page) => ((await api(page, "GET", "/api/announcements")).data?.announcements || []).map((a) => a.title);

test("announcements: HR and Admin manage, audiences hold, readers read only", async ({ page, monitor }) => {
  test.setTimeout(20 * 60 * 1000);
  monitor.allow(/^40[034] (POST|PATCH|DELETE) \/api\/announcements/);
  const main_ = await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single());
  const north = await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single());

  await step(page, "HR > Announcements > post school-wide and North-only, edit, delete", async () => {
    monitor.at("HR > Announcements");
    say("Logging in as HR, opening Announcements…");
    await openPage(page, "hr", "hr-announcements");
    await postThroughForm(page, { title: T.school, body: "No classes on Nov 2 (All Souls' Day).", audience: "Whole school" });
    check("HR", await row(page, T.school).isVisible(), "school-wide announcement listed, For: Whole school");
    check("HR", /Whole school/.test(await row(page, T.school).innerText()), "audience shown as Whole school");
    await postThroughForm(page, { title: T.north, body: "Fire drill at 10 AM.", audience: BRANCH_NORTH });
    check("HR", new RegExp(BRANCH_NORTH).test(await row(page, T.north).innerText()), `branch announcement listed, For: ${BRANCH_NORTH}`);
    say("Editing the North announcement…");
    await row(page, T.north).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").locator("#an-body").fill("Fire drill moved to 2 PM.");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20000 });
    await settle(page);
    check("HR", /2 PM/.test(await row(page, T.north).innerText()), "edit saved");
    say("Posting a throwaway and deleting it (with the confirmation)…");
    await postThroughForm(page, { title: `${T.school} (delete me)`, body: "Posted by mistake.", audience: "Whole school" });
    await row(page, `${T.school} (delete me)`).getByRole("button", { name: "Delete" }).click();
    const askText = await page.locator('[role="alertdialog"]:visible, [role="dialog"]:visible').last().innerText();
    check("HR", /Delete/.test(askText), "a confirmation appears before deleting");
    await confirm(page, "Delete");
    check("HR", /Deleted/.test(await row(page, `${T.school} (delete me)`).innerText()), "deleted (kept on record as Deleted)");
    say("Over-length title typed in the form (150 characters)…");
    await main(page).getByRole("button", { name: "Post announcement" }).click();
    await page.getByRole("dialog").locator("#an-title").fill("T".repeat(150));
    const kept = (await page.getByRole("dialog").locator("#an-title").inputValue()).length;
    check("Limits", kept === 100, `title box keeps ${kept} of 150 characters`);
    await page.keyboard.press("Escape");
    const longTitle = await api(page, "POST", "/api/announcements", { title: "T".repeat(101), body: "x", audience: "all" });
    const longBody = await api(page, "POST", "/api/announcements", { title: "x", body: "M".repeat(1001), audience: "all" });
    check("Limits", longTitle.status === 400 && longBody.status === 400, `API refuses a 101-character title (${longTitle.status}) and a 1,001-character message (${longBody.status})`);
  });

  await step(page, "Admin (Main) > own branch only; never school-wide, North, or HR's", async () => {
    monitor.at("Admin > Announcements");
    say("Logging in as Admin (Main Campus)…");
    await openPage(page, "admin", "adm-announcements");
    await postThroughForm(page, { title: T.main, body: "Faculty meeting Friday 3 PM." });
    check("Admin", new RegExp(BRANCH_MAIN).test(await row(page, T.main).innerText()), `posted, For: ${BRANCH_MAIN}`);
    await main(page).getByRole("button", { name: "Post announcement" }).click();
    const fixed = page.getByRole("dialog").locator("#an-audience");
    check("Admin", (await fixed.getAttribute("readonly")) !== null && (await fixed.inputValue()) === BRANCH_MAIN, "the audience box is fixed to the Admin's branch");
    await page.keyboard.press("Escape");
    const hrRow = row(page, T.school);
    check("Admin", (await hrRow.getByRole("button").count()) === 0, "HR's school-wide announcement is listed with no Edit / Delete");
    check("Admin", (await main(page).locator("tr", { hasText: T.north }).count()) === 0, "North's announcement is not listed");
    say("Direct API calls an Admin must not get through…");
    const all = await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: "all" });
    const other = await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: north.id });
    check("Admin API", all.status === 403 && other.status === 403, `school-wide ${all.status}, another branch ${other.status}`);
    const hrId = (await rows(db().from("branch_announcements").select("id").eq("title", T.school).single())).id;
    const editHr = await api(page, "PATCH", "/api/announcements", { id: hrId, action: "edit", title: "Hacked", body: "Hacked" });
    const delHr = await api(page, "DELETE", "/api/announcements", { id: hrId });
    check("Admin API", editHr.status === 403 && delHr.status === 403, `edit HR's ${editHr.status}, delete HR's ${delHr.status}`);
  });

  await step(page, "Admin (North) posts; Main's Admin cannot touch it", async () => {
    await as(page, "admin2", "adm-announcements");
    const posted = await api(page, "POST", "/api/announcements", { title: T.northAdmin, body: "North canteen closed Friday." });
    check("Admin (North)", posted.status === 200, "North's Admin posts to North");
    await as(page, "admin", "adm-announcements");
    const id = posted.data.announcement.id;
    const edit = await api(page, "PATCH", "/api/announcements", { id, action: "edit", title: "x", body: "y" });
    const del = await api(page, "DELETE", "/api/announcements", { id });
    check("Admin API", edit.status === 404 && del.status === 404, `Main's Admin on North's post: edit ${edit.status}, delete ${del.status} (not even known)`);
  });

  await step(page, "Accountant and Employee read their audience's only; every write is blocked", async () => {
    for (const [role, pageId] of [["accountant", "ac-announcements"], ["employee", "emp-announcements"]]) {
      monitor.at(`${role} > Announcements`);
      say(`Logging in as ${role}, opening Announcements…`);
      await openPage(page, role, pageId);
      const text = await main(page).innerText();
      check(role, text.includes(T.school) && text.includes(T.main), "sees the school-wide and own-branch (Main) announcements");
      check(role, !text.includes(T.north) && !text.includes(T.northAdmin), "does not see North's announcements");
      check(role, (await main(page).getByRole("button", { name: /Post announcement|Edit|Delete/ }).count()) === 0, "no Post / Edit / Delete on screen");
      const id = (await rows(db().from("branch_announcements").select("id").eq("title", T.school).single())).id;
      const results3 = [
        await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: "all" }),
        await api(page, "PATCH", "/api/announcements", { id, action: "edit", title: "x", body: "y" }),
        await api(page, "DELETE", "/api/announcements", { id }),
      ].map((r) => r.status);
      check(`${role} API`, results3.every((s) => s === 403), `POST / PATCH / DELETE answered ${results3.join(" / ")}`);
    }
    const bell = await api(page, "GET", "/api/notifications");
    check("Employee", JSON.stringify(bell.data || {}).includes(T.school), "the employee was notified in-system of the school-wide announcement");
    await page.goto("/employee?page=emp-dash");
    await settle(page);
    check("Employee", (await main(page).innerText()).includes(T.school), "the dashboard card shows it");
  });

  await step(page, "Employee in North: sees North's, not Main's", async () => {
    await as(page, "employee3", "emp-announcements");
    const titles = await feedTitles(page);
    check("Employee (North)", titles.includes(T.north) && titles.includes(T.school) && !titles.includes(T.main), `sees: ${titles.filter((t) => t.includes(STAMP)).join(", ")}`);
  });

  await step(page, "An expired announcement disappears from the normal view", async () => {
    await as(page, "hr", "hr-announcements");
    const posted = await api(page, "POST", "/api/announcements", { title: T.expired, body: "Enrollment closes.", audience: "all" });
    psql(`select set_config('sacs.announcement_action', 'on', false); update branch_announcements set expires_on = current_date - 1 where id = '${posted.data.announcement.id}';`);
    await as(page, "employee", "emp-announcements");
    check("Expiry", !(await feedTitles(page)).includes(T.expired), "an employee no longer sees it");
    await as(page, "hr", "hr-announcements");
    await settle(page);
    check("Expiry", /Expired/.test(await row(page, T.expired).innerText()), "HR's list still shows it, marked Expired");
  });

  await step(page, "Super Admin: moderation (delete any), no posting", async () => {
    monitor.at("Super Admin > Announcements");
    await openPage(page, "super_admin", "sa-announcements");
    check("Super Admin", (await main(page).getByRole("button", { name: "Post announcement" }).count()) === 0, "no Post button");
    const post = await api(page, "POST", "/api/announcements", { title: "x", body: "y", audience: "all" });
    check("Super Admin", post.status === 403, `posting refused (${post.status})`);
    say(`Deleting North's Admin post as moderation…`);
    await row(page, T.northAdmin).getByRole("button", { name: "Delete" }).click();
    await confirm(page, "Delete");
    check("Super Admin", /Deleted/.test(await row(page, T.northAdmin).innerText()), "deleted (moderation)");
  });

  await step(page, "Database: the audience rule holds even for a direct write", async () => {
    const admin = await profileByEmail(ACCOUNTS.admin.email);
    let refused = [];
    for (const [label, sql] of [
      ["Admin school-wide via the function", `select public.announcement_post('${admin.id}', null, 'x', 'y');`],
      ["Admin to North via the function", `select public.announcement_post('${admin.id}', '${north.id}', 'x', 'y');`],
      ["direct insert (no function)", `insert into branch_announcements (branch_id, title, body, author_role) values ('${main_.id}', 'x', 'y', 'admin');`],
      ["101-character title", `select public.announcement_post('${admin.id}', '${main_.id}', repeat('T', 101), 'y');`],
    ]) {
      try { psql(sql); refused.push(`${label}: ALLOWED`); } catch { refused.push(`${label}: refused`); }
    }
    check("Database", refused.every((r) => r.endsWith("refused")), refused.join("; "));
    const audit = await rows(db().from("audit_logs").select("action").eq("module", "announcements"));
    const actions = new Set(audit.map((a) => a.action));
    check("Audit", ["announcement_post", "announcement_edit", "announcement_remove"].every((a) => actions.has(a)), `logged: ${[...actions].join(", ")}`);
  });
});

test.afterAll(() => {
  const line = "=".repeat(70);
  console.log(`\n${line}\n ANNOUNCEMENTS SUMMARY (${clock()}): ${results.filter((r) => r.ok).length}/${results.length} PASS\n${line}`);
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  #${r.step} ${r.time}  ${r.where}: ${r.text}`);
  console.log(line);
});
