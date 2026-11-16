// UI six parts (2026-11-16): Work Schedules list, the shared Switch, the
// license warning row, page content in the sidebar during navigation, no
// "Action needed" panel, and "Review and finalize" opening the single-entry
// draft. Headless, no slowMo. UI_PHASE=before only takes screenshots and
// runs the sidebar probe (on the code before the change); UI_PHASE=after
// (default) also checks the behaviour. Screenshots: test-results/ui-six-parts/<phase>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { test, expect } from "@playwright/test";
import { psql } from "../support/db.mjs";
import { fixClock } from "./clock.mjs";
import { stateFile } from "./roles.mjs";

/** SQL on the LOCAL stack, rows as objects. */
const rows = async (sql) => JSON.parse(psql(`select coalesce(json_agg(t), '[]') from (${sql}) t`) || "[]");

const PHASE = process.env.UI_PHASE === "before" ? "before" : "after";
const AFTER = PHASE === "after";
// UI_DSF=1.25 mimics Windows display scaling (125 %), where rounding glitches show.
const DSF = Number(process.env.UI_DSF || 1);
const OUT = join(process.cwd(), "test-results", "ui-six-parts", PHASE + (DSF !== 1 ? `-dsf${DSF}` : ""));
mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: "parallel" });
test.beforeEach(async ({ context }) => { await fixClock(context); });
if (DSF !== 1) test.use({ deviceScaleFactor: DSF });

const DESKTOP = { width: 1366, height: 768 };
const PHONE = { width: 390, height: 844 };
const main = (page) => page.locator("#portal-main");
const shot = (target, name) => target.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled" });
const noSideScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

