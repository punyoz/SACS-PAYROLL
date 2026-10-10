import { describe, it, expect } from "vitest";
import { scrub, sentryOptions } from "@/lib/monitoring/sentry-options";

/**
 * Error monitoring must never carry payroll or personal data to Sentry, and
 * must stay off until a DSN is configured.
 */

describe("Sentry options", () => {
  it("is off without a DSN, and never sends PII, traces or replays", () => {
    expect(sentryOptions(undefined)).toMatchObject({ enabled: false, dsn: undefined, sendDefaultPii: false, tracesSampleRate: 0 });
    expect(sentryOptions("https://key@o1.ingest.sentry.io/1")).toMatchObject({ enabled: true, sendDefaultPii: false, tracesSampleRate: 0 });
    const options = sentryOptions("https://key@o1.ingest.sentry.io/1");
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("integrations");
  });

  it("strips cookies, auth headers, bodies and query strings before sending", () => {
    const event = scrub({
      request: {
        url: "https://payroll.example/api/accountant/payroll?format=pdf&entry_id=abc",
        query_string: "format=pdf&entry_id=abc",
        cookies: { "sacs-session": "secret" },
        data: { basic_salary: 30000, sss_number: "34-1234567-8" },
        headers: { Cookie: "sacs-session=secret", Authorization: "Bearer x", "x-sacs-kiosk": "1", "user-agent": "Edge" },
      },
      user: { id: "u-1", email: "maria@example.com", ip_address: "1.2.3.4" },
    });
    expect(event.request).toEqual({ url: "https://payroll.example/api/accountant/payroll", headers: { "user-agent": "Edge" } });
    expect(event.user).toEqual({ id: "u-1" });
  });
});
