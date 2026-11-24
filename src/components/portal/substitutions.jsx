"use client";

import { dateLabel } from "@/lib/portal/payroll-preview";

import { ItemThread } from "@/components/portal/item-thread";

import * as React from "react";
import { Loader2Icon, PlusIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { useBulkDecisions } from "@/components/portal/bulk-action-dialog";
import { useApprovalFilters } from "@/components/portal/approval-filters";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { ExportButtons } from "@/components/portal/export-buttons";
import { cn } from "@/lib/utils";
import { FilterBar } from "@/components/portal/filter-bar";

/*
 * Substitute teaching (Part C, 2026-11-22; 2026-11-24): when a teacher's leave
 * or half day is approved, the system proposes a substitution for each school
 * day; HR picks the teacher from the suggestions (same level and branch,
 * tapped in that day, not on leave, under the weekly cap) and approves. HR
 * files one by hand only for an unplanned absence (approved on filing).
 * Payroll pays it when the substitute's taps cover it. role: "hr" | "accountant".
 */

const STATUS_TONE = { pending: "gold", approved: "success", rejected: "danger", cancelled: "muted" };
const TAP = { confirmed: ["success", "Confirmed by taps"], waiting: ["muted", "Waiting for the day"], no_taps: ["danger", "No taps: not paid"], no_substitute: ["gold", "No teacher picked yet"] };
const EMPTY = { absent: "", date: "", start: "", end: "", periods: "1", class_section: "", subject: "", substitute: "", reason: "" };
const UNPLANNED = { no_show: "No-show", sudden_illness: "Sudden illness", other: "Other unplanned absence" };

/**
 * HR picks the substitute: on a system proposal (`proposal`: the day, hours and periods are set; approve with the
 * picked teacher) or for an unplanned absence (filed and approved at once).
 */
function ArrangeDialog({ open, initial, proposal = null, teachers, onClose, onSaved }) {
  const { notify } = usePortalSession();
  const [f, setF] = React.useState(EMPTY);
  const [found, setFound] = React.useState(null); // { suggestions, cap, future }
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setF(proposal ? { ...EMPTY, absent: proposal.absent_employee_id, date: proposal.sub_date, start: String(proposal.start_time).slice(0, 5), end: String(proposal.end_time).slice(0, 5), periods: String(proposal.periods) } : { ...EMPTY, ...(initial || {}) });
    setFound(null); setError("");
  }, [open, initial, proposal]);
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
    if (!proposal && !f.reason) { setError("Choose why the absence was unplanned."); return; }
    setBusy(true);
    try {
      if (proposal) {
        await fetchJson("/api/substitutions", jsonBody("PATCH", { id: proposal.id, action: "approve", substitute_id: f.substitute, periods: Number(f.periods) }));
        notify("Substitution approved", "Payroll pays it when the substitute's taps cover the time.", "success");
      } else {
        await fetchJson("/api/substitutions", jsonBody("PATCH", {
          action: "file_unplanned", unplanned_reason: f.reason, absent_employee_id: f.absent, substitute_id: f.substitute, sub_date: f.date,
          start_time: f.start, end_time: f.end, periods: Number(f.periods), class_section: f.class_section, subject: f.subject,
        }));
        notify("Substitution filed and approved", "Payroll pays it when the substitute's taps cover the time.", "success");
      }
      onSaved();
      onClose();
    } catch (e) { setError(e.message || "Not saved."); } finally { setBusy(false); }
  }
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="arrange-substitute">
        <DialogHeader>
          <DialogTitle>{proposal ? `Assign substitute teacher · ${proposal.absent_name}` : "Substitute for an unplanned absence"}</DialogTitle>
          <DialogDescription>{proposal
            ? `${dateLabel(proposal.sub_date)} ${String(proposal.start_time).slice(0, 5)}–${String(proposal.end_time).slice(0, 5)}, ${proposal.periods} period${proposal.periods === 1 ? "" : "s"} (from the approved leave). Suggestions: same level and branch, tapped in that day, not on leave, under the weekly cap. Assign saves the teacher and approves the substitution.`
            : "Only for a no-show or a sudden illness: planned leave gets a system proposal. Suggestions: same level and branch, tapped in that day, not on leave, under the weekly cap. Filed and approved at once."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {proposal ? null : (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sub-reason">Unplanned absence</Label>
            <Select value={f.reason} onValueChange={(v) => setF((c) => ({ ...c, reason: v }))}>
              <SelectTrigger id="sub-reason" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{Object.entries(UNPLANNED).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          )}
          {proposal ? (
            <div className="space-y-1.5"><Label htmlFor="sub-periods">Class periods covered</Label><Input id="sub-periods" type="number" min={1} max={proposal.periods} value={f.periods} onChange={set("periods")} /><p className="text-xs text-muted-foreground">Up to {proposal.periods}; the weekly cap counts these.</p></div>
          ) : null}
          {proposal ? null : (<>
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
          </>)}
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
          <Button onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{proposal ? "Assign" : "File and approve"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SubstitutionsPanel({ role, refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", rows: [], teachers: [], onLeave: [] });
  const [arrange, setArrange] = React.useState(null);
  const [picking, setPicking] = React.useState(null);
  const [deciding, setDeciding] = React.useState(null);
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [list, people] = await Promise.all([
        fetchJson("/api/substitutions"),
        role === "hr" ? fetchJson("/api/substitutions?teachers=1") : Promise.resolve({ teachers: [], on_leave: [] }),
      ]);
      setState({ loading: false, error: "", rows: list.substitutions || [], teachers: people.teachers || [], onLeave: people.on_leave || [] });
    } catch (e) { setState((s) => ({ ...s, loading: false, error: e.message || "Could not load the substitutions." })); }
  }, [role]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const filters = useApprovalFilters(state.rows, {
    prefix: "sub", typeLabel: "Status", people: role === "hr",
    get: { name: (r) => `${r.substitute_name || ""} ${r.absent_name}`, code: (r) => r.substitute_code, type: (r) => r.status, filed: (r) => r.created_at, requested: (r) => r.sub_date, branch: (r) => r.branch_id, employeeId: (r) => r.substitute_id },
  });
  const send = (r, decision, remark) => fetchJson("/api/substitutions", jsonBody("PATCH", { id: r.id, action: decision, remark }));
  const bulk = useBulkDecisions({
    entityType: "substitution", onDone: load, send,
    decisions: [{ decision: "approve", label: "Approve" }, { decision: "reject", label: "Reject", destructive: true }],
    // A proposal needs its own pick: not in the bulk approve.
    isSelectable: (r) => role === "hr" && r.status === "pending" && !r.needs_substitute,
    label: (r) => `${r.substitute_name} ${r.sub_date}`,
    rowLabel: (r) => `${r.substitute_name || "(teacher to pick)"} covering ${r.absent_name} · ${dateLabel(r.sub_date)} ${r.start_time}-${r.end_time}`,
  });

  const columns = [
    { key: "sub_date", header: "Date", sortable: true, cell: (r) => <div><p className="font-medium">{dateLabel(r.sub_date)}</p><p className="text-xs text-muted-foreground">{r.start_time}-{r.end_time} · {r.periods} period{r.periods === 1 ? "" : "s"}</p></div> },
    { key: "who", header: "Substitute → covering", cell: (r) => <div><p className="font-medium">{r.substitute_name || <span className="text-gold-text">Pick a teacher</span>}</p><p className="text-xs text-muted-foreground">covering {r.absent_name}{r.class_section ? `, ${r.class_section}` : ""}{r.subject ? ` (${r.subject})` : ""}</p></div>, searchValue: (r) => `${r.substitute_name} ${r.absent_name}` },
    { key: "tap", header: "Taps", cell: (r) => <StatusBadge tone={TAP[r.tap_check]?.[0] || "muted"}>{TAP[r.tap_check]?.[1] || r.tap_check}</StatusBadge> },
    { key: "status", header: "Status", sortable: true, cell: (r) => <div className="space-y-0.5"><StatusBadge tone={STATUS_TONE[r.status] || "muted"}>{r.status}</StatusBadge>{r.decided_by_name ? <p className="text-xs text-muted-foreground">{r.decided_by_name}{r.decision_note ? ` · ${r.decision_note}` : ""}</p> : null}</div> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (role !== "hr" ? null : (
      <div className="flex justify-end gap-1.5">
        <ItemThread itemType="substitution" itemId={r.id} title={`Messages · ${r.absent_name}`} />
        {r.status !== "pending" ? null : <>
        <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeciding({ row: r, decision: "reject" })}>Reject</Button>
        {r.needs_substitute
          ? <Button size="sm" onClick={() => setPicking(r)} data-testid="pick-substitute">Assign</Button>
          : <Button size="sm" onClick={() => setDeciding({ row: r, decision: "approve" })}>Approve</Button>}
        </>}
      </div>
    )) },
  ];

  return (
    <Card className="min-w-0 shadow-xs" data-testid="substitutions">
      <CardHeader>
        <CardTitle>Substitute teaching</CardTitle>
        <CardDescription>
          {role === "hr"
            ? "A teacher's approved leave or half day proposes a substitution for each school day: pick the teacher and approve. File one by hand only for an unplanned absence. Paid only when the substitute's taps cover the time: inside their shift ₱ per period, outside it as overtime, above the standard load at the overload rate."
            : "Substitutions HR approved; paid when the substitute's taps cover the time."}
        </CardDescription>
        <CardAction className="flex gap-2">
          {role === "hr" ? <Button size="sm" variant="outline" onClick={() => setArrange({})}><PlusIcon aria-hidden="true" />Unplanned absence</Button> : null}
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable toolbar={filters.toolbar} columns={columns} rows={filters.rows} loading={state.loading} error={state.error} onRetry={load}
          caption="Substitutions" minWidth={900} empty={{ title: "No substitutions in this range", icon: UsersIcon }}
          selection={role === "hr" ? bulk.selection : null} />
        {bulk.dialog}
      </CardContent>
      <ArrangeDialog open={Boolean(arrange)} initial={arrange} teachers={state.teachers} onClose={() => setArrange(null)} onSaved={load} />
      <ArrangeDialog open={Boolean(picking)} proposal={picking} teachers={state.teachers} onClose={() => setPicking(null)} onSaved={load} />
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

/** The Accountant's Action needed (Part C): substitutions approved after their cutoff was processed. */
export function SubstitutionsActionNeededCard({ refreshKey = 0, onOpen }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    let live = true;
    fetchJson("/api/substitutions?late=1").then((d) => { if (live) setRows(d.late || []); }).catch(() => {});
    return () => { live = false; };
  }, [refreshKey]);
  if (!rows.length) return null;
  return (
    <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="substitutions-action-needed">
      <p className="font-semibold">Action needed: substitutions approved after their cutoff ({rows.length})</p>
      <p className="mb-1 text-xs text-muted-foreground">Their cutoff was already processed: they are paid on the next payslip as an adjustment when you process it.</p>
      <ul className="space-y-0.5">{rows.slice(0, 8).map((r) => <li key={r.id}>{r.substitute_name} · {dateLabel(r.sub_date)} {r.start_time}-{r.end_time}, covering {r.absent_name}</li>)}</ul>
      {onOpen ? <Button size="sm" variant="outline" className="mt-2" onClick={onOpen}>Open Process Payroll</Button> : null}
    </div>
  );
}

/** The substitution report (Part C): paid substitutions by substitute, absent teacher or cutoff, with totals; the export = the screen. */
export function SubstitutionsReportCard() {
  const [f, setF] = React.useState(() => {
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    return { from: `${today.slice(0, 8)}01`, to: today, by: "substitute", q: "" };
  });
  const [state, setState] = React.useState({ loading: true, error: "", rows: [], totals: null });
  const query = `from=${f.from}&to=${f.to}&by=${f.by}${f.q.trim() ? `&q=${encodeURIComponent(f.q.trim())}` : ""}`;
  React.useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    fetchJson(`/api/reports/substitutions?${query}`).then((d) => { if (live) setState({ loading: false, error: "", rows: d.rows || [], totals: d.totals }); })
      .catch((e) => { if (live) setState({ loading: false, error: e.message || "Could not load the report.", rows: [], totals: null }); });
    return () => { live = false; };
  }, [query]);
  const BY = { substitute: "Substitute", absent: "Absent teacher", cutoff: "Cutoff" };
  return (
    <Card className="min-w-0 shadow-xs" data-testid="substitutions-report">
      <CardHeader>
        <CardTitle>Substitute teaching</CardTitle>
        <CardDescription>What processed payslips paid for substitutions{state.totals ? `: ${state.totals.substitutions} substitution${state.totals.substitutions === 1 ? "" : "s"}, ${state.totals.hours} h, ₱${state.totals.amount.toLocaleString("en-PH", { minimumFractionDigits: 2 })}` : ""}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <FilterBar data-testid="substitution-report-filters">
          <Input type="search" data-filter="search" aria-label="Search" placeholder="Search…" value={f.q} onChange={(e) => setF((c) => ({ ...c, q: e.target.value }))} />
          <Select value={f.by} onValueChange={(v) => setF((c) => ({ ...c, by: v }))}>
            <SelectTrigger aria-label="Group by"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(BY).map(([v, l]) => <SelectItem key={v} value={v}>By {l.toLowerCase()}</SelectItem>)}</SelectContent>
          </Select>
          <div data-filter="date"><DatePicker aria-label="From" value={f.from} max={f.to} onChange={(v) => setF((c) => ({ ...c, from: v }))} /></div>
          <div data-filter="date"><DatePicker aria-label="To" value={f.to} min={f.from} onChange={(v) => setF((c) => ({ ...c, to: v }))} /></div>
          <ExportButtons href={`/api/reports/substitutions?${query}`} label="substitutions" disabled={state.loading} />
        </FilterBar>
        <DataTable searchable={false} caption="Substitute teaching" loading={state.loading} error={state.error} rows={state.rows} rowKey={(r) => r.key} minWidth={520}
          empty={{ title: "No substitutions paid in this range", icon: UsersIcon }}
          columns={[
            { key: "key", header: BY[f.by], className: "font-medium" },
            { key: "substitutions", header: "Substitutions", align: "right" },
            { key: "hours", header: "Hours", align: "right" },
            { key: "amount", header: "Paid", align: "right", cell: (r) => `₱${Number(r.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })}` },
          ]} />
      </CardContent>
    </Card>
  );
}

