"use client";

import * as React from "react";
import { BanknoteIcon, Loader2Icon, MegaphoneIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime, money, moneyCompact } from "@/lib/portal/payroll-preview";
import { ANNOUNCEMENT_CATEGORIES } from "@/lib/branch-requests";
import { cn } from "@/lib/utils";
import { useBranchView } from "./oversight-shared";

/*
 * Branch Payroll Summary (view=payroll): each approved run's totals for the
 * Admin's branch, never an employee's figures. Announcements
 * (/api/announcements): the Admin posts, edits and removes them for its
 * branch's employees, who see them on their dashboard and in the bell.
 */

export function PayrollSummaryPage({ refreshKey }) {
  const view = useBranchView("payroll", {}, refreshKey);
  const periods = view.data?.periods || [];
  const latest = periods[0];
  return (
    <>
      <section aria-label="Latest" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Latest approved period" value={latest ? latest.period_label : "—"} hint={latest ? latest.cutoff : "No approved payroll yet"} icon={BanknoteIcon} tone="gold" loading={view.first} />
        <StatCard label="Total payroll cost (gross)" value={latest ? moneyCompact(latest.total_gross) : "₱ 0"} hint={latest ? `${latest.employees} employees` : ""} icon={WalletIcon} loading={view.first} />
        <StatCard label="Total net paid" value={latest ? moneyCompact(latest.total_net) : "₱ 0"} icon={WalletIcon} tone="success" loading={view.first} />
      </section>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Branch payroll by period</CardTitle>
          <CardDescription>Totals of HR-approved payroll runs only. Individual salaries and payslips are not shown.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={view.load} disabled={view.loading}><RefreshCwIcon className={cn(view.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={[
            { key: "period_start", header: "Pay period", sortable: true, cell: (p) => <div><p className="font-medium">{p.period_label}</p><p className="text-xs text-muted-foreground">{p.cutoff}</p></div>, searchValue: (p) => p.period_label },
            { key: "employees", header: "Employees", align: "right", className: "tabular-nums" },
            { key: "total_gross", header: "Total gross", align: "right", className: "tabular-nums", cell: (p) => money(p.total_gross) },
            { key: "total_deductions", header: "Total deductions", align: "right", className: "tabular-nums", cell: (p) => money(p.total_deductions) },
            { key: "total_net", header: "Total net", align: "right", className: "tabular-nums font-medium", cell: (p) => money(p.total_net) },
            { key: "approved_at", header: "Approved by HR", cell: (p) => <div className="text-xs"><p>{p.approved_by || "HR"}</p><p className="text-muted-foreground">{p.approved_at ? dateTime(p.approved_at) : ""}</p></div> },
          ]} rows={periods} loading={view.first} error={view.error} onRetry={view.load} pageSize={12} searchable={false}
            empty={{ title: "No approved payroll yet", description: "A period appears here once HR approves the branch's run.", icon: BanknoteIcon }} caption="Branch payroll summary" minWidth={820} />
        </CardContent>
      </Card>
    </>
  );
}

const CATEGORY_TONE = { holiday: "gold", meeting: "info", schedule_change: "warning", general: "muted" };

export function AnnouncementsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [editing, setEditing] = React.useState(null); // {} new, or the announcement
  const [form, setForm] = React.useState({ title: "", body: "", category: "general" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/announcements");
      if (data.available === false) throw new Error(data.error);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load announcements.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  function open(item) {
    setEditing(item || {});
    setForm(item ? { title: item.title, body: item.body, category: item.category } : { title: "", body: "", category: "general" });
    setError("");
  }

  async function save() {
    setBusy(true); setError("");
    try {
      if (editing?.id) {
        await fetchJson("/api/announcements", jsonBody("PATCH", { id: editing.id, action: "edit", ...form }));
        notify("Announcement Updated", "", "success");
      } else {
        const result = await fetchJson("/api/announcements", jsonBody("POST", form));
        notify("Announcement Posted", `${result.notified || 0} employee(s) of your branch notified.`, "success");
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    const ok = await confirm({ title: `Remove "${item.title}"?`, description: "Employees will no longer see it. It stays on record here as removed.", confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    try {
      await fetchJson("/api/announcements", jsonBody("PATCH", { id: item.id, action: "remove" }));
      notify("Announcement Removed", "", "info");
      await load();
    } catch (err) {
      notify("Error", err.message, "error");
    }
  }

  const rows = state.data?.announcements || [];
  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle>
          <CardDescription>For your branch&apos;s employees only. They see them on their dashboard and get a notification.</CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            <Button size="sm" onClick={() => open(null)}><PlusIcon aria-hidden="true" />Post announcement</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={[
            { key: "title", header: "Announcement", sortable: true, cell: (a) => <div className="max-w-96 whitespace-normal"><p className="font-medium">{a.title}</p><p className="text-xs text-muted-foreground whitespace-pre-wrap">{a.body}</p></div>, searchValue: (a) => `${a.title} ${a.body}` },
            { key: "category", header: "Type", cell: (a) => <StatusBadge tone={CATEGORY_TONE[a.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[a.category] || a.category}</StatusBadge> },
            { key: "created_at", header: "Posted", sortable: true, cell: (a) => <div className="text-xs"><p>{a.created_by_name}</p><p className="text-muted-foreground">{dateTime(a.created_at)}</p>{a.updated_at && a.updated_at !== a.created_at && !a.archived ? <p className="text-muted-foreground">Edited {dateTime(a.updated_at)}</p> : null}</div> },
            { key: "state", header: "Status", cell: (a) => (a.archived ? <StatusBadge tone="muted">Removed {a.archived_at ? dateTime(a.archived_at) : ""}</StatusBadge> : <StatusBadge tone="success">Visible</StatusBadge>) },
            { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (a) => (a.archived ? null : (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" onClick={() => open(a)}><PencilIcon aria-hidden="true" />Edit</Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => remove(a)}><Trash2Icon aria-hidden="true" />Remove</Button>
              </div>
            )) },
          ]} rows={rows} loading={state.loading && !state.data} error={state.error} onRetry={load} pageSize={10}
            searchPlaceholder="Search announcements…" empty={{ title: "No announcements yet", icon: MegaphoneIcon }} caption="Announcements" minWidth={900} />
        </CardContent>
      </Card>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o && !busy) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit announcement" : "Post an announcement"}</DialogTitle>
            <DialogDescription>Only your branch&apos;s employees see it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5"><Label htmlFor="an-title">Title</Label><Input id="an-title" maxLength={150} value={form.title} onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="an-cat">Type</Label>
              <Select value={form.category} onValueChange={(v) => setForm((c) => ({ ...c, category: v }))}>
                <SelectTrigger id="an-cat" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(ANNOUNCEMENT_CATEGORIES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="an-body">Message</Label><Textarea id="an-body" rows={5} maxLength={4000} value={form.body} onChange={(e) => setForm((c) => ({ ...c, body: e.target.value }))} /></div>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            <Button onClick={save} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{editing?.id ? "Save" : "Post"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

/** Employees' dashboard card: their branch's current announcements. */
export function BranchAnnouncementsCard({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, items: [] });
  React.useEffect(() => {
    let alive = true;
    fetchJson("/api/announcements")
      .then((data) => { if (alive) setState({ loading: false, items: (data.announcements || []).slice(0, 5) }); })
      .catch(() => { if (alive) setState((c) => ({ ...c, loading: false })); });
    return () => { alive = false; };
  }, [refreshKey]);
  if (!state.loading && !state.items.length) return null;
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader><CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle><CardDescription>From your branch</CardDescription></CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {state.items.map((a) => (
            <li key={a.id} className="rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{a.title}</p><StatusBadge tone={CATEGORY_TONE[a.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[a.category] || a.category}</StatusBadge></div>
              <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{a.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">{a.created_by_name} · {dateTime(a.created_at)}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
