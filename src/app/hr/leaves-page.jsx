"use client";

import * as React from "react";
import { CalendarCheck2Icon, CalendarDaysIcon, CheckIcon, InfoIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { useProofViewer } from "@/components/portal/proof-viewer";
import { RequestStatusBadge, StatusBadge } from "@/components/portal/status-badge";
import { STATUS_TONES } from "@/lib/branch-requests";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { LeaveBalanceNote } from "@/components/portal/leave-balance-note";
import { countLeaveDays } from "@/lib/leave-requests/split";
import { REASON_MAX } from "@/lib/input-limits";

/*
 * Leave Approval (loadHRLeaves / hrLeaveAction / hrCancelLeave,
 * public/legacy/js/hr.js): GET /api/hr/leave-requests?status=all and
 * PATCH { id, action: approve | reject | cancel }.
 */

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const range = (req) => ({
  days: req.days || req.duration_days || countLeaveDays(req.start_date, req.end_date || req.start_date) || "?",
  from: req.from_date || req.start_date || "—",
  to: req.to_date || req.end_date || "—",
  // A truthy marker for a stored proof (fetched on View, 20261105030000).
  proof: req.proof_url || req.proof_data || (req.has_stored_proof ? "stored" : ""),
});

/** The branch Admin's recommendation on a leave request; HR still decides. */
function AdminRecommendation({ rec, compact = false }) {
  if (!rec) return compact ? <span className="text-xs text-muted-foreground">—</span> : <p className="text-xs text-muted-foreground">Branch Admin: no recommendation yet</p>;
  return (
    <div className={compact ? "max-w-56 text-xs whitespace-normal" : "rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs"}>
      <p className="flex flex-wrap items-center gap-1.5">{compact ? null : <span className="font-medium">Branch Admin:</span>}<StatusBadge tone={STATUS_TONES[rec.status] || "muted"}>{rec.status_label}</StatusBadge></p>
      <p className="mt-0.5">{rec.admin_note}</p>
      <p className="text-muted-foreground">{rec.created_by_name}</p>
    </div>
  );
}

export function LeavesPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [proofViewer, openInlineProof] = useProofViewer();
  // Older requests carry the proof inline; newer ones keep it in the private
  // bucket and it is fetched only when HR clicks View.
  const openProof = React.useCallback(async (req) => {
    if (!req.has_stored_proof) { openInlineProof(range(req).proof); return; }
    try {
      const data = await fetchJson(`/api/hr/leave-requests/proof?id=${encodeURIComponent(req.id)}`);
      openInlineProof(data.proof_url);
    } catch (error) {
      notify("Cannot open proof", error.message || "The proof document could not be loaded.", "error");
    }
  }, [openInlineProof, notify]);
  const [state, setState] = React.useState({ loading: true, error: null, pending: [], history: [], balances: {} });
  const [busy, setBusy] = React.useState(null);
  // The request being rejected: HR writes the reason the employee sees (2026-11-06).
  const [rejecting, setRejecting] = React.useState(null);
  // The branch Admins' recommendations, by leave request (2026-10-20).
  const [recs, setRecs] = React.useState(() => new Map());

  const loadRecs = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/hr/branch-requests?kind=leave_endorsement");
      setRecs(new Map((data.requests || []).map((r) => [r.ref_id, r])));
    } catch { /* keep what is shown; the leave list is unaffected */ }
  }, []);
  React.useEffect(() => { loadRecs(); }, [loadRecs, refreshKey]);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.pending.length && !current.history.length, error: null }));
    try {
      const data = await fetchJson("/api/hr/leave-requests?status=all");
      setState({ loading: false, error: null, pending: data.pending_requests || [], history: data.history_requests || [], balances: data.balances || {} });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load leave requests." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function decide(req, action, reason) {
    // A rejection asks for the reason in its own dialog (LeaveRejectDialog).
    if (action === "reject" && reason === undefined) {
      setRejecting(req);
      return;
    }
    if (action === "approve") {
      const ok = await confirm({ title: "Approve this leave request?", description: "The employee will be notified of the approval.", confirmLabel: "Approve" });
      if (!ok) return;
    }
    setBusy(`${req.id}:${action}`);
    try {
      const data = await fetchJson("/api/hr/leave-requests", jsonBody("PATCH", { id: req.id, action, ...(action === "reject" ? { reason } : {}) }));
      notify(`Leave ${action === "approve" ? "Approved" : "Rejected"}`, `Leave request has been ${action === "approve" ? "approved" : "rejected"}.`, action === "approve" ? "success" : "info");
      // Approving never overwrites a day the employee actually tapped in.
      const conflicts = data.attendance_conflicts;
      if (Array.isArray(conflicts) && conflicts.length) {
        notify(
          "Leave overlaps recorded attendance",
          `These days already have an RFID tap and were left as recorded, not marked On Leave: ${conflicts.map((c) => `${c.log_date} (${c.status})`).join(", ")}. Resolve them in Attendance if needed.`,
          "error",
        );
      }
      await load();
    } catch (error) {
      notify("Error", error.message || "Action failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function cancelLeave(req) {
    const ok = await confirm({
      title: "Cancel this approved leave?",
      description: "Its On Leave days are removed from attendance and the employee can tap in on them again.",
      confirmLabel: "Cancel leave",
      cancelLabel: "Keep leave",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchJson("/api/hr/leave-requests", jsonBody("PATCH", { id: req.id, action: "cancel" }));
      notify("Leave Cancelled", "The approved leave was cancelled and its On Leave days released.", "info");
      await load();
    } catch (error) {
      notify("Error", error.message || "Could not cancel the leave.", "error");
    }
  }

  const today = localDateKey();
  const historyColumns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => r.employee_name || r.employee_id || "—", searchValue: (r) => r.employee_name },
    { key: "leave_type", header: "Leave type", sortable: true, searchValue: (r) => r.leave_type },
    { key: "duration", header: "Duration", className: "whitespace-nowrap tabular-nums", cell: (r) => { const x = range(r); return `${x.days}d · ${x.from} – ${x.to}`; } },
    { key: "reason", header: "Reason", className: "max-w-48 truncate text-muted-foreground", cell: (r) => r.reason || "—", searchValue: (r) => r.reason },
    { key: "branch_admin", header: "Branch Admin", cell: (r) => <AdminRecommendation rec={recs.get(r.id)} compact /> },
    { key: "proof", header: "Proof", cell: (r) => (range(r).proof ? <Button variant="outline" size="sm" onClick={() => openProof(r)}><PaperclipIcon aria-hidden="true" />View</Button> : "—") },
    {
      key: "status",
      header: "Decision",
      sortable: true,
      searchValue: (r) => r.status,
      cell: (r) => {
        const s = String(r.status || "").toLowerCase();
        const canCancel = s === "approved" && (r.end_date || r.start_date || "") >= today;
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <RequestStatusBadge status={r.status} />
              {canCancel ? <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => cancelLeave(r)}>Cancel</Button> : null}
            </div>
            {s === "cancelled" && r.cancelled_by_name ? <p className="text-xs text-muted-foreground">by {r.cancelled_by_name}</p> : null}
            {s === "rejected" && r.decision_reason ? <p className="max-w-56 text-xs text-muted-foreground [overflow-wrap:anywhere]">Reason: {r.decision_reason}</p> : null}
          </div>
        );
      },
    },
    { key: "submitted", header: "Submitted", className: "whitespace-nowrap", sortValue: (r) => r.submitted_at || r.created_at || "", cell: (r) => (r.submitted_at || r.created_at ? new Date(r.submitted_at || r.created_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—") },
    { key: "decided", header: "Decided", className: "whitespace-nowrap", sortValue: (r) => r.decided_at || "", cell: (r) => (r.decided_at ? new Date(r.decided_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—") },
  ];

  return (
    <>
      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertDescription>Leave requests forwarded for approval are listed here. Approved or rejected requests move to Leave History.</AlertDescription>
      </Alert>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Pending requests {state.pending.length ? <Badge variant="secondary">{state.pending.length}</Badge> : null}</CardTitle>
          <CardDescription>Approve or reject each request.</CardDescription>
        </CardHeader>
        <CardContent>
          {state.loading ? (
            <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
          ) : state.error && !state.pending.length ? (
            <ErrorState message={state.error} onRetry={load} />
          ) : !state.pending.length ? (
            <EmptyState icon={CalendarCheck2Icon} title="No pending leave requests" description="You're all caught up." />
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {state.pending.map((req) => {
                const x = range(req);
                return (
                  <li key={req.id} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
                    <div className="min-w-0 space-y-1">
                      <p className="font-semibold">{req.employee_name || req.employee_id || "Unknown"}</p>
                      <p className="text-sm">
                        <strong>{req.leave_type || "Leave"}</strong> · {req.pay_status === "without_pay" ? "Without pay" : "With pay"} · {String(x.days)} day{x.days !== 1 ? "s" : ""}
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums"><CalendarDaysIcon className="size-3.5" aria-hidden="true" />{x.from} to {x.to}</p>
                      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{req.reason || "—"}</p>
                      <LeaveBalanceNote balance={state.balances[req.employee_id]} request={req} />
                      <AdminRecommendation rec={recs.get(req.id)} />
                    </div>
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      {x.proof ? <Button variant="outline" size="sm" onClick={() => openProof(req)}><PaperclipIcon aria-hidden="true" />View proof</Button> : null}
                      <div className="ml-auto flex gap-2">
                        <Button variant="destructive" size="sm" onClick={() => decide(req, "reject")} disabled={Boolean(busy)}><XIcon aria-hidden="true" />Reject</Button>
                        <Button size="sm" onClick={() => decide(req, "approve")} disabled={Boolean(busy)}><CheckIcon aria-hidden="true" />Approve</Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Leave history</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={historyColumns}
            rows={state.history}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search employee, type, reason or decision…"
            empty={{ title: "No leave history yet", icon: CalendarDaysIcon }}
            caption="Leave history"
            minWidth={1000}
          />
        </CardContent>
      </Card>

      {confirmDialog}
      {proofViewer}
      <LeaveRejectDialog
        request={rejecting}
        onClose={() => setRejecting(null)}
        onReject={async (reason) => { const req = rejecting; await decide(req, "reject", reason); setRejecting(null); }}
      />
    </>
  );
}

/**
 * Reject with a reason (decision 2026-11-06), laid out like the payroll
 * rejection dialog: 5-500 characters, shown to the employee on their leave
 * list and in the rejection notice.
 */
function LeaveRejectDialog({ request, onClose, onReject }) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setReason(""); setError(""); setBusy(false); }, [request]);
  if (!request) return null;

  async function submit() {
    if (reason.trim().length < 5) {
      setError("Write the reason for rejecting (at least 5 characters). The employee sees it.");
      return;
    }
    setBusy(true);
    setError("");
    await onReject(reason.trim());
    setBusy(false);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reject this leave request?</DialogTitle>
          <DialogDescription>
            {request.employee_name}: {request.leave_type}, {request.start_date}{request.end_date && request.end_date !== request.start_date ? ` to ${request.end_date}` : ""}. The employee is notified with your reason. This decision cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lv-reject-reason">Reason for rejecting</Label>
            <Textarea id="lv-reject-reason" rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => { setReason(e.target.value); setError(""); }}
              placeholder="Required: why the leave cannot be granted" aria-invalid={Boolean(error) || undefined} autoFocus />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
