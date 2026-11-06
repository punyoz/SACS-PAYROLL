// An on-screen label for each step ("HR > Payroll Approval > click Approve"),
// so someone watching the headed run knows what is being tested. It survives
// reloads (sessionStorage) and never takes clicks.
import { test } from "@playwright/test";

const BANNER_SCRIPT = () => {
  const draw = () => {
    let label = "";
    try { label = sessionStorage.getItem("e2e-step") || ""; } catch { /* storage blocked */ }
    if (!label || !document.body) return;
    let el = document.getElementById("e2e-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "e2e-banner";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;"
        + "background:rgba(17,24,39,.92);color:#fde68a;font:600 13px/1.3 system-ui,sans-serif;padding:6px 14px;border-radius:999px;"
        + "box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      document.body.appendChild(el);
    }
    el.textContent = `▶ ${label}`;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw);
  else draw();
};

export async function installBanner(context) {
  await context.addInitScript(BANNER_SCRIPT);
}

// Live-run narration: every step gets a number, and anything the page monitor
// caught since the previous step is printed in plain words with that number,
// then the run pauses (E2E_PROBLEM_PAUSE ms, default 3000 when headed) so the
// person watching can see it.
let stepNo = 0;
const pendingProblems = [];
const PROBLEM_PAUSE = Number(process.env.E2E_PROBLEM_PAUSE ?? (process.env.E2E_HEADLESS === "1" ? 0 : 3000));

export function currentStep() { return stepNo; }

/** Called by the page monitor (support/monitor.mjs) for each unexpected issue. */
export function reportProblem(where, kind, text) {
  pendingProblems.push({ at: stepNo, where, kind, text });
}

const PLAIN_KIND = {
  "console.error": "the page logged an error",
  uncaught: "the page threw an uncaught error",
  crash: "the page crashed",
  "request-failed": "a request failed",
  http: "a request was answered with an error",
};

/** Print and pause on any problem seen since the last step. */
export async function flushProblems(page) {
  if (!pendingProblems.length) return;
  const list = pendingProblems.splice(0);
  for (const p of list) {
    console.log(`  ⚠ PROBLEM at step ${p.at} [${p.where}]: ${PLAIN_KIND[p.kind] || p.kind}: ${String(p.text).slice(0, 240)}`);
  }
  // A plain timer, not page.waitForTimeout: this also runs in fixture
  // teardown, where a page call made Playwright fail ("step id not found").
  void page;
  if (PROBLEM_PAUSE > 0) await new Promise((r) => setTimeout(r, PROBLEM_PAUSE));
}

/** Show the label, log it, and wrap the work in a named report step. */
export async function step(page, label, fn) {
  await flushProblems(page);
  stepNo += 1;
  console.log(`  [step ${stepNo}] ${label}`);
  await page.evaluate((text) => {
    try { sessionStorage.setItem("e2e-step", text); } catch { /* storage blocked */ }
  }, label).catch(() => {});
  await page.evaluate(BANNER_SCRIPT).catch(() => {});
  if (!fn) return undefined;
  return test.step(label, fn);
}
