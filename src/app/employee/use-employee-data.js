"use client";

import * as React from "react";
import { BACKGROUND, apiFetch, fetchJson } from "@/lib/portal/api";

/*
 * The Employee portal's data, from the same endpoints with the same
 * parameters as public/legacy/js/employee.js. Display state only.
 */

const STATS_POLL_MS = 30000;

/**
 * GET /api/employee/stats — the month's counts, calendar records, today's
 * log, upcoming leave and next holiday. Polled every 30 s while the tab is
 * visible (an RFID tap is recorded elsewhere), marked as background so the
 * poll never keeps an idle session alive.
 */
export function useEmployeeStats(email, refreshKey) {
  const [state, setState] = React.useState({ data: null, loading: true, error: null });

  const load = React.useCallback(async ({ background = false } = {}) => {
    if (!email) return;
    try {
      const response = await apiFetch(`/api/employee/stats?email=${encodeURIComponent(email)}`, background ? BACKGROUND : undefined);
      if (!response.ok) throw new Error("Failed to load attendance data.");
      const data = await response.json();
      setState({ data, loading: false, error: null });
    } catch (error) {
      // A failed background poll keeps what is on screen.
      setState((current) => (background && current.data ? current : { data: current.data, loading: false, error: error.message }));
    }
  }, [email]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load({ background: true });
    }, STATS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { ...state, reload: load };
}

/** GET /api/employee/payslips — newest first. */
export function usePayslips(email, refreshKey) {
  const [state, setState] = React.useState({ list: [], loading: true, error: null });

  const load = React.useCallback(async () => {
    if (!email) return;
    setState((current) => ({ ...current, loading: !current.list.length, error: null }));
    try {
      const response = await apiFetch(`/api/employee/payslips?email=${encodeURIComponent(email)}`);
      if (!response.ok) throw new Error("Unable to load your payslips.");
      const data = await response.json();
      setState({ list: Array.isArray(data.payslips) ? data.payslips : [], loading: false, error: null });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [email]);

  React.useEffect(() => { load(); }, [load, refreshKey]);
  return { ...state, reload: load };
}

/*
 * There is no server-side notification store, so (as the legacy portal does)
 * the browser remembers per account the status it last showed for each
 * request and announces an approval or cancellation the first time it sees
 * one. On a browser that has never seen a request, only decisions from the
 * last 7 days are announced.
 */
const LEAVE_SEEN_KEY_PREFIX = "sacs-leave-seen:";
const LEAVE_NOTIFY_WINDOW_MS = 7 * 86400000;

function notifyLeaveDecisions(requests, ctx, notify) {
  const accountKey = String(ctx?.id || ctx?.email || "").trim();
  if (!accountKey) return;
  const storageKey = `${LEAVE_SEEN_KEY_PREFIX}${accountKey}`;

  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { seen = null; }
  const known = seen && typeof seen === "object" ? seen : {};

  const next = {};
  requests.forEach((request) => {
    const id = String(request.id || "");
    const status = String(request.status || "").toLowerCase();
    if (!id) return;
    next[id] = status;
    if (known[id] === status) return;

    const decidedAt = new Date(status === "cancelled" ? (request.cancelled_at || request.updated_at) : request.decided_at).getTime();
    const recent = Number.isFinite(decidedAt) && Date.now() - decidedAt <= LEAVE_NOTIFY_WINDOW_MS;
    if (!(id in known) && !recent) return;

    const range = `${request.leave_type || "Leave"} · ${request.start_date} to ${request.end_date}`;
    if (status === "approved") notify("Your leave request was approved.", range, "success");
    else if (status === "cancelled") notify("Your approved leave was cancelled.", `${range} · You can tap in on these days again.`, "info");
  });

  try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage blocked: notices may repeat */ }
}

/** GET /api/employee/leave-requests — the person's requests and leave balance. */
export function useLeaveRequests(ctx, notify, refreshKey) {
  const [state, setState] = React.useState({ requests: [], balance: null, loading: true, error: null });
  const employeeId = String(ctx?.employee_id || "").trim();
  const fullName = String(ctx?.full_name || "").trim();
  const ctxRef = React.useRef(ctx);
  ctxRef.current = ctx;

  const load = React.useCallback(async () => {
    if (!employeeId && !fullName) {
      setState({ requests: [], balance: null, loading: false, error: null });
      return;
    }
    setState((current) => ({ ...current, loading: !current.requests.length, error: null }));
    try {
      const params = new URLSearchParams();
      if (employeeId) params.set("employee_id", employeeId);
      if (fullName) params.set("employee_name", fullName);
      const payload = await fetchJson(`/api/employee/leave-requests?${params.toString()}`);
      const requests = Array.isArray(payload.requests) ? payload.requests : [];
      setState({ requests, balance: payload.balance || null, loading: false, error: null });
      notifyLeaveDecisions(requests, ctxRef.current, notify);
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load leave requests." }));
    }
  }, [employeeId, fullName, notify]);

  React.useEffect(() => { load(); }, [load, refreshKey]);
  return { ...state, reload: load };
}
