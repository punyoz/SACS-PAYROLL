"use client";

import * as React from "react";
import { BuildingIcon, Loader2Icon, PencilIcon, PercentIcon, RefreshCwIcon } from "lucide-react";
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

const VALUE_MAX = { percent: "100", count: "31", day_of_month: "31", days: "366", switch: "1", half: "3" };
const WHOLE_UNITS = new Set(["count", "days", "day_of_month", "switch", "half"]);

/** The value check of submitSARate. */
function valueError(rate, value) {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || n < 0) return "Enter a value of 0 or more.";
  const unit = rate?.unit;
  if (unit === "percent" && n > 100) return "A percentage cannot be more than 100.";
  if (unit === "count" && (!Number.isInteger(n) || n > 31)) return "Enter a whole number from 0 to 31.";
  if (unit === "days" && (!Number.isInteger(n) || n < 1 || n > 366)) return "Enter a whole number of days from 1 to 366.";
  if (unit === "day_of_month" && (!Number.isInteger(n) || n > 31)) return "Enter a day of the month from 0 (month end) to 31.";
  if (unit === "switch" && n !== 0 && n !== 1) return "Enter 1 (on) or 0 (off).";
  if (unit === "half" && ![1, 2, 3].includes(n)) return "Enter 1, 2 or 3.";
  return "";
}

