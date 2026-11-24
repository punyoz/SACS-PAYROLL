"use client";

import { dateLabel } from "@/lib/portal/payroll-preview";
import { rangeLabel } from "@/lib/date-label";

import { ItemThread } from "@/components/portal/item-thread";

import { SystemRecommendation } from "@/components/portal/system-recommendation";
import { HrCorrectionRequests } from "@/components/portal/hr-correction-requests";
import { HrOvertimeRequests } from "@/components/portal/overtime-requests";
import * as React from "react";
import { CalendarCheck2Icon, CalendarDaysIcon, CheckIcon, InfoIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { BulkActionDialog } from "@/components/portal/bulk-action-dialog";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { DataTable } from "@/components/portal/data-table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { useProofViewer } from "@/components/portal/proof-viewer";
import { RequestStatusBadge, StatusBadge } from "@/components/portal/status-badge";
import { STATUS_TONES } from "@/lib/branch-requests";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { LeaveBalanceNote } from "@/components/portal/leave-balance-note";
import { countLeaveDays, requestDays } from "@/lib/leave-requests/split";

/*
 * Leave Approval (loadHRLeaves / hrLeaveAction / hrCancelLeave,
 * public/legacy/js/hr.js): GET /api/hr/leave-requests?status=all and
 * PATCH { id, action: approve | reject | cancel }.
 */

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const range = (req) => ({
  // A half day (Part B) is 0.5 of its one date, AM or PM.
  days: req.half_day ? requestDays(req) : req.days || req.duration_days || countLeaveDays(req.start_date, req.end_date || req.start_date) || "?",
  from: req.from_date || req.start_date || "—",
  to: req.half_day ? `${req.start_date} (${req.half_day})` : req.to_date || req.end_date || "—",
  // Dates as people read them (2026-11-26): "Nov 27, 2026", "Nov 12 – 13, 2026", "Nov 11, 2026 (AM)".
  range: req.half_day ? `${dateLabel(req.start_date)} (${req.half_day})` : rangeLabel(req.from_date || req.start_date, req.to_date || req.end_date),
  // A truthy marker for a stored proof (fetched on View, 20261105030000).
  proof: req.proof_url || req.proof_data || (req.has_stored_proof ? "stored" : ""),
});

/** An earlier note from the branch Admin (before the Admin became view-only, 2026-11-24); nothing when there is none. */
function AdminRecommendation({ rec, compact = false }) {
  if (!rec) return null;
  return (
    <div className={compact ? "max-w-56 text-xs whitespace-normal" : "rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs"}>
      <p className="flex flex-wrap items-center gap-1.5">{compact ? null : <span className="font-medium">Earlier note from the branch Admin:</span>}<StatusBadge tone={STATUS_TONES[rec.status] || "muted"}>{rec.status_label}</StatusBadge></p>
      <p className="mt-0.5">{rec.admin_note}</p>
      <p className="text-muted-foreground">{rec.created_by_name}</p>
    </div>
  );
}

export function LeavesPage({ refreshKey }) {
  const { notify, me } = usePortalSession();
  // Nobody decides their own request (2026-11-23): no buttons, no checkbox on your own.
  const myId = String(me?.user?.id || "");
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
  // The request being decided, with its remark (Part H): { req, action }. A
  // rejection's remark is required and the employee sees it (2026-11-06).
  const [deciding, setDeciding] = React.useState(null);
  // Part F: search and a leave-type filter (kept in the address), counts per type,
  // and bulk approve / reject of the pending requests shown.
  const [selected, setSelected] = React.useState(() => new Set());
  const [bulk, setBulk] = React.useState(null); // { decision, rows }
  const pendingFiltersHook = useApprovalFilters(state.pending, {
    prefix: "lv", typeLabel: "Leave type",
    get: { name: (r) => r.employee_name, code: (r) => r.employee_code || r.employee_id, type: (r) => r.leave_type || "Leave", filed: (r) => r.submitted_at, requested: (r) => r.start_date, branch: (r) => r.branch_id, employeeId: (r) => r.employee_id },
  });
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

  async function decide(req, action, remark) {
    // Approve and reject both ask for a remark in their dialog (Part H).
    if (remark === undefined) {
      setDeciding({ req, action });
      return;
    }
    setBusy(`${req.id}:${action}`);
    try {
      const data = await fetchJson("/api/hr/leave-requests", jsonBody("PATCH", { id: req.id, action, remark }));
      notify(`Leave ${action === "approve" ? "Approved" : "Rejected"}`, `Leave request has been ${action === "approve" ? "approved" : "rejected"}.`, action === "approve" ? "success" : "info");
      // Approving never overwrites a day the employee actually tapped in.
      const conflicts = data.attendance_conflicts;
      if (Array.isArray(conflicts) && conflicts.length) {
        notify(
          "Leave overlaps recorded attendance",
          `These days already have an RFID tap and were left as recorded, not marked On Leave: ${conflicts.map((c) => `${dateLabel(c.log_date)} (${c.status})`).join(", ")}. Resolve them in Attendance if needed.`,
          "error",
        );
      }
      await load();
    } catch (error) {
      notify("Error", error.message || "Action failed.", "error");
      throw error;
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
    { key: "duration", header: "Duration", className: "whitespace-nowrap tabular-nums", cell: (r) => { const x = range(r); return `${x.days}d · ${x.range}`; } },
    { key: "reason", header: "Reason", className: "max-w-48 truncate text-muted-foreground", cell: (r) => r.reason || "—", searchValue: (r) => r.reason },
    // 2026-11-24: the branch Admin follows the request; HR and the Admin can message each other on it.
    { key: "branch_admin", header: <span className="sr-only">Messages with the branch Admin</span>, align: "right", cell: (r) => <ItemThread itemType="leave_request" itemId={r.id} title={`Messages · ${r.employee_name || "leave request"}`} /> },
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

  // Part F: the pending list as filtered here (search, type with counts, branch,
  // category, employment status, dates, sort; all in the address).
  const { rows: shownAll, toolbar: pendingFilters } = pendingFiltersHook;
  const shownPending = shownAll.filter((r) => String(r.employee_id) !== myId);

  return (
    <>
      <BulkActionDialog
        open={Boolean(bulk)}
        title={bulk?.decision === "reject" ? "Reject the selected leave requests" : "Approve the selected leave requests"}
        rows={bulk?.rows || []}
        label={(r) => { const x = range(r); return `${r.employee_name || "Employee"} · ${r.leave_type || "Leave"} · ${x.range}`; }}
        decision={bulk?.decision}
        entityType="leave_request"
        destructive={bulk?.decision === "reject"}
        confirmLabel={bulk?.decision === "reject" ? "Reject" : "Approve"}
        run={(r, remark) => fetchJson("/api/hr/leave-requests", jsonBody("PATCH", { id: r.id, action: bulk.decision, remark }))}
        onDone={() => load()}
        onClose={() => { setBulk(null); setSelected(new Set()); }}
      />
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
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2" data-testid="leave-pending-filters">
                {pendingFilters}
                <label className="ml-auto inline-flex items-center gap-2 text-sm">
                  <Checkbox aria-label="Select all shown" checked={shownPending.length > 0 && shownPending.every((r) => selected.has(r.id)) ? true : shownPending.some((r) => selected.has(r.id)) ? "indeterminate" : false}
                    onCheckedChange={(on) => setSelected(on === true ? new Set(shownPending.map((r) => r.id)) : new Set())} />
                  Select all shown ({shownPending.length})
                </label>
              </div>
              {selected.size ? (
                <div role="region" aria-label="Selected rows" data-testid="bulk-bar" className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                  <span className="font-medium tabular-nums">{selected.size} selected</span>
                  <span className="flex flex-1 flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => setBulk({ decision: "reject", rows: state.pending.filter((r) => selected.has(r.id)) })}>Reject selected</Button>
                    <Button size="sm" onClick={() => setBulk({ decision: "approve", rows: state.pending.filter((r) => selected.has(r.id)) })}>Approve selected</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
                  </span>
                </div>
              ) : null}
              {!shownPending.length ? <EmptyState icon={CalendarCheck2Icon} title="No matches" description="Nothing pending matches the search or type." /> : null}
            <ul className="grid gap-3 lg:grid-cols-2">
              {shownPending.map((req) => {
                const x = range(req);
                return (
                  <li key={req.id} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2 font-semibold">
                        {String(req.employee_id) === myId ? null : (
                        <Checkbox aria-label={`Select ${req.employee_name || "this request"} ${x.from}`} checked={selected.has(req.id)}
                          onCheckedChange={(on) => setSelected((cur) => { const next = new Set(cur); if (on === true) next.add(req.id); else next.delete(req.id); return next; })} />
                        )}
                        {req.employee_name || req.employee_id || "Unknown"}
                      </p>
                      <p className="text-sm">
                        <strong>{req.leave_type || "Leave"}</strong> · {req.pay_status === "without_pay" ? "Without pay" : "With pay"} · {String(x.days)} day{x.days !== 1 ? "s" : ""}
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums"><CalendarDaysIcon className="size-3.5" aria-hidden="true" />{x.range}</p>
                      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{req.reason || "—"}</p>
                      <LeaveBalanceNote balance={state.balances[req.employee_id]} request={req} />
                      <SystemRecommendation rec={req.system_recommendation} compact />
                      <AdminRecommendation rec={recs.get(req.id)} />
                    </div>
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      {x.proof ? <Button variant="outline" size="sm" onClick={() => openProof(req)}><PaperclipIcon aria-hidden="true" />View proof</Button> : null}
                      {String(req.employee_id) === myId ? <p className="ml-auto text-xs text-muted-foreground" data-testid="own-request">Your own request: another HR officer decides it</p> : (
                      <div className="ml-auto flex gap-2">
                        <Button variant="destructive" size="sm" onClick={() => decide(req, "reject")} disabled={Boolean(busy)}><XIcon aria-hidden="true" />Reject</Button>
                        <Button size="sm" onClick={() => decide(req, "approve")} disabled={Boolean(busy)}><CheckIcon aria-hidden="true" />Approve</Button>
                      </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            </div>
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
            pageSize={10}
            searchPlaceholder="Search employee, type, reason or decision…"
            empty={{ title: "No leave history yet", icon: CalendarDaysIcon }}
            caption="Leave history"
            minWidth={1000}
          />
        </CardContent>
      </Card>

      {confirmDialog}
      {proofViewer}
      {/* Overtime requests are decided here too (Part B, 2026-11-22). */}
      <HrOvertimeRequests />
      {/* Attendance correction requests (2026-11-23): evidence, pay difference, presets, several at once. */}
      <HrCorrectionRequests />
      <DecisionRemarkDialog
        open={Boolean(deciding)}
        idPrefix={deciding?.action === "reject" ? "lv-reject" : "lv-approve"}
        decision={deciding?.action || "approve"}
        entityType="leave_request"
        destructive={deciding?.action === "reject"}
        confirmLabel={deciding?.action === "reject" ? "Reject" : "Approve"}
        title={deciding?.action === "reject" ? "Reject this leave request?" : "Approve this leave request?"}
        description={deciding ? `${deciding.req.employee_name}: ${deciding.req.leave_type}, ${deciding.req.start_date}${deciding.req.end_date && deciding.req.end_date !== deciding.req.start_date ? ` to ${deciding.req.end_date}` : ""}. ${deciding.action === "reject" ? "The employee is notified with your remark. This decision cannot be undone." : "The employee will be notified of the approval."}` : ""}
        onClose={() => setDeciding(null)}
        onConfirm={async (remark) => { const { req, action } = deciding; await decide(req, action, remark); setDeciding(null); }}
      />
    </>
  );
}
