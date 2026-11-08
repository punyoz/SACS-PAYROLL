/**
 * Live notification bell (alpha test D2, 20261109040000): GET
 * /api/notifications hands the signed-in account its own random channel; a
 * new notification sends a content-free Realtime "ping" there. Nothing about
 * the notification travels over the socket; the bell reloads through the API.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let createSessionToken;
let SESSION_COOKIE;

function requestAs(userId, role = "hr") {
  const token = createSessionToken({ user_id: userId, role, branch_id: null, email: `${userId}@sacs.test`, full_name: "Hana HR", session_id: `s-${userId}` });
  const request = new Request("https://sacs.test/api/notifications", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  request.nextUrl = new URL(request.url);
  return request;
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-live-bell";
  resetDb();
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("GET /api/notifications: the live channel", () => {
  it("returns only the signed-in account's own topic and notifications", async () => {
    table("notification_channels").push({ user_id: ME, topic: "a".repeat(32) }, { user_id: OTHER, topic: "b".repeat(32) });
    table("notifications").push(
      { id: "n1", recipient_id: ME, kind: "rate_change", title: "Mine", created_at: "2026-11-09T01:00:00Z", read_at: null },
      { id: "n2", recipient_id: OTHER, kind: "rate_change", title: "Not mine", created_at: "2026-11-09T01:00:00Z", read_at: null },
    );
    const { GET } = await import("@/app/api/notifications/route");
    const body = await (await GET(requestAs(ME))).json();
    expect(body.live).toEqual({ topic: "a".repeat(32) });
    expect(body.notifications.map((n) => n.title)).toEqual(["Mine"]);
  });

  it("creates the channel on first use", async () => {
    const { GET } = await import("@/app/api/notifications/route");
    await GET(requestAs(ME));
    expect(table("notification_channels").some((row) => row.user_id === ME)).toBe(true);
  });
});

describe("the database side (20261109040000)", () => {
  const sql = readFileSync("supabase/migrations/20261109040000_live_notification_bell.sql", "utf8");

  it("sends an empty ping, never the notification's content", () => {
    expect(sql).toContain("PERFORM realtime.send('{}'::jsonb, 'ping', 'bell-' || v_topic, false);");
    expect(sql).not.toMatch(/realtime\.send\([^;]*NEW\.(title|body|kind|link_page)/);
  });

  it("keeps browsers out of the channel table and never blocks a notification", () => {
    expect(sql).toContain("REVOKE ALL ON public.notification_channels FROM anon, authenticated;");
    expect(sql).toContain("FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)");
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN\s+-- Never block the notification itself\.\s+NULL;/);
    expect(sql).toContain("encode(extensions.gen_random_bytes(16), 'hex')");
  });
});