function RateDialog({ request, data, branches, onClose, onSaved }) {
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
      .then((payload) => setEmployees((payload.employees || []).filter((e) => !e.archived)))
      .catch(() => setEmployees([]));
  }, [open, values.scope, employees]);

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
  const lateDate = finalized && values.effective && values.effective <= finalized.end_key;

  async function save(event) {
    event.preventDefault();
    if (busy || !rate) return;
    const scopeRef = values.scope === "position" ? values.position.trim() : values.scope === "global" ? "" : values.ref;
    const nextErrors = {};
    const vError = valueError(rate, values.value);
    if (vError) nextErrors.value = vError;
    else if (!values.effective) nextErrors.effective = "Choose the date the new value takes effect.";
    else if (values.scope !== "global" && !scopeRef) nextErrors[values.scope === "position" ? "position" : "ref"] = "Choose who this rate applies to.";
    setErrors(nextErrors);
    const firstKey = Object.keys(nextErrors)[0];
    if (firstKey) {
      setFeedback(nextErrors[firstKey]);
      document.getElementById(`sa-rate-${firstKey}`)?.focus();
      return;
    }
    const ok = await confirm({
      title: "Confirm rate change",
      description: `Set ${rate.label || "this rate"} to ${rateDisplay(rate, values.value)} from ${rateDate(values.effective)}? A new version is added; the current one stays in the history. Past payslips are not affected.`,
      confirmLabel: "Save",
    });
    if (!ok) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await fetchJson("/api/admin/payroll-rates", jsonBody("POST", {
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
              <Label htmlFor="sa-rate-value">{VALUE_LABEL[rate?.unit] || "New value (₱)"}</Label>
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="sa-rate-effective">Effective starting</Label>
              <DatePicker id="sa-rate-effective" value={values.effective} onChange={(v) => set("effective", v)} {...invalid("effective")} />
              {error("effective") || (
                <p className={cn("text-xs", lateDate ? "text-warning" : "text-muted-foreground")}>
                  {lateDate
                    ? `${finalized.label} has already been processed — this change will apply from the next pay period instead (${rateDate(data.earliest_effective_date)}).`
                    : "Payroll uses the version in force on a pay period's first day, so a mid-period date takes effect from the following period. Past payslips are not affected."}
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
                <Select value={values.ref || undefined} onValueChange={(v) => set("ref", v)} disabled={Boolean(branchPreset)}>
                  <SelectTrigger id="sa-rate-ref" className="w-full" {...invalid("ref")}><SelectValue placeholder={(branches || []).length ? "Select branch" : "No branches found"} /></SelectTrigger>
                  <SelectContent>{(branches || []).map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
                </Select>
                {error("ref")}
              </div>
            ) : null}
            {values.scope === "employee" ? (
              <div className="space-y-2">
                <Label htmlFor="sa-rate-ref">Employee</Label>
                <Select value={values.ref || undefined} onValueChange={(v) => set("ref", v)} disabled={!employees}>
                  <SelectTrigger id="sa-rate-ref" className="w-full" {...invalid("ref")}>
                    <SelectValue placeholder={!employees ? "Loading employees…" : employees.length ? "Select employee" : "No employees found"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {employeeGroups.map(([name, list]) => (
                      <SelectGroup key={name}>
                        <SelectLabel>{name}</SelectLabel>
                        {list.map((e) => <SelectItem key={e.id} value={String(e.id)}>{e.full_name}{e.employee_id ? ` — ${e.employee_id}` : ""}</SelectItem>)}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
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
              <Label htmlFor="sa-rate-note">Note (optional)</Label>
              <Input id="sa-rate-note" maxLength={300} placeholder="e.g. Board resolution 2026-14" value={values.note} onChange={(e) => set("note", e.target.value)} />
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

export function RatesSection({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null, branches: [] });
  const [dialog, setDialog] = React.useState({ open: false, rateType: "", branch: null });
  const [today] = React.useState(manilaToday);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    const [rates, branches] = await Promise.allSettled([fetchJson("/api/admin/payroll-rates"), fetchJson("/api/admin/branches")]);
    setState((current) => ({
      loading: false,
      error: rates.status === "rejected" ? rates.reason?.message || "Unable to load payroll rates." : null,
      data: rates.status === "fulfilled" ? rates.value : current.data,
      branches: branches.status === "fulfilled" ? branches.value.branches || [] : current.branches,
    }));
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const rates = React.useMemo(() => data?.rates || [], [data]);
  const dailyRate = React.useMemo(() => rates.find((r) => r.rate_type === "daily") || { unit: "peso" }, [rates]);

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
    { key: "current", header: "This period", className: "whitespace-nowrap tabular-nums", cell: (r) => rateDisplay(r, r.current?.value) },
    {
      key: "next",
      header: "Next period",
      className: "whitespace-nowrap tabular-nums",
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
      cell: (r) => <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, rateType: r.rate_type, branch: null })} aria-label={`Edit ${r.label}`}><PencilIcon aria-hidden="true" />Edit</Button>,
    },
  ], [today]);

  const branchColumns = React.useMemo(() => {
    const valueCell = (v) => (
      <div className="tabular-nums">
        {rateDisplay(dailyRate, v?.value)}
        {v?.scope === "branch" ? null : <p className="text-xs text-muted-foreground">Default</p>}
      </div>
    );
    return [
      {
        key: "name",
        header: "Branch",
        sortable: true,
        className: "font-medium",
        cell: (b) => <>{b.name}{b.status && b.status !== "Active" ? <span className="ml-1 text-xs font-normal text-muted-foreground">(Inactive)</span> : null}</>,
      },
      { key: "current", header: "This period", cell: (b) => valueCell(b.current) },
      {
        key: "next",
        header: "Next period",
        cell: (b) => {
          const changing = Number(b.next_period?.value) !== Number(b.current?.value);
          return <div className={cn(changing && "font-semibold text-warning")}>{valueCell(b.next_period)}</div>;
        },
      },
      {
        key: "history",
        header: "History",
        className: "min-w-72 whitespace-normal",
        cell: (b) => <History rate={dailyRate} history={b.history} today={today} empty="No branch rate yet — uses the default" />,
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        cell: (b) => <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, rateType: "daily", branch: b.branch_id })} aria-label={`Edit daily rate for ${b.name}`}><PencilIcon aria-hidden="true" />Edit</Button>,
      },
    ];
  }, [dailyRate, today]);

  const finalizedNote = data?.finalized_period
    ? ` ${data.finalized_period.label} is already processed; new versions start ${rateDate(data.earliest_effective_date)} or later.`
    : "";
  const unavailable = data && !data.available;

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><PercentIcon className="size-4 text-gold-text" aria-hidden="true" />Payroll rates</CardTitle>
          <CardDescription>Payroll uses the value in force on each pay period&apos;s first day.{finalizedNote}</CardDescription>
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
              rows={rates}
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
            <CardTitle className="flex items-center gap-2"><BuildingIcon className="size-4 text-gold-text" aria-hidden="true" />Daily rate per branch</CardTitle>
            <CardDescription>Salary per day for each branch. A branch without its own rate uses the default Daily rate above.</CardDescription>
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
              caption="Daily rate per branch"
              minWidth={860}
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
      />
    </>
  );
}
