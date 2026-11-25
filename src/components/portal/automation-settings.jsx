"use client";

import * as React from "react";
import { BotIcon, DownloadIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/portal/data-table";
import { DecisionRemarkDialog } from "@/components/portal/remark-field";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { AUTOMATION_MODULES, AUTOMATION_SWITCHES, STATUS_LABEL } from "@/lib/automation/shared";
import { cn } from "@/lib/utils";

/*
 * Settings > Automation (HR / Super Admin, 2026-11-24; it replaces the
 * dashboard's Automation card, since the system runs by itself):
 *  - the emergency "Pause all", a switch per module and the daily digests;
 *  - the Activity log: what the system did ("by System, rule ..."), the data
 *    it used, and Undo with a preset reason; filters and a CSV export.
 * Items the system could not decide, or that wait too long, are in the
 * dashboard's Action needed list.
 */

const TONE = { done: "success", admin_check: "info", with_hr: "info", open: "warning", couldnt_decide: "danger", undone: "muted", closed: "muted" };
const ALL = "all";
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const dayOf = (iso) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : "");
const dataText = (d) => Object.entries(d || {}).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");

function csv(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["When", "Module", "Status", "Employee", "What the system did", "Rule", "Data used", "Reason it could not decide", "Undone by", "Undo reason"];
  const lines = rows.map((a) => [when(a.created_at), AUTOMATION_MODULES[a.module] || a.module, STATUS_LABEL[a.status] || a.status, a.employee_name || "", a.summary, a.rule, dataText(a.data), a.reason || "", a.undone_by_name || "", a.undo_reason || ""].map(esc).join(","));
  return [head.map(esc).join(","), ...lines].join("\r\n");
}

