// Full system check 2026-11-28, Part 1 B: every role, every page, at 1366 /
// 1920 / phone width, sidebar open and collapsed, light and dark. Each page is
// measured for the layout rules below; every finding is written to
// test-results/layout-matrix.jsonl with a screenshot (screenshots/2026-11-28-layout/<PHASE>/)
// and fails the test (soft, so one page lists all its problems).
//
//   SHOTS=before|after E2E_RESET=0 npx playwright test e2e/specs/99-layout-matrix-2026-11-28.spec.mjs --project=desktop
//
// Rules: no horizontal page scroll; no tab-bar scroll arrows; no cut-off text
// (a cut text that shows itself on hover, via title, is allowed); nothing
// sticking out past the sidebar edge; filter-bar controls one height and one
// top line; money right-aligned; no ISO dates / "Invalid Date" / "NaN" /
// "undefined" / "[object Object]"; "1 days"-style plurals; no column empty on
// every row; no table showing more than 10 rows; one primary button per card.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { PAGES, main, settle } from "../support/portal.mjs";

const PHASE = process.env.SHOTS || "after";
const SHOTS = join(process.cwd(), "screenshots", "2026-11-28-layout", PHASE);
const LOG = join(process.cwd(), "test-results", "layout-matrix.jsonl");
mkdirSync(SHOTS, { recursive: true });

// name, viewport, theme, sidebar open
const STATES = [
  ["1366-light-open", { width: 1366, height: 768 }, "light", true],
  ["1366-dark-collapsed", { width: 1366, height: 768 }, "dark", false],
  ["1920-dark-open", { width: 1920, height: 1080 }, "dark", true],
  ["1920-light-collapsed", { width: 1920, height: 1080 }, "light", false],
  ["390-light", { width: 390, height: 844 }, "light", true],
  ["390-dark", { width: 390, height: 844 }, "dark", true],
];
const ONLY = process.env.LAYOUT_ROLES ? process.env.LAYOUT_ROLES.split(",") : Object.keys(PAGES);

