/**
 * fetch() for the React portals, with their session handling:
 *
 *   401 "session_replaced"         signed in on another device -> /login?reason=signed_in_elsewhere
 *   401 (anything else)            the session lapsed          -> /login?reason=session_expired
 *   403 "password_change_required" the issued password must be replaced -> reload into the gate
 *
 * The same endpoints, methods and bodies as the legacy screens; the server's
 * guards are what authorize anything.
 */

import { AUTH_CONTEXT_KEY } from "@/app/login/auth-context";

const CREDENTIAL_ENDPOINTS = ["/api/legacy-auth/login", "/api/legacy-auth/reset-password"];

const REASON_BY_CODE = {
  session_replaced: "signed_in_elsewhere",
  session_revoked: "account_changed",
  account_archived: "account_archived",
};

const ROLES = ["super_admin", "admin", "accountant", "employee", "hr"];

let redirecting = false;

/**
 * A full page load, not a client-side route change: leaving a portal for
 * /login (or another role's portal) must drop every bit of in-memory state,
 * exactly as the legacy portals' window.top.location assignments do.
 */
export function hardNavigate(url) {
  window.location.href = url;
}

/** Clear the browser's copy of the sign-in and go to /login (signOutLocally, rbac.js). */
export function signOutLocally(reason) {
  if (redirecting) return;
  redirecting = true;
  try {
    localStorage.removeItem(AUTH_CONTEXT_KEY);
    ROLES.forEach((role) => localStorage.removeItem(`sacs-active-page-${role}`));
  } catch {
    // private mode
  }
  hardNavigate(`/login${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`);
}

/** Mark the stored context as gated and reload into the change-password screen. */
export function requirePasswordChange() {
  if (redirecting) return;
  redirecting = true;
  try {
    const ctx = JSON.parse(localStorage.getItem(AUTH_CONTEXT_KEY) || "null");
    if (ctx) localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify({ ...ctx, must_change_password: true }));
  } catch {
    // private mode
  }
  window.location.reload();
}

export async function apiFetch(url, init) {
  const response = await fetch(url, init);
  const isCredentialCall = CREDENTIAL_ENDPOINTS.some((path) => url.includes(path));

  if (response.status === 401 && !isCredentialCall && !redirecting) {
    const body = await response.clone().json().catch(() => ({}));
    signOutLocally(REASON_BY_CODE[body?.code] || "session_expired");
  } else if (response.status === 403 && !redirecting) {
    const body = await response.clone().json().catch(() => ({}));
    if (body?.code === "password_change_required") requirePasswordChange();
  }
  return response;
}

/** apiFetch + JSON, throwing the server's error message on a non-2xx reply (attFetchJson). */
export async function fetchJson(url, init) {
  const response = await apiFetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

/** JSON body helper for POST / PATCH. */
export function jsonBody(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** A timed refresh, not the person doing something: must not keep an idle session alive (src/proxy.js). */
export const BACKGROUND = { headers: { "x-sacs-background": "1" } };

/** End the server session too, not just the local copy (sacsEndServerSession, rbac.js). */
export function endServerSession() {
  return fetch("/api/legacy-auth/logout", { method: "POST", keepalive: true }).catch(() => {});
}
