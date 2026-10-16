/**
 * Back-button safety (src/proxy.js):
 *
 *   - /login is guest-only: a live session is sent to its own portal;
 *   - a replaced / missing session still gets the sign-in page;
 *   - every guarded page and API reply is marked no-store.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-login-guard";
  resetDb();
  users.push({ id: "u-hr", email: "hr@sacs.test", app_metadata: { session_id: "s-1" }, user_metadata: { role: "hr" } });
  table("profiles").push({ id: "u-hr", role: "hr", archived: false });
});

async function visit(path, sessionId) {
  const { proxy } = await import("@/proxy");
  const headers = {};
  if (sessionId) {
    const { createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session");
    headers.cookie = `${SESSION_COOKIE}=${createSessionToken({ user_id: "u-hr", role: "hr", session_id: sessionId })}`;
  }
  return proxy(new NextRequest(`https://sacs.test${path}`, { headers }));
}

function expectNoStore(response) {
  expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("expires")).toBe("0");
}

describe("/login guest guard", () => {
  it("shows the sign-in page without a session", async () => {
    const response = await visit("/login");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expectNoStore(response);
  });

  it("sends a live session to its own portal", async () => {
    const response = await visit("/login", "s-1");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")).pathname).toBe("/hr");
    expectNoStore(response);
  });

  it("shows the sign-in page for a session replaced elsewhere", async () => {
    const response = await visit("/login?reason=signed_in_elsewhere", "s-old");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("protected pages", () => {
  it("redirect to /login without a session and are never cached", async () => {
    const response = await visit("/hr");
    expect(new URL(response.headers.get("location")).pathname).toBe("/login");
    expectNoStore(response);
  });

  it("mark API replies no-store", async () => {
    expectNoStore(await visit("/api/rbac/me"));
  });
});
