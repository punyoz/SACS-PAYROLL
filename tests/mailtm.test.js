/**
 * src/lib/mail/mailtm.service.mjs with fetch replaced: the off switch, code
 * extraction from the app's real code email, token refresh on a 401, and
 * polling until a code arrives or the timeout passes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildOtpEmail } from "@/lib/mail/otp-email";

let svc;
const env = { USE_MAILTM: process.env.USE_MAILTM, NODE_ENV: process.env.NODE_ENV };

/** Route table for the fake mail.tm: "METHOD /path" -> (init) => [status, body]. */
let routes;
let calls;

function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/ld+json" },
  });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.USE_MAILTM = "true";
  process.env.NODE_ENV = "test";
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (url, init = {}) => {
    const key = `${init.method || "GET"} ${new URL(url).pathname}`;
    calls.push({ key, auth: init.headers?.Authorization || "" });
    const handler = routes[key];
    if (!handler) return json(404, { detail: "no route" });
    const [status, body] = handler(init);
    return json(status, body);
  });
  svc = await import("@/lib/mail/mailtm.service.mjs");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env.USE_MAILTM = env.USE_MAILTM;
  process.env.NODE_ENV = env.NODE_ENV;
});

const inbox = { address: "t1@maxxspace.com", password: "pw" };

describe("the off switch", () => {
  it("is off unless USE_MAILTM=true", async () => {
    process.env.USE_MAILTM = "false";
    expect(svc.isMailtmEnabled()).toBe(false);
    await expect(svc.listMessages(inbox)).rejects.toBeInstanceOf(svc.MailtmDisabledError);
    expect(calls).toHaveLength(0);
  });

  it("is always off in production, even with USE_MAILTM=true", async () => {
    process.env.NODE_ENV = "production";
    expect(svc.isMailtmEnabled()).toBe(false);
    await expect(svc.createInbox()).rejects.toBeInstanceOf(svc.MailtmDisabledError);
    expect(calls).toHaveLength(0);
  });
});

describe("extractOtp", () => {
  it("reads the code out of the app's own sign-in email (text and HTML)", () => {
    const mail = buildOtpEmail({ code: "042917", purpose: "login", minutes: 5, name: "Ana" });
    expect(svc.extractOtp({ text: mail.text })).toBe("042917");
    // HTML only: the digits are split by hair spaces in the template.
    expect(svc.extractOtp({ html: [mail.html] })).toBe("042917");
  });

  it("prefers the number next to the word code and ignores longer numbers", () => {
    expect(svc.extractOtp({ text: "Ref 20261007123 sent 2026. Your code is 381920." })).toBe("381920");
    expect(svc.extractOtp({ text: "Order 12345678 shipped" })).toBeNull();
    expect(svc.extractOtp(null)).toBeNull();
  });
});

describe("tokens", () => {
  it("fetches a fresh token once when the cached one is refused", async () => {
    let issued = 0;
    routes["POST /token"] = () => [200, { token: `tok-${++issued}`, id: "acc-1" }];
    routes["GET /messages"] = (init) => (init.headers.Authorization === "Bearer tok-1"
      ? [401, { message: "Expired JWT Token" }]
      : [200, { "hydra:member": [] }]);
    expect(await svc.listMessages(inbox)).toEqual([]);
    expect(issued).toBe(2);
  });

  it("accepts plain-array collections as well as hydra:member", async () => {
    routes["POST /token"] = () => [200, { token: "tok" }];
    routes["GET /messages"] = () => [200, [{ id: "m1", createdAt: "2026-10-07T00:00:00Z" }]];
    expect((await svc.listMessages(inbox)).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("waitForOtp", () => {
  it("polls until a message with a code arrives", async () => {
    let polls = 0;
    routes["POST /token"] = () => [200, { token: "tok" }];
    routes["GET /messages"] = () => {
      polls += 1;
      return [200, { "hydra:member": polls < 3 ? [] : [{ id: "m1", subject: "Your SACS Payroll sign-in code", from: { address: "school@gmail.com" }, createdAt: new Date().toISOString() }] }];
    };
    routes["GET /messages/m1"] = () => [200, { id: "m1", text: "Use this code to finish signing in: 550123" }];
    const found = await svc.waitForOtp(inbox, { intervalMs: 5, timeoutMs: 2_000 });
    expect(found).toMatchObject({ code: "550123", messageId: "m1", from: "school@gmail.com" });
    expect(polls).toBe(3);
  });

  it("gives up after the timeout, and skips mail older than `since`", async () => {
    routes["POST /token"] = () => [200, { token: "tok" }];
    routes["GET /messages"] = () => [200, { "hydra:member": [{ id: "old", createdAt: "2026-01-01T00:00:00Z" }] }];
    routes["GET /messages/old"] = () => [200, { id: "old", text: "code 111111" }];
    const found = await svc.waitForOtp(inbox, { since: "2026-10-01T00:00:00Z", intervalMs: 5, timeoutMs: 30 });
    expect(found).toBeNull();
    expect(calls.some((c) => c.key === "GET /messages/old")).toBe(false);
  });
});

describe("inboxes at a chosen address", () => {
  it("refuses a domain mail.tm does not serve", async () => {
    routes["GET /domains"] = () => [200, { "hydra:member": [{ domain: "maxxspace.com", isActive: true, isPrivate: false }] }];
    await expect(svc.createInbox({ address: "someone@gmail.com" })).rejects.toThrow(/not a live mail\.tm domain/);
    expect(calls.some((c) => c.key === "POST /accounts")).toBe(false);
  });

  it("explains how to save an address that already exists", async () => {
    routes["GET /domains"] = () => [200, { "hydra:member": [{ domain: "maxxspace.com", isActive: true, isPrivate: false }] }];
    routes["POST /accounts"] = () => [422, { detail: "address: This value is already used." }];
    await expect(svc.createInbox({ address: "Taken@MaxxSpace.com" })).rejects.toThrow(/npm run mailtm -- add taken@maxxspace\.com/);
  });
});
