// The downloads (G10): tester guide PDF, roster PDF (no passwords), and the
// empty-page audit table (CSV + PDF), into demo-data/ (gitignored).
//   node scripts/demo/make-docs.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { DATA_DIR } from "./config.mjs";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = async (browser, html, file, landscape = false) => {
  const p = await browser.newPage();
  await p.setContent(html, { waitUntil: "load" });
  await p.pdf({ path: file, format: "A4", landscape, printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  await p.close();
  console.log(`written ${file}`);
};
const shell = (title, body) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{font:9.5pt/1.4 "Segoe UI",Arial,sans-serif;color:#1c1917} h1{color:#14532d;font-size:16pt;margin:0 0 6pt}
  table{border-collapse:collapse;width:100%} th,td{border:1px solid #d6d3d1;padding:2.5pt 4pt;text-align:left;vertical-align:top}
  th{background:#f0fdf4;color:#14532d} .fail{color:#b91c1c;font-weight:600} .exp{color:#92400e}</style><h1>${esc(title)}</h1>${body}`;

const browser = await chromium.launch({ channel: "chromium" });
try {
  await page(browser, readFileSync(join(process.cwd(), "docs", "demo", "tester-guide.html"), "utf8"), join(DATA_DIR, "tester-guide.pdf"));

  const roster = readFileSync(join(DATA_DIR, "demo-roster.csv"), "utf8").trim().split(/\r?\n/).map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, 5));
  await page(browser, shell("Demo roster (no passwords)", `<p>40 accounts · login tags only (the inbox address is kept separately)</p><table>${roster.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join("")}</tr>`).join("")}</table>`), join(DATA_DIR, "demo-roster.pdf"));

  const dir = join(process.cwd(), "test-results", "demo-audit");
  if (existsSync(dir)) {
    const rows = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const csv = ["Role,Width,Page,Tab,Rows,Cards,Result,Notes", ...rows.map((r) => [r.role, r.width, r.page, r.tab || "", r.rows, r.cards, r.result || (r.empties.length ? "FAIL" : "OK"),
      [...(r.unexpected || []).map((e) => `empty: ${e}`), ...(r.expected || []).map((e) => `expected empty: ${e.text} (${e.reason})`), r.bad ? `shows: ${r.bad}` : ""].filter(Boolean).join("; ")]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))];
    writeFileSync(join(DATA_DIR, "empty-page-audit.csv"), `${csv.join("\n")}\n`);
    console.log(`written ${join(DATA_DIR, "empty-page-audit.csv")}`);
    const body = `<p>${rows.length} views (every page and tab, 1366 px and 390 px), ${rows.filter((r) => r.result === "FAIL").length} failing, ${rows.filter((r) => r.result === "OK (expected empty)").length} with an expected empty state.</p>
      <table><tr><th>Role</th><th>Width</th><th>Page</th><th>Tab</th><th>Rows</th><th>Cards</th><th>Result</th><th>Notes</th></tr>${rows.map((r) => `<tr><td>${esc(r.role)}</td><td>${r.width}</td><td>${esc(r.page)}</td><td>${esc(r.tab || "")}</td><td>${r.rows}</td><td>${r.cards}</td>
      <td class="${r.result === "FAIL" ? "fail" : r.result?.startsWith("OK (") ? "exp" : ""}">${esc(r.result)}</td><td>${esc([...(r.unexpected || []).map((e) => `empty: ${e}`), ...(r.expected || []).map((e) => `${e.text}: ${e.reason}`)].join("; "))}</td></tr>`).join("")}</table>`;
    await page(browser, shell("Empty-page audit", body), join(DATA_DIR, "empty-page-audit.pdf"), true);
  }
} finally {
  await browser.close();
}
