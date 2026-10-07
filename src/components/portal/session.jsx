"use client";

import * as React from "react";
import { toast } from "sonner";
import { AUTH_CONTEXT_KEY, ROLE_ROUTES, readAuthContext } from "@/app/login/auth-context";
import { apiFetch, endServerSession, hardNavigate, requirePasswordChange } from "@/lib/portal/api";

/**
 * The signed-in person, for a React portal. The same checks the legacy
 * portals run at boot and while open (public/legacy/js/app.js initApp() and
 * js/rbac.js):
 *
 *   - no stored sign-in context -> /login
 *   - /api/rbac/me says another role -> that role's portal
 *   - the account must replace its issued password -> the existing
 *     change-password screen (the legacy one, in a frame) until it is done
 *   - a 10-second heartbeat while the tab is visible, and on focus, so a
 *     sign-in elsewhere ends this one within seconds
 *   - the context follows edits made in another tab
 *
 * The stored context is display-only; the signed HttpOnly cookie is what the
 * API authorizes by (src/proxy.js).
 */

const SessionContext = React.createContext(null);

const HEARTBEAT_MS = 10000;
const MAX_HISTORY = 30;

function persistContext(next) {
  try {
    if (next) localStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(next));
    else localStorage.removeItem(AUTH_CONTEXT_KEY);
  } catch {
    // storage blocked: this tab keeps its copy
  }
}

export function PortalSessionProvider({ role, children, gate: Gate }) {
  const [ctx, setCtx] = React.useState(null);
  const [me, setMe] = React.useState(null);
  const [ready, setReady] = React.useState(false);
  const [notifications, setNotifications] = React.useState([]);
  const [unread, setUnread] = React.useState(0);

  // Boot: the stored context first (instant names), then the signed session.
  React.useEffect(() => {
    let stored = readAuthContext();
    if (!stored || !stored.role) {
      hardNavigate("/login");
      return;
    }
    // The proxy already verified the cookie owns this portal; repair a stale
    // local role instead of bouncing between portals on it.
    if (stored.role !== role) {
      stored = { ...stored, role };
      persistContext(stored);
    }
    setCtx(stored);
    setReady(true);

    let cancelled = false;
    apiFetch("/api/rbac/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (cancelled || !data?.user) return;
        if (data.user.role !== role) {
          hardNavigate(ROLE_ROUTES[data.user.role] || "/login");
          return;
        }
        setMe(data);
        // The session is authoritative for the password gate too.
        const mustChange = Boolean(data.user.must_change_password);
        const latest = readAuthContext() || stored;
        if (Boolean(latest.must_change_password) !== mustChange) {
          const next = { ...latest, must_change_password: mustChange };
          persistContext(next);
          setCtx(next);
        }
      });
    return () => { cancelled = true; };
  }, [role]);

  // Heartbeat: a newer sign-in elsewhere, or a reset to the issued password.
  React.useEffect(() => {
    if (!ready) return undefined;
    let inFlight = false;
    const check = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      apiFetch("/api/legacy-auth/session", { method: "GET", cache: "no-store", credentials: "same-origin" })
        .then((res) => (res.ok ? res.json().catch(() => null) : null))
        .then((body) => {
          if (body?.must_change_password && !readAuthContext()?.must_change_password) requirePasswordChange();
        })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    const timer = setInterval(check, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [ready]);

  // Another tab (or the password-gate frame) changed the stored context.
  React.useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== AUTH_CONTEXT_KEY) return;
      const next = readAuthContext();
      if (!next) {
        hardNavigate("/login");
        return;
      }
      setCtx(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateContext = React.useCallback((patch) => {
    setCtx((current) => {
      const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      persistContext(next);
      return next;
    });
  }, []);

  const logout = React.useCallback(() => {
    endServerSession();
    persistContext(null);
    try {
      Object.keys(ROLE_ROUTES).forEach((r) => localStorage.removeItem(`sacs-active-page-${r}`));
    } catch {
      // private mode
    }
    hardNavigate("/login");
  }, []);

  /** Toast + the bell's history (pushNotification, app.js). */
  const notify = React.useCallback((title, description, type = "success") => {
    const show = type === "error" ? toast.error : type === "info" ? toast.info : toast.success;
    show(title, description ? { description } : undefined);
    setNotifications((list) => [{ title, description, type, time: new Date() }, ...list].slice(0, MAX_HISTORY));
    setUnread((n) => n + 1);
  }, []);

  const can = React.useCallback((module, action = "read") => {
    const perms = me?.permissions?.[module];
    // Until /api/rbac/me answers, show the portal's own modules; the API
    // guards still decide every request.
    if (!me) return true;
    return Boolean(perms?.actions?.includes(String(action).toLowerCase()));
  }, [me]);

  const value = React.useMemo(() => ({
    role,
    ctx,
    me,
    updateContext,
    logout,
    can,
    notify,
    notifications,
    unread,
    markRead: () => setUnread(0),
  }), [role, ctx, me, updateContext, logout, can, notify, notifications, unread]);

  if (!ready || !ctx) return null;

  if (ctx.must_change_password && Gate) {
    return <Gate role={role} />;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function usePortalSession() {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("usePortalSession must be used inside <PortalSessionProvider>.");
  return value;
}

/**
 * The page a portal had open, kept per role exactly where the legacy portals
 * keep it (localStorage "sacs-active-page-<role>"), so sign-out clears it.
 */
export function usePersistedPage(role, pages, fallback) {
  const key = `sacs-active-page-${role}`;
  const [page, setPageState] = React.useState(fallback);

  React.useEffect(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("page");
      const saved = fromUrl || localStorage.getItem(key);
      if (saved && pages.includes(saved)) setPageState(saved);
    } catch {
      // storage blocked
    }
    // pages is a constant list per portal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setPage = React.useCallback((next) => {
    setPageState(next);
    try { localStorage.setItem(key, next); } catch { /* storage blocked */ }
    // ?page= keeps a refresh or a shared link on the same page.
    const params = new URLSearchParams(window.location.search);
    params.set("page", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    window.scrollTo?.({ top: 0 });
  }, [key]);

  return [page, setPage];
}
