"use client";

import * as React from "react";
import { CreditCardIcon, Loader2Icon, RefreshCwIcon, ScanLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { logAuditMovement } from "@/lib/portal/audit";
import { cn } from "@/lib/utils";

/*
 * System Maintenance (loadSystemData / openRfidEditModal / submitRfidUpdate /
 * voidRfidCard / submitRfidAttendanceScan, public/legacy/js/admin.js):
 * GET and PATCH /api/admin/system for RFID UIDs; POST /api/admin/attendance
 * { rfid_code, manual_entry: true } for a scan.
 */

/** "08:05 AM" in the browser's time zone (formatTimeOnly, app.js). */
function timeOnly(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

/** formatRfidScanFeedback (admin.js) */
function scanMessage(record, tap) {
  if (!record) return "";
  const name = record.employee_name || "Employee";
  if (tap === "duplicate") return `${name}: repeated tap ignored — only the first and last tap of the day count.`;
  if (tap === "after_correction") return `${name}: tap recorded. This day was corrected by HR / Admin, so its times stay as corrected (flagged for review).`;
  if (record.time_out) return `${name}: Time Out recorded at ${timeOnly(record.time_out)} (Time In ${timeOnly(record.time_in)}).`;
  return `${name}: Time In recorded at ${timeOnly(record.time_in)} (${record.status || "Present"}).`;
}

function AssignDialog({ device, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const [uid, setUid] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (!device) return;
    setUid(device.rfid_uid || "");
    setFeedback({ text: "", ok: false });
    // Selected, so a HID reader's keystrokes replace it at once.
    setTimeout(() => inputRef.current?.select(), 50);
  }, [device]);

  async function save(event) {
    event.preventDefault();
    if (!device?.id) { setFeedback({ text: "Employee ID is missing.", ok: false }); return; }
    const value = uid.trim();
    setBusy(true);
    try {
      await fetchJson("/api/admin/system", jsonBody("PATCH", { id: device.id, rfid_uid: value }));
      setFeedback({ text: value ? "RFID assigned successfully." : "RFID removed.", ok: true });
      notify("RFID Updated", value ? "RFID UID has been assigned to the employee." : "RFID UID has been removed.", "success");
      await onSaved();
      setTimeout(() => onOpenChange(false), 500);
    } catch (error) {
      setFeedback({ text: error.message || "Failed to update RFID", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(device)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign RFID UID</DialogTitle>
          <DialogDescription>Tap the card on the reader, or type the UID. Leave it blank to remove the current assignment.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="adm-f-employee-display">Employee</Label>
            <Input id="adm-f-employee-display" readOnly value={device ? `${device.full_name} (${device.employee_id || "N/A"})` : ""} className="bg-muted text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adm-f-rfid-uid">RFID UID</Label>
            <Input id="adm-f-rfid-uid" ref={inputRef} maxLength={16} autoComplete="off" placeholder="Tap RFID card or enter UID manually" value={uid} onChange={(e) => setUid(e.target.value)} className="font-mono" />
          </div>
          <p role="status" aria-live="polite" className={cn("min-h-5 text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save RFID"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScanCard() {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const inputRef = React.useRef(null);
  const inFlight = React.useRef(false);
  const idle = React.useRef(null);

  // Focused on open, so a USB reader's keystrokes land here without a click.
  React.useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0); }, []);
  React.useEffect(() => () => clearTimeout(idle.current), []);

  const submit = React.useCallback(async (raw) => {
    if (inFlight.current) return;
    const code = String(raw || "").trim();
    if (!code) {
      setFeedback({ text: "Enter RFID or employee ID first.", ok: false });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFeedback({ text: "Processing RFID scan…", ok: true });
    try {
      // manual_entry: this box also accepts an Employee ID; the kiosk does not.
      const payload = await fetchJson("/api/admin/attendance", jsonBody("POST", { rfid_code: code, manual_entry: true }));
      setValue("");
      setFeedback({ text: scanMessage(payload.record, payload.tap) || payload.message || "RFID scan recorded.", ok: true });
      logAuditMovement({
        module: "ui",
        action: "rfid_scan",
        entity_type: "attendance",
        entity_id: code,
        description: "Admin submitted RFID attendance scan.",
        source: "ui",
        metadata: { persisted: Boolean(payload.persisted) },
      });
    } catch (error) {
      setFeedback({ text: error.message || "Failed to process RFID scan", ok: false });
    } finally {
      inFlight.current = false;
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, []);

  function onChange(event) {
    // Numbers only: drop anything else typed or pasted.
    const digits = event.target.value.replace(/\D/g, "");
    setValue(digits);
    clearTimeout(idle.current);
    // Some readers never send Enter after a tap: submit once keystrokes stop
    // for a beat, from 6 digits, so a paused manual entry never fires early.
    if (/^\d{6,}$/.test(digits)) idle.current = setTimeout(() => submit(digits), 400);
  }

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScanLineIcon className="size-4 text-gold-text" aria-hidden="true" />RFID scan input</CardTitle>
        <CardDescription>Tap an RFID card (or type the employee ID). Only the first and the last tap of the day are counted: the first tap is Time In, the last tap is Time Out, and a repeated tap within a minute is ignored.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => { e.preventDefault(); clearTimeout(idle.current); submit(value); }}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="adm-rfid-input">RFID / Employee ID</Label>
            <Input id="adm-rfid-input" ref={inputRef} inputMode="numeric" pattern="[0-9]*" maxLength={16} autoComplete="off" placeholder="Tap RFID card or enter employee ID" value={value} onChange={onChange} disabled={busy} className="h-11 font-mono text-base" />
          </div>
          <Button type="submit" size="lg" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Recording…</> : "Record scan"}</Button>
        </form>
        <p role="status" aria-live="polite" className={cn("mt-3 min-h-5 text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
      </CardContent>
    </Card>
  );
}

export function MaintenancePage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, devices: [] });
  const [editing, setEditing] = React.useState(null);
  const [confirmDialog, confirm] = useConfirm();

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.devices.length, error: null }));
    try {
      const payload = await fetchJson("/api/admin/system");
      setState({ loading: false, error: null, devices: (payload.rfid_devices || []).filter((d) => !d.archived) });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const voidCard = React.useCallback(async (device) => {
    const ok = await confirm({
      title: `Void the RFID card for ${device.full_name}?`,
      description: "The employee will no longer be able to tap in with this card.",
      confirmLabel: "Void card",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchJson("/api/admin/system", jsonBody("PATCH", { id: device.id, rfid_uid: "" }));
      notify("RFID Voided", `RFID card for ${device.full_name} has been voided.`, "success");
      await load();
    } catch (error) {
      notify("Error", error.message || "Failed to void RFID card.", "error");
    }
  }, [confirm, load, notify]);

  const columns = React.useMemo(() => [
    { key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (d) => d.full_name },
    { key: "employee_id", header: "Employee ID", className: "tabular-nums", cell: (d) => d.employee_id || "N/A", searchValue: (d) => d.employee_id },
    { key: "employee_type", header: "Type", cell: (d) => <StatusBadge tone={d.employee_type === "Non-Teaching" ? "gold" : "info"} dot={false}>{d.employee_type || "Teaching"}</StatusBadge> },
    { key: "rfid_uid", header: "RFID UID", className: "font-mono text-xs", cell: (d) => (String(d.rfid_uid || "").trim() ? d.rfid_uid : "—"), searchValue: (d) => d.rfid_uid },
    {
      key: "status",
      header: "Status",
      sortValue: (d) => (String(d.rfid_uid || "").trim() ? 1 : 0),
      cell: (d) => (String(d.rfid_uid || "").trim() ? <StatusBadge tone="success">Assigned</StatusBadge> : <StatusBadge tone="gold">Unassigned</StatusBadge>),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (d) => {
        const has = Boolean(String(d.rfid_uid || "").trim());
        return (
          <div className="flex justify-end gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setEditing(d)}>{has ? "Update" : "Assign"}</Button>
            {has ? <Button variant="destructive" size="sm" onClick={() => voidCard(d)}>Void</Button> : null}
          </div>
        );
      },
    },
  ], [voidCard]);

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CreditCardIcon className="size-4 text-gold-text" aria-hidden="true" />RFID device registration</CardTitle>
          <CardDescription>Assign or update RFID UIDs for employees in your branch. The UID matches card taps to attendance records. Void a card that is lost or no longer in use.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={state.devices}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search employee name, ID or UID…"
            empty={{ title: "No employees found", icon: CreditCardIcon }}
            caption="RFID cards"
            minWidth={720}
          />
        </CardContent>
      </Card>

      <ScanCard />

      <AssignDialog device={editing} onOpenChange={(open) => { if (!open) setEditing(null); }} onSaved={load} />
      {confirmDialog}
    </>
  );
}
