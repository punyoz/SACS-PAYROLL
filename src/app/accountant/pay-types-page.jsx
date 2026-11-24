"use client";

import * as React from "react";
import { Loader2Icon, PlusIcon, RefreshCwIcon, TagsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";

/**
 * Additional Pay > Additional pay types (2026-11-26): the Accountant's own pay types (name, taxable or not,
 * description). Each item of a type is still approved by HR. A type in use is deactivated, never deleted;
 * an unused one can be deleted.
 */
export function PayTypesPage({ refreshKey = 0 }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, error: null, types: [] });
  const [form, setForm] = React.useState({ name: "", taxable: true, description: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try { setState({ loading: false, error: null, types: (await fetchJson("/api/accountant/pay-types")).types || [] }); }
    catch (e) { setState((c) => ({ ...c, loading: false, error: e.message || "Could not load the pay types." })); }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function add(event) {
    event.preventDefault();
    if (form.name.trim().length < 2) { setError("Name the pay type (at least 2 characters)."); return; }
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/accountant/pay-types", jsonBody("POST", { name: form.name.trim(), taxable: form.taxable, description: form.description.trim() }));
      notify("Pay type added", `${form.name.trim()} is now offered on Additional Pay.`, "success");
      setForm({ name: "", taxable: true, description: "" });
      await load();
    } catch (e) { setError(e.message || "Not added."); } finally { setBusy(false); }
  }

  async function setActive(t, active) {
    try {
      await fetchJson("/api/accountant/pay-types", jsonBody("PATCH", { id: t.id, active }));
      notify(active ? "Reactivated" : "Deactivated", active ? `${t.name} is offered again.` : `${t.name} is no longer offered; its filed items stay as they are.`, "info");
      await load();
    } catch (e) { notify("Not changed", e.message, "error"); }
  }

  async function remove(t) {
    const ok = await confirm({ title: `Delete "${t.name}"?`, description: "It was never used. It is removed from the list.", confirmLabel: "Delete", destructive: true });
    if (!ok) return;
    try {
      await fetchJson(`/api/accountant/pay-types?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
      notify("Deleted", `${t.name} was deleted.`, "info");
      await load();
    } catch (e) { notify("Not deleted", e.message, "error"); }
  }

  const columns = [
    { key: "name", header: "Pay type", sortable: true, className: "font-medium", searchValue: (t) => `${t.name} ${t.description || ""}`,
      cell: (t) => <div><p>{t.name}</p>{t.description ? <p className="text-xs font-normal text-muted-foreground">{t.description}</p> : null}</div> },
    { key: "taxable", header: "Tax", cell: (t) => (t.taxable ? "Taxable" : "Not taxable") },
    { key: "used", header: "Items", align: "right", className: "tabular-nums", cell: (t) => t.used },
    { key: "active", header: "Status", cell: (t) => <StatusBadge tone={t.active ? "success" : "muted"}>{t.active ? "Offered" : "Deactivated"}</StatusBadge> },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (t) => (
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setActive(t, !t.active)}>{t.active ? "Deactivate" : "Reactivate"}</Button>
        {!t.used ? <Button size="sm" variant="outline" className="text-destructive" onClick={() => remove(t)}>Delete</Button> : null}
      </div>
    ) },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="pay-types">
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>Add a pay type</CardTitle>
          <CardDescription>Your own kinds of additional pay, offered on Additional Pay next to incentive, overload, honorarium and bonus. HR still approves each item.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} noValidate className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="pt-name">Name</Label>
              <Input id="pt-name" maxLength={60} placeholder="e.g. Club adviser allowance" value={form.name} onChange={(e) => { setForm((c) => ({ ...c, name: e.target.value })); setError(""); }} />
            </div>
            <label className="flex h-10 items-center gap-2 text-sm" htmlFor="pt-taxable">
              <Switch id="pt-taxable" checked={form.taxable} onCheckedChange={(v) => setForm((c) => ({ ...c, taxable: v }))} />Taxable
            </label>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pt-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="pt-description" maxLength={300} value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
            <Button type="submit" className="sm:col-span-2 sm:justify-self-start" disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}Add pay type</Button>
          </form>
        </CardContent>
      </Card>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TagsIcon className="size-4 text-gold-text" aria-hidden="true" />Additional pay types</CardTitle>
          <CardDescription>A type already used is deactivated, never deleted: its items stay on their payslips.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={state.types} loading={state.loading && !state.types.length} error={state.error} onRetry={load}
            searchPlaceholder="Search pay types…" empty={{ title: "No pay types of your own yet", icon: TagsIcon }} caption="Additional pay types" minWidth={760} />
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  );
}
