"use client";

import * as React from "react";
import { HandCoinsIcon, Loader2Icon, PencilIcon, PlusIcon, ReceiptTextIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { ErrorState } from "@/components/portal/empty-state";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { peso, rateDate, taxFor } from "./config-format";

/*
 * Semi-monthly payroll settings (loadSAPayrollSettings / submitSATaxTable /
 * submitSAContribution, public/legacy/js/super-admin.js): GET and POST
 * /api/admin/payroll-settings — the monthly withholding tax table and each
 * employee's monthly contribution amounts, both saved as versions from an
 * effective date.
 */

const TYPES = [["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"]];

function exampleFor(rows, index) {
  const row = rows[index];
  const next = rows[index + 1];
  return next
    ? `At ${peso(next.bracket_over)}: ${peso(taxFor(Number(next.bracket_over), rows))}`
    : `Above ${peso(row.bracket_over)}: ${row.rate_pct}% of the excess`;
}

/** The checks of submitSATaxTable; "" when the table can be saved. */
function taxTableError(rows) {
  if (!rows.length) return "Add at least one bracket.";
  if (rows.some((row) => [row.bracket_over, row.base_tax, row.rate_pct].some((v) => !Number.isFinite(v) || v < 0))) return "Every amount must be 0 or more.";
  if (rows.some((row) => row.rate_pct > 100)) return "A rate cannot be more than 100%.";
  if (rows[0].bracket_over !== 0) return "The first bracket must start at 0.";
  if (rows.some((row, i) => i > 0 && row.bracket_over <= rows[i - 1].bracket_over)) return "Each bracket must start above the one before it.";
  return "";
}

function TaxTableCard({ data, loading, onReload }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [rows, setRows] = React.useState([]);
  const [effective, setEffective] = React.useState("");
  const [note, setNote] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });
  const [busy, setBusy] = React.useState(false);

  const versions = React.useMemo(() => data?.tax_table?.versions || [], [data]);
  const currentVersion = versions.find((v) => v.version_id === data?.tax_table?.current_version_id) || versions[0] || null;

  // The editor starts from the version payroll will use next.
  React.useEffect(() => {
    if (!data) return;
    const upcoming = versions.find((v) => v.version_id === data.tax_table?.next_period_version_id) || currentVersion;
    setRows((upcoming?.rows || [{ bracket_over: 0, base_tax: 0, rate_pct: 0 }]).map((row) => ({ ...row })));
    setEffective((value) => value || data.default_effective_date || "");
    // currentVersion follows versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, versions]);

  const setCell = (index, field, value) => setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value === "" ? "" : Number(value) } : row)));
  const addRow = () => setRows((current) => [...current, { bracket_over: Number(current[current.length - 1]?.bracket_over || 0) + 1, base_tax: 0, rate_pct: 0 }]);
  const removeRow = (index) => setRows((current) => current.filter((_, i) => i !== index));

  async function save() {
    const clean = rows.map((row) => ({ bracket_over: Number(row.bracket_over), base_tax: Number(row.base_tax), rate_pct: Number(row.rate_pct) }));
    const problem = taxTableError(clean) || (!effective ? "Choose the date it takes effect." : "");
    if (problem) {
      setFeedback({ text: problem, tone: "error" });
      if (!effective) document.getElementById("sa-tax-effective")?.focus();
      return;
    }
    const ok = await confirm({
      title: "Confirm tax table",
      description: `Save the monthly withholding tax table from ${rateDate(effective)}? A new version is added; the current one stays in the history. Past payslips are not affected.`,
      confirmLabel: "Save",
    });
    if (!ok) return;
    setBusy(true);
    setFeedback({ text: "Saving…", tone: "" });
    try {
      const result = await fetchJson("/api/admin/payroll-settings", jsonBody("POST", { kind: "tax_table", effective_date: effective, rows: clean, note: note.trim() }));
      setFeedback({ text: result.warning || `Saved — applies from ${rateDate(result.effective_date)}.`, tone: result.warning ? "warning" : "success" });
      notify(result.warning ? "Tax Table Scheduled" : "Tax Table Saved", result.warning || `Applies from ${rateDate(result.effective_date)}.`, result.warning ? "info" : "success");
      await onReload();
    } catch (error) {
      setFeedback({ text: error.message || "Unable to save the tax table.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ReceiptTextIcon className="size-4 text-gold-text" aria-hidden="true" />Withholding tax table (monthly)</CardTitle>
        <CardDescription>
          The 2nd half computes withholding tax once, on the month&apos;s taxable income (monthly gross − SSS, PhilHealth, Pag-IBIG).
          Saved as a new version from the effective date — past payslips are not affected.
          {data?.finalized_period ? ` ${data.finalized_period.label} is already processed; new versions start ${rateDate(data.earliest_effective_date)} or later.` : ""}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onReload} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Tax = base tax + rate × (taxable income − &quot;over&quot;), for the highest bracket the taxable income is over.{" "}
          {currentVersion ? `In force since ${rateDate(currentVersion.effective_date)}.` : "No table yet — payroll cannot compute the 2nd half until one is saved."}
        </p>
        {loading && !data ? <Skeleton className="h-40 w-full" /> : (
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-160">
              <TableCaption className="sr-only">Tax brackets</TableCaption>
              <TableHeader>
                <TableRow><TableHead>Over (₱)</TableHead><TableHead>Base tax (₱)</TableHead><TableHead>Rate (%)</TableHead><TableHead>Example</TableHead><TableHead><span className="sr-only">Remove</span></TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={index}>
                    {[["bracket_over", "Over"], ["base_tax", "Base tax"], ["rate_pct", "Rate"]].map(([field, label]) => (
                      <TableCell key={field}>
                        <Input
                          type="number"
                          min="0"
                          max={field === "rate_pct" ? "100" : undefined}
                          step="0.01"
                          inputMode="decimal"
                          aria-label={`${label}, bracket ${index + 1}`}
                          value={row[field]}
                          onChange={(e) => setCell(index, field, e.target.value)}
                          className="max-w-36 tabular-nums"
                        />
                      </TableCell>
                    ))}
                    <TableCell className="text-xs text-muted-foreground">{exampleFor(rows, index)}</TableCell>
                    <TableCell className="text-right">
                      {index > 0 ? <Button variant="ghost" size="icon-sm" onClick={() => removeRow(index)} aria-label={`Remove bracket ${index + 1}`}><Trash2Icon aria-hidden="true" /></Button> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <Button variant="outline" size="sm" onClick={addRow}><PlusIcon aria-hidden="true" />Add bracket</Button>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sa-tax-effective">Effective starting</Label>
            <DatePicker id="sa-tax-effective" value={effective} onChange={setEffective} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sa-tax-note">Note (optional)</Label>
            <Input id="sa-tax-note" maxLength={300} placeholder="e.g. BIR RR 11-2018 Annex E" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={busy || !data}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save new version"}</Button>
          <p role="status" aria-live="polite" className={cn("text-sm", { "text-success": feedback.tone === "success", "text-destructive": feedback.tone === "error", "text-warning": feedback.tone === "warning", "text-muted-foreground": !feedback.tone })}>{feedback.text}</p>
        </div>
        {versions.length ? (
          <p className="text-xs text-muted-foreground">
            History: {versions.map((v) => `${rateDate(v.effective_date)}${v.created_by_name ? ` · ${v.created_by_name}` : ""}${v.note ? ` (${v.note})` : ""}`).join(" → ")}
          </p>
        ) : null}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

function amountOf(row, type) {
  const fixed = row.fixed && row.fixed[type] !== null && row.fixed[type] !== undefined;
  return { amount: fixed ? Number(row.fixed[type]) : Number(row.computed?.[type] || 0), fixed };
}

function ContributionDialog({ row, defaultDate, open, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const [values, setValues] = React.useState({ sss: "", philhealth: "", pagibig: "", effective: "", note: "" });
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open || !row) return;
    setFeedback("");
    setBusy(false);
    const fixed = (type) => (row.fixed && row.fixed[type] !== null && row.fixed[type] !== undefined ? String(row.fixed[type]) : "");
    setValues({ sss: fixed("sss"), philhealth: fixed("philhealth"), pagibig: fixed("pagibig"), effective: defaultDate || "", note: "" });
  }, [open, row, defaultDate]);

  const set = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const defaultLabel = row?.default_source === "fixed" ? "Payroll Rates (fixed amounts)" : "Legal table";

  async function save(event) {
    event.preventDefault();
    if (busy || !row) return;
    const amounts = { sss: values.sss, philhealth: values.philhealth, pagibig: values.pagibig };
    if (Object.values(amounts).some((v) => v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0))) {
      setFeedback("Enter each amount as 0 or more, or leave it blank.");
      return;
    }
    if (!values.effective) {
      setFeedback("Choose the date it takes effect.");
      document.getElementById("sa-contrib-effective")?.focus();
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const result = await fetchJson("/api/admin/payroll-settings", jsonBody("POST", {
        kind: "contribution",
        employee_id: row.employee_id,
        effective_date: values.effective,
        ...amounts,
        note: values.note.trim(),
      }));
      notify(result.warning ? "Scheduled for Next Period" : "Contributions Saved", result.warning || `Applies from ${rateDate(result.effective_date)}.`, result.warning ? "info" : "success");
      onOpenChange(false);
      await onSaved();
    } catch (error) {
      setFeedback(error.message || "Unable to save the contribution amounts.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Contribution amounts — {row?.employee_name}</DialogTitle>
          <DialogDescription>
            {defaultLabel}: SSS <strong className="tabular-nums text-foreground">{peso(row?.computed?.sss)}</strong>, PhilHealth <strong className="tabular-nums text-foreground">{peso(row?.computed?.philhealth)}</strong>, Pag-IBIG <strong className="tabular-nums text-foreground">{peso(row?.computed?.pagibig)}</strong> a month on {peso(row?.monthly_salary)}.
            <span className="mt-1 block text-xs">Leave an amount blank to use {row?.default_source === "fixed" ? "the fixed amounts in Payroll Rates" : "the legal table"}. 0 = exempt.</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-3">
          {TYPES.map(([type, label]) => (
            <div key={type} className="space-y-2">
              <Label htmlFor={`sa-contrib-${type}`}>{label}{type === "sss" ? " (₱/month)" : ""}</Label>
              <Input id={`sa-contrib-${type}`} type="number" min="0" step="0.01" inputMode="decimal" placeholder="Computed" value={values[type]} onChange={(e) => set(type, e.target.value)} className="tabular-nums" autoFocus={type === "sss"} />
            </div>
          ))}
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="sa-contrib-effective">Effective starting</Label>
            <DatePicker id="sa-contrib-effective" value={values.effective} onChange={(v) => set("effective", v)} />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="sa-contrib-note">Note (optional)</Label>
            <Input id="sa-contrib-note" maxLength={300} placeholder="e.g. Voluntary SSS contribution" value={values.note} onChange={(e) => set("note", e.target.value)} />
          </div>
          {feedback ? <Alert variant="destructive" className="sm:col-span-3"><AlertDescription>{feedback}</AlertDescription></Alert> : null}
          <DialogFooter className="gap-2 sm:col-span-3 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => setValues((current) => ({ ...current, sss: "", philhealth: "", pagibig: "" }))}>Use default</Button>
            <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ContributionsCard({ data, loading, onReload }) {
  const [editing, setEditing] = React.useState({ open: false, row: null });

  const columns = React.useMemo(() => {
    const amountCell = (row, type) => {
      const c = amountOf(row, type);
      const defaultLabel = row.default_source === "fixed" ? "Payroll Rates" : "Legal table";
      return (
        <div className="tabular-nums">
          {peso(c.amount)}
          <p className={cn("text-xs", c.fixed ? "text-warning" : "text-muted-foreground")}>{c.fixed ? "Fixed" : defaultLabel}</p>
        </div>
      );
    };
    return [
      {
        key: "employee_name",
        header: "Employee",
        sortable: true,
        searchValue: (r) => `${r.employee_name || ""} ${r.employee_code || ""}`,
        cell: (r) => (
          <div>
            <p className="font-medium">{r.employee_name}</p>
            <p className="text-xs text-muted-foreground">{[r.employee_code, r.branch_name].filter(Boolean).join(" · ")}</p>
            {r.scheduled ? <p className="text-xs text-warning">Changes {rateDate(r.scheduled.effective_date)}</p> : null}
          </div>
        ),
      },
      { key: "monthly_salary", header: "Monthly salary", sortValue: (r) => Number(r.monthly_salary || 0), className: "tabular-nums", cell: (r) => peso(r.monthly_salary) },
      ...TYPES.map(([type, label]) => ({ key: type, header: label, sortValue: (r) => amountOf(r, type).amount, cell: (r) => amountCell(r, type) })),
      {
        key: "total",
        header: "Total",
        className: "font-semibold tabular-nums",
        sortValue: (r) => TYPES.reduce((sum, [type]) => sum + amountOf(r, type).amount, 0),
        cell: (r) => peso(TYPES.reduce((sum, [type]) => sum + amountOf(r, type).amount, 0)),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        cell: (r) => <Button variant="outline" size="sm" onClick={() => setEditing({ open: true, row: r })} aria-label={`Edit contributions for ${r.employee_name}`}><PencilIcon aria-hidden="true" />Edit</Button>,
      },
    ];
  }, []);

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HandCoinsIcon className="size-4 text-gold-text" aria-hidden="true" />Contribution amounts</CardTitle>
        <CardDescription>
          Monthly SSS, PhilHealth and Pag-IBIG per employee, deducted once in the 2nd half. Without an amount here, payroll uses Payroll Rates: the fixed amounts when &quot;Contributions as fixed amounts&quot; is On, otherwise the legal tables.
          A change applies from its effective date; a blank amount goes back to the default. 0 = exempt.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onReload} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={data?.contributions || []}
          rowKey={(r) => r.employee_id}
          loading={loading && !data}
          pageSize={15}
          searchPlaceholder="Search employee…"
          empty={{ title: "No employees found", icon: HandCoinsIcon }}
          caption="Contribution amounts"
          minWidth={900}
        />
      </CardContent>
      <ContributionDialog
        row={editing.row}
        defaultDate={data?.default_effective_date}
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        onSaved={onReload}
      />
    </Card>
  );
}

export function PayrollSettingsSection({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/admin/payroll-settings");
      if (!data.available) throw new Error(data.error || "Payroll settings are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load payroll settings." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  if (state.error && !state.data) {
    return <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>;
  }

  return (
    <>
      <TaxTableCard data={state.data} loading={state.loading} onReload={load} />
      <ContributionsCard data={state.data} loading={state.loading} onReload={load} />
    </>
  );
}
