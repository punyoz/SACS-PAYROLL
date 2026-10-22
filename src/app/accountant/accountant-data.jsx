"use client";

import * as React from "react";
import { fetchJson } from "@/lib/portal/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/*
 * The Accountant portal's shared data (runAccountantLoad, public/legacy/js/
 * accountant.js): one GET /api/accountant/payroll[?period=&entry_id=] feeds
 * the dashboard, Process Payroll, Payroll Records, Pay Record, Monitoring,
 * Reports and the attendance reference. A load asked for while another is
 * in flight wins over it, so switching the period mid-load never leaves the
 * tables on the old period.
 */

const AccountantContext = React.createContext(null);

export function useAccountant() {
  return React.useContext(AccountantContext);
}

/*
 * The chosen pay period is kept in the address (?period=), so a refresh, a
 * shared link or Back reopens the same period instead of falling back to the
 * current one (2026-10-20 audit: a run being resubmitted for October 1-15
 * vanished from Process Payroll on refresh).
 */
function periodFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("period") || "";
  } catch {
    return "";
  }
}

function keepPeriodInUrl(next) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("period", next);
    else params.delete("period");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  } catch {
    // history unavailable: the period still applies to this visit
  }
}

/*
 * The payroll history Payroll Records, Monitoring and Reports list: the last
 * 12 months ("recent", the default) or one year (?hy=YYYY). Five years of
 * payslips are never sent at once (scale test 2026-10-22).
 */
function historyFromUrl() {
  try {
    const value = new URLSearchParams(window.location.search).get("hy") || "";
    return /^\d{4}$/.test(value) ? value : "recent";
  } catch {
    return "recent";
  }
}

function keepHistoryInUrl(next) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (next && next !== "recent") params.set("hy", next);
    else params.delete("hy");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  } catch {
    // history unavailable: the choice still applies to this visit
  }
}

/** "Last 12 months" or a year, for the history pages' headers. */
export function HistorySelect({ className }) {
  const { data, history, setHistory } = useAccountant();
  const years = data?.history_years || [];
  return (
    <Select value={history} onValueChange={setHistory}>
      <SelectTrigger size="sm" className={className || "w-40"} aria-label="Showing"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="recent">Last 12 months</SelectItem>
        {years.map((year) => <SelectItem key={year} value={String(year)}>{year}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function historyLabel(history) {
  return history && history !== "recent" ? `Year ${history}` : "Last 12 months";
}

export function AccountantDataProvider({ children, navigate }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [period, setPeriodState] = React.useState("");
  const [entryId, setEntryId] = React.useState("");
  const seq = React.useRef(0);
  // The latest choices, read by load() without re-creating it.
  const periodRef = React.useRef(typeof window === "undefined" ? "" : periodFromUrl());
  const historyRef = React.useRef(typeof window === "undefined" ? "recent" : historyFromUrl());
  const [history, setHistoryState] = React.useState(historyRef.current);
  const entryRef = React.useRef("");
  const chooseEntry = React.useCallback((id) => {
    entryRef.current = String(id || "");
    setEntryId(String(id || ""));
  }, []);

  const load = React.useCallback(async (options = {}) => {
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams();
      const chosen = options.period || periodRef.current;
      if (chosen) params.set("period", chosen);
      if (options.entryId) params.set("entry_id", options.entryId);
      if (historyRef.current !== "recent") params.set("history", historyRef.current);
      const query = params.toString();
      const data = await fetchJson(`/api/accountant/payroll${query ? `?${query}` : ""}`);
      if (mine !== seq.current) return data;
      const options_ = data.period_options || [];
      const active = data.active_period?.label;
      const shown = chosen && options_.includes(chosen) ? chosen : active && options_.includes(active) ? active : options_[0] || "";
      periodRef.current = shown;
      setPeriodState(shown);
      // With no entry chosen, the first saved draft opens in the form.
      if (!entryRef.current && data.draft_entries?.length) chooseEntry(data.draft_entries[0].id);
      setState({ loading: false, error: null, data });
      return data;
    } catch (error) {
      if (mine === seq.current) setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load accountant data." }));
      return null;
    }
  }, [chooseEntry]);

  React.useEffect(() => { load(); }, [load]);

  const value = React.useMemo(() => ({
    ...state,
    period,
    entryId,
    history,
    /** Another history window: the last 12 months or a year. */
    setHistory: (next) => { historyRef.current = next || "recent"; setHistoryState(historyRef.current); keepHistoryInUrl(historyRef.current); load(); },
    setEntryId: chooseEntry,
    load,
    /** A new period for both Process Payroll selectors, and everything reloads. */
    setPeriod: (next) => { setPeriodState(next); periodRef.current = next; keepPeriodInUrl(next); load({ period: next }); },
    /** Open an entry's payslip on the Pay Record page (openPayslipFromRecord). */
    openPayslip: (id) => { load({ entryId: id }); navigate("ac-payslips"); },
    /** Edit a draft in the Process Payroll form (editDraftEntry). */
    editDraft: (id) => { chooseEntry(id); navigate("ac-process"); load({ entryId: id }); },
  }), [state, period, entryId, history, load, navigate, chooseEntry]);

  return <AccountantContext.Provider value={value}>{children}</AccountantContext.Provider>;
}
