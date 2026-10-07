"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { AttendanceBadge, StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import {
  canCorrect,
  formatDateTime,
  formatMinutes,
  formatTapTime,
  hoursMinutes,
  isLogId,
  nowHm,
  reasonError,
  todayKey,
  workedMinutes,
} from "@/lib/portal/attendance";
import { formatDateKey, formatTime, normalizeAttendanceStatus, timeInputValue } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * The attendance dialogs of public/legacy/js/app.js (openAttendanceCorrection,
 * openAttendanceReview, openAttendanceResolve, openOvertimeReview,
 * openAttendanceTaps, openAttendanceCorrectionHistory), with the same
 * checks and the same PATCH bodies. The server re-checks role, branch and
 * every rule.
 *
 * <AttendanceActionsProvider> holds which dialog is open and a `version`
 * that goes up after every change, so the board, the log and the employee
 * page reload.
 */

const ActionsContext = React.createContext(null);

export function useAttendanceActions() {
  return React.useContext(ActionsContext);
}

export function AttendanceActionsProvider({ children, onOpenEmployee }) {
  const [dialog, setDialog] = React.useState(null); // { kind, row }
  const [version, setVersion] = React.useState(0);
  const changed = React.useCallback(() => setVersion((v) => v + 1), []);

  const value = React.useMemo(() => ({
    version,
    changed,
    open: (kind, row) => setDialog({ kind, row }),
    // Opens one employee's record page (null where the portal has none).
    openEmployee: onOpenEmployee || null,
  }), [version, changed, onOpenEmployee]);

  const close = (isOpen) => { if (!isOpen) setDialog(null); };
  const row = dialog?.row || null;

  return (
    <ActionsContext.Provider value={value}>
      {children}
      <CorrectRecordDialog row={dialog?.kind === "correct" ? row : null} onOpenChange={close} onDone={changed} />
      <ReviewCorrectionDialog correction={dialog?.kind === "review" ? row : null} onOpenChange={close} onDone={changed} />
      <ResolveDialog row={dialog?.kind === "resolve" ? row : null} onOpenChange={close} onDone={changed} />
      <OvertimeDialog row={dialog?.kind === "overtime" ? row : null} onOpenChange={close} onDone={changed} />
      <TapsDialog row={dialog?.kind === "taps" ? row : null} onOpenChange={close} />
      <HistoryDialog row={dialog?.kind === "history" ? row : null} onOpenChange={close} />
    </ActionsContext.Provider>
  );
}

/* ── Building blocks ── */

