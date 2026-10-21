"use client";

import * as React from "react";
import { Loader2Icon, RadioTowerIcon, ScanLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RfidCardsPanel } from "@/components/portal/rfid/rfid-cards-panel";
import { RfidTerminalsPanel } from "@/components/portal/rfid/rfid-terminals-panel";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, hardNavigate, jsonBody } from "@/lib/portal/api";
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

function ScanCard({ auditActor }) {
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
      if (auditActor) {
        logAuditMovement({
          module: "ui",
          action: "rfid_scan",
          entity_type: "attendance",
          entity_id: code,
          description: `${auditActor} submitted RFID attendance scan.`,
          source: "ui",
          metadata: { persisted: Boolean(payload.persisted) },
        });
      }
    } catch (error) {
      setFeedback({ text: error.message || "Failed to process RFID scan", ok: false });
    } finally {
      inFlight.current = false;
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [auditActor]);

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

const ADMIN_REGISTRATION_TEXT = "Register, replace and deactivate the RFID cards of your branch, and manage its terminals. HR and the Super Admin see the same cards.";

/**
 * Also the Super Admin's System Maintenance (loadSASystemData and friends,
 * public/legacy/js/super-admin.js): every branch, and a scan is not written
 * to the audit trail (auditActor null).
 */
const ADMIN_TERMINAL_TEXT = "Open the dedicated tap-in/tap-out screen for your branch's RFID reader. It replaces this view and is locked behind your Administration password.";

export function MaintenancePage({ refreshKey, registrationText = ADMIN_REGISTRATION_TEXT, auditActor = "Admin", terminalText = ADMIN_TERMINAL_TEXT }) {
  const { can } = usePortalSession();

  return (
    <>
      {/* The RFID reader is a device: HR, the Admin and the Super Admin run it
          from here (it used to sit on their Attendance pages). */}
      {can("rfid_devices", "update") ? (
        <Card className="border-brand-gold/60 bg-gradient-to-r from-brand-gold/10 to-transparent shadow-xs">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><RadioTowerIcon className="size-5" aria-hidden="true" /></span>
            <div className="flex-1">
              <p className="font-semibold">RFID Terminal</p>
              <p className="text-sm text-muted-foreground">{terminalText}</p>
            </div>
            <Button onClick={() => hardNavigate("/rfid-terminal")}>Open RFID Terminal</Button>
          </CardContent>
        </Card>
      ) : null}
      {/* Cards and terminals: the same records HR and the Super Admin see
          (an Admin: its own branch). 2026-10-21. */}
      <p className="text-sm text-muted-foreground">{registrationText}</p>
      <RfidCardsPanel refreshKey={refreshKey} />
      <RfidTerminalsPanel refreshKey={refreshKey} showOpen={false} />

      {/* Recording a scan writes attendance, which only HR manages (2026-10-20). */}
      {can("attendance", "update") ? <ScanCard auditActor={auditActor} /> : null}
    </>
  );
}
