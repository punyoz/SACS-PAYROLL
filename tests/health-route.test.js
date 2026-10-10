import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, setMissingTables, table } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

/**
 * GET /api/health keeps the Free-plan project awake (one real database read)
 * and feeds the uptime monitor. It must answer without a session and reveal
 * nothing but up / down.
 */

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-health";
  resetDb();
  setMissingTables([]);
  table("branches").push({ id: "branch-a", name: "Antipolo" });
});

describe("/api/health", () => {
  it("answers ok after reading the database", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers 503 with no detail when the database read fails", async () => {
    resetDb();
    setMissingTables(["branches"]);
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("is reachable without signing in", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("https://sacs.test/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("other API routes still need a session", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("https://sacs.test/api/healthz"));
    expect(response.status).toBe(401);
  });
});
