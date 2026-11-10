// The narrower sidebar (2026-11-08), every role, local stack only:
//   width 13rem in one place; labels never wrap or spill (a cut label shows
//   its full text on hover); header and footer fit; the page fills the freed
//   space; collapse toggle (icons, tooltips, saved); phone / tablet drawer at
//   360, 390, 768 px with touch (40 px rows); light and dark; zoom 125 / 150 %.
//
//   SHOTS=before|after E2E_SLOWMO=500 npx playwright test e2e/specs/99-sidebar-narrow.spec.mjs --project=desktop
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle, pageOverflow } from "../support/portal.mjs";

const PHASE = process.env.SHOTS || "after";
const SHOTS = join(process.cwd(), "screenshots", "2026-11-08-sidebar", PHASE);
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

const ROLES = [
  ["super_admin", "sa-accounts"],
  ["admin", "adm-leaves"],
  ["hr", "hr-employees"],
  ["accountant", "ac-monitoring"],
  ["employee", "emp-timesheet"],
];
const results = [];
const cut = {};
function check(where, ok, text) {
  results.push({ where, ok, text });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  expect.soft(ok, `${where}: ${text}`).toBe(true);
}

/** What the sidebar looks like right now. */
async function measure(page) {
  return page.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const container = document.querySelector('[data-slot="sidebar-container"]');
    const inset = document.querySelector('[data-slot="sidebar-inset"]');
    const buttons = [...document.querySelectorAll('[data-sidebar="content"] [data-sidebar="menu-button"]')].filter((b) => b.getBoundingClientRect().height > 0); // collapsed groups (2026-11-09) hide theirs
    const labels = buttons.map((b) => {
      const span = b.querySelector("[data-fit]") || b.querySelector("span:last-child");
      const lineHeight = parseFloat(getComputedStyle(span).lineHeight) || 20;
      return {
        text: span.textContent.trim(),
        cut: span.scrollWidth > span.clientWidth + 1,
        wraps: span.getBoundingClientRect().height > lineHeight * 1.5,
        spills: b.getBoundingClientRect().right > container.getBoundingClientRect().right + 0.5,
        height: b.getBoundingClientRect().height,
        fontSize: parseFloat(getComputedStyle(span).fontSize),
      };
    });
    const fits = (sel) => [...document.querySelectorAll(sel)].every((el) => el.getBoundingClientRect().right <= container.getBoundingClientRect().right + 0.5);
    return {
      width: box(container)?.width || 0,
      insetLeft: box(inset)?.left || 0,
      insetRight: box(inset)?.right || 0,
      sidebarRight: box(container)?.right || 0,
      viewport: document.documentElement.clientWidth,
      labels,
      headerFits: fits('[data-sidebar="header"] *'),
      footerFits: fits('[data-sidebar="footer"] *'),
      footerVisible: (() => { const f = box(document.querySelector('[data-sidebar="footer"]')); return Boolean(f && f.bottom <= window.innerHeight + 1 && f.top >= 0); })(),
      headerTools: [...document.querySelectorAll("header button")].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 0.5),
      scrollbar: (() => { const c = document.querySelector('[data-sidebar="content"]'); return c ? c.offsetWidth - c.clientWidth : 0; })(),
    };
  });
}

