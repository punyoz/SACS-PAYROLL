"use client";

import * as React from "react";
import { Loader2Icon, PlusIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";

/*
 * Substitute teaching (Part C, 2026-11-22): the branch Admin arranges a
 * substitute (from the suggestions: same level and branch, tapped in that day,
 * not on leave, under the weekly cap); HR approves (a preset remark); payroll
 * pays it when the substitute's taps cover it. role: "admin" | "hr" | "accountant".
 */

const STATUS_TONE = { pending: "gold", approved: "success", rejected: "danger", cancelled: "muted" };
const TAP = { confirmed: ["success", "Confirmed by taps"], waiting: ["muted", "Waiting for the day"], no_taps: ["danger", "No taps: not paid"] };
const EMPTY = { absent: "", date: "", start: "", end: "", periods: "1", class_section: "", subject: "", substitute: "", leave_request_id: "" };

function ArrangeDialog({ open, initial, teachers, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const [f, setF] = React.useState(EMPTY);
  const [found, setFound] = React.useState(null); // { suggestions, cap, future }
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setF({ ...EMPTY, ...(initial || {}) }); setFound(null); setError(""); } }, [open, initial]);
  const set = (k) => (v) => { setF((c) => ({ ...c, [k]: v?.target ? v.target.value : v, ...(k === "absent" || k === "date" ? { substitute: "" } : {}) })); if (k === "absent" || k === "date" || k === "periods") setFound(null); };

  async function find() {
    setError("");
    if (!f.absent || !f.date) { setError("Choose the absent teacher and the date first."); return; }
    try {
      setFound(await fetchJson(`/api/substitutions?suggest=1&absent=${f.absent}&date=${f.date}&periods=${Number(f.periods) || 1}`));
    } catch (e) { setError(e.message || "Could not find substitutes."); }
  }
  async function save() {
    setError("");
    if (!f.substitute) { setError("Choose the substitute."); return; }
    setBusy(true);
    try {
      await fetchJson("/api/substitutions", jsonBody("POST", {
        absent_employee_id: f.absent, substitute_id: f.substitute, sub_date: f.date, start_time: f.start, end_time: f.end,
        periods: Number(f.periods), class_section: f.class_section, subject: f.subject, leave_request_id: f.leave_request_id || undefined,
      }));
      notify("Substitution sent to HR", "HR approves it; payroll pays it when the substitute's taps cover the time.", "success");
      onSaved();
      onClose();
    } catch (e) { setError(e.message || "Not saved."); } finally { setBusy(false); }
  }
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="arrange-substitute">
        <DialogHeader>
          <DialogTitle>Arrange a substitute</DialogTitle>
          <DialogDescription>Suggestions: teachers of the same level and branch who tapped in that day, are not on leave and are under the weekly cap. You pick; HR approves.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sub-absent">Absent teacher</Label>
            <SearchableSelect id="sub-absent" label="Absent teacher" value={f.absent} onValueChange={set("absent")} placeholder="Choose the teacher"
              options={teachers.map((t) => ({ value: t.id, label: t.full_name, description: [t.employee_id, t.employee_level].filter(Boolean).join(" · ") }))} />
          </div>
          <div className="space-y-1.5"><Label htmlFor="sub-date">Date</Label><DatePicker id="sub-date" value={f.date} onChange={set("date")} /></div>
          <div className="space-y-1.5"><Label htmlFor="sub-periods">Class periods</Label><Input id="sub-periods" type="number" min={1} max={10} value={f.periods} onChange={set("periods")} /></div>
          <div className="space-y-1.5"><Label htmlFor="sub-start">Start</Label><Input id="sub-start" type="time" value={f.start} onChange={set("start")} /></div>
          <div className="space-y-1.5"><Label htmlFor="sub-end">End</Label><Input id="sub-end" type="time" value={f.end} onChange={set("end")} /></div>
          <div className="space-y-1.5"><Label htmlFor="sub-class">Class / section <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="sub-class" maxLength={80} value={f.class_section} onChange={set("class_section")} placeholder="e.g. Grade 5" /></div>
          <div className="space-y-1.5"><Label htmlFor="sub-subject">Subject <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="sub-subject" maxLength={80} value={f.subject} onChange={set("subject")} /></div>
          <div className="space-y-2 sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={find}><UsersIcon aria-hidden="true" />Find substitutes</Button>
            {found ? (found.suggestions.length ? (
              <ul className="space-y-1" aria-label="Suggested substitutes" data-testid="sub-suggestions">
                {found.suggestions.map((s) => (
                  <li key={s.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="sub-pick" value={s.id} checked={f.substitute === s.id} onChange={() => setF((c) => ({ ...c, substitute: s.id }))} />
                      {s.full_name} <span className="text-xs text-muted-foreground">({s.week_periods} of {found.cap} periods this week)</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No teacher fits: same level and branch, tapped in, not on leave, under {found.cap} periods a week.</p>) : null}
            {found?.future ? <p className="text-xs text-muted-foreground">A future date: the tap check waits for the day; the taps still decide the pay.</p> : null}
          </div>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Send to HR</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SubstitutionsPanel({ role, refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", rows: [], teachers: [], onLeave: [] });
  const [arrange, setArrange] = React.useState(null);
  const [deciding, setDeciding] = React.useState(null);
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [list, people] = await Promise.all([
        fetchJson("/api/substitutions"),
        role === "admin" ? fetchJson("/api/substitutions?teachers=1") : Promise.resolve({ teachers: [], on_leave: [] }),
      ]);
      setState({ loading: false, error: "", rows: list.substitutions || [], teachers: people.teachers || [], onLeave: people.on_leave || [] });
    } catch (e) { setState((s) => ({ ...s, loading: false, error: e.message || "Could not load the substitutions." })); }
  }, [role]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const filters = useApprovalFilters(state.rows, {
    prefix: "sub", typeLabel: "Status", people: role === "hr",
    get: { name: (r) => `${r.substitute_name} ${r.absent_name}`, code: (r) => r.substitute_code, type: (r) => r.status, filed: (r) => r.created_at, requested: (r) => r.sub_date, branch: (r) => r.branch_id, employeeId: (r) => r.substitute_id },
  });
  const send = (r, decision, remark) => fetchJson("/api/substitutions", jsonBody("PATCH", { id: r.id, action: decision, remark }));
  const bulk = useBulkDecisions({
    entityType: "substitution", onDone: load, send,
    decisions: [{ decision: "approve", label: "Approve" }, { decision: "reject", label: "Reject", destructive: true }],
    isSelectable: (r) => role === "hr" && r.status === "pending",
    label: (r) => `${r.substitute_name} ${r.sub_date}`,
    rowLabel: (r) => `${r.substitute_name} covering ${r.absent_name} · ${r.sub_date} ${r.start_time}-${r.end_time}`,
  });

  const columns = [
    { key: "sub_date", header: "Date", sortable: true, cell: (r) => <div><p className="font-medium">{r.sub_date}</p><p className="text-xs text-muted-foreground">{r.start_time}-{r.end_time} · {r.periods} period{r.periods === 1 ? "" : "s"}</p></div> },
    { key: "who", header: "Substitute → covering", cell: (r) => <div><p className="font-medium">{r.substitute_name}</p><p className="text-xs text-muted-foreground">covering {r.absent_name}{r.class_section ? `, ${r.class_section}` : ""}{r.subject ? ` (${r.subject})` : ""}</p></div>, searchValue: (r) => `${r.substitute_name} ${r.absent_name}` },
    { key: "tap", header: "Taps", cell: (r) => <StatusBadge tone={TAP[r.tap_check]?.[0] || "muted"}>{TAP[r.tap_check]?.[1] || r.tap_check}</StatusBadge> },
    { key: "status", header: "Status", sortable: true, cell: (r) => <div className="space-y-0.5"><StatusBadge tone={STATUS_TONE[r.status] || "muted"}>{r.status}</StatusBadge>{r.decided_by_name ? <p className="text-xs text-muted-foreground">{r.decided_by_name}{r.decision_note ? ` · ${r.decision_note}` : ""}</p> : null}</div> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (r.status !== "pending" ? null : role === "hr" ? (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeciding({ row: r, decision: "reject" })}>Reject</Button>
        <Button size="sm" onClick={() => setDeciding({ row: r, decision: "approve" })}>Approve</Button>
      </div>
    ) : role === "admin" ? (
      <Button size="sm" variant="outline" onClick={async () => {
        try { await fetchJson("/api/substitutions", jsonBody("PATCH", { id: r.id, action: "cancel" })); await load(); } catch (e) { notify("Not cancelled", e.message, "error"); }
      }}>Cancel</Button>
    ) : null) },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="substitutions">
      <CardHeader>
        <CardTitle>Substitute teaching</CardTitle>
        <CardDescription>
          {role === "admin" ? "Arrange a substitute for a teacher on leave or absent. HR approves; payroll pays it when the substitute's taps cover the time."
            : "Approve or reject the branch Admins' substitutions. Paid only when the substitute's taps cover the time: inside their shift ₱ per period, outside it as overtime, above the standard load at the overload rate."}
        </CardDescription>
        <CardAction className="flex gap-2">
          {role === "admin" ? <Button size="sm" onClick={() => setArrange({})}><PlusIcon aria-hidden="true" />Arrange substitute</Button> : null}
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {role === "admin" && state.onLeave.length ? (
          <div className="rounded-lg border p-3" data-testid="teachers-on-leave">
            <p className="mb-2 text-sm font-semibold">Teachers on leave (7 days back to 14 ahead)</p>
            <ul className="space-y-1 text-sm">
              {state.onLeave.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{l.employee_name} · {l.leave_type}{l.half_day ? ` (${l.half_day})` : ""} · {l.start_date}{l.end_date !== l.start_date ? ` to ${l.end_date}` : ""}</span>
                  <Button size="sm" variant="outline" onClick={() => setArrange({ absent: l.employee_id, date: l.start_date, leave_request_id: l.id })}>Arrange substitute</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <DataTable toolbar={filters.toolbar} columns={columns} rows={filters.rows} loading={state.loading} error={state.error} onRetry={load} pageSize={15}
          caption="Substitutions" minWidth={900} empty={{ title: "No substitutions in this range", icon: UsersIcon }}
          selection={role === "hr" ? bulk.selection : null} />
        {bulk.dialog}
      </CardContent>
      <ArrangeDialog open={Boolean(arrange)} initial={arrange} teachers={state.teachers} onClose={() => setArrange(null)} onSaved={load} />
      <DecisionRemarkDialog
        open={Boolean(deciding)} idPrefix="sub-remark" decision={deciding?.decision || "approve"} entityType="substitution"
        destructive={deciding?.decision === "reject"} confirmLabel={deciding?.decision === "reject" ? "Reject" : "Approve"}
        title={deciding ? `${deciding.decision === "reject" ? "Reject" : "Approve"} the substitution?` : ""}
        description={deciding ? `${deciding.row.substitute_name} covering ${deciding.row.absent_name} · ${deciding.row.sub_date} ${deciding.row.start_time}-${deciding.row.end_time}` : ""}
        onClose={() => setDeciding(null)}
        onConfirm={async (remark) => { await send(deciding.row, deciding.decision, remark); setDeciding(null); await load(); }}
      />
    </Card>
  );
}