function Field({ id, label, error, children }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-error`} className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function Summary({ children }) {
  return <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">{children}</div>;
}

/**
 * A dialog whose buttons run async actions: buttons disable while one runs,
 * a thrown error shows inline, success closes it (openAttendanceDialog).
 */
function ActionDialog({ open, onOpenChange, title, description, summary, children, actions, wide }) {
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => { if (open) { setError(""); setBusy(null); } }, [open]);

  async function run(action) {
    setBusy(action.label);
    setError("");
    try {
      const ok = await action.onClick();
      if (ok !== false) onOpenChange(false);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[92dvh] overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {summary ? <Summary>{summary}</Summary> : null}
        <form onSubmit={(e) => e.preventDefault()} noValidate className="space-y-4">
          {children}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            {actions.map((action) => (
              <Button key={action.label} type="button" variant={action.variant || "default"} disabled={Boolean(busy)} onClick={() => (action.close ? onOpenChange(false) : run(action))}>
                {busy === action.label ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : action.label}
              </Button>
            ))}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Field errors in one object; throws so the dialog shows "Fill in…" (attRequireFields). */
function useFieldErrors() {
  const [errors, setErrors] = React.useState({});
  const check = (next) => {
    setErrors(next);
    if (Object.values(next).some(Boolean)) throw new Error("Fill in the highlighted fields.");
  };
  return [errors, check, setErrors];
}

/** A Final payslip does not change by itself when its days are corrected (attPayrollNotice). */
function usePayrollNotice() {
  const { notify } = usePortalSession();
  return (result) => {
    if (result?.payroll_notice) notify("Final Payslip Not Updated", result.payroll_notice, "info");
  };
}

/* ── Correct any record ── */

const CORRECTION_TYPES = [
  ["time_in", "Correct time in (accidental late time in)"],
  ["time_out", "Correct time out (accidental late or missing time out)"],
  ["both", "Correct both time in and time out"],
  ["present", "Mark as present (worked but did not tap)"],
];

const needsFor = (type) => ({
  in: type === "time_in" || type === "both" || type === "present",
  out: type === "time_out" || type === "both" || type === "present",
});

function CorrectRecordDialog({ row, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const payrollNotice = usePayrollNotice();
  const [type, setType] = React.useState("time_in");
  const [timeIn, setTimeIn] = React.useState("");
  const [timeOut, setTimeOut] = React.useState("");
  const [note, setNote] = React.useState("");
  const [errors, check, setErrors] = useFieldErrors();

  React.useEffect(() => {
    if (!row) return;
    setType(!row.time_in ? "present" : !row.time_out ? "time_out" : "time_in");
    setTimeIn(timeInputValue(row.time_in));
    setTimeOut(timeInputValue(row.time_out));
    setNote("");
    setErrors({});
  }, [row, setErrors]);

  if (!row || !canCorrect(row)) return null;
  const status = normalizeAttendanceStatus(row.status);
  const needs = needsFor(type);

  async function save() {
    const today = todayKey();
    const now = nowHm();
    const currentIn = timeInputValue(row.time_in);
    const currentOut = timeInputValue(row.time_out);
    const effectiveIn = needs.in ? timeIn : currentIn;
    const notFuture = (value) => (row.log_date === today && value && value > now ? "A corrected time cannot be in the future." : "");
    const next = {};
    if (!needs.in && !row.time_in) next.type = 'This record has no time in. Choose "Correct both" or "Mark as present".';
    else if (!needs.out && !row.time_out && row.log_date < today) next.type = 'This day has no time out. Choose "Correct both" to enter it too.';
    if (needs.in) {
      if (!timeIn) next.timeIn = "New time in is required.";
      else if (!needs.out && currentOut && timeIn >= currentOut) next.timeIn = `Time in must be earlier than the time out (${formatTime(row.time_out)}).`;
      else next.timeIn = notFuture(timeIn);
    }
    if (needs.out) {
      if (!timeOut) next.timeOut = "New time out is required.";
      else if (effectiveIn && timeOut <= effectiveIn) next.timeOut = "Time out must be later than time in.";
      else next.timeOut = notFuture(timeOut);
    }
    next.note = reasonError(note);
    check(next);
    const effectiveOut = needs.out ? timeOut : currentOut;
    if (row.time_in && effectiveIn === currentIn && effectiveOut === currentOut) {
      throw new Error("The new times are the same as the current ones.");
    }

    const result = await fetchJson("/api/attendance/corrections", jsonBody("PATCH", {
      action: "correct_record",
      log_id: isLogId(row.id) ? row.id : undefined,
      employee_id: row.employee_id,
      log_date: row.log_date,
      type,
      time_in: needs.in ? timeIn : undefined,
      time_out: needs.out ? timeOut : undefined,
      note: note.trim(),
    }));
    notify("Attendance Corrected", `${row.employee_name || "The employee"}'s ${formatDateKey(row.log_date)} record is updated and marked Corrected.`, "success");
    payrollNotice(result);
    onDone();
  }

  return (
    <ActionDialog
      open
      onOpenChange={onOpenChange}
      title="Correct attendance"
      summary={(
        <>
          <div className="flex flex-wrap items-center gap-2">
            <strong>{row.employee_name || "Employee"}</strong>
            {row.employee_code ? <span className="text-muted-foreground">({row.employee_code})</span> : null}
            <span>· {formatDateKey(row.log_date)}</span>
            <AttendanceBadge status={status} />
          </div>
          <div className="text-muted-foreground">Current: time in {formatTime(row.time_in)}, time out {formatTime(row.time_out)}</div>
          {status === "Pending Correction" ? <div>Saving closes the employee&apos;s pending correction request.</div> : null}
        </>
      )}
      actions={[{ label: "Cancel", variant: "outline", close: true }, { label: "Save correction", onClick: save }]}
    >
      <Field id="att-correct-type" label="Resolution" error={errors.type}>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="att-correct-type" className="w-full" aria-invalid={Boolean(errors.type) || undefined}><SelectValue /></SelectTrigger>
          <SelectContent>{CORRECTION_TYPES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        {needs.in ? (
          <Field id="att-correct-in" label="New time in" error={errors.timeIn}>
            <Input id="att-correct-in" type="time" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} aria-invalid={Boolean(errors.timeIn) || undefined} />
          </Field>
        ) : null}
        {needs.out ? (
          <Field id="att-correct-out" label="New time out" error={errors.timeOut}>
            <Input id="att-correct-out" type="time" value={timeOut} onChange={(e) => setTimeOut(e.target.value)} aria-invalid={Boolean(errors.timeOut) || undefined} />
          </Field>
        ) : null}
      </div>
      <Field id="att-correct-note" label="Reason" error={errors.note}>
        <Textarea id="att-correct-note" rows={2} maxLength={500} placeholder="e.g. Tapped in late by mistake; confirmed with the branch logbook" value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={Boolean(errors.note) || undefined} />
      </Field>
      <p className="text-xs text-muted-foreground">Hours, late, undertime and status are recomputed from the branch schedule and used by payroll. The original taps are kept in the correction history.</p>
    </ActionDialog>
  );
}