/** Everything wrong with the layout of the page on screen (runs in the browser). */
function measure() {
  const out = [];
  const add = (rule, text, el) => out.push({ rule, text: String(text).slice(0, 200), at: el ? (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) : "" });
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const root = document.querySelector("#portal-main");
  if (!root) return [{ rule: "no-main", text: "#portal-main missing" }];
  const doc = document.documentElement;
  if (doc.scrollWidth - doc.clientWidth > 1) add("page-scroll-x", `page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);

  // Tab bars that scroll (arrows) or overflow.
  for (const list of root.querySelectorAll('[role="tablist"]')) {
    if (!visible(list)) continue;
    if (list.scrollWidth > list.clientWidth + 1) add("tabs-overflow", `tab bar overflows by ${list.scrollWidth - list.clientWidth}px`, list);
    const arrows = list.parentElement?.querySelectorAll('button[aria-label*="croll" i]') || [];
    if (arrows.length) add("tabs-arrows", "tab bar shows scroll arrows", list);
  }

  // Cut-off text: a leaf text element whose text is wider than its box, with no hover title.
  const textual = root.querySelectorAll("h1,h2,h3,h4,p,span,label,button,a,th,td,[data-slot=badge],[data-slot=select-value]");
  for (const el of textual) {
    if (!visible(el) || el.closest("[data-slot=table-container],[data-radix-scroll-area-viewport],pre,textarea,[data-allow-cut]")) continue;
    if (el.children.length && [...el.children].some((c) => c.textContent.trim())) continue; // leaf text only
    const text = el.textContent.trim();
    if (!text) continue;
    const s = getComputedStyle(el);
    const clipsX = s.overflowX !== "visible" || s.textOverflow === "ellipsis";
    if (clipsX && el.scrollWidth > el.clientWidth + 1 && !el.title && !el.closest("[title]")) add("cut-text", `"${text.slice(0, 60)}" cut (${el.scrollWidth}>${el.clientWidth}px)`, el);
    const box = el.getBoundingClientRect();
    if (box.left < root.getBoundingClientRect().left - 1 && box.right > 0) add("past-sidebar-edge", `"${text.slice(0, 60)}" starts under the sidebar`, el);
  }

  // Filter bars: same height, one top line per row.
  for (const bar of root.querySelectorAll("[data-slot=filter-bar]")) {
    if (!visible(bar)) continue;
    const controls = [...bar.querySelectorAll("input:not([type=checkbox]):not([type=hidden]),[data-slot=select-trigger],[data-slot=popover-trigger],[data-slot=button],button[role=combobox]")]
      .filter((c) => visible(c) && !c.closest("[data-slot=popover-content]") && !c.parentElement.closest("[data-slot=select-trigger],[data-slot=popover-trigger]"));
    const heights = [...new Set(controls.map((c) => Math.round(c.getBoundingClientRect().height)))];
    if (heights.length > 1) add("filter-heights", `filter controls ${heights.join("/")}px high`, bar);
    const rows = new Map();
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      const key = [...rows.keys()].find((k) => Math.abs(k - r.top) < 20) ?? r.top;
      rows.set(key, [...(rows.get(key) || []), r.top]);
    }
    for (const tops of rows.values()) { const d = Math.max(...tops) - Math.min(...tops); if (d > 1) add("filter-misaligned", `filter controls ${Math.round(d)}px off one line`, bar); }
    const wide = window.innerWidth >= 640 && controls.filter((c) => c.matches("[data-slot=select-trigger],button[role=combobox]") && c.getBoundingClientRect().width > 320);
    if (wide && wide.length) add("filter-wide-dropdown", `${wide.length} dropdown(s) wider than 320px`, bar);
  }

  // Tables.
  for (const table of root.querySelectorAll("table")) {
    if (!visible(table)) continue;
    const body = [...table.querySelectorAll("tbody tr")].filter((tr) => visible(tr) && tr.cells.length > 1);
    if (body.length > 10) add("table-rows", `${body.length} rows on one page (want 10)`, table.querySelector("th"));
    const heads = [...table.querySelectorAll("thead th")];
    if (body.length >= 2) heads.forEach((th, i) => {
      if (!th.textContent.trim()) return; // action / checkbox columns
      if (body.every((tr) => { const c = tr.cells[i]; return c && !c.textContent.trim().replace(/[—–-]/g, "") && !c.querySelector("svg,img,input,button"); })) add("empty-column", `column "${th.textContent.trim()}" empty on every row`, th);
    });
    for (const tr of body) for (const td of tr.cells) {
      if (!/^[-−]?\s*₱\s?[\d,]+(\.\d+)?$/.test(td.textContent.trim())) continue;
      const align = getComputedStyle(td).textAlign;
      const inner = td.firstElementChild ? getComputedStyle(td.firstElementChild).textAlign : align;
      if (!["right", "end"].includes(align) && !["right", "end"].includes(inner) && !td.querySelector(".text-right,.justify-end,.ml-auto")) { add("money-left", `money "${td.textContent.trim()}" not right-aligned`, heads[td.cellIndex]); break; }
    }
  }

  // Text that should never show.
  const text = root.innerText;
  const bad = [
    ["iso-date", /\b20\d\d-[01]\d-[0-3]\d\b(?!T)/],
    ["iso-datetime", /\b20\d\d-[01]\d-[0-3]\dT\d\d:/],
    ["invalid-date", /Invalid Date|\bNaN\b|\bundefined\b|\[object Object\]|\bnull\b(?! value)/],
    ["error-screen", /Something went wrong|Application error|Unhandled Runtime Error|Failed to fetch/],
    ["plural", /(^|[^\d.,])1 (days|employees|records|items|hours|payslips|requests|people|minutes|cards|branches|accounts|loans|results|rows)\b/],
    ["junk-text", /\b(lorem ipsum|asdf|TODO|FIXME|xxx)\b/i],
  ];
  for (const [rule, re] of bad) { const m = text.match(re); if (m) add(rule, `shows "${text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ")}"`); }

  // One primary button per card.
  for (const card of root.querySelectorAll("[data-slot=card]")) {
    if (!visible(card) || card.querySelector("[data-slot=card]")) continue;
    const prim = [...card.querySelectorAll('[data-slot=button][data-variant="default"], [data-slot=button]:not([data-variant])')].filter((b) => visible(b) && !b.closest("table,[role=tablist],[data-slot=filter-bar]"));
    if (prim.length > 1) add("primary-buttons", `${prim.length} primary buttons in one card: ${prim.map((b) => b.textContent.trim()).join(" | ").slice(0, 120)}`, card.querySelector("[data-slot=card-title]"));
  }
  // Same-size buttons side by side.
  return out;
}

for (const role of ONLY) {
  test.describe(`${ROLE_LABEL[role]} layout`, () => {
    for (const [name, viewport, theme, open] of STATES) {
      test(`${name}`, async ({ page, context, monitor }) => {
        test.setTimeout(20 * 60_000);
        await page.setViewportSize(viewport);
        await context.addInitScript(([t]) => { try { localStorage.setItem("sacs-ui-theme", t); } catch { /* blocked */ } }, [theme]);
        await context.addCookies([{ name: "sidebar_state", value: String(open), url: `http://127.0.0.1:${process.env.E2E_PORT || 3100}` }]);
        await as(page, role);
        const portal = role === "super_admin" ? "/super-admin" : `/${role}`;
        for (const [id, label] of PAGES[role]) {
          const where = `${ROLE_LABEL[role]} > ${label} @ ${name}`;
          monitor.at(where);
          await page.goto(`${portal}?page=${id}`);
          await main(page).waitFor();
          await settle(page);
          await page.waitForTimeout(400);
          const found = await page.evaluate(measure);
          if (found.length) {
            const file = `${role}-${id}-${name}.png`;
            await page.screenshot({ path: join(SHOTS, file), fullPage: true });
            appendFileSync(LOG, `${JSON.stringify({ role, page: id, label, state: name, shot: file, found })}\n`);
          }
          for (const f of found) expect.soft(f, where).toBeUndefined();
        }
      });
    }
  });
}
