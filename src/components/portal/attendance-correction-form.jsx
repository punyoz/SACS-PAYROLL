"use client";

import * as React from "react";
import { Loader2Icon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { FIX_TYPES, REASON_CODES, fixTypesFor, timesNeeded } from "@/lib/attendance/correction-requests";

/*
 * Attendance correction request (2026-11-23): the employee asks HR to fix a
 * time in / time out. Filled in with the day and its taps; the server checks
 * the filing window, the limit per cutoff, the times and one open request per
 * day (20261124040000).
 */

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) : "");
const MAX_BYTES = 2 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

export function AttendanceCorrectionForm({ day, initialFix = null, onDone, onCancel }) {
  const { notify } = usePortalSession();
  const options = fixTypesFor(day);
  const [fix, setFix] = React.useState(options.includes(initialFix) ? initialFix : options[0] || "missing_in");
  const [timeIn, setTimeIn] = React.useState(hhmm(day?.time_in));
  const [timeOut, setTimeOut] = React.useState(hhmm(day?.time_out));
  const [reasonCode, setReasonCode] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [file, setFile] = React.useState(null);
  const [usage, setUsage] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const need = timesNeeded(fix, day);
  const dateKey = String(day?.log_date || "").slice(0, 10);

  React.useEffect(() => {
    let alive = true;
    fetchJson(`/api/attendance/corrections?usage=1&date=${dateKey}`).then((u) => { if (alive) setUsage(u); }).catch(() => {});
    return () => { alive = false; };
  }, [dateKey]);

  async function submit(event) {
    event.preventDefault();
    if (need.in && !timeIn) { setError("Enter the correct time in."); return; }
    if (need.out && !timeOut) { setError("Enter the correct time out."); return; }
    if (need.in && need.out && timeOut <= timeIn) { setError("The time out must be after the time in."); return; }
    if (!reasonCode) { setError("Choose the reason."); return; }
    if (reasonCode === "other" && reason.trim().length < 5) { setError("Describe the reason (at least 5 characters)."); return; }
    if (file && file.size > MAX_BYTES) { setError("The attachment must be under 2 MB."); return; }
    setBusy(true);
    setError("");
    try {
      const attachment = file ? await readAsDataUrl(file) : undefined;
      await fetchJson("/api/attendance/corrections", jsonBody("POST", {
        log_id: day.id, fix_type: fix, time_in: need.in ? timeIn : undefined, time_out: need.out ? timeOut : undefined,
        reason_code: reasonCode, reason: reason.trim() || undefined, attachment,
      }));
      notify("Attendance correction request sent", "HR reviews it. The day shows Pending Correction until it is decided.", "success");
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit} noValidate data-testid="correction-form">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <p><strong>{dateKey}</strong> · {day?.status}</p>
        <p className="text-muted-foreground">Recorded: time in {hhmm(day?.time_in) || "—"}, time out {hhmm(day?.time_out) || "—"}</p>
        {usage ? <p className="text-xs text-muted-foreground" data-testid="correction-usage">{usage.used} of {usage.max} used this cutoff · file within {usage.window_days} working days after the date</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="corr-fix">What to fix</Label>
        <Select value={fix} onValueChange={setFix}>
          <SelectTrigger id="corr-fix" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((t) => <SelectItem key={t} value={t}>{FIX_TYPES[t]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {need.in ? <div className="space-y-1.5"><Label htmlFor="corr-in">Correct time in</Label><Input id="corr-in" type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} /></div> : null}
        {need.out ? <div className="space-y-1.5"><Label htmlFor="corr-out">Correct time out</Label><Input id="corr-out" type="time" value={timeOut} onChange={(e) => setTimeOut(e.target.value)} /></div> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="corr-reason">Reason</Label>
        <Select value={reasonCode} onValueChange={setReasonCode}>
          <SelectTrigger id="corr-reason" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
          <SelectContent>{Object.entries(REASON_CODES).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="corr-note">{reasonCode === "other" ? "Describe the reason" : "Details (optional)"}</Label>
        <Textarea id="corr-note" rows={2} maxLength={450} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="corr-file">Attachment (optional)</Label>
        <Input id="corr-file" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <p className="text-xs text-muted-foreground">e.g. a photo of the logbook. PDF, PNG or JPEG, under 2 MB.</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive" data-testid="correction-error">{error}</p> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
        <Button type="submit" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}Send request</Button>
      </div>
    </form>
  );
}
