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

/** ?draft=<entry id>: the Draft opened in the single-entry form ("Review and finalize"). */
function draftFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("draft") || "";
  } catch {
    return "";
  }
}

function keepDraftInUrl(id) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("draft", id);
    else if (params.has("draft")) params.delete("draft");
    else return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
  } catch {
    // history unavailable: the draft still opens for this visit
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
// size: "sm" in card headers (next to small buttons); "default" as a form field next to other dropdowns.
export function HistorySelect({ className, size = "sm" }) {
  const { data, history, setHistory } = useAccountant();
  const years = data?.history_years || [];
  return (
    <Select value={history} onValueChange={setHistory}>
      <SelectTrigger size={size} className={className || "w-40"} aria-label="Showing"><SelectValue /></SelectTrigger>
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
  const [entryId, setEntryId] = React.useState(() => (typeof window === "undefined" ? "" : draftFromUrl()));
  // The Draft named in the address that is no longer open: { id, finalized }.
  const [draftGone, setDraftGone] = React.useState(null);
  const seq = React.useRef(0);
  // The latest choices, read by load() without re-creating it.
  const periodRef = React.useRef(typeof window === "undefined" ? "" : periodFromUrl());
  const historyRef = React.useRef(typeof window === "undefined" ? "recent" : historyFromUrl());
  const [history, setHistoryState] = React.useState(historyRef.current);
  const entryRef = React.useRef(typeof window === "undefined" ? "" : draftFromUrl());
  const chooseEntry = React.useCallback((id) => {
    entryRef.current = String(id || "");
    setEntryId(String(id || ""));
    // Another entry chosen in the form: the address no longer names the old Draft.
    if (draftFromUrl() && draftFromUrl() !== entryRef.current) keepDraftInUrl("");
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
      // draft_entries holds every period's drafts: a draft of another period
      // never stays open (its 1st-half basic showed as the 2nd half's salary).
      const drafts = data.draft_entries || [];
      // A Draft named in the address (a "Review and finalize" link) that was finalized or cancelled since.
      const named = draftFromUrl();
      if (named && !drafts.some((draft) => String(draft.id) === named)) {
        const record = (data.records || []).find((row) => String(row.id) === named);
        setDraftGone({ id: named, finalized: Boolean(record) });
        if (entryRef.current === named) chooseEntry("");
        keepDraftInUrl("");
      }
      const open = drafts.find((draft) => String(draft.id) === entryRef.current);
      if (open && open.pay_period !== shown) chooseEntry("");
      // With no entry chosen, the period's first saved draft opens in the form.
      const first = drafts.find((draft) => draft.pay_period === shown);
      if (!entryRef.current && first) chooseEntry(first.id);
      setState({ loading: false, error: null, data });
      return data;
    } catch (error) {
      if (mine === seq.current) setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load accountant data." }));
      return null;
    }
  }, [chooseEntry]);

  React.useEffect(() => { load(); }, [load]);

  // A link inside the portal (Action needed) names a period: follow it.
  React.useEffect(() => {
    const onPopState = () => {
      const next = periodFromUrl();
      const draft = draftFromUrl();
      if (draft && draft !== entryRef.current) { setDraftGone(null); chooseEntry(draft); }
      if (next && next !== periodRef.current) { periodRef.current = next; setPeriodState(next); load({ period: next }); }
      else if (draft) load();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [load, chooseEntry]);

  const value = React.useMemo(() => ({
    ...state,
    period,
    entryId,
    draftGone,
    /** The Draft was just finalized here: no "already finalized" notice for it. */
    clearDraftLink: () => { keepDraftInUrl(""); setDraftGone(null); },
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
    editDraft: (id) => {
      // Opens in its own period, so the form never mixes two periods.
      const draftPeriod = (state.data?.draft_entries || []).find((draft) => String(draft.id) === String(id))?.pay_period;
      if (draftPeriod) { periodRef.current = draftPeriod; setPeriodState(draftPeriod); keepPeriodInUrl(draftPeriod); }
      setDraftGone(null);
      chooseEntry(id); keepDraftInUrl(id); navigate("ac-process");
      // The single-entry form, filled with the Draft, scrolls into view.
      load({ entryId: id, period: draftPeriod }).then(() => requestAnimationFrame(() => document.getElementById("pc-entry")?.scrollIntoView({ behavior: "smooth", block: "start" })));
    },
  }), [state, period, entryId, draftGone, history, load, navigate, chooseEntry]);

  return <AccountantContext.Provider value={value}>{children}</AccountantContext.Provider>;
}
