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

/** Show the label, log it, and wrap the work in a named report step. */
export async function step(page, label, fn) {
  console.log(`  ▶ ${label}`);
  await page.evaluate((text) => {
    try { sessionStorage.setItem("e2e-step", text); } catch { /* storage blocked */ }
  }, label).catch(() => {});
  await page.evaluate(BANNER_SCRIPT).catch(() => {});
  if (!fn) return undefined;
  return test.step(label, fn);
}
