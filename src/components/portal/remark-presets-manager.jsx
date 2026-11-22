"use client";

import * as React from "react";
import { PlusIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { ExportButtons } from "@/components/portal/export-buttons";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { clearRemarkPresetCache } from "@/components/portal/remark-field";
import { fetchJson, jsonBody } from "@/lib/portal/api";

/*
 * Part H (2026-11-22): the preset remarks (Settings: add, edit, deactivate,
 * reorder, per decision and type; HR and the Super Admin) and the decision
 * reasons report (how often each was used, counted from the audit log).
 */

export const DECISION_LABELS = { approve: "Approve", reject: "Reject", resolve: "Resolve", endorse: "Endorse", object: "Object", override: "Override", revoke: "Revoke" };
export const TYPE_LABELS = {
  "*": "Any type", leave_request: "Leave request", overtime_request: "Overtime request", attendance_correction: "Attendance correction",
  payroll_run: "Payroll run", awol_case: "AWOL case", transfer_request: "Transfer request", adjustment: "Incentive / loan",
  final_pay: "Final pay", tenure_grant: "Tenure pay protection", subsidy_request: "Subsidy request",
  payroll_correction: "Payroll correction", branch_request: "Branch request", substitution: "Substitution",
};
const ALL = "all";

/** Settings: the preset remarks. A preset is never deleted; a deactivated one stays readable on old records. */
export function RemarkPresetsCard({ refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", presets: [] });
  const [filter, setFilter] = React.useState(ALL);
  const [draft, setDraft] = React.useState({ decision: "reject", entity_type: "*", label: "" });
  const [edits, setEdits] = React.useState({});
  const [busy, setBusy] = React.useState("");
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const data = await fetchJson("/api/remark-presets?all=1");
      setState({ loading: false, error: "", presets: data.presets || [] });
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error: error.message || "Could not load the preset remarks." }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function save(body, method, done) {
    setBusy(body.id || "new");
    try {
      await fetchJson("/api/remark-presets", jsonBody(method, body));
      clearRemarkPresetCache();
      notify("Preset remarks", done, "success");
      await load();
      return true;
    } catch (error) {
      notify("Not saved", error.message || "Try again.", "error");
      return false;
    } finally {
      setBusy("");
    }
  }

  const rows = state.presets.filter((p) => filter === ALL || p.decision === filter);
  const edit = (p, patch) => setEdits((e) => ({ ...e, [p.id]: { label: p.label, sort_order: p.sort_order, ...e[p.id], ...patch } }));
  const columns = [
    { key: "decision", header: "Decision", sortable: true, cell: (p) => DECISION_LABELS[p.decision] || p.decision, searchValue: (p) => DECISION_LABELS[p.decision] },
    { key: "entity_type", header: "For", sortable: true, cell: (p) => TYPE_LABELS[p.entity_type] || p.entity_type, searchValue: (p) => TYPE_LABELS[p.entity_type] },
    { key: "label", header: "Remark", sortable: true, searchValue: (p) => p.label, cell: (p) => (
      <Input aria-label={`Remark: ${p.label}`} className="min-w-56" maxLength={120} value={edits[p.id]?.label ?? p.label} onChange={(e) => edit(p, { label: e.target.value })} />
    ) },
    { key: "sort_order", header: "Order", sortable: true, cell: (p) => (
      <Input aria-label={`Order of ${p.label}`} className="w-20" type="number" min={0} max={10000} value={edits[p.id]?.sort_order ?? p.sort_order} onChange={(e) => edit(p, { sort_order: e.target.value })} />
    ) },
    { key: "active", header: "Offered", cell: (p) => (
      <span className="inline-flex items-center gap-2">
        <Switch aria-label={`${p.active ? "Deactivate" : "Reactivate"} ${p.label}`} checked={p.active} disabled={busy === p.id}
          onCheckedChange={(on) => save({ id: p.id, active: on }, "PATCH", `${p.label}: ${on ? "offered again" : "deactivated (old records keep it)"}.`)} />
        <StatusBadge tone={p.active ? "success" : "muted"}>{p.active ? "Active" : "Deactivated"}</StatusBadge>
      </span>
    ) },
    { key: "save", header: "", cell: (p) => (edits[p.id] ? (
      <Button size="sm" variant="outline" disabled={busy === p.id} onClick={async () => {
        const e = edits[p.id];
        if (await save({ id: p.id, label: e.label, sort_order: Number(e.sort_order) }, "PATCH", `${e.label}: saved.`)) setEdits((m) => { const { [p.id]: _drop, ...rest } = m; return rest; });
      }}><SaveIcon aria-hidden="true" />Save</Button>
    ) : null) },
  ];

  return (
    <Card className="shadow-xs" data-testid="remark-presets">
      <CardHeader>
        <CardTitle>Preset remarks</CardTitle>
        <CardDescription>The remarks offered when approving, rejecting, resolving, endorsing, objecting, overriding or revoking. &quot;Other (write your own)&quot; is always offered too. Deactivated remarks stay readable on old records and in the reports.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[10rem_12rem_1fr_auto] sm:items-end" onSubmit={async (e) => {
          e.preventDefault();
          if (await save(draft, "POST", `Added: ${draft.label}.`)) setDraft((d) => ({ ...d, label: "" }));
        }}>
          <div className="space-y-1.5">
            <Label htmlFor="rp-decision">Decision</Label>
            <Select value={draft.decision} onValueChange={(v) => setDraft((d) => ({ ...d, decision: v }))}>
              <SelectTrigger id="rp-decision" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(DECISION_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-type">For</Label>
            <Select value={draft.entity_type} onValueChange={(v) => setDraft((d) => ({ ...d, entity_type: v }))}>
              <SelectTrigger id="rp-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-label">New remark</Label>
            <Input id="rp-label" maxLength={120} value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} placeholder="e.g. Medical certificate missing" />
          </div>
          <Button type="submit" disabled={busy === "new" || draft.label.trim().length < 3}><PlusIcon aria-hidden="true" />Add</Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="rp-filter" className="text-sm">Show</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger id="rp-filter" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>Every decision</SelectItem>{Object.entries(DECISION_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <DataTable columns={columns} rows={rows} loading={state.loading} error={state.error} onRetry={load} rowKey={(p) => p.id}
          searchPlaceholder="Search remarks…" caption="Preset remarks" minWidth={760} empty={{ title: "No preset remarks" }} pageSize={25} />
      </CardContent>
    </Card>
  );
}

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/**
 * Decision reasons: how often each remark was used (one per decided item),
 * by decision, type, branch and dates. The export lists the screen's rows.
 * allBranches: HR / Super Admin (a branch filter); a branch Admin sees its own.
 */
export function DecisionReasonsCard({ allBranches = false, refreshKey = 0 }) {
  const [filters, setFilters] = React.useState({ from: monthStart(), to: today(), decision: ALL, entity_type: ALL, branch_id: ALL, q: "" });
  const [branches, setBranches] = React.useState([]);
  const [state, setState] = React.useState({ loading: true, error: "", rows: [], total: 0 });
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const query = React.useMemo(() => {
    const p = new URLSearchParams();
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    if (filters.decision !== ALL) p.set("decision", filters.decision);
    if (filters.entity_type !== ALL) p.set("entity_type", filters.entity_type);
    if (allBranches && filters.branch_id !== ALL) p.set("branch_id", filters.branch_id);
    if (filters.q.trim()) p.set("q", filters.q.trim());
    return p.toString();
  }, [filters, allBranches]);

  React.useEffect(() => {
    if (!allBranches) return;
    fetchJson("/api/admin/branches").then((d) => setBranches(d.branches || [])).catch(() => setBranches([]));
  }, [allBranches]);
  React.useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    const timer = setTimeout(() => {
      fetchJson(`/api/reports/remark-reasons?${query}`)
        .then((d) => { if (live) setState({ loading: false, error: "", rows: d.rows || [], total: d.total || 0 }); })
        .catch((e) => { if (live) setState({ loading: false, error: e.message || "Could not load the reasons.", rows: [], total: 0 }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, refreshKey]);

  const columns = [
    { key: "label", header: "Reason", sortable: true, className: "font-medium" },
    { key: "decision_label", header: "Decision", sortable: true },
    { key: "type_label", header: "Type", sortable: true },
    { key: "count", header: "Times used", sortable: true, className: "text-right tabular-nums" },
  ];
  return (
    <Card className="shadow-xs" data-testid="decision-reasons">
      <CardHeader>
        <CardTitle>Decision reasons</CardTitle>
        <CardDescription>How often each remark was used, one count per decided item, from the audit log. {state.loading ? "" : `${state.total} decision${state.total === 1 ? "" : "s"} in this range.`}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5"><Label htmlFor="dr-from">From</Label><DatePicker id="dr-from" value={filters.from} max={filters.to || undefined} onChange={(v) => set({ from: v })} /></div>
          <div className="space-y-1.5"><Label htmlFor="dr-to">To</Label><DatePicker id="dr-to" value={filters.to} min={filters.from || undefined} onChange={(v) => set({ to: v })} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="dr-decision">Decision</Label>
            <Select value={filters.decision} onValueChange={(v) => set({ decision: v })}>
              <SelectTrigger id="dr-decision" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>Every decision</SelectItem>{Object.entries(DECISION_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dr-type">Type</Label>
            <Select value={filters.entity_type} onValueChange={(v) => set({ entity_type: v })}>
              <SelectTrigger id="dr-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>Every type</SelectItem>{Object.entries(TYPE_LABELS).filter(([v]) => v !== "*").map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {allBranches ? (
            <div className="space-y-1.5">
              <Label htmlFor="dr-branch">Branch</Label>
              <Select value={filters.branch_id} onValueChange={(v) => set({ branch_id: v })}>
                <SelectTrigger id="dr-branch" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ALL}>All branches</SelectItem>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5"><Label htmlFor="dr-search">Search</Label><Input id="dr-search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Reason, decision or type" /></div>
        </div>
        <div className="flex flex-wrap justify-end"><ExportButtons href={`/api/reports/remark-reasons?${query}`} label="decision reasons" disabled={state.loading} /></div>
        <DataTable columns={columns} rows={state.rows} loading={state.loading} error={state.error} rowKey={(r) => r.key} searchable={false}
          caption="Decision reasons" minWidth={560} initialSort={{ key: "count", dir: "desc" }} empty={{ title: "No decisions with a remark in this range" }} />
      </CardContent>
    </Card>
  );
}