export function AutomationSettings({ refreshKey = 0 }) {
  const { notify, role } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const [busy, setBusy] = React.useState(false);
  const [undoing, setUndoing] = React.useState(null);
  const [f, setF] = React.useState({ module: ALL, status: ALL, from: "", to: "" });

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try { setState({ loading: false, error: "", data: await fetchJson("/api/automation?limit=500") }); }
    catch (e) { setState((s) => ({ ...s, loading: false, error: e.message })); }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const d = state.data;
  async function patch(payload, done) {
    setBusy(true);
    try { await fetchJson("/api/automation", jsonBody("PATCH", payload)); notify(done, "", "success"); await load(); }
    catch (e) { notify("Not changed", e.message, "error"); } finally { setBusy(false); }
  }

  const rows = (d?.actions || []).filter((a) => (f.module === ALL || a.module === f.module) && (f.status === ALL || a.status === f.status)
    && (!f.from || dayOf(a.created_at) >= f.from) && (!f.to || dayOf(a.created_at) <= f.to));
  const columns = [
    { key: "created_at", header: "When", sortable: true, className: "whitespace-nowrap text-xs", cell: (a) => when(a.created_at), sortValue: (a) => a.created_at },
    { key: "summary", header: "What the system did", cell: (a) => (
      <div className="max-w-md space-y-0.5 whitespace-normal">
        <p className="text-sm font-medium">{a.summary}</p>
        <p className="text-xs text-muted-foreground">by System, rule: {a.rule}</p>
        {dataText(a.data) ? <p className="text-xs text-muted-foreground" data-testid="automation-data">Data used: {dataText(a.data)}</p> : null}
        {a.reason ? <p className="text-xs text-destructive">Couldn&apos;t decide: {a.reason}</p> : null}
        {a.undo_reason ? <p className="text-xs text-muted-foreground">Undone by {a.undone_by_name}: {a.undo_reason}</p> : null}
      </div>
    ), searchValue: (a) => `${a.summary} ${a.rule} ${a.employee_name || ""}` },
    { key: "module", header: "Module", className: "text-xs", cell: (a) => AUTOMATION_MODULES[a.module] || a.module },
    { key: "status", header: "Status", cell: (a) => <div className="space-y-1"><StatusBadge tone={TONE[a.status] || "muted"}>{STATUS_LABEL[a.status] || a.status}</StatusBadge>{a.escalated_at ? <StatusBadge tone="danger">Waiting too long</StatusBadge> : null}</div> },
    { key: "act", header: <span className="sr-only">Undo</span>, align: "right", cell: (a) => (role === "hr" && a.kind === "applied" && a.status === "done"
      ? <Button size="sm" variant="outline" onClick={() => setUndoing(a)}>Undo</Button> : null) },
  ];

  function exportCsv() {
    const blob = new Blob([`﻿${csv(rows)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `automation-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="automation-settings">
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BotIcon className="size-4 text-gold-text" aria-hidden="true" />Automation</CardTitle>
          <CardDescription>The system checks, prepares and routes items to HR by itself. HR approvals stay manual. Switch a module off here, or pause everything in an emergency.</CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            {d ? (
              <Button size="sm" variant={d.paused ? "default" : "destructive"} disabled={busy} data-testid="automation-pause"
                onClick={() => patch({ action: "pause", paused: !d.paused }, d.paused ? "Automation resumed" : "Automation paused")}>
                {d.paused ? <><PlayIcon aria-hidden="true" />Resume all</> : <><PauseIcon aria-hidden="true" />Pause all</>}
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.error && !d ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
          {d?.paused ? <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm" data-testid="automation-paused">Everything automatic is paused until you resume it.</p> : null}
          {d ? (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Modules" data-testid="automation-modules">
              {AUTOMATION_SWITCHES.map((m) => [m, AUTOMATION_MODULES[m]]).map(([m, label]) => {
                const on = !d.modules_paused?.[m];
                return (
                  <li key={m} className="flex min-h-10 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <label htmlFor={`auto-${m}`}>{label}</label>
                    <Switch id={`auto-${m}`} checked={on} disabled={busy || d.paused} onCheckedChange={(v) => patch({ action: "pause", module: m, paused: !v }, `${label} ${v ? "on" : "off"}`)} />
                  </li>
                );
              })}
            </ul>
          ) : null}
          {d?.digest ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Daily digest</p>
              <ul className="grid gap-2 sm:grid-cols-2" aria-label="Daily digest">
                {[["hr", "HR: what the system did and what waits for HR"], ["admin", "Branch Admins: HR's decisions for their branch"]].map(([who, label]) => (
                  <li key={who} className="flex min-h-10 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <label htmlFor={`digest-${who}`}>{label}</label>
                    <Switch id={`digest-${who}`} checked={Boolean(d.digest[who])} disabled={busy} onCheckedChange={(v) => patch({ action: "digest", who, on: v }, `Digest ${v ? "on" : "off"}`)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Activity log</CardTitle>
          <CardDescription>Everything the system did by itself, the rule and the data it used. Undo an applied action with a preset reason. What it could not decide, or what waits too long, is also in Action needed on the dashboard.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}><DownloadIcon aria-hidden="true" />Export CSV</Button></CardAction>
        </CardHeader>
        <CardContent>
          <DataTable
            toolbar={(
              <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
                <Select value={f.module} onValueChange={(v) => setF((c) => ({ ...c, module: v }))}>
                  <SelectTrigger className="h-10 w-full" aria-label="Module"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={ALL}>Any module</SelectItem>{Object.entries(AUTOMATION_MODULES).map(([m, l]) => <SelectItem key={m} value={m}>{l}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={f.status} onValueChange={(v) => setF((c) => ({ ...c, status: v }))}>
                  <SelectTrigger className="h-10 w-full" aria-label="Status"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={ALL}>Any status</SelectItem>{Object.entries(STATUS_LABEL).filter(([k]) => k !== "admin_check").map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                </Select>
                <Input type="date" className="h-10" aria-label="From" value={f.from} onChange={(e) => setF((c) => ({ ...c, from: e.target.value }))} />
                <Input type="date" className="h-10" aria-label="To" value={f.to} onChange={(e) => setF((c) => ({ ...c, to: e.target.value }))} />
              </div>
            )}
            columns={columns} rows={rows} loading={state.loading && !d} error={state.error} onRetry={load}
            searchPlaceholder="Search name, ID or details…" caption="Automation activity log" minWidth={900}
            empty={{ title: "Nothing done by the system yet", icon: BotIcon }} />
        </CardContent>
      </Card>

      <DecisionRemarkDialog open={Boolean(undoing)} title="Undo this automatic action" description={undoing?.summary}
        decision="revoke" entityType="automation_action" confirmLabel="Undo" destructive idPrefix="automation-undo"
        onClose={() => setUndoing(null)}
        onConfirm={async (remark) => { await patch({ id: undoing.id, action: "undo", remark }, "Undone"); setUndoing(null); }} />
    </div>
  );
}