/** Luminance contrast of a menu label against the sidebar background. */
async function labelContrast(page) {
  return page.evaluate(() => {
    const rgb = (c) => (c.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const label = document.querySelector('[data-sidebar="content"] [data-sidebar="menu-button"]:not([data-active="true"]) [data-fit]')
      || document.querySelector('[data-sidebar="content"] [data-sidebar="menu-button"] span');
    let bgEl = label;
    let bg = "rgba(0, 0, 0, 0)";
    while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
    const a = lum(rgb(getComputedStyle(label).color));
    const b = lum(rgb(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    for (const key of Object.keys(localStorage)) if (/theme/i.test(key)) localStorage.setItem(key, t);
    localStorage.setItem("sacs-ui-theme", t);
  }, theme);
  await page.reload();
  await settle(page);
}

test("narrow sidebar: every role, laptop and desktop, light and dark, zoom", async ({ page, monitor }) => {
  monitor.allow(/^401 GET /, /status of 401/);

  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    await step(page, `Every role at ${width}x${height}`, async () => {
      await page.setViewportSize({ width, height });
      for (const [role, pageId] of ROLES) {
        await as(page, role, pageId);
        await settle(page);
        const m = await measure(page);
        const where = `${role} ${width}px`;
        if (PHASE === "after") check(where, Math.abs(m.width - 208) <= 3, `sidebar ${Math.round(m.width)} px wide`);
        check(where, m.labels.every((l) => !l.wraps && !l.spills), "no label wraps or spills out");
        check(where, m.labels.every((l) => l.fontSize >= 14), `labels ${Math.min(...m.labels.map((l) => l.fontSize))} px or larger`);
        if (PHASE === "after") check(where, m.labels.every((l) => l.height >= 36), `rows ${Math.round(Math.min(...m.labels.map((l) => l.height)))} px or taller`);
        check(where, m.headerFits && m.footerFits && m.footerVisible, "header and footer fit; footer in view");
        check(where, Math.abs(m.insetLeft - m.sidebarRight) <= 3 && Math.abs(m.insetRight - m.viewport) <= 1, `page starts at the sidebar (${Math.round(m.insetLeft)} / ${Math.round(m.sidebarRight)}) and fills to the edge`);
        check(where, m.headerTools && (await pageOverflow(page)) <= 0, "bell / theme / profile in view, no sideways scroll");
        check(where, m.scrollbar === 0, "no sidebar scrollbar");
        cut[role] = m.labels.filter((l) => l.cut).map((l) => l.text);
        await shot(page, `${role}-${width}`);
      }
    });
  }

  await step(page, "A cut label shows its full text on hover", async () => {
    await page.setViewportSize({ width: 1366, height: 768 });
    for (const [role, pageId] of ROLES) {
      if (!cut[role]?.length) continue;
      await as(page, role, pageId);
      await settle(page);
      const button = page.locator('[data-sidebar="content"] [data-sidebar="menu-button"]', { hasText: cut[role][0] }).first();
      await button.hover();
      check(`${role} tooltip`, (await button.getAttribute("title")) === cut[role][0], `"${cut[role][0]}" has its full text on hover`);
    }
  });

  await step(page, "Collapse toggle: icon width, tooltips, saved after reload", async () => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await as(page, "hr", "hr-employees");
    await settle(page);
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    let m = await measure(page);
    check("Collapsed", m.width >= 48 && m.width <= 60 && Math.abs(m.insetLeft - m.sidebarRight) <= 3, `icon-only ${Math.round(m.width)} px, page follows`);
    const icon = page.locator('[data-sidebar="content"] [data-sidebar="menu-button"]').nth(1);
    await icon.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    check("Collapsed", true, `icon tooltip: ${await page.getByRole("tooltip").innerText()}`);
    await shot(page, "hr-1366-collapsed");
    await page.reload();
    await settle(page);
    m = await measure(page);
    check("Collapsed", m.width < 80, "still collapsed after a reload");
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
  });

  await step(page, "Dark mode: labels readable", async () => {
    await page.setViewportSize({ width: 1366, height: 768 });
    for (const theme of ["light", "dark"]) {
      await as(page, "accountant", "ac-monitoring");
      await setTheme(page, theme);
      const ratio = await labelContrast(page);
      check(`Contrast ${theme}`, ratio >= 4.5, `menu label contrast ${ratio.toFixed(1)}:1`);
      await shot(page, `accountant-1366-${theme}`);
    }
    await setTheme(page, "light");
  });

  for (const zoom of [1.25, 1.5]) {
    await step(page, `Browser zoom ${zoom * 100}% (1366 px laptop)`, async () => {
      await page.setViewportSize({ width: Math.round(1366 / zoom), height: Math.round(768 / zoom) });
      for (const [role, pageId] of [["super_admin", "sa-accounts"], ["hr", "hr-employees"]]) {
        await as(page, role, pageId);
        await settle(page);
        const m = await measure(page);
        check(`${role} zoom ${zoom * 100}%`, m.labels.every((l) => !l.wraps && !l.spills) && m.footerVisible && (await pageOverflow(page)) <= 0, `labels on one line, footer visible (viewport ${m.viewport} CSS px)`);
        await shot(page, `${role}-zoom-${zoom * 100}`);
      }
    });
  }

  writeFileSync(join(SHOTS, "..", `${PHASE}-results.json`), JSON.stringify({ results, cut }, null, 2));
  expect(results.filter((r) => !r.ok).map((r) => `${r.where}: ${r.text}`)).toEqual([]);
});

test("narrow sidebar: phone and tablet drawer with touch", async ({ browser }) => {
  // Under 768 px the sidebar is a slide-in drawer; at 768 px (tablet) the
  // app already shows the regular sidebar, checked as such below.
  for (const width of [360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    for (const [role, pageId] of [["super_admin", "sa-accounts"], ["hr", "hr-employees"], ["accountant", "ac-monitoring"]]) {
      await as(page, role, pageId);
      await settle(page);
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      const drawer = page.locator('[data-slot="sheet-content"][data-sidebar="sidebar"], [data-mobile="true"]').first();
      await drawer.waitFor();
      await page.waitForTimeout(400);
      const info = await drawer.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll('[data-sidebar="menu-button"]')].filter((b) => b.getBoundingClientRect().height > 0);
        return {
          width: r.width,
          cut: rows.map((b) => b.querySelector("[data-fit]")).filter((s) => s && s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent),
          minHeight: Math.min(...rows.map((b) => b.getBoundingClientRect().height)),
        };
      });
      check(`Drawer ${role} ${width}px`, info.width <= width && info.cut.length === 0 && info.minHeight >= 40,
        `drawer ${Math.round(info.width)} px, ${info.cut.length ? `cut: ${info.cut.join(", ")}` : "no label cut"}, rows ${Math.round(info.minHeight)} px`);
      if (role === "hr") await page.screenshot({ path: join(SHOTS, `drawer-${width}.png`) });
      await page.keyboard.press("Escape");
    }
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    for (const [role, pageId] of [["super_admin", "sa-accounts"], ["hr", "hr-employees"], ["accountant", "ac-monitoring"]]) {
      await as(page, role, pageId);
      await settle(page);
      const m = await measure(page);
      check(`Tablet ${role} 768px`, m.labels.every((l) => !l.wraps && !l.spills) && m.labels.every((l) => l.height >= 40) && (await pageOverflow(page)) <= 0,
        `sidebar ${Math.round(m.width)} px, rows ${Math.round(Math.min(...m.labels.map((l) => l.height)))} px (touch), no sideways scroll${m.labels.some((l) => l.cut) ? `; cut: ${m.labels.filter((l) => l.cut).map((l) => l.text).join(", ")}` : ""}`);
      if (role === "hr") await page.screenshot({ path: join(SHOTS, "tablet-768.png") });
    }
    await context.close();
  }
  writeFileSync(join(SHOTS, "..", `${PHASE}-drawer-results.json`), JSON.stringify(results, null, 2));
  expect(results.filter((r) => !r.ok).map((r) => `${r.where}: ${r.text}`)).toEqual([]);
});
