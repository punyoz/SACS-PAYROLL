"use client";

import * as React from "react";
import { BadgeCheckIcon, FileTextIcon, Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/portal/date-picker";
import { useProofViewer } from "@/components/portal/proof-viewer";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Licensed teacher (HR → Edit Employee; docs/payroll-schedule-loans-awol.md
 * §6.6, §9.3). Its own saves, through /api/hr/teacher-license — never the
 * employee form's: every change needs a reason and goes to the shared change
 * log. Off is a normal state (no PRC fields). Turning on, or changing the
 * number, expiry or ID, leaves it Pending until HR verifies.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["application/pdf", "image/png", "image/jpeg"];

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export function LicenseSection({ employeeId }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState({ number: "", expires: "", reason: "", document: null, fileName: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [showHistory, setShowHistory] = React.useState(false);
  // A verify / turn-off waiting for its reason: { action, label }.
  const [pending, setPending] = React.useState(null);
  const [pendingReason, setPendingReason] = React.useState("");
  const [proofViewer, openProof] = useProofViewer();

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/hr/teacher-license?employee_id=${encodeURIComponent(employeeId)}`);
      if (data.available === false) throw new Error(data.error || "Not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err.message || "Unable to load the license.", data: null });
    }
  }, [employeeId]);
  React.useEffect(() => { load(); }, [load]);

  const teacher = state.data?.teacher;
  const canEdit = Boolean(state.data?.can_edit);
  const on = Boolean(teacher?.is_licensed_teacher);

  function reset(open = false) {
    setForm({ number: "", expires: teacher?.license_expires_on || "", reason: "", document: null, fileName: "" });
    setError("");
    setEditing(open);
  }

  async function pickFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!TYPES.includes(file.type)) { setError("The PRC ID must be a PDF, PNG or JPEG file."); return; }
    if (file.size > MAX_BYTES) { setError("The PRC ID must be 2 MB or smaller."); return; }
    try {
      const dataUrl = await readFile(file);
      setForm((c) => ({ ...c, document: { data_url: dataUrl, file_name: file.name }, fileName: file.name }));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function send(action, extra = {}) {
    setBusy(action);
    setError("");
    try {
      await fetchJson("/api/hr/teacher-license", jsonBody("POST", { action, employee_id: employeeId, ...extra }));
      const words = {
        turn_on: ["Licensed Teacher Added", "Pending HR verification — verify it to start the subsidy."],
        update_details: ["License Updated", "Verification cleared: verify it again."],
        verify: ["License Verified", "The subsidy counts from this month if verified on or before the 15th."],
        turn_off: ["Licensed Teacher Turned Off", "The subsidy stops from the next 15th."],
      };
      notify(words[action][0], words[action][1], "success");
      reset(false);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy("");
    }
  }

  function saveDetails() {
    if (form.reason.trim().length < 3) { setError("Give the reason for the change."); return; }
    if (!on) {
      if (!form.number.trim()) { setError("Enter the PRC license number."); return; }
      if (!form.expires) { setError("Enter the license expiry date."); return; }
    }
    send(on ? "update_details" : "turn_on", {
      reason: form.reason.trim(),
      prc_license_no: form.number.trim() || undefined,
      license_expires_on: form.expires && form.expires !== teacher?.license_expires_on ? form.expires : (on ? undefined : form.expires),
      document: form.document || undefined,
    });
  }

  function ask(action, label) {
    setPending({ action, label });
    setPendingReason("");
    setError("");
  }

  async function confirmPending() {
    if (pendingReason.trim().length < 3) { setError("Give the reason (at least 3 characters)."); return; }
    const { action } = pending;
    setPending(null);
    await send(action, { reason: pendingReason.trim() });
  }

  async function openDocument() {
    try {
      const data = await fetchJson(`/api/hr/teacher-license?document_id=${encodeURIComponent(teacher.document_id)}`);
      openProof(data.document.data_url);
    } catch (err) {
      setError(err.message);
    }
  }

  if (state.loading && !state.data) return <p className="text-sm text-muted-foreground sm:col-span-2"><Loader2Icon className="mr-1 inline size-4 animate-spin" aria-hidden="true" />Loading license…</p>;
  if (state.error) return <p className="text-sm text-destructive sm:col-span-2">{state.error}</p>;
  if (!teacher) return null;

  return (
    <div className="space-y-3 rounded-lg border p-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch id="emp-license-switch" checked={on || editing} disabled={!canEdit || busy !== ""}
            onCheckedChange={(next) => (on && !next ? ask("turn_off", "Turn off licensed teacher") : reset(next))} />
          <Label htmlFor="emp-license-switch">Licensed teacher</Label>
        </div>
        <StatusBadge tone={teacher.status.tone}>{teacher.status.label}</StatusBadge>
      </div>
      {!on && !editing ? <p className="text-xs text-muted-foreground">Turn on only for teachers with a PRC license. While off, no PRC details are kept and the teacher is not in the licensed-teacher subsidy.</p> : null}

      {on ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">PRC license no.</dt><dd className="font-medium tabular-nums">{teacher.prc_license_masked || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Expires</dt><dd className="font-medium">{dateLabel(teacher.license_expires_on)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">PRC ID</dt><dd>{teacher.has_document ? <button type="button" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" onClick={openDocument}><FileTextIcon className="size-3.5" aria-hidden="true" />View</button> : "None"}</dd></div>
        </dl>
      ) : null}

      {editing || (on && canEdit) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {editing ? (
            <>
              <div className="space-y-1.5"><Label htmlFor="emp-license-no">PRC license number{on ? " (new)" : ""}</Label>
                <Input id="emp-license-no" maxLength={20} autoComplete="off" placeholder={on ? "Leave blank to keep" : "e.g. 0123456"} value={form.number} onChange={(e) => setForm((c) => ({ ...c, number: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="emp-license-exp">License expiry date</Label>
                <DatePicker id="emp-license-exp" value={form.expires} onChange={(v) => setForm((c) => ({ ...c, expires: v }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="emp-license-file">PRC ID <span className="font-normal text-muted-foreground">(optional, PDF / PNG / JPEG, 2 MB)</span></Label>
                <Input id="emp-license-file" type="file" accept="application/pdf,image/png,image/jpeg" onChange={pickFile} />{form.fileName ? <p className="text-xs text-muted-foreground">{form.fileName}</p> : null}</div>
              <div className="space-y-1.5"><Label htmlFor="emp-license-reason">Reason for the change</Label>
                <Input id="emp-license-reason" maxLength={500} placeholder="e.g. New PRC license submitted" value={form.reason} onChange={(e) => setForm((c) => ({ ...c, reason: e.target.value }))} /></div>
              {on ? <p className="text-xs text-warning sm:col-span-2">Saving clears verification. HR must verify again before the subsidy continues.</p> : null}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="button" size="sm" onClick={saveDetails} disabled={busy !== ""}>{busy === "turn_on" || busy === "update_details" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{on ? "Save license changes" : "Save license"}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => reset(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" className="sm:col-span-2 sm:w-fit" onClick={() => reset(true)}>Change number, expiry or ID</Button>
          )}
        </div>
      ) : null}

      {on ? (
        <div className={cn("flex flex-wrap items-center justify-between gap-2 rounded-md p-2 text-sm", teacher.verified_at ? "bg-success/8" : "bg-warning/10")}>
          {teacher.verified_at ? (
            <p className="flex items-center gap-1.5"><BadgeCheckIcon className="size-4 text-success" aria-hidden="true" />Verified by {teacher.verified_by_name || "HR"} · {dateLabel(String(teacher.verified_at).slice(0, 10))}</p>
          ) : (
            <p className="flex items-center gap-1.5"><ShieldAlertIcon className="size-4 text-warning" aria-hidden="true" />Not verified. Check the number on the PRC online verification and the uploaded ID.</p>
          )}
          {canEdit && !teacher.verified_at && teacher.status.code !== "expired" ? (
            <Button type="button" size="sm" onClick={() => ask("verify", "Verify license")} disabled={busy !== ""}>{busy === "verify" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Verify license</Button>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-2">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="emp-license-pending">{pending.label}: reason</Label>
            <Input id="emp-license-pending" maxLength={500} autoFocus value={pendingReason} onChange={(e) => setPendingReason(e.target.value)}
              placeholder={pending.action === "verify" ? "e.g. Checked on PRC online verification" : "e.g. Moved to a non-teaching post"} />
          </div>
          <Button type="button" size="sm" variant={pending.action === "turn_off" ? "destructive" : "default"} onClick={confirmPending}>Confirm</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {(state.data?.history || []).length ? (
        <div>
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowHistory((v) => !v)}>License history {showHistory ? "▴" : "▾"}</button>
          {showHistory ? (
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {state.data.history.map((h) => (
                <li key={h.id}>{dateLabel(String(h.changed_at).slice(0, 10))} · {h.changed_by_name || "System"} ({h.changed_by_role || "—"}) · {String(h.action || "").replace("_", " ")}{h.new_value?.prc_last4 ? ` · ••••${h.new_value.prc_last4}` : ""}{h.new_value?.expires_on ? ` · exp ${dateLabel(h.new_value.expires_on)}` : ""} — {h.reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {proofViewer}
    </div>
  );
}
