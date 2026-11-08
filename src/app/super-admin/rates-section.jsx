"use client";

import * as React from "react";
import { BuildingIcon, CalculatorIcon, ChevronDownIcon, LinkIcon, Loader2Icon, PencilIcon, PercentIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { ErrorState } from "@/components/portal/empty-state";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { manilaToday, rateDate, rateDisplay, rateHistory } from "./config-format";
import { CONTRIBUTION_MAX } from "@/lib/input-limits";
import { hourlyFromDaily, HOURS_PER_DAY } from "@/lib/payroll/rates";
import { SearchableSelect } from "@/components/portal/searchable-select";

// The daily rate and its hourly rate (always daily ÷ 8) are shown and edited
// as one linked pair (2026-11-08); the other rates stay in the table below.
const PAIR = new Set(["daily", "hourly"]);

/*
 * Payroll Rates, effective-dated (loadSAPayrollRates / renderSABranchDailyRates
 * / openSARateModal / submitSARate, public/legacy/js/super-admin.js):
 * GET and POST /api/admin/payroll-rates. A change is never an overwrite: it
 * adds a version with the date it starts, and payroll reads the version in
 * force on each pay period's first day. A date inside a processed period is
 * moved to the next one by the server, which says so.
 */

function History({ rate, history, today, empty = "Not set — built-in default" }) {
  const versions = rateHistory(rate, history, today);
  if (!versions.length) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
      {versions.map((v, i) => (
        <li key={v.key} className="flex items-center gap-1">
          {i > 0 ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
          <span
            title={v.note || undefined}
            className={cn("rounded px-1.5 py-0.5", v.now ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground")}
          >
            {v.text} <span className="opacity-80">({v.range})</span>{v.who ? <span className="opacity-70"> · {v.who}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

const VALUE_LABEL = {
  percent: "New value (%)",
  count: "Late days per absence (0 = off)",
  day_of_month: "Day of the month (0 = month end)",
  days: "Working days (per year, or per month if 31 or less)",
  switch: "1 = On, 0 = Off",
  half: "1 = 1–15 payslip, 2 = 16–end payslip, 3 = half on each",
};

const VALUE_MAX = { percent: "100", count: "31", day_of_month: "31", days: "366", switch: "1", half: "3", peso: String(CONTRIBUTION_MAX) };
const WHOLE_UNITS = new Set(["count", "days", "day_of_month", "switch", "half"]);

/** The value check of submitSARate. */
function valueError(rate, value) {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || n < 0) return "Enter a value of 0 or more.";
  if (rate?.rate_type === "daily" && !(n > 0)) return "The daily rate must be more than ₱0.";
  if (rate?.unit === "peso" && n > CONTRIBUTION_MAX) return `Enter an amount of at most ₱${CONTRIBUTION_MAX.toLocaleString("en-PH")}.`;
  const unit = rate?.unit;
  if (unit === "percent" && n > 100) return "A percentage cannot be more than 100.";
  if (unit === "count" && (!Number.isInteger(n) || n > 31)) return "Enter a whole number from 0 to 31.";
  if (unit === "days" && (!Number.isInteger(n) || n < 1 || n > 366)) return "Enter a whole number of days from 1 to 366.";
  if (unit === "day_of_month" && (!Number.isInteger(n) || n > 31)) return "Enter a day of the month from 0 (month end) to 31.";
  if (unit === "switch" && n !== 0 && n !== 1) return "Enter 1 (on) or 0 (off).";
  if (unit === "half" && ![1, 2, 3].includes(n)) return "Enter 1, 2 or 3.";
  return "";
}

function RateDialog({ request, data, branches, onClose, onSaved, endpoint }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [values, setValues] = React.useState({ value: "", effective: "", scope: "global", ref: "", position: "", note: "" });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [employees, setEmployees] = React.useState(null);
  const open = Boolean(request?.open);
  const rate = (data?.rates || []).find((r) => r.rate_type === request?.rateType);
  const branchPreset = request?.branch
    ? (data?.branch_daily || []).find((b) => String(b.branch_id) === String(request.branch))
    : null;
  const current = branchPreset ? branchPreset.current : rate?.current;

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setFeedback("");
    setBusy(false);
    setValues({
      value: "",
      effective: data?.default_effective_date || "",
      scope: request?.branch ? "branch" : "global",
      ref: request?.branch ? String(request.branch) : "",
      position: "",
      note: "",
    });
  }, [open, request, data]);

  // Employees for "One employee", loaded the first time it is chosen.
  React.useEffect(() => {
    if (!open || values.scope !== "employee" || employees) return;
    fetchJson("/api/hr/employees")
      // Nobody changes a rate set for themselves (alpha test Part E).
      .then((payload) => setEmployees((payload.employees || []).filter((e) => !e.archived && String(e.id) !== String(data?.actor_id || ""))))
      .catch(() => setEmployees([]));
  }, [open, values.scope, employees, data?.actor_id]);

  const set = (key, value) => {
    setValues((currentValues) => ({ ...currentValues, [key]: value, ...(key === "scope" ? { ref: "" } : null) }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  // Grouped by branch so the right person is easy to find.
  const employeeGroups = React.useMemo(() => {
    const names = new Map((branches || []).map((b) => [String(b.id), b.name]));
    const groups = new Map();
    (employees || []).forEach((e) => {
      const name = names.get(String(e.branch_id || "")) || "No branch assigned";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(e);
    });
    return [...groups.keys()]
      .sort((a, b) => (a === "No branch assigned" ? 1 : b === "No branch assigned" ? -1 : a.localeCompare(b)))
      .map((name) => [name, groups.get(name).sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")))]);
  }, [employees, branches]);

  const finalized = data?.finalized_period;
  // Future pay periods only (alpha test Part E): from the next period's first day.
  const minDate = data?.min_effective_date || data?.default_effective_date || "";
  const lateDate = finalized && values.effective && values.effective <= finalized.end_key;
  // The daily rate carries the hourly rate with it: daily ÷ 8, shown as it is typed.
  const isDaily = rate?.rate_type === "daily";
  const typedDaily = Number(values.value);
  const liveHourly = isDaily && values.value !== "" && Number.isFinite(typedDaily) && typedDaily > 0 ? hourlyFromDaily(typedDaily) : null;

  async function save(event) {
    event.preventDefault();
    if (busy || !rate) return;
    const scopeRef = values.scope === "position" ? values.position.trim() : values.scope === "global" ? "" : values.ref;
    const nextErrors = {};
    const vError = valueError(rate, values.value);
    if (vError) nextErrors.value = vError;
    else if (!values.effective) nextErrors.effective = "Choose the date the new value takes effect.";
    else if (minDate && values.effective < minDate) nextErrors.effective = `Rate changes apply to future pay periods only: choose ${rateDate(minDate)} or later.`;
    else if (values.scope !== "global" && !scopeRef) nextErrors[values.scope === "position" ? "position" : "ref"] = "Choose who this rate applies to.";
    else if (!values.note.trim()) nextErrors.note = isDaily ? "Give a reason for the daily rate change." : "Give a reason for the rate change.";
    setErrors(nextErrors);
    const firstKey = Object.keys(nextErrors)[0];
    if (firstKey) {
      setFeedback(nextErrors[firstKey]);
      document.getElementById(`sa-rate-${firstKey}`)?.focus();
      return;
    }
    const ok = await confirm({
      title: "Confirm rate change",
      description: `Set ${rate.label || "this rate"} to ${rateDisplay(rate, values.value)}${isDaily ? ` (hourly rate ${rateDisplay(rate, hourlyFromDaily(values.value))}, automatic)` : ""} from ${rateDate(values.effective)}? A new version is added; the current one stays in the history. Past payslips are not affected.`,
      confirmLabel: "Save",
    });
    if (!ok) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await fetchJson(endpoint, jsonBody("POST", {
        rate_type: rate.rate_type,
        scope: values.scope,
        scope_ref: scopeRef || null,
        value: Number(values.value),
        effective_date: values.effective,
        note: values.note.trim(),
      }));
      notify(
        result.warning ? "Rate Scheduled for Next Period" : "Rate Saved",
        result.warning || `${rate.label || "Rate"} set to ${rateDisplay(rate, values.value)} from ${rateDate(result.effective_date)}.`,
        result.warning ? "info" : "success",
      );
      onClose();
      await onSaved();
    } catch (error) {
      setFeedback(error.message || "Unable to save the rate.");
    } finally {
      setBusy(false);
    }
  }

  const invalid = (key) => ({ "aria-invalid": errors[key] ? true : undefined, "aria-describedby": errors[key] ? `sa-rate-${key}-error` : undefined });
  const error = (key) => (errors[key] ? <p id={`sa-rate-${key}-error`} className="text-sm text-destructive">{errors[key]}</p> : null);

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{branchPreset ? `Edit daily rate — ${branchPreset.name}` : `Edit ${rate?.label || "rate"}`}</DialogTitle>
            <DialogDescription>
              Current value: <strong className="text-foreground tabular-nums">{rateDisplay(rate, current?.value)}</strong>
              {current?.effective_date ? ` since ${rateDate(current.effective_date)}` : " (built-in default)"}
              {branchPreset && current?.scope !== "branch" ? " — the default; this branch has no rate of its own yet" : ""}.
              {rate?.hint ? <span className="mt-1 block text-xs">{rate.hint}</span> : null}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sa-rate-value">{isDaily ? "New daily rate (₱)" : VALUE_LABEL[rate?.unit] || "New value (₱)"}</Label>
              <Input
                id="sa-rate-value"
                type="number"
                inputMode="decimal"
                min="0"
                max={VALUE_MAX[rate?.unit]}
                step={WHOLE_UNITS.has(rate?.unit) ? "1" : "0.01"}
                value={values.value}
                onChange={(e) => set("value", e.target.value)}
                autoFocus
                {...invalid("value")}
              />
              {error("value")}
              {isDaily ? (
                <div data-testid="hourly-preview" aria-live="polite" className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-center gap-1.5 font-medium"><CalculatorIcon className="size-3.5 text-gold-text" aria-hidden="true" />Hourly rate (automatic)</span>
                    <span className="font-semibold tabular-nums text-primary">{liveHourly === null ? "—" : rateDisplay(rate, liveHourly)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {liveHourly === null ? `Daily rate ÷ ${HOURS_PER_DAY}, rounded to the centavo.` : `${rateDisplay(rate, typedDaily)} ÷ ${HOURS_PER_DAY} = ${rateDisplay(rate, liveHourly)}`}
                    {values.effective ? `, from ${rateDate(values.effective)}` : ""}. For example ₱700 ÷ 8 = ₱87.50 and ₱650 ÷ 8 = ₱81.25.
                  </p>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="sa-rate-effective">Effective starting</Label>
              <DatePicker id="sa-rate-effective" value={values.effective} onChange={(v) => set("effective", v)} {...invalid("effective")} />
              {error("effective") || (
                <p className={cn("text-xs", lateDate ? "text-warning" : "text-muted-foreground")}>
                  {lateDate
                    ? `${finalized.label} has already been processed — this change will apply from the next pay period instead (${rateDate(data.earliest_effective_date)}).`
                    : `Future pay periods only: ${minDate ? `${rateDate(minDate)} or later` : "from the next period"}. Payroll uses the version in force on a pay period's first day. Past payslips are not affected.`}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="sa-rate-scope">Applies to</Label>
              <Select value={values.scope} onValueChange={(v) => set("scope", v)} disabled={Boolean(branchPreset)}>
                <SelectTrigger id="sa-rate-scope" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Everyone (default)</SelectItem>
                  <SelectItem value="branch">One branch</SelectItem>
                  <SelectItem value="position">One position</SelectItem>
                  <SelectItem value="employee">One employee</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {values.scope === "branch" ? (
              <div className="space-y-2">
                <Label htmlFor="sa-rate-ref">Branch</Label>
                <SearchableSelect id="sa-rate-ref" label="Branch" value={values.ref || ""} onValueChange={(v) => set("ref", v)} disabled={Boolean(branchPreset)}
                  placeholder={(branches || []).length ? "Select branch" : "No branches found"} searchPlaceholder="Search branch…"
                  options={(branches || []).map((b) => ({ value: String(b.id), label: b.name }))} {...invalid("ref")} />
                {error("ref")}
              </div>
            ) : null}
            {values.scope === "employee" ? (
              <div className="space-y-2">
                <Label htmlFor="sa-rate-ref">Employee</Label>
                <SearchableSelect id="sa-rate-ref" label="Employee" value={values.ref || ""} onValueChange={(v) => set("ref", v)} disabled={!employees}
                  placeholder={!employees ? "Loading employees…" : employees.length ? "Select employee" : "No employees found"} searchPlaceholder="Search name, ID or branch…"
                  options={employeeGroups.flatMap(([name, list]) => list.map((e) => ({ value: String(e.id), group: name, label: `${e.full_name}${e.employee_id ? ` — ${e.employee_id}` : ""}` })))}
                  {...invalid("ref")} />
                {error("ref")}
              </div>
            ) : null}
            {values.scope === "position" ? (
              <div className="space-y-2">
                <Label htmlFor="sa-rate-position">Position</Label>
                <Input id="sa-rate-position" maxLength={80} placeholder="e.g. Teacher I" value={values.position} onChange={(e) => set("position", e.target.value)} {...invalid("position")} />
                {error("position")}
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="sa-rate-note">Reason <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Input id="sa-rate-note" maxLength={300} placeholder="e.g. Board resolution 2026-14" value={values.note} onChange={(e) => set("note", e.target.value)} required {...invalid("note")} />
              {error("note")}
            </div>
            {feedback && !Object.values(errors).some(Boolean) ? (
              <Alert variant="destructive"><AlertDescription>{feedback}</AlertDescription></Alert>
            ) : null}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save new version"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}


/** One version list, one line per version, so the daily and hourly lists line up row for row. */
function VersionLines({ rate, history, today, empty }) {
  const versions = rateHistory(rate, history, today);
  if (!versions.length) return <span className="text-xs text-muted-foreground">{empty}</span>;
  return (
    <ol className="space-y-1 text-xs">
      {versions.map((v) => (
        <li key={v.key} title={v.note || undefined}
          className={cn("grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-2 rounded px-1.5 py-0.5", v.now ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
          <span className={cn("text-right tabular-nums", v.now && "font-semibold")}>{v.text}</span>
          <span className="min-w-0 break-words">{v.range}{v.who ? <span className="opacity-75"> · {v.who}</span> : null}</span>
        </li>
      ))}
    </ol>
  );
}

const PAIR_GRID = "md:grid md:grid-cols-[minmax(11rem,1.15fr)_7.5rem_7.5rem_minmax(18rem,2.2fr)_6.5rem] md:items-start md:gap-x-4";

/**
 * The daily rate and the hourly rate as one linked pair (2026-11-08): same
 * columns, same dates, values that visibly match. Only the daily rate has an
 * Edit button; the hourly rate is always daily ÷ 8.
 */
function RatePairCard({ daily, hourly, today, onEditDaily, loading, branches }) {
  const branchName = (id) => (branches || []).find((b) => String(b.id) === String(id))?.name;
  const whoFor = (o) => (o.scope === "branch" ? branchName(o.scope_ref) || "a branch" : o.scope === "employee" ? "one employee" : `position ${o.scope_ref}`);
  const [showTyped, setShowTyped] = React.useState(false);
  const typed = hourly?.typed_versions || [];
  const cellLabel = "text-xs font-medium text-muted-foreground md:hidden";
  const row = (r, { action, rule }) => {
    const changing = Number(r.next_period?.value) !== Number(r.current?.value);
    return (
      <div data-testid={`pair-row-${r.rate_type}`} className={cn("grid grid-cols-2 gap-x-3 gap-y-2 border-t px-4 py-3 first:border-t-0", PAIR_GRID)}>
        <div className="col-span-2 md:col-span-1">
          <p className="flex flex-wrap items-center gap-1.5 font-medium">{r.label}{rule ? <span className="rounded-full bg-brand-gold/15 px-2 py-0.5 text-[11px] font-medium text-gold-text">{rule}</span> : null}</p>
          {r.hint ? <p className="text-xs text-muted-foreground">{r.hint}</p> : null}
        </div>
        <div className="md:text-right"><p className={cellLabel}>This period</p><p data-testid={`${r.rate_type}-current`} className="font-medium tabular-nums">{rateDisplay(r, r.current?.value)}</p></div>
        <div className="md:text-right"><p className={cellLabel}>Next period</p><p data-testid={`${r.rate_type}-next`} className={cn("tabular-nums", changing && "font-semibold text-warning")}>{rateDisplay(r, r.next_period?.value)}</p></div>
        <div className="col-span-2 min-w-0 md:col-span-1">
          <p className={cellLabel}>History</p>
          <div data-testid={`${r.rate_type}-history`}><VersionLines rate={r} history={r.history} today={today} empty="Not set — built-in default" /></div>
          {(r.overrides || []).length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Also set for: {r.overrides.map((o) => `${whoFor(o)} ${rateDisplay(r, o.value)} from ${rateDate(o.effective_date)}`).join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="col-span-2 flex md:col-span-1 md:justify-end">{action}</div>
      </div>
    );
  };
  return (
    <Card className="min-w-0 shadow-xs" data-testid="rate-pair">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LinkIcon className="size-4 text-gold-text" aria-hidden="true" />Daily and hourly rate</CardTitle>
        <CardDescription>
          Edit the daily rate only. The hourly rate is always the daily rate ÷ {HOURS_PER_DAY}, with the same dates, and is never typed.
          From Oct 1, 2026 an employee with a salary on file is paid on monthly salary × 12 ÷ working days per year (hourly = that ÷ {HOURS_PER_DAY});
          these values apply to an employee with no salary on file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div aria-hidden="true" className={cn("hidden border-b bg-muted/60 px-4 py-2 text-xs font-semibold text-muted-foreground", PAIR_GRID)}>
            <span>Rate</span><span className="text-right">This period</span><span className="text-right">Next period</span><span>History</span><span className="sr-only">Actions</span>
          </div>
          {loading || !daily || !hourly ? <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p> : (
            <>
              {row(daily, { action: onEditDaily ? <Button variant="outline" size="sm" onClick={onEditDaily} aria-label="Edit Daily rate"><PencilIcon aria-hidden="true" />Edit</Button> : null })}
              {row(hourly, {
                rule: `Daily rate ÷ ${HOURS_PER_DAY} (automatic)`,
                action: <span data-testid="hourly-automatic" className="text-xs whitespace-nowrap text-muted-foreground">Automatic</span>,
              })}
            </>
          )}
        </div>
        {typed.length ? (
          <div className="mt-3 rounded-lg border border-dashed px-4 py-2">
            <button type="button" onClick={() => setShowTyped((v) => !v)} aria-expanded={showTyped}
              className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm font-medium">
              Hourly rates typed by hand earlier ({typed.length}) — kept as history
              <ChevronDownIcon className={cn("size-4 transition-transform", showTyped && "rotate-180")} aria-hidden="true" />
            </button>
            {showTyped ? (
              <ul data-testid="typed-hourly" className="space-y-1 pb-2 text-xs">
                {typed.map((t) => (
                  <li key={t.id || `${t.effective_date}-${t.value}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2">
                    <span className="text-right tabular-nums line-through decoration-muted-foreground/50">{rateDisplay(hourly, t.value)}</span>
                    <span className="text-muted-foreground">from {rateDate(t.effective_date)}{t.scope !== "global" ? ` (${t.scope})` : ""}{t.created_by_name ? ` · ${t.created_by_name}` : ""} — <span className={t.status === "superseded" ? "text-warning" : ""}>{t.status_label}</span></span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * endpoint: /api/admin/payroll-rates (Super Admin, System Configuration) or
 * /api/payroll/rates (HR, Government Rates page; alpha test Part E). Edit
 * shows only for the rates the reply says this account may change
 * (can_change); onlyEditable lists just those (HR).
 */
export function RatesSection({ refreshKey, endpoint = "/api/admin/payroll-rates", onlyEditable = false }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null, branches: [] });
  const [dialog, setDialog] = React.useState({ open: false, rateType: "", branch: null });
  const [today] = React.useState(manilaToday);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    const [rates, branches] = await Promise.allSettled([fetchJson(endpoint), fetchJson("/api/admin/branches")]);
    setState((current) => ({
      loading: false,
      error: rates.status === "rejected" ? rates.reason?.message || "Unable to load payroll rates." : null,
      data: rates.status === "fulfilled" ? rates.value : current.data,
      branches: branches.status === "fulfilled" ? branches.value.branches || [] : current.branches,
    }));
  }, [endpoint]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const canChange = React.useCallback((type) => (data?.can_change ? Boolean(data.can_change[type]) : !onlyEditable), [data, onlyEditable]);
  const rates = React.useMemo(() => data?.rates || [], [data]);
  const dailyRate = React.useMemo(() => rates.find((r) => r.rate_type === "daily") || { unit: "peso" }, [rates]);
  const hourlyRate = React.useMemo(() => rates.find((r) => r.rate_type === "hourly") || null, [rates]);
  // Daily and hourly have their own linked card; every other rate is in the table.
  const otherRates = React.useMemo(() => rates.filter((r) => !PAIR.has(r.rate_type) && (!onlyEditable || canChange(r.rate_type))), [rates, onlyEditable, canChange]);

  const rateColumns = React.useMemo(() => [
    {
      key: "label",
      header: "Rate",
      sortable: true,
      className: "min-w-56 whitespace-normal",
      searchValue: (r) => `${r.label} ${r.hint || ""}`,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.label}</p>
          {r.hint ? <p className="text-xs text-muted-foreground">{r.hint}</p> : null}
        </div>
      ),
    },
    { key: "current", header: "This period", align: "right", headClassName: "w-32", className: "w-32 whitespace-nowrap tabular-nums", cell: (r) => rateDisplay(r, r.current?.value) },
    {
      key: "next",
      header: "Next period",
      align: "right",
      headClassName: "w-32",
      className: "w-32 whitespace-nowrap tabular-nums",
      cell: (r) => {
        const changing = Number(r.next_period?.value) !== Number(r.current?.value);
        return <span className={cn(changing && "font-semibold text-warning")}>{rateDisplay(r, r.next_period?.value)}</span>;
      },
    },
    {
      key: "history",
      header: "History",
      className: "min-w-72 whitespace-normal",
      cell: (r) => (
        <div className="space-y-1">
          <History rate={r} history={r.history} today={today} />
          {(r.overrides || []).length ? (
            <p className="text-xs text-muted-foreground">
              {r.overrides.map((o) => `${o.scope}: ${rateDisplay(r, o.value)} from ${rateDate(o.effective_date)}`).join(" · ")}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      // The hourly rate is the daily rate ÷ 8 (rates.js derivedHourly): nothing to edit.
      cell: (r) => (r.derived
        ? <span className="text-xs text-muted-foreground whitespace-nowrap">Daily ÷ 8</span>
        : canChange(r.rate_type)
          ? <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, rateType: r.rate_type, branch: null })} aria-label={`Edit ${r.label}`}><PencilIcon aria-hidden="true" />Edit</Button>
          : <span className="text-xs whitespace-nowrap text-muted-foreground">Super Admin only</span>),
    },
  ], [today, canChange]);

  const branchColumns = React.useMemo(() => {
    const defaultNote = <p className="text-xs font-normal text-muted-foreground">Uses system default</p>;
    return [
      {
        key: "name",
        header: "Branch",
        sortable: true,
        className: "min-w-40 font-medium whitespace-normal",
        cell: (b) => <>{b.name}{b.status && b.status !== "Active" ? <span className="ml-1 text-xs font-normal text-muted-foreground">(Inactive)</span> : null}</>,
      },
      {
        key: "daily",
        header: "Daily rate",
        align: "right",
        headClassName: "w-32",
        className: "w-32 whitespace-nowrap tabular-nums",
        sortValue: (b) => Number(b.current?.value) || 0,
        cell: (b) => <div data-testid="branch-daily">{rateDisplay(dailyRate, b.current?.value)}{b.uses_default ? defaultNote : null}</div>,
      },
      {
        key: "hourly",
        header: "Hourly rate (automatic)",
        align: "right",
        headClassName: "w-40",
        className: "w-40 whitespace-nowrap tabular-nums",
        cell: (b) => <div data-testid="branch-hourly">{rateDisplay(dailyRate, b.hourly_current)}<p className="text-xs font-normal text-muted-foreground">Daily ÷ {HOURS_PER_DAY}</p></div>,
      },
      {
        key: "effective",
        header: "Effective",
        headClassName: "w-36",
        className: "w-36 whitespace-nowrap",
        cell: (b) => (b.uses_default ? <span className="text-muted-foreground">{b.current?.effective_date ? `${rateDate(b.current.effective_date)} (default)` : "Built-in default"}</span> : rateDate(b.current?.effective_date)),
      },
      {
        key: "next",
        header: "Next period",
        align: "right",
        headClassName: "w-36",
        className: "w-36 whitespace-nowrap tabular-nums",
        cell: (b) => {
          const changing = Number(b.next_period?.value) !== Number(b.current?.value);
          return (
            <div className={cn(changing && "font-semibold text-warning")}>
              {rateDisplay(dailyRate, b.next_period?.value)}
              <p className="text-xs font-normal">{rateDisplay(dailyRate, b.hourly_next)}/hr{b.next_uses_default ? " · default" : ""}</p>
            </div>
          );
        },
      },
      {
        key: "history",
        header: "History (daily, hourly)",
        className: "min-w-80 whitespace-normal",
        cell: (b) => (
          <ol className="space-y-1 text-xs">
            {b.history?.length ? rateHistory(dailyRate, b.history, today).map((v, i) => (
              <li key={v.key} className={cn("grid grid-cols-[5rem_5rem_minmax(0,1fr)] gap-x-2 rounded px-1.5 py-0.5", v.now ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
                <span className="text-right tabular-nums">{v.text}</span>
                <span className="text-right tabular-nums">{rateDisplay(dailyRate, b.hourly_history?.[i]?.value)}/hr</span>
                <span className="min-w-0 break-words">{v.range}</span>
              </li>
            )) : <li className="text-muted-foreground">No branch rate yet — uses the system default</li>}
          </ol>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        cell: (b) => (canChange("daily") ? <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, rateType: "daily", branch: b.branch_id })} aria-label={`Edit daily rate for ${b.name}`}><PencilIcon aria-hidden="true" />Edit</Button> : null),
      },
    ];
  }, [dailyRate, today, canChange]);

  const finalizedNote = data?.finalized_period
    ? ` ${data.finalized_period.label} is already processed; new versions start ${rateDate(data.earliest_effective_date)} or later.`
    : "";
  const unavailable = data && !data.available;

  return (
    <>
      {!(data && !data.available) && !(state.error && !data) ? (
        <RatePairCard daily={rates.find((r) => r.rate_type === "daily")} hourly={hourlyRate} today={today} loading={state.loading && !data} branches={state.branches}
          onEditDaily={canChange("daily") ? () => setDialog({ open: true, rateType: "daily", branch: null }) : null} />
      ) : null}
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><PercentIcon className="size-4 text-gold-text" aria-hidden="true" />{onlyEditable ? "Government rates you can change" : "Payroll rates"}</CardTitle>
          <CardDescription>
            Payroll uses the value in force on each pay period&apos;s first day.{finalizedNote}
            {onlyEditable ? " Each change is a new version for future pay periods, with a reason; the Super Admin is notified. Nobody changes a rate set for themselves. The withholding tax table is fixed by law." : ""}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {state.error && !data ? <ErrorState message={state.error} onRetry={load} /> : unavailable ? (
            <Alert className="border-warning/40"><AlertDescription className="text-warning">{data.error || "Payroll rates are not set up yet."}</AlertDescription></Alert>
          ) : (
            <DataTable
              columns={rateColumns}
              rows={otherRates}
              rowKey={(r) => r.rate_type}
              loading={state.loading && !data}
              paginate={false}
              searchPlaceholder="Search rates…"
              empty={{ title: "No payroll rates", icon: PercentIcon }}
              caption="Payroll rates"
              minWidth={900}
            />
          )}
        </CardContent>
      </Card>

      {!unavailable ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BuildingIcon className="size-4 text-gold-text" aria-hidden="true" />Daily and hourly rate per branch</CardTitle>
            <CardDescription>Every branch: its own daily rate, or the system default when it has none. The hourly rate is that daily rate ÷ {HOURS_PER_DAY}, automatic. A branch&apos;s rate applies to that branch only.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={branchColumns}
              rows={data?.branch_daily || []}
              rowKey={(b) => b.branch_id}
              loading={state.loading && !data}
              error={state.error && !data ? state.error : null}
              onRetry={load}
              paginate={false}
              searchPlaceholder="Search branches…"
              empty={{ title: "No branches found", icon: BuildingIcon }}
              caption="Daily and hourly rate per branch"
              minWidth={1080}
            />
          </CardContent>
        </Card>
      ) : null}

      <RateDialog
        request={dialog}
        data={data}
        branches={state.branches}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
        onSaved={load}
        endpoint={endpoint}
      />
    </>
  );
}