async function openPage(page, portal, id, viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  await page.goto(`${portal}?page=${id}`);
  await main(page).waitFor();
  // Not "networkidle": the live bell keeps a connection open.
  await page.waitForFunction(() => !document.querySelector("#portal-main [data-slot=skeleton]"), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------- Part 4
// The sidebar's right edge (inside the gold border) must show only the
// sidebar. Two checks per navigation: what is on top at sample points
// (elementFromPoint, every animation frame) and the pixels of frames taken
// every ~50 ms (no beige / page-coloured pixels in the strip).
const FOREIGN_OK = "[data-slot=sidebar-container],[data-mobile=true],[role=dialog],[role=alertdialog],[data-radix-popper-content-wrapper],[data-sonner-toaster],[data-slot=tooltip-content]";

async function startProbe(page) {
  await page.evaluate((ok) => {
    const probe = { hits: [], frames: 0, run: true };
    window.__sidebarProbe = probe;
    const tick = () => {
      if (!probe.run) return;
      const box = [...document.querySelectorAll("[data-slot=sidebar-container],[data-mobile=true]")]
        .map((el) => el.getBoundingClientRect()).find((r) => r.width > 0 && r.left >= -1 && r.right <= window.innerWidth + 1);
      if (box) {
        probe.frames += 1;
        for (let y = box.top + 8; y < box.bottom - 8; y += 16) {
          for (const dx of [4, 8, 14]) {
            const x = box.right - 2 - dx;
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest(ok)) {
              probe.hits.push({ x: Math.round(x), y: Math.round(y), el: `${el.tagName.toLowerCase()}.${String(el.className || "").split(" ").slice(0, 4).join(".")}`, text: (el.textContent || "").trim().slice(0, 30) });
            }
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, FOREIGN_OK);
}
const stopProbe = (page) => page.evaluate(() => { const p = window.__sidebarProbe; if (p) p.run = false; return p ? { hits: p.hits, frames: p.frames } : { hits: [], frames: 0 }; });

/** Page-coloured pixels (beige / near-white) in the sidebar strip of one frame. */
async function foreignPixels(png, strip) {
  const scaled = Object.fromEntries(Object.entries(strip).map(([k, v]) => [k, Math.round(v * DSF)]));
  const { data, info } = await sharp(png).extract(scaled).raw().toBuffer({ resolveWithObject: true });
  let bad = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 185 && g > 185 && b > 160) bad += 1;
  }
  return bad;
}

async function sidebarStrip(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-slot=sidebar-container],[data-mobile=true]")].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // 6 px just inside the right border, below the header row, above the footer.
    return { left: Math.max(0, Math.round(r.right - 10)), top: Math.round(r.top + 64), width: 6, height: Math.max(1, Math.round(r.height - 140)) };
  });
}

async function expandAllGroups(page) {
  for (let i = 0; i < 12; i += 1) {
    const closed = page.locator("[data-nav-group] button[aria-expanded=false]");
    if (!(await closed.count())) break;
    await closed.first().evaluate((b) => b.click());
  }
}

async function sweepSidebar(page, role, label) {
  const report = { role, label, pages: [] };
  await expandAllGroups(page);
  const links = await page.locator("[data-slot=sidebar-container] a[href*='page='], [data-mobile=true] a[href*='page=']").evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  for (const href of links) {
    if (/rfid-terminal|kiosk/.test(href)) continue; // the kiosk leaves the portal
    const strip = await sidebarStrip(page);
    await startProbe(page);
    const link = page.locator(`[data-slot=sidebar-container] a[href="${href}"], [data-mobile=true] a[href="${href}"]`).first();
    if (!(await link.count())) { await stopProbe(page); continue; }
    await link.evaluate((a) => a.click()); // a DOM click: no hover change in the sidebar
    let worst = 0;
    const started = Date.now();
    while (Date.now() - started < 900) {
      if (strip) {
        const png = await page.screenshot({ animations: "allow" }).catch(() => null);
        if (png) {
          const bad = await foreignPixels(png, strip);
          if (bad > worst) { worst = bad; if (bad > 3) writeFileSync(join(OUT, `glitch-${role}-${label}-${href.replace(/\W+/g, "_")}.png`), png); }
        }
      }
      await page.waitForTimeout(50);
    }
    const probe = await stopProbe(page);
    report.pages.push({ href, probeHits: probe.hits.length, sample: probe.hits.slice(0, 3), frames: probe.frames, worstForeignPixels: worst });
    await main(page).waitFor();
  }
  return report;
}

const ROLE_PORTALS = [["super_admin", "/super-admin"], ["admin", "/admin"], ["hr", "/hr"], ["accountant", "/accountant"], ["employee", "/employee"]];

for (const [role, portal] of ROLE_PORTALS) {
  test.describe(`Part 4 sidebar: ${role}`, () => {
    test.use({ storageState: stateFile(role) });
    test(`${role}: nothing from the page draws inside the sidebar while navigating (1366 expanded + collapsed, 390 menu)`, async ({ page }) => {
      test.setTimeout(15 * 60 * 1000);
      const all = [];
      await openPage(page, portal, "", DESKTOP);
      // Positive control: page-coloured content over the sidebar IS caught by both checks.
      {
        const strip = await sidebarStrip(page);
        await page.evaluate(() => { const d = document.createElement("div"); d.id = "__ctl"; Object.assign(d.style, { position: "fixed", inset: "0", background: "#f6f7f3", zIndex: "60" }); document.body.appendChild(d); });
        await startProbe(page);
        await page.waitForTimeout(150);
        const control = await stopProbe(page);
        const px = await foreignPixels(await page.screenshot(), strip);
        await page.evaluate(() => document.getElementById("__ctl").remove());
        expect(control.hits.length, "probe sees a planted overlay").toBeGreaterThan(0);
        expect(px, "pixel check sees a planted overlay").toBeGreaterThan(3);
      }
      const save = () => writeFileSync(join(OUT, `sidebar-${role}.json`), JSON.stringify(all, null, 2));
      all.push(await sweepSidebar(page, role, "1366-expanded"));
      save();
      await page.getByRole("button", { name: "Toggle navigation" }).first().click();
      await page.waitForTimeout(400);
      all.push(await sweepSidebar(page, role, "1366-collapsed"));
      save();
      await page.getByRole("button", { name: "Toggle navigation" }).first().click();

      // Phone: the menu is a sheet; it is checked while open over each page.
      await openPage(page, portal, "", PHONE);
      const phone = { role, label: "390-menu", pages: [] };
      await page.getByRole("button", { name: "Toggle navigation" }).first().click();
      await page.locator("[data-mobile=true]").waitFor();
      await expandAllGroups(page);
      const ids = await page.evaluate(() => [...document.querySelectorAll("[data-mobile=true] a[href*='page=']")].map((a) => a.getAttribute("href")));
      await page.keyboard.press("Escape");
      for (const href of [...new Set(ids)].slice(0, 8)) {
        await page.goto(`${portal}${href}`);
        await main(page).waitFor();
        await startProbe(page);
        await page.getByRole("button", { name: "Toggle navigation" }).first().click();
        await page.waitForTimeout(500);
        const probe = await stopProbe(page);
        const strip = await sidebarStrip(page);
        const bad = strip ? await foreignPixels(await page.screenshot(), strip) : 0;
        phone.pages.push({ href, probeHits: probe.hits.length, sample: probe.hits.slice(0, 3), frames: probe.frames, worstForeignPixels: bad });
        await page.keyboard.press("Escape");
      }
      all.push(phone);
      save();
      const bad = all.flatMap((r) => r.pages.filter((p) => p.probeHits || p.worstForeignPixels > 3).map((p) => `${r.label} ${p.href}: ${p.probeHits} hits, ${p.worstForeignPixels} px ${JSON.stringify(p.sample)}`));
      if (AFTER) expect(bad, bad.join("\n")).toEqual([]);
    });
  });
}

test.describe("Part 4 overlays stay above the sidebar", () => {
  test.use({ storageState: stateFile("hr") });
  test("a dialog, a dropdown and a toast appear above the sidebar", async ({ page }) => {
    test.skip(!AFTER, "after only");
    await openPage(page, "/hr", "hr-schedules");
    // Dropdown: the account menu in the sidebar footer opens to the right, over the page.
    await page.locator("[data-slot=sidebar-footer] button").first().click();
    const menu = page.getByRole("menu").first();
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const top = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[role=menu]"), { x: box.x + 10, y: box.y + 10 });
    expect(top).toBe(true);
    await page.keyboard.press("Escape");
    // Dialog: covers the sidebar too (its overlay is on top at the sidebar's middle).
    await page.getByRole("button", { name: "New schedule" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const overSidebar = await page.evaluate(() => {
      const r = document.querySelector("[data-slot=sidebar-container]").getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !el.closest("[data-slot=sidebar-container]");
    });
    expect(overSidebar).toBe(true);
    await shot(page, "overlay-dialog-1366");
    await page.keyboard.press("Escape");
    // Tooltip on an upcoming-change chip: above everything.
    const chip = main(page).getByTestId("ws-upcoming").first();
    if (await main(page).getByRole("button", { name: "Expand all" }).count()) await main(page).getByRole("button", { name: "Expand all" }).click();
    if (await chip.count()) {
      await chip.focus();
      await expect(page.locator("[data-slot=tooltip-content]").first()).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------- Part 1
test.describe("Part 1 Work Schedules (HR)", () => {
  test.use({ storageState: stateFile("hr") });

  test("screenshots", async ({ page }) => {
    for (const [vp, tag] of [[DESKTOP, "1366"], [PHONE, "390"]]) {
      await openPage(page, "/hr", "hr-schedules", vp);
      const card = main(page).locator("[data-slot=card]", { hasText: "Employees and their schedules" });
      await card.scrollIntoViewIfNeeded();
      await shot(page, `ws-collapsed-${tag}`);
      if (AFTER) {
        await card.getByRole("button", { name: /^Main Branch/ }).click();
        await shot(page, `ws-one-open-${tag}`);
        await card.getByRole("checkbox", { name: /Select all in Main Branch$/ }).click();
        await shot(page, `ws-selected-${tag}`);
        await card.getByRole("button", { name: "Clear" }).click();
        await card.getByRole("searchbox").fill("Benjie");
        await shot(page, `ws-search-${tag}`);
        expect(await noSideScroll(page)).toBe(true);
      }
    }
  });

  test("collapsed headers fit one screen; counts match the server; search, filters, expand/collapse", async ({ page }) => {
    test.skip(!AFTER, "after only");
    await openPage(page, "/hr", "hr-schedules");
    const api = await (await page.request.get("/api/admin/work-schedules")).json();
    const byBranch = new Map();
    api.employees.forEach((e) => { const k = e.branch_name || "No branch"; byBranch.set(k, [...(byBranch.get(k) || []), e]); });
    const card = main(page).locator("[data-slot=card]", { hasText: "Employees and their schedules" });
    const heads = card.locator("[data-testid=ws-branch]");
    await expect(heads).toHaveCount(byBranch.size);
    const boxes = await heads.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
    expect(boxes.at(-1)[1] - boxes[0][0]).toBeLessThan(DESKTOP.height - 120);
    if (byBranch.has("No branch")) await expect(heads.last()).toContainText("No branch");
    const summary = [];
    for (const [name, list] of byBranch) {
      const head = card.locator(`[data-testid=ws-branch][data-branch="${name}"]`);
      const own = list.filter((e) => e.follows?.source === "employee").length;
      const def = list.filter((e) => e.follows?.source === "default").length;
      const up = list.filter((e) => e.own_upcoming?.length).length;
      await expect(head).toContainText(`${list.length} employee${list.length === 1 ? "" : "s"}`);
      if (def) await expect(head).toContainText(`${def} Default`);
      if (own) await expect(head).toContainText(`${own} own schedule`);
      if (up) await expect(head).toContainText(`${up} upcoming change`);
      summary.push({ branch: name, employees: list.length, default: def, own, upcoming: up, text: (await head.innerText()).replace(/\s+/g, " ") });
    }
    writeFileSync(join(OUT, "ws-branch-summary.json"), JSON.stringify(summary, null, 2));
    // Nothing open: no employee rows.
    await expect(card.locator("[data-testid=ws-row]")).toHaveCount(0);
    await card.getByRole("button", { name: "Expand all" }).click();
    const shown = await card.locator("[data-testid=ws-row]").count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(api.employees.length);
    await card.getByRole("button", { name: "Collapse all" }).click();
    await expect(card.locator("[data-testid=ws-row]")).toHaveCount(0);
    // Search opens the matching branch and shows only matches.
    await card.getByRole("searchbox").fill("Andrea");
    await expect(card.locator("[data-testid=ws-row]")).toHaveCount(api.employees.filter((e) => /andrea/i.test(`${e.full_name} ${e.employee_code} ${e.follows?.name} ${e.branch_name}`)).length);
    await card.getByRole("searchbox").fill("zzzz-nobody");
    await expect(card.getByText("No employees match")).toBeVisible();
    await card.getByRole("searchbox").fill("");
    // Schedule filter: Own schedule.
    await card.getByRole("combobox", { name: "Schedule" }).click();
    await page.getByRole("option", { name: "Own schedule" }).click();
    await expect(card.locator("[data-testid=ws-row]")).toHaveCount(api.employees.filter((e) => e.follows?.source === "employee").length);
    await card.getByRole("combobox", { name: "Schedule" }).click();
    await page.getByRole("option", { name: "Has upcoming change" }).click();
    await expect(card.locator("[data-testid=ws-row]")).toHaveCount(api.employees.filter((e) => e.own_upcoming?.length).length);
  });

  test("ticking a branch / level selects every employee in it (hidden ones too) and Assign / Set level get exactly those", async ({ page }) => {
    test.skip(!AFTER, "after only");
    await openPage(page, "/hr", "hr-schedules");
    const api = await (await page.request.get("/api/admin/work-schedules")).json();
    const mainIds = api.employees.filter((e) => e.branch_name === "Main Branch").map((e) => e.id).sort();
    const card = main(page).locator("[data-slot=card]", { hasText: "Employees and their schedules" });
    // Collapsed branch: tick it anyway.
    await card.getByRole("checkbox", { name: /Select all in Main Branch$/ }).click();
    const bar = page.getByTestId("ws-action-bar");
    await expect(bar).toContainText(`${mainIds.length} selected`);
    let sent = null;
    await page.route("**/api/admin/work-schedules", async (route) => {
      if (route.request().method() === "POST") { sent = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: "{\"success\":true}" }); } else await route.continue();
    });
    await bar.getByRole("button", { name: "Assign schedule" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect.poll(() => sent).not.toBeNull();
    expect([...sent.employee_ids].sort()).toEqual(mainIds);
    expect(sent.action).toBe("assign");
    // A level of a branch, partial state on the branch box.
    sent = null;
    await card.getByRole("button", { name: /^Main Branch/ }).click();
    const levelBox = card.locator("[data-testid=ws-level]").first().getByRole("checkbox");
    await levelBox.click();
    const levelCount = Number((await card.locator("[data-testid=ws-level]").first().getAttribute("data-count")) || 0);
    await expect(bar).toContainText(`${levelCount} selected`);
    await bar.getByRole("button", { name: "Set level" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent.action).toBe("set_level");
    expect(sent.employee_ids.length).toBe(levelCount);
    // One row unticked: the branch box shows the partial state.
    await card.getByRole("checkbox", { name: /Select all in Main Branch$/ }).click();
    await card.locator("[data-testid=ws-row]").first().getByRole("checkbox").click();
    await expect(card.getByRole("checkbox", { name: /Select all in Main Branch$/ })).toHaveAttribute("data-state", "indeterminate");
    // Phone: no sideways scroll, action bar visible.
    await page.setViewportSize(PHONE);
    expect(await noSideScroll(page)).toBe(true);
    await expect(bar).toBeInViewport();
  });
});

test.describe("Part 1 Admin scope", () => {
  test.use({ storageState: stateFile("admin") });
  test("Admin reads only its own branch's employees (server)", async ({ page }) => {
    test.skip(!AFTER, "after only");
    const res = await page.request.get("/api/admin/work-schedules");
    if (res.status() === 403) return; // not allowed at all is narrower still
    const data = await res.json();
    const branches = new Set((data.employees || []).map((e) => e.branch_name));
    expect(branches.size).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- Part 2
async function thumbCheck(sw) {
  return sw.evaluate((el) => {
    const t = el.querySelector("[data-slot=switch-thumb]").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { w: Math.round(t.width), h: Math.round(t.height), inside: t.left >= r.left - 0.5 && t.right <= r.right + 0.5, right: t.left - r.left > r.width / 3 };
  });
}

test.describe("Part 2 switch", () => {
  test.use({ storageState: stateFile("hr") });
  test("Early Bird switch: same round knob on and off, inside the track, Space toggles, nothing saved until Save", async ({ page }) => {
    await openPage(page, "/hr", "hr-schedules");
    const sw = main(page).locator("#eb-exclude");
    await sw.scrollIntoViewIfNeeded();
    const before = await (await page.request.get("/api/admin/early-bird")).json();
    const wrap = sw.locator("xpath=../..");
    const first = await sw.getAttribute("aria-checked");
    await shot(wrap, `switch-${first === "true" ? "on" : "off"}`);
    const a = await thumbCheck(sw);
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", first === "true" ? "false" : "true");
    await shot(wrap, `switch-${first === "true" ? "off" : "on"}`);
    const b = await thumbCheck(sw);
    writeFileSync(join(OUT, "switch-thumb.json"), JSON.stringify({ first, a, b }, null, 2));
    if (!AFTER) return;
    expect(a.w).toBe(b.w);
    expect(a.h).toBe(b.h);
    expect(a.w).toBe(a.h);
    expect(a.inside && b.inside).toBe(true);
    await expect(wrap).toContainText(first === "true" ? "No" : "Yes");
    // The label toggles it back.
    await main(page).getByText("Unexcused absence makes ineligible").click();
    await expect(sw).toHaveAttribute("role", "switch");
    await expect(sw).toHaveAttribute("aria-checked", first);
    const after = await (await page.request.get("/api/admin/early-bird")).json();
    expect(JSON.stringify(after.settings ?? after)).toBe(JSON.stringify(before.settings ?? before));
    // Touch target: at least 40 px tall (the hit area around the track).
    const hit = await sw.evaluate((el) => { const s = getComputedStyle(el, "::before"); return parseFloat(s.top) * -2 + el.getBoundingClientRect().height; });
    expect(hit).toBeGreaterThanOrEqual(40);
  });

  test("Tenure Pay Protection switch has the same knob", async ({ page }) => {
    await openPage(page, "/hr", "hr-tenure");
    const add = main(page).getByRole("button", { name: /Add|New/ }).first();
    if (await add.count()) await add.click().catch(() => {});
    const sw = page.locator("[data-slot=switch]").first();
    if (!(await sw.count())) test.skip(true, "no tenure switch on screen");
    await shot(sw.locator("xpath=.."), "switch-tenure");
    const k = await thumbCheck(sw);
    if (AFTER) { expect(k.w).toBe(k.h); expect(k.inside).toBe(true); }
  });
});

test.describe("Part 2 switch (Super Admin)", () => {
  test.use({ storageState: stateFile("super_admin") });
  test("Leave conversion switch has the same knob", async ({ page }) => {
    await openPage(page, "/super-admin", "sa-config");
    await main(page).getByRole("tab", { name: "Tax & contributions" }).click();
    const sw = main(page).locator("#lc-enabled");
    await sw.scrollIntoViewIfNeeded();
    await shot(sw.locator("xpath=.."), "switch-leave-conversion");
    const k = await thumbCheck(sw);
    if (AFTER) { expect(k.w).toBe(k.h); expect(k.inside).toBe(true); }
  });

  // ------------------------------------------------------------ Part 3
  test("license warning: Save warning sits next to its box; saves the same value and audit entry", async ({ page }) => {
    for (const [vp, tag] of [[DESKTOP, "1366"], [PHONE, "390"]]) {
      await openPage(page, "/super-admin", "sa-config", vp);
      await main(page).getByRole("tab", { name: "Payroll" }).click();
      const input = main(page).locator("#sub-warn");
      await input.scrollIntoViewIfNeeded();
      const block = input.locator("xpath=ancestor::div[contains(@class,'border')][1]");
      await shot(block, `license-warning-${tag}`);
      if (!AFTER) continue;
      const button = main(page).getByRole("button", { name: "Save warning" });
      const [i, b] = [await input.boundingBox(), await button.boundingBox()];
      if (tag === "1366") {
        const gap = b.x - (i.x + i.width);
        expect(gap).toBeLessThanOrEqual(16);
        expect(Math.abs((i.y + i.height / 2) - (b.y + b.height / 2))).toBeLessThanOrEqual(2);
        writeFileSync(join(OUT, "license-gap.json"), JSON.stringify({ input: i, button: b, gap }, null, 2));
      }
      expect(await noSideScroll(page)).toBe(true);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }
    if (!AFTER) return;
    await page.setViewportSize(DESKTOP);
    const [stored] = await rows("select value from system_config where section='hr' and key='license_expiry_warning_days'");
    const value = stored?.value || "60";
    await main(page).locator("#sub-warn").fill(value);
    await main(page).getByRole("button", { name: "Save warning" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Saved" }).first()).toBeVisible();
    const [now] = await rows("select value from system_config where section='hr' and key='license_expiry_warning_days'");
    expect(now.value).toBe(value);
    const [audit] = await rows("select action, module from audit_logs order by created_at desc limit 1");
    expect(audit).toMatchObject({ action: "license_warning_days", module: "system" });
  });
});

// ---------------------------------------------------------------- Parts 5 + 6
test.describe("Parts 5-6 Process Payroll (Accountant, Main Branch)", () => {
  test.use({ storageState: stateFile("accountant") });

  test("no Action needed panel anywhere; the three actions stay reachable", async ({ page }) => {
    for (const [vp, tag] of [[DESKTOP, "1366"], [PHONE, "390"]]) {
      await openPage(page, "/accountant", "ac-process", vp);
      await shot(page, `process-top-${tag}`);
      if (!AFTER) continue;
      await expect(main(page).getByTestId("action-needed")).toHaveCount(0);
      await expect(main(page).getByText("Action needed", { exact: true })).toHaveCount(0);
      await expect(main(page).getByText(/What is still open for payroll/)).toHaveCount(0);
      expect(await noSideScroll(page)).toBe(true);
    }
    if (!AFTER) return;
    await openPage(page, "/accountant", "ac-dashboard");
    await expect(main(page).getByTestId("action-needed")).toHaveCount(0);
    // The view is gone from the API too.
    const res = await page.request.get("/api/accountant/payroll-runs?view=action_needed");
    expect((await res.json()).items).toBeUndefined();
    // Finalize a draft: the Drafts group link.
    await openPage(page, "/accountant", "ac-process&period=November%201-15%2C%202026");
    await expect(main(page).getByTestId("group-drafts").getByTestId("review-draft").first()).toBeAttached();
    // Submit for HR approval: the run card's button.
    await expect(main(page).getByTestId("submit-run").first()).toBeAttached();
  });

  test("Review and finalize opens the single-entry draft; finalizing works once; another branch is refused", async ({ page, context }) => {
    test.skip(!AFTER, "after only");
    test.setTimeout(5 * 60 * 1000);
    const [draft] = await rows("select e.id, e.employee_id, e.employee_name, e.pay_period, (e.payroll->'totals'->>'net_pay') as net from payroll_entries e join branches b on b.id=e.branch_id where e.status='draft' and b.name='Main Branch' order by e.employee_name limit 1");
    expect(draft, "a Main Branch draft in the demo data").toBeTruthy();
    await openPage(page, "/accountant", `ac-process&period=${encodeURIComponent(draft.pay_period)}`);
    const drafts = main(page).getByTestId("group-drafts");
    await drafts.locator("summary").click().catch(() => {});
    const link = drafts.locator(`[data-testid=run-row][data-employee="${draft.employee_name}"]`).getByRole("link", { name: /Review and finalize/ });
    const href = await link.getAttribute("href");
    expect(href).toContain(`draft=${draft.id}`);
    await shot(drafts, "drafts-list-1366");
    // A new tab opens the same draft.
    const tab = await context.newPage();
    await tab.setViewportSize(DESKTOP);
    await tab.goto(`/accountant${href}`);
    await expect(tab.locator("#pc-entry")).toContainText("Editing saved entry");
    await expect(tab.locator("#pc-employee")).toContainText(draft.employee_name);
    await tab.close();
    // In place: the form fills and scrolls into view.
    await link.click();
    await expect(page).toHaveURL(new RegExp(`draft=${draft.id}`));
    await expect(main(page).locator("#pc-employee")).toContainText(draft.employee_name);
    await expect(main(page).locator("#pc-entry")).toBeInViewport();
    await shot(page, "single-entry-draft-1366");
    // Finalize there.
    await main(page).getByRole("button", { name: /Finalize draft/ }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Draft Finalized|Payroll Processed/ }).first()).toBeVisible({ timeout: 60000 });
    // Finalized in place: the same entry, now Final, with a payslip number from the usual sequence.
    const [final] = await rows(`select status, payslip_no from payroll_entries where id='${draft.id}'`);
    expect(final.status).toBe("paid");
    expect(final.payslip_no).toMatch(/^PS-\d{6}-\d{4}$/);
    await expect(main(page).locator(`[data-testid=group-drafts] [data-employee="${draft.employee_name}"]`)).toHaveCount(0);
    // The same link again: a clear message, not an error page.
    await page.goto(`/accountant${href}`);
    await expect(main(page).getByTestId("draft-gone")).toContainText("This draft was already finalized");
    const [audit] = await rows(`select action, description from audit_logs where module='payroll' and action='process' order by created_at desc limit 1`);
    expect(audit.description).not.toMatch(/₱|\d+\.\d\d/);
  });

  test.describe("the branch with a run Pending HR Approval (Robinson, one Accountant)", () => {
    test.use({ storageState: stateFile("accountant_single") });
    test("View a run pending HR approval: its run card on Process Payroll", async ({ page }) => {
      test.skip(!AFTER, "after only");
      await openPage(page, "/accountant", "ac-process&period=October%2016-31%2C%202026");
      await expect(main(page).locator("[data-testid=run-card][data-status=pending]").first()).toBeVisible();
    });
  });

  test("another branch's draft is refused by direct API call", async ({ page }) => {
    test.skip(!AFTER, "after only");
    const [other] = await rows("select e.id, e.employee_id, e.pay_period from payroll_entries e join branches b on b.id=e.branch_id where e.status='draft' and b.name='Robinson Branch' limit 1");
    const post = await page.request.post("/api/accountant/payroll", { data: { action: "submit", entry_id: other.id, employee_id: other.employee_id, pay_period: other.pay_period } });
    expect([403, 404]).toContain(post.status());
    const cancel = await page.request.patch("/api/accountant/payroll", { data: { action: "cancel_draft", entry_id: other.id } });
    expect(cancel.status()).toBe(403);
    const [still] = await rows(`select status from payroll_entries where id='${other.id}'`);
    expect(still.status).toBe("draft");
  });
});

// ---------------------------------------------------------------- Needs correction (2026-11-16)
// A Paid 2nd half computed with an old 1st half: planted LOCALLY by changing
// only that payslip's stored 1st-half basis (restored afterwards). The badge
// shows on its row and payslip for the branch's Accountant and HR, nowhere
// else, and goes once a correction is filed.
test.describe("Needs correction warning", () => {
  test("only when true; on the row and the payslip; Accountant of the branch + HR; gone once corrected; amounts unchanged", async ({ browser }) => {
    test.skip(!AFTER, "after only");
    test.setTimeout(5 * 60 * 1000);
    const PERIOD = "September 16-30, 2026";
    const [target] = await rows(`select e.id, e.employee_name, e.payroll->'monthly'->'first_half_basis' as basis,
      e.payroll->'totals' as totals, e.payslip_no from payroll_entries e join branches b on b.id = e.branch_id
      join payroll_runs r on r.id = e.run_id where b.name = 'Main Branch' and e.pay_period = '${PERIOD}' and e.status = 'paid'
      and r.status = 'approved' and e.payroll->'monthly'->'first_half_basis' is not null order by e.employee_name limit 1`);
    expect(target, "a Paid Main Branch 2nd half with a 1st-half basis").toBeTruthy();
    const open = async (role, path) => {
      const context = await browser.newContext({ storageState: stateFile(role), viewport: DESKTOP });
      await fixClock(context);
      const page = await context.newPage();
      await page.goto(path);
      await main(page).waitFor();
      await page.waitForFunction(() => !document.querySelector("#portal-main [data-slot=skeleton]"), null, { timeout: 30000 }).catch(() => {});
      return { page, context };
    };
    const acctRecords = `/accountant?page=ac-records`;
    const hrRecords = `/hr?page=hr-payroll-records&pr_period=${encodeURIComponent(PERIOD)}`;
    const search = async (page, text) => { await main(page).getByRole("searchbox").first().fill(text); await page.waitForTimeout(400); };

    // 1. Not true yet: no warning on either screen.
    for (const [role, path] of [["accountant", acctRecords], ["hr", hrRecords]]) {
      const { page, context } = await open(role, path);
      await expect(main(page).getByTestId("needs-correction")).toHaveCount(0);
      await context.close();
    }

    // 2. Plant: the 1st half this payslip was computed with differs by ₱100 (only the stored basis).
    // Local fixture only: the Final-payslip lock is bypassed for this one planted edit (and its restore).
    psql(`set session_replication_role = replica; update payroll_entries set payroll = jsonb_set(payroll, '{monthly,first_half_basis,net_pay}', to_jsonb((payroll->'monthly'->'first_half_basis'->>'net_pay')::numeric - 100)) where id = '${target.id}'`);
    try {
      // Accountant of Main: the row badge, Correct opens the dialog with the suggested values; nothing filed.
      {
        const { page, context } = await open("accountant", acctRecords);
        await search(page, target.employee_name);
        const row = main(page).locator("tr", { hasText: PERIOD }).filter({ hasText: target.employee_name });
        await expect(row.getByTestId("needs-correction")).toContainText("Needs correction: computed with an old 1st half");
        await expect(main(page).getByTestId("needs-correction")).toHaveCount(1);
        await shot(row, "needs-correction-row-accountant");
        await row.getByTestId("needs-correction").getByRole("button", { name: "Correct" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.locator("input[type=number]").first()).toHaveValue(/^100(\.00?)?$/);
        await shot(dialog, "needs-correction-dialog");
        await page.keyboard.press("Escape");
        // The payslip view (the row's Payslip button): the same warning, with the way to the correction.
        await row.getByRole("button", { name: "Payslip" }).click();
        const note = main(page).getByTestId("needs-correction-note");
        await expect(note).toBeVisible({ timeout: 30000 });
        // Clean payslip (2026-11-16): no explanation lines under the items; each is behind its ⓘ.
        const lineList = main(page).getByTestId("payroll-line-groups");
        await expect(lineList.locator("li[data-line] > p")).toHaveCount(0);
        await expect(lineList.getByTestId("info-tip").first()).toBeVisible();
        await lineList.getByTestId("info-tip").first().click();
        await expect(page.locator("[data-slot=popover-content]").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await shot(page, "needs-correction-payslip-accountant");
        await note.getByRole("link", { name: "Correct in Payroll Records" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await context.close();
      }
      // HR: the row badge (no filing), the payslip note linking to Payroll Approval.
      {
        const { page, context } = await open("hr", hrRecords);
        await search(page, target.employee_name);
        const row = main(page).locator("tr").filter({ hasText: target.employee_name });
        await expect(row.getByTestId("needs-correction")).toBeVisible();
        await expect(row.getByTestId("needs-correction").getByRole("button")).toHaveCount(0);
        await row.getByRole("button", { name: "View" }).click();
        const note = main(page).getByTestId("needs-correction-note");
        await expect(note).toBeVisible();
        await expect(note.getByRole("link", { name: "Corrections in Payroll Approval" })).toBeVisible();
        // Clean payslip (2026-11-16): no explanation lines under the items; each is behind its ⓘ.
        const lineList = main(page).getByTestId("payroll-line-groups");
        await expect(lineList.locator("li[data-line] > p")).toHaveCount(0);
        await expect(lineList.getByTestId("info-tip").first()).toBeVisible();
        await lineList.getByTestId("info-tip").first().click();
        await expect(page.locator("[data-slot=popover-content]").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await shot(page, "needs-correction-payslip-hr");
        await context.close();
      }
      // Another branch's Accountant: never sees it (their records hold no Main payslip).
      {
        const { page, context } = await open("accountant_single", acctRecords);
        await expect(main(page).getByTestId("needs-correction")).toHaveCount(0);
        const api = await (await page.request.get(`/api/accountant/payroll?period=${encodeURIComponent(PERIOD)}`)).json();
        expect((api.history_records || []).some((r) => r.id === target.id)).toBe(false);
        await context.close();
      }
      // 3. A correction filed (Pending): the warning is gone.
      psql(`insert into payroll_corrections (entry_id, employee_id, branch_id, period_label, kind, amount, reason, status, requested_by_name)
        select e.id, e.employee_id, e.branch_id, e.pay_period, 'underpayment', 100, 'E2E planted check', 'pending', 'E2E' from payroll_entries e where e.id = '${target.id}'`);
      {
        const { page, context } = await open("accountant", acctRecords);
        await search(page, target.employee_name);
        await expect(main(page).getByTestId("needs-correction")).toHaveCount(0);
        await context.close();
      }
    } finally {
      // Restore first, then remove the planted correction (hard deletes are refused outside replica mode).
      psql(`set session_replication_role = replica; update payroll_entries set payroll = jsonb_set(payroll, '{monthly,first_half_basis}', '${JSON.stringify(target.basis)}'::jsonb) where id = '${target.id}'`);
      psql(`set session_replication_role = replica; delete from payroll_corrections where entry_id = '${target.id}' and reason = 'E2E planted check'`);
    }
    // 4. Amounts and payslip number unchanged.
    const [after] = await rows(`select e.payroll->'totals' as totals, e.payslip_no, e.payroll->'monthly'->'first_half_basis' as basis from payroll_entries e where e.id = '${target.id}'`);
    expect(after.totals).toEqual(target.totals);
    expect(after.payslip_no).toBe(target.payslip_no);
    expect(after.basis).toEqual(target.basis);
  });
});

