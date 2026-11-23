"use client";

import * as React from "react";
import { ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/portal/data-table";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { FIX_TYPES } from "@/lib/attendance/correction-requests";

/*
 * HR's attendance correction requests (2026-11-23), in the approvals list:
 * the evidence (the day before / after, the schedule, the branch's taps that
 * day, this cutoff's other requests, the Admin's check) and the pay difference
 * are shown before deciding; preset remarks; several at once. Approving
 * applies the times and recalculates the day; a paid day's difference goes on
 * the next payslip as an approved adjustment.
 */

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) : "—");
const dayText = (d) => (d ? `${d.status} · in ${hhmm(d.time_in)} · out ${hhmm(d.time_out)}${d.late_minutes ? ` · late ${d.late_minutes} min` : ""}${d.undertime_minutes ? ` · short ${d.undertime_minutes} min` : ""}` : "—");

function Evidence({ id }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  React.useEffect(() => {
    let alive = true;
    fetchJson(`/api/attendance/corrections?evidence=${id}`).then((d) => { if (alive) setState({ loading: false, error: "", data: d }); })
      .catch((e) => { if (alive) setState({ loading: false, error: e.message, data: null }); });
    return () => { alive = false; };
  }, [id]);
  if (state.loading) return <p className="text-sm text-muted-foreground">Loading the evidence…</p>;
  if (state.error) return <p role="alert" className="text-sm text-destructive">{state.error}</p>;
  const e = state.data.evidence;
  const pay = e.pay || {};
  return (
    <dl className="grid gap-2 text-sm" data-testid="correction-evidence">
      <div><dt className="text-xs text-muted-foreground">Before</dt><dd>{dayText(e.preview?.before)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">After (as the system would compute it)</dt><dd>{dayText(e.preview?.after)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Schedule</dt><dd>{e.schedule ? `${e.schedule.name || "Schedule"} · ${e.schedule.work_start}–${e.schedule.work_end}` : "—"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Terminal that day</dt>
        <dd>{e.terminal.tapped} of {e.terminal.scheduled} at the branch tapped{e.terminal.offline_suspected ? <StatusBadge tone="warning" className="ml-2">Possibly offline</StatusBadge> : null}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Other requests this cutoff</dt><dd>{e.past_this_cutoff.length ? e.past_this_cutoff.map((p) => `${p.log_date} (${p.status})`).join(", ") : "None"}</dd></div>
      {e.admin_check?.admin_note ? <div><dt className="text-xs text-muted-foreground">Branch Admin</dt><dd>{e.admin_check.admin_objected ? "Objected: " : "Note: "}{e.admin_check.admin_note}</dd></div> : null}
      {e.attachment_url ? <div><dt className="text-xs text-muted-foreground">Attachment</dt><dd><a className="underline" href={e.attachment_url} target="_blank" rel="noreferrer">Open the attachment</a></dd></div> : null}
      <div className="rounded-md border p-2" data-testid="correction-pay">
        <dt className="text-xs text-muted-foreground">Pay</dt>
        <dd className="font-medium">{!pay.processed ? "Not paid yet: the day is paid as corrected when its payroll is processed."
          : pay.amount === null ? pay.text : pay.amount === 0 ? "No change in pay." : `${pay.text} (on the next payslip, as an approved adjustment)`}</dd>
      </div>
    </dl>
  );
}

export function HrCorrectionRequests() {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ rows: [], loading: true, error: "" });
  const [reviewing, setReviewing] = React.useState(null);
  const [deciding, setDeciding] = React.useState(null); // { row, decision }
  const load = React.useCallback(async () => {
    try {
      const d = await fetchJson("/api/attendance/corrections?status=pending");
      setState({ rows: (d.corrections || []).filter((r) => r.fix_type), loading: false, error: "" });
    } catch (e) { setState((s) => ({ ...s, loading: false, error: e.message })); }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  const send = (row, decision, remark) => fetchJson("/api/attendance/corrections", jsonBody("PATCH", { correction_id: row.id, decision, remark }));
  const bulk = useBulkDecisions({
    entityType: "attendance_correction", onDone: load,
    decisions: [{ decision: "approve", label: "Approve" }, { decision: "reject", label: "Reject", destructive: true }],
    label: (r) => `${r.employee_name} ${String(r.log_date).slice(0, 10)}`, send,
  });
  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => r.employee_name },
    { key: "log_date", header: "Date", sortable: true, cell: (r) => String(r.log_date).slice(0, 10) },
    { key: "fix_type", header: "Request", cell: (r) => (
      <div><p>{FIX_TYPES[r.fix_type]}</p><p className="text-xs text-muted-foreground">{[r.corrected_time_in && `in ${hhmm(r.corrected_time_in)}`, r.corrected_time_out && `out ${hhmm(r.corrected_time_out)}`].filter(Boolean).join(" · ")} · {r.reason}</p></div>
    ), searchValue: (r) => `${r.employee_name} ${r.reason || ""}` },
    { key: "actions", header: "", cell: (r) => (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setReviewing(r)}>Review</Button>
      </div>
    ) },
  ];
  return (
    <Card className="min-w-0 shadow-xs" data-testid="hr-correction-requests">
      <CardHeader>
        <CardTitle>Attendance correction requests</CardTitle>
        <CardDescription>Employees asking to fix a time in or time out. Review the evidence and the pay difference, then approve or reject. Your own direct change is Override (Attendance).</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={state.rows} loading={state.loading} error={state.error} onRetry={load}
          empty={{ title: "No attendance correction requests waiting", icon: ClockIcon }} caption="Attendance correction requests" minWidth={620}
          selection={bulk.selection} />
        {bulk.dialog}
      </CardContent>
      <Dialog open={Boolean(reviewing)} onOpenChange={(o) => { if (!o) setReviewing(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{reviewing ? `${reviewing.employee_name} · ${String(reviewing.log_date).slice(0, 10)}` : ""}</DialogTitle>
            <DialogDescription>{reviewing ? `${FIX_TYPES[reviewing.fix_type]} · ${reviewing.reason}` : ""}</DialogDescription>
          </DialogHeader>
          {reviewing ? <Evidence id={reviewing.id} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeciding({ row: reviewing, decision: "reject" })}>Reject</Button>
            <Button onClick={() => setDeciding({ row: reviewing, decision: "approve" })}>Approve</Button>
          </div>
        </DialogContent>
      </Dialog>
      <DecisionRemarkDialog open={Boolean(deciding)} title={deciding?.decision === "approve" ? "Approve the correction" : "Reject the correction"}
        decision={deciding?.decision} entityType="attendance_correction" confirmLabel={deciding?.decision === "approve" ? "Approve" : "Reject"}
        destructive={deciding?.decision === "reject"} idPrefix="corr-remark" onClose={() => setDeciding(null)}
        onConfirm={async (remark) => {
          const res = await send(deciding.row, deciding.decision, remark);
          notify(deciding.decision === "approve" ? "Correction approved" : "Correction rejected", res?.pay?.line || "", "success");
          setDeciding(null); setReviewing(null); await load();
        }} />
    </Card>
  );
}