/* ── Review an employee's correction request ── */

function ReviewCorrectionDialog({ correction, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const payrollNotice = usePayrollNotice();
  const [resolution, setResolution] = React.useState("incomplete");
  const [note, setNote] = React.useState("");

  React.useEffect(() => { if (correction) { setResolution("incomplete"); setNote(""); } }, [correction]);
  if (!correction) return null;

  const decide = (decision) => async () => {
    const result = await fetchJson("/api/attendance/corrections", jsonBody("PATCH", {
      correction_id: correction.id,
      decision,
      resolution,
      note: note.trim(),
    }));
    notify(
      decision === "approve" ? "Correction Approved" : "Correction Rejected",
      decision === "approve" ? "The time out was updated and the day is marked Corrected." : "The request was rejected.",
      decision === "approve" ? "success" : "info",
    );
    payrollNotice(result);
    onDone();
  };

  return (
    <ActionDialog
      open
      onOpenChange={onOpenChange}
      title="Review correction request"
      summary={(
        <>
          <div><strong>{correction.employee_name || "Employee"}</strong> · {formatDateKey(correction.log_date)}</div>
          <div className="flex flex-wrap items-center gap-2">Recorded: {formatTime(correction.original_time_in)} – {formatTime(correction.original_time_out)} <AttendanceBadge status={correction.original_status} /></div>
          <div>Requested time out: <strong className="tabular-nums">{formatTime(correction.corrected_time_out)}</strong></div>
          <div className="mt-1 text-foreground">“{correction.reason || ""}”</div>
        </>
      )}
      actions={[
        { label: "Reject", variant: "destructive", onClick: decide("reject") },
        { label: "Approve", onClick: decide("approve") },
      ]}
    >
      <Field id="att-review-resolution" label="If rejected, the record becomes">
        <Select value={resolution} onValueChange={setResolution}>
          <SelectTrigger id="att-review-resolution" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="incomplete">Keep as recorded (Incomplete stays out of payroll)</SelectItem>
            <SelectItem value="absent">Absent</SelectItem>
            <SelectItem value="half_day">Half Day</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field id="att-review-note" label="Note (optional)">
        <Textarea id="att-review-note" rows={2} maxLength={500} placeholder="Shown with the decision in the audit trail" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}

/* ── Resolve an Incomplete record ── */

function ResolveDialog({ row, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const payrollNotice = usePayrollNotice();
  const [resolution, setResolution] = React.useState("time_out");
  const [time, setTime] = React.useState("");
  const [note, setNote] = React.useState("");
  const [errors, check, setErrors] = useFieldErrors();

  React.useEffect(() => { if (row) { setResolution("time_out"); setTime(""); setNote(""); setErrors({}); } }, [row, setErrors]);
  if (!row) return null;

  async function save() {
    check({
      time: resolution === "time_out" && !time ? "Time out is required." : "",
      note: reasonError(note),
    });
    const result = await fetchJson("/api/attendance/corrections", jsonBody("PATCH", {
      action: "resolve",
      log_id: row.id,
      resolution,
      time_out: resolution === "time_out" ? time : "",
      note: note.trim(),
    }));
    notify("Record Resolved", "The attendance record is resolved and can now be included in payroll.", "success");
    payrollNotice(result);
    onDone();
  }

  return (
    <ActionDialog
      open
      onOpenChange={onOpenChange}
      title="Resolve incomplete record"
      summary={(
        <>
          <div><strong>{row.employee_name || "Employee"}</strong> · {formatDateKey(row.log_date)}</div>
          <div className="text-muted-foreground">Time in {formatTime(row.time_in)}, no time out recorded.</div>
        </>
      )}
      actions={[{ label: "Cancel", variant: "outline", close: true }, { label: "Resolve", onClick: save }]}
    >
      <Field id="att-resolve-resolution" label="Resolution">
        <Select value={resolution} onValueChange={setResolution}>
          <SelectTrigger id="att-resolve-resolution" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="time_out">Record the time out</SelectItem>
            <SelectItem value="absent">Mark Absent</SelectItem>
            <SelectItem value="half_day">Mark Half Day</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {resolution === "time_out" ? (
        <Field id="att-resolve-time" label="Time out" error={errors.time}>
          <Input id="att-resolve-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={Boolean(errors.time) || undefined} />
        </Field>
      ) : null}
      <Field id="att-resolve-note" label="Reason" error={errors.note}>
        <Textarea id="att-resolve-note" rows={2} maxLength={500} placeholder="e.g. Confirmed with the branch logbook" value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={Boolean(errors.note) || undefined} />
      </Field>
    </ActionDialog>
  );
}

/* ── Overtime ── */

function OvertimeDialog({ row, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const [minutes, setMinutes] = React.useState("");
  const [note, setNote] = React.useState("");
  const [errors, check, setErrors] = useFieldErrors();
  const max = Number(row?.overtime_minutes) || 0;

  React.useEffect(() => {
    if (!row) return;
    const current = row.approval?.status === "approved" ? row.approval.approved_minutes : row.overtime_minutes;
    setMinutes(String(Number(current) || 0));
    setNote(row.approval?.note || "");
    setErrors({});
  }, [row, setErrors]);
  if (!row) return null;

  const decide = (decision) => async () => {
    const n = Number(minutes);
    if (decision === "approve") {
      check({ minutes: !minutes ? "Minutes to approve is required." : (Number.isInteger(n) && n >= 1 && n <= max ? "" : `Enter a whole number from 1 to ${max}.`) });
    }
    await fetchJson("/api/attendance/overtime", jsonBody("PATCH", {
      log_id: row.log_id,
      decision,
      approved_minutes: decision === "approve" ? n : 0,
      note: note.trim(),
    }));
    notify(
      decision === "approve" ? "Overtime Approved" : "Overtime Rejected",
      decision === "approve" ? `${n} minute${n === 1 ? "" : "s"} will be paid as overtime.` : "No overtime will be paid for this day.",
      decision === "approve" ? "success" : "info",
    );
    onDone();
  };

  return (
    <ActionDialog
      open
      onOpenChange={onOpenChange}
      title="Review overtime"
      summary={(
        <>
          <div><strong>{row.employee_name || "Employee"}</strong> · {formatDateKey(row.log_date)}</div>
          <div>Time out <strong className="tabular-nums">{formatTime(row.time_out)}</strong>, shift ends {row.work_end || ""}: <strong>{formatMinutes(row.overtime_minutes)}</strong> past schedule.</div>
          <div className="text-muted-foreground">Only the minutes approved here are paid as overtime.</div>
        </>
      )}
      actions={[
        { label: "Reject", variant: "destructive", onClick: decide("reject") },
        { label: "Approve", onClick: decide("approve") },
      ]}
    >
      <Field id="att-ot-minutes" label={`Minutes to approve (1–${max})`} error={errors.minutes}>
        <Input id="att-ot-minutes" type="number" min={1} max={max} step={1} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-invalid={Boolean(errors.minutes) || undefined} />
      </Field>
      <Field id="att-ot-note" label="Note (optional)">
        <Textarea id="att-ot-note" rows={2} maxLength={300} placeholder="Shown with the decision in the audit trail" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}

/* ── Tap history ── */

function TapsDialog({ row, onOpenChange }) {
  if (!row) return null;
  const taps = [...(row.taps || [])].sort((a, b) => String(a.tapped_at).localeCompare(String(b.tapped_at)));
  const corrected = normalizeAttendanceStatus(row.status) === "Corrected";
  const correctedAt = corrected ? row.last_correction?.approved_at : null;
  const note = !taps.length
    ? "No taps were recorded for this day."
    : taps.length === 1
      ? "One tap only: it is the Time In. The day stays Incomplete until a later tap records the Time Out."
      : `Time In is the first tap, Time Out the last of ${taps.length} taps.`;

  return (
    <ActionDialog
      open
      wide
      onOpenChange={onOpenChange}
      title="Tap history"
      summary={(
        <>
          <div className="flex flex-wrap items-center gap-2"><strong>{row.employee_name || "Employee"}</strong> · {formatDateKey(row.log_date)} <AttendanceBadge status={row.status} /></div>
          <div className="text-muted-foreground">{note}</div>
          {corrected ? (
            <div>This day was corrected{row.last_correction?.approved_by_name ? ` by ${row.last_correction.approved_by_name}` : ""}: the record shows <span className="tabular-nums">{formatTime(row.time_in)} – {formatTime(row.time_out)}</span>, not the taps below.</div>
          ) : null}
        </>
      )}
      actions={[{ label: "Close", variant: "outline", close: true }]}
    >
      {taps.length ? (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/60">
              <TableRow><TableHead>#</TableHead><TableHead>Time</TableHead><TableHead>Counts as</TableHead><TableHead>Branch</TableHead><TableHead>Reader</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {taps.map((tap, index) => {
                const role = index === 0 ? "Time In" : index === taps.length - 1 ? "Time Out" : "";
                const late = correctedAt && String(tap.tapped_at) > String(correctedAt);
                return (
                  <TableRow key={`${tap.tapped_at}-${index}`} className={role ? "bg-primary/5" : undefined}>
                    <TableCell className="tabular-nums">{index + 1}</TableCell>
                    <TableCell className="tabular-nums">{formatTapTime(tap.tapped_at)}</TableCell>
                    <TableCell>
                      {role ? <StatusBadge tone={role === "Time In" ? "success" : "info"}>{role}</StatusBadge> : <span className="text-muted-foreground">—</span>}
                      {late ? <p className="mt-1 text-xs text-warning">After correction</p> : null}
                    </TableCell>
                    <TableCell>{tap.branch_name || "—"}</TableCell>
                    <TableCell>{tap.device || (tap.source === "manual_entry" ? "Manual entry (portal)" : "RFID Terminal")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </ActionDialog>
  );
}

/* ── Correction history ── */

function correctionKind(c) {
  const labels = {
    time_in: "Time in corrected",
    time_out: "Time out corrected",
    both: "Time in and time out corrected",
    present: "Marked present (did not tap)",
  };
  if (c.correction_type && labels[c.correction_type]) return labels[c.correction_type];
  if (c.corrected_time_in) return "Absence corrected";
  if (c.original_status === "Incomplete" && c.status === "approved" && c.reason && c.reason === c.review_note) return "Incomplete record resolved";
  return "Employee correction request";
}

function HistoryDialog({ row, onOpenChange }) {
  if (!row) return null;
  const pair = (a, b) => `${formatTime(a)} – ${formatTime(b)}`;
  const items = [...(row.corrections || [])].reverse();

  return (
    <ActionDialog
      open
      wide
      onOpenChange={onOpenChange}
      title="Correction history"
      summary={(
        <>
          <div className="flex flex-wrap items-center gap-2"><strong>{row.employee_name || "Employee"}</strong> · {formatDateKey(row.log_date)} <AttendanceBadge status={row.status} /></div>
          <div>Now: <span className="tabular-nums">{pair(row.time_in, row.time_out)}</span></div>
        </>
      )}
      actions={[{ label: "Close", variant: "outline", close: true }]}
    >
      {items.length ? (
        <ol className="space-y-3">
          {items.map((c, index) => {
            const state = c.status === "pending" ? "Waiting for review" : c.status === "approved" ? "Applied" : "Rejected";
            let after;
            if (c.status === "pending") after = `Requested time out ${formatTime(c.corrected_time_out)}`;
            else if (c.resolution === "absent") after = "Marked Absent";
            else if (c.resolution === "half_day") after = "Marked Half Day";
            else if (c.status === "rejected") after = "Kept as recorded";
            else after = pair(c.corrected_time_in || c.original_time_in, c.corrected_time_out || c.original_time_out);
            const hasFacts = c.corrected_late_minutes !== null && c.corrected_late_minutes !== undefined;
            const before = workedMinutes({ time_in: c.original_time_in, time_out: c.original_time_out });
            const afterMinutes = workedMinutes({ time_in: c.corrected_time_in || c.original_time_in, time_out: c.corrected_time_out });
            const who = c.status === "pending" ? (c.requested_by_name || "Employee") : (c.approved_by_name || c.requested_by_name || "HR / Admin");
            const when = c.status === "pending" ? c.requested_at : (c.approved_at || c.requested_at);
            return (
              <li key={c.id || index} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{correctionKind(c)}</strong>
                  <StatusBadge tone={c.status === "pending" ? "gold" : c.status === "approved" ? "success" : "danger"}>{state}</StatusBadge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Original taps</p>
                    <p className="flex flex-wrap items-center gap-2 tabular-nums">{pair(c.original_time_in, c.original_time_out)} {c.original_status ? <AttendanceBadge status={c.original_status} /> : null}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">New values</p>
                    <p className="tabular-nums">{after}</p>
                  </div>
                </div>
                {hasFacts ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>Hours {before === null ? "—" : hoursMinutes(before)} → {afterMinutes === null ? "—" : hoursMinutes(afterMinutes)}</span>
                    <span>Late {formatMinutes(c.original_late_minutes)} → {formatMinutes(c.corrected_late_minutes)}</span>
                    <span>Undertime {formatMinutes(c.original_undertime_minutes)} → {formatMinutes(c.corrected_undertime_minutes)}</span>
                  </div>
                ) : null}
                <p>Reason: “{c.reason || ""}”</p>
                {c.review_note && c.review_note !== c.reason ? <p>Note: {c.review_note}</p> : null}
                <p className="text-xs text-muted-foreground">{c.status === "pending" ? "Requested" : "Changed"} by {who} · {formatDateTime(when)}</p>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-sm text-muted-foreground">No corrections for this day.</p>}
    </ActionDialog>
  );
}
