"use client";

import * as React from "react";
import { apiFetch, BACKGROUND } from "@/lib/portal/api";

/*
 * Live Payroll Approval updates: Server-Sent Events from
 * /api/hr/payroll-runs/stream (which listens to Supabase Realtime on the
 * server), plus a poll every minute in case a connection drops. onChange is
 * called, at most every half second, whenever any visible run changes.
 */

export function useLivePayrollRuns(onChange, { enabled = true, pollMs = 60000 } = {}) {
  const callback = React.useRef(onChange);
  React.useEffect(() => { callback.current = onChange; }, [onChange]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => callback.current?.(), 500);
    };
    let source = null;
    if (typeof window !== "undefined" && "EventSource" in window) {
      source = new EventSource("/api/hr/payroll-runs/stream");
      source.addEventListener("change", fire);
    }
    const poll = setInterval(() => callback.current?.(), pollMs);
    const onFocus = () => callback.current?.();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      if (source) source.close();
    };
  }, [enabled, pollMs]);
}

/** The pending-run count for HR's sidebar badge, kept live. */
export function usePendingRunCount(enabled = true) {
  const [count, setCount] = React.useState(0);
  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch("/api/hr/payroll-runs?count=1", BACKGROUND);
      if (!response.ok) return;
      const data = await response.json();
      setCount(Number(data.pending) || 0);
    } catch { /* keep the last count */ }
  }, []);
  React.useEffect(() => { if (enabled) load(); }, [enabled, load]);
  useLivePayrollRuns(load, { enabled });
  return [count, load];
}
