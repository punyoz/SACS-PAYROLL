"use client";

/**
 * An account still on the password it was issued sees only the mandatory
 * change-password screen. That screen is still the legacy one
 * (public/legacy/pages/change-password.html, js/app.js
 * initPasswordChangeScreen), shown here in a frame. When it succeeds it
 * clears must_change_password in the stored sign-in context; the session
 * provider hears that through the storage event and opens the portal.
 */
export function PasswordGate({ role }) {
  return (
    <iframe
      src={`/legacy/index.html?role=${encodeURIComponent(role)}`}
      title="Change your password"
      className="block h-dvh w-full border-0"
    />
  );
}
