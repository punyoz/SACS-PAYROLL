"use client";

import * as React from "react";
import { FileLockIcon, Loader2Icon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { formatPeso } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * Final Payslip Override (loadSAPayslipOverrides / openSAPayslipOverride /
 * submitSAPayslipOverride, public/legacy/js/super-admin.js). A Final payslip
 * is locked; a Super Admin can recompute it from the latest attendance and
 * corrections, with a reason: PATCH /api/accountant/payroll
 * { action: "override_final" }. The server archives the replaced record and
 * issues a new payslip number.
 */

function processed(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

function reasonError(value) {
  if (!value) return "Reason is required.";
  return value.length < 10 ? "Give a little more detail (at least 10 characters)." : "";
}

function OverrideDialog({ record, open, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setReason("");
    setError("");
    setFeedback("");
    setBusy(false);
  }, [open]);

  async function send(text, confirmIncomplete) {
    try {
      return await fetchJson("/api/accountant/payroll", jsonBody("PATCH", {
        action: "override_final",
        employee_id: record.employee_id,
        pay_period: record.pay_period,
        reason: text,
        confirm_incomplete: confirmIncomplete,
      }));
    } catch (err) {
      if (err.status === 422 && err.code === "unresolved_attendance" && !confirmIncomplete) {
        const proceed = await confirm({ title: "Unresolved attendance", description: err.message, confirmLabel: "Override anyway" });
        if (!proceed) throw new Error("Override cancelled.");
        return send(text, true);
      }
      throw err;
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !record) return;
    const text = reason.trim();
    const problem = reasonError(text);
    setError(problem);
    if (problem) {
      document.getElementById("sa-ovr-reason")?.focus();
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const data = await send(text, false);
      const number = data.entry?.payslip_no || "";
      notify("Payslip Overridden", `New Final payslip ${number} issued for ${record.employee_name || "the employee"}.`, "success");
      onOpenChange(false);
      onDone(`Overridden: ${record.employee_name || "employee"}, new payslip ${number}.`);
    } catch (err) {
      setFeedback(err.message || "Unable to override the payslip.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Override Final payslip</DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">{record?.employee_name || "Employee"}</strong> · {record?.pay_period}. The payslip is recomputed from the latest attendance and corrections. The current one is archived and a new payslip number is issued.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sa-ovr-reason">Reason</Label>
              <Textarea
                id="sa-ovr-reason"
                rows={3}
                maxLength={500}
                placeholder="e.g. HR corrected Sep 24 after the payslip was finalized"
                value={reason}
                onChange={(e) => { setReason(e.target.value); if (error) setError(""); }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "sa-ovr-reason-error" : "sa-ovr-reason-hint"}
                autoFocus
              />
              {error
                ? <p id="sa-ovr-reason-error" className="text-sm text-destructive">{error}</p>
                : <p id="sa-ovr-reason-hint" className="text-xs text-muted-foreground">Saved in the audit log.</p>}
            </div>
            {feedback ? <Alert variant="destructive"><AlertDescription>{feedback}</AlertDescription></Alert> : null}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Overriding…</> : "Override payslip"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

export function OverrideSection({ refreshKey }) {
  const [period, setPeriod] = React.useState("");
  const [state, setState] = React.useState({ loading: true, error: null, records: [], options: [], active: "" });
  const [dialog, setDialog] = React.useState({ open: false, record: null });
  const [done, setDone] = React.useState("");

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams();
      if (period) params.set("period", period);
      const data = await fetchJson(`/api/accountant/payroll${params.toString() ? `?${params}` : ""}`);
      setState({ loading: false, error: null, records: data.records || [], options: data.period_options || [], active: data.active_period?.label || period });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Unable to load payslips." }));
    }
  }, [period]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const columns = React.useMemo(() => [
    {
      key: "employee_name",
      header: "Employee",
      sortable: true,
      searchValue: (r) => `${r.employee_name || ""} ${r.employee_code || ""}`,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.employee_name || "—"}</p>
          <p className="text-xs text-muted-foreground">{r.employee_code || ""}</p>
        </div>
      ),
    },
    { key: "payslip_no", header: "Payslip no.", sortable: true, className: "font-mono text-xs", cell: (r) => r.payslip_no || "—" },
    { key: "net_pay", header: "Net pay", align: "right", className: "tabular-nums", sortValue: (r) => Number(r.net_pay || 0), cell: (r) => formatPeso(r.net_pay) },
    {
      key: "submitted_at",
      header: "Processed",
      sortValue: (r) => r.submitted_at || "",
      cell: (r) => (
        <div className="space-y-1">
          <p className="whitespace-nowrap tabular-nums">{processed(r.submitted_at)}</p>
          {r.payroll?.generation?.override ? <StatusBadge tone="warning">Overridden</StatusBadge> : null}
          {r.attendance_changed ? (
            <p className="max-w-64 text-xs whitespace-normal text-warning" title={(r.attendance_changed.days || []).join(", ")}>
              Attendance changed after Final ({r.attendance_changed.count}). Override to update.
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, record: r })} aria-label={`Override payslip for ${r.employee_name}`}><RotateCcwIcon aria-hidden="true" />Override</Button>,
    },
  ], []);

  const selected = period || state.active;

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileLockIcon className="size-4 text-gold-text" aria-hidden="true" />Final payslip override</CardTitle>
        <CardDescription>
          Recompute a locked Final payslip from the latest attendance and corrections. Needs a reason, saved in the audit log. The replaced payslip is archived, never deleted, and a new payslip number is issued.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {done ? <Alert className="border-success/40"><AlertDescription className="text-success">{done}</AlertDescription></Alert> : null}
        <DataTable
          columns={columns}
          rows={state.records}
          loading={state.loading && !state.records.length}
          error={state.error}
          onRetry={load}
          pageSize={10}
          searchPlaceholder="Search employee…"
          toolbar={(
            <Select value={selected || undefined} onValueChange={setPeriod} disabled={!state.options.length}>
              <SelectTrigger className="w-full sm:w-52" aria-label="Pay period"><SelectValue placeholder="Pay period" /></SelectTrigger>
              <SelectContent>{state.options.map((label) => <SelectItem key={label} value={label}>{label}</SelectItem>)}</SelectContent>
            </Select>
          )}
          empty={{ title: "No Final payslips for this period", icon: FileLockIcon }}
          caption="Final payslips"
          minWidth={820}
        />
      </CardContent>
      <OverrideDialog
        record={dialog.record}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onDone={(text) => { setDone(text); load(); }}
      />
    </Card>
  );
}
