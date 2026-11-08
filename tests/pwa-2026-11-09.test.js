/**
 * PWA (alpha test D1): the manifest, the offline page and a service worker
 * that caches the public app shell only, never payroll data.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("manifest", () => {
  it("installs as SACS Payroll in its own window with 192 / 512 / maskable icons", async () => {
    const manifest = (await import("@/app/manifest")).default();
    expect(manifest).toMatchObject({ name: "SACS Payroll", start_url: "/", display: "standalone", theme_color: "#1B5E3C" });
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of manifest.icons) expect(existsSync(`public${icon.src}`), icon.src).toBe(true);
  });
});

describe("service worker (public/sw.js)", () => {
  let listeners;
  let cachePut;
  beforeEach(() => {
    listeners = {};
    cachePut = vi.fn();
    const cache = { addAll: vi.fn(async () => {}), put: cachePut };
    const self = {
      location: { origin: "https://sacs.test" },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: vi.fn(), clients: { claim: vi.fn() },
    };
    const caches = { open: vi.fn(async () => cache), match: vi.fn(async () => undefined), keys: vi.fn(async () => []), delete: vi.fn() };
    const fetch = vi.fn(async () => ({ ok: true, type: "basic", clone() { return this; } }));
    new Function("self", "caches", "fetch", readFileSync("public/sw.js", "utf8"))(self, caches, fetch);
  });

  const fire = (url, { method = "GET", mode = "cors" } = {}) => {
    const event = { request: { url, method, mode }, respondWith: vi.fn() };
    listeners.fetch(event);
    return event;
  };

  it("never answers /api/ requests (payroll, payslips, attendance go straight to the network)", () => {
    for (const path of ["/api/accountant/payroll", "/api/employee/payslips?id=1", "/api/attendance/logs", "/api/notifications"]) {
      expect(fire(`https://sacs.test${path}`).respondWith, path).not.toHaveBeenCalled();
    }
    expect(fire("https://sacs.test/api/admin/attendance", { method: "POST" }).respondWith).not.toHaveBeenCalled();
  });

  it("pages always come from the network (offline page only when that fails); build files are cached", async () => {
    const page = fire("https://sacs.test/accountant", { mode: "navigate" });
    expect(page.respondWith).toHaveBeenCalledTimes(1);
    expect(fire("https://sacs.test/_next/static/chunks/app.js").respondWith).toHaveBeenCalledTimes(1);
    expect(fire("https://other.example/x.js").respondWith).not.toHaveBeenCalled();
  });

  it("the source says so too: no cache.put for anything but shell assets", () => {
    const src = readFileSync("public/sw.js", "utf8");
    expect(src).toMatch(/if \(url\.pathname\.startsWith\("\/api\/"\)[^)]*\)\) return;/);
    expect(src.match(/cache\.put/g)).toHaveLength(1);
  });
});

describe("offline page", () => {
  it("exists and says nothing is saved on the device", () => {
    const html = readFileSync("public/offline.html", "utf8");
    expect(html).toContain("You are offline");
    expect(html).toContain("Nothing is saved on this device");
  });
});
