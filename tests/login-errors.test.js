import { describe, it, expect } from "vitest";
import {
  friendlyLoginError,
  GENERIC_CREDENTIALS_MESSAGE,
  UNCONFIRMED_EMAIL_MESSAGE,
  RATE_LIMITED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
} from "@/lib/auth/login-errors";

describe("Friendly sign-in errors", () => {
  it("shows the same message for a wrong password and an unknown email", () => {
    const wrongPassword = friendlyLoginError({
      code: "invalid_credentials",
      status: 400,
      message: "Invalid login credentials",
    });
    const unknownEmail = friendlyLoginError({
      code: "user_not_found",
      status: 400,
      message: "User not found",
    });

    expect(wrongPassword).toBe(GENERIC_CREDENTIALS_MESSAGE);
    // The whole point: these must be indistinguishable, or the route can be
    // used to discover which addresses hold accounts.
    expect(unknownEmail).toBe(wrongPassword);
  });

  it("asks an unconfirmed account to confirm its email", () => {
    expect(friendlyLoginError({ code: "email_not_confirmed", status: 400 }))
      .toBe(UNCONFIRMED_EMAIL_MESSAGE);
  });

  it("recognises an unconfirmed email from the message alone", () => {
    // Older GoTrue releases sent no code.
    expect(friendlyLoginError({ message: "Email not confirmed" }))
      .toBe(UNCONFIRMED_EMAIL_MESSAGE);
  });

  it("reports rate limiting from a 429", () => {
    expect(friendlyLoginError({ status: 429, message: "Request rate limit reached" }))
      .toBe(RATE_LIMITED_MESSAGE);
  });

  it("recognises Supabase's per-account cooldown wording", () => {
    expect(friendlyLoginError({
      status: 400,
      message: "For security purposes, you can only request this after 27 seconds",
    })).toBe(RATE_LIMITED_MESSAGE);
  });

  it("separates an outage from a bad password", () => {
    expect(friendlyLoginError({ status: 503, message: "service unavailable" }))
      .toBe(SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("never leaks Supabase's own wording", () => {
    const raw = "Invalid login credentials";
    expect(friendlyLoginError({ message: raw })).not.toContain(raw);
  });

  it("falls back to the generic message when there is no error object", () => {
    expect(friendlyLoginError(null)).toBe(GENERIC_CREDENTIALS_MESSAGE);
  });
});
