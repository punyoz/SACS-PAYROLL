"use client";

import * as React from "react";
import { Loader2Icon, MegaphoneIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, dateTime } from "@/lib/portal/payroll-preview";
import { ANNOUNCEMENT_CATEGORIES } from "@/lib/branch-requests";
import { ANNOUNCEMENT_MESSAGE_MAX, ANNOUNCEMENT_TITLE_MAX } from "@/lib/input-limits";
import { manilaDateKey } from "@/lib/payroll/periods";
import { cn } from "@/lib/utils";

/*
 * Announcements (/api/announcements, 20261030010000).
 *   AnnouncementsManager  HR (whole school or any branch), the branch Admin
 *                         (its own branch, its own posts) and the Super Admin
 *                         (moderation: delete only). The database checks
 *                         every write; the buttons only offer what it allows.
 *   AnnouncementsFeed     everyone's read-only list: school-wide plus own branch, current only
 *   AnnouncementsCard     the same, latest five, on the dashboard
 */

const CATEGORY_TONE = { holiday: "gold", meeting: "info", schedule_change: "warning", general: "muted" };
const STATUS = { active: ["Active", "success"], expired: ["Expired", "muted"], deleted: ["Deleted", "danger"] };
const EMPTY_FORM = { title: "", body: "", category: "general", audience: "", expires_on: "" };

function useAnnouncements(manage, refreshKey) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/announcements${manage ? "?manage=1" : ""}`);
      if (data.available === false) throw new Error(data.error);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load announcements.", data: c.data }));
    }
  }, [manage]);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  return { ...state, load };
}

function AudienceBadge({ item }) {
  return <StatusBadge tone={item.audience === "all" ? "gold" : "info"} dot={false}>{item.audience_label}</StatusBadge>;
}

export function AnnouncementsManager({ refreshKey, description }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const { loading, error: loadError, data, load } = useAnnouncements(true, refreshKey);
  const [editing, setEditing] = React.useState(null); // {} new, or the announcement
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const audiences = data?.audiences || null;
  const fixed = data?.fixed_audience || null;

  function open(item) {
    setEditing(item || {});
    setForm(item
      ? { title: item.title, body: item.body, category: item.category, audience: item.branch_id || "all", expires_on: item.expires_on || "" }
      : { ...EMPTY_FORM, audience: fixed ? fixed.value : "" });
    setError("");
  }

  async function save() {
    if (!form.title.trim() || !form.body.trim()) { setError("Write a title and the message."); return; }
    if (audiences && !form.audience) { setError("Choose who the announcement is for."); return; }
    setBusy(true); setError("");
    try {
      const payload = { title: form.title, body: form.body, category: form.category, expires_on: form.expires_on || null, ...(audiences ? { audience: form.audience } : {}) };
      if (editing?.id) {
        await fetchJson("/api/announcements", jsonBody("PATCH", { id: editing.id, action: "edit", ...payload }));
        notify("Announcement Updated", "", "success");
      } else {
        const result = await fetchJson("/api/announcements", jsonBody("POST", payload));
        notify("Announcement Posted", `${result.notified || 0} people notified.`, "success");
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
    const ok = await confirm({
      title: `Delete "${item.title}"?`,
      description: `${item.audience_label}: nobody will see it any more. A copy stays on record for the audit trail.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchJson("/api/announcements", jsonBody("DELETE", { id: item.id }));
      notify("Announcement Deleted", "", "info");
      await load();
    } catch (err) {
      notify("Error", err.message, "error");
    }
  }

  const rows = data?.announcements || [];
  const today = manilaDateKey();
  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle>
          <CardDescription>
            {description || (audiences ? "Post to the whole school or to one branch. Employees see current ones on their dashboard and get a notification."
              : fixed ? `Post to ${fixed.label}'s employees. You can change or delete your own; school-wide ones from HR are listed read only.`
                : "Every announcement in the school. You can delete any of them (moderation).")}
          </CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            {data?.can_post ? <Button size="sm" onClick={() => open(null)}><PlusIcon aria-hidden="true" />Post announcement</Button> : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataTable columns={[
            { key: "title", header: "Announcement", sortable: true, cell: (a) => <div className="max-w-96 whitespace-normal"><p className="font-medium">{a.title}</p><p className="text-xs text-muted-foreground whitespace-pre-wrap">{a.body}</p></div>, searchValue: (a) => `${a.title} ${a.body} ${a.audience_label}` },
            { key: "audience_label", header: "For", sortable: true, cell: (a) => <AudienceBadge item={a} /> },
            { key: "category", header: "Type", cell: (a) => <StatusBadge tone={CATEGORY_TONE[a.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[a.category] || a.category}</StatusBadge> },
            { key: "created_at", header: "Posted", sortable: true, cell: (a) => <div className="text-xs"><p>{a.created_by_name}</p><p className="text-muted-foreground">{dateTime(a.created_at)}</p>{a.updated_at && a.updated_at !== a.created_at && a.status !== "deleted" ? <p className="text-muted-foreground">Edited {dateTime(a.updated_at)}</p> : null}</div>, searchValue: (a) => a.created_by_name },
            { key: "status", header: "Status", sortable: true, cell: (a) => { const [label, tone] = STATUS[a.status] || [a.status, "muted"]; return <div className="text-xs"><StatusBadge tone={tone}>{label}</StatusBadge>{a.expires_on ? <p className="mt-1 text-muted-foreground">{a.status === "expired" ? "Ended" : "Until"} {dateLabel(a.expires_on)}</p> : null}</div>; } },
            { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (a) => (a.can_edit || a.can_delete ? (
              <div className="flex justify-end gap-1.5">
                {a.can_edit ? <Button size="sm" variant="outline" onClick={() => open(a)}><PencilIcon aria-hidden="true" />Edit</Button> : null}
                {a.can_delete ? <Button size="sm" variant="outline" className="text-destructive" onClick={() => remove(a)}><Trash2Icon aria-hidden="true" />Delete</Button> : null}
              </div>
            ) : null) },
          ]} rows={rows} loading={loading && !data} error={loadError} onRetry={load} pageSize={10}
            searchPlaceholder="Search announcements…" empty={{ title: "No announcements yet", icon: MegaphoneIcon }} caption="Announcements" minWidth={960} />
        </CardContent>
      </Card>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o && !busy) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit announcement" : "Post an announcement"}</DialogTitle>
            <DialogDescription>{fixed ? `Only ${fixed.label}'s employees see it.` : "Choose who sees it."}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="an-title">Title</Label>
              <Input id="an-title" maxLength={ANNOUNCEMENT_TITLE_MAX} value={form.title} onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))} />
              <p className="text-right text-xs text-muted-foreground">{form.title.length}/{ANNOUNCEMENT_TITLE_MAX}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="an-audience">For</Label>
                {audiences ? (
                  <Select value={form.audience} onValueChange={(v) => setForm((c) => ({ ...c, audience: v }))}>
                    <SelectTrigger id="an-audience" className="w-full"><SelectValue placeholder="Whole school or a branch" /></SelectTrigger>
                    <SelectContent>{audiences.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                  </Select>
                ) : (
                  <Input id="an-audience" value={editing?.audience_label || fixed?.label || ""} readOnly tabIndex={-1} className="bg-muted text-muted-foreground" />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="an-cat">Type</Label>
                <Select value={form.category} onValueChange={(v) => setForm((c) => ({ ...c, category: v }))}>
                  <SelectTrigger id="an-cat" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(ANNOUNCEMENT_CATEGORIES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="an-body">Message</Label>
              <Textarea id="an-body" rows={5} maxLength={ANNOUNCEMENT_MESSAGE_MAX} value={form.body} onChange={(e) => setForm((c) => ({ ...c, body: e.target.value }))} />
              <p className="text-right text-xs text-muted-foreground">{form.body.length}/{ANNOUNCEMENT_MESSAGE_MAX}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="an-expires">Show until <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <div className="flex gap-2">
                <DatePicker id="an-expires" value={form.expires_on} min={today} onChange={(v) => setForm((c) => ({ ...c, expires_on: v || "" }))} placeholder="No end date" className="flex-1" />
                {form.expires_on ? <Button type="button" variant="ghost" size="sm" onClick={() => setForm((c) => ({ ...c, expires_on: "" }))}>Clear</Button> : null}
              </div>
            </div>
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

function AnnouncementItem({ item }) {
  return (
    <li className="rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{item.title}</p>
        <StatusBadge tone={CATEGORY_TONE[item.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[item.category] || item.category}</StatusBadge>
        <AudienceBadge item={item} />
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{item.body}</p>
      <p className="mt-1 text-xs text-muted-foreground">{item.created_by_name} · {dateTime(item.created_at)}{item.expires_on ? ` · until ${dateLabel(item.expires_on)}` : ""}</p>
    </li>
  );
}

/** Everyone's full list: what is current for them (read only). */
export function AnnouncementsFeed({ refreshKey }) {
  const { loading, error, data, load } = useAnnouncements(false, refreshKey);
  const rows = data?.announcements || [];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle>
        <CardDescription>For the whole school and for your branch.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        {error && !rows.length ? <ErrorState message={error} onRetry={load} />
          : loading && !data ? <p className="text-sm text-muted-foreground">Loading…</p>
            : rows.length ? <ul className="space-y-3">{rows.map((a) => <AnnouncementItem key={a.id} item={a} />)}</ul>
              : <EmptyState title="No announcements right now" icon={MegaphoneIcon} />}
      </CardContent>
    </Card>
  );
}

/** The dashboard card: the latest five current ones (hidden when there are none). */
export function AnnouncementsCard({ refreshKey }) {
  const { loading, data } = useAnnouncements(false, refreshKey);
  const items = (data?.announcements || []).slice(0, 5);
  if (loading || !items.length) return null;
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader><CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle><CardDescription>For the whole school and for your branch</CardDescription></CardHeader>
      <CardContent>
        <ul className="space-y-3">{items.map((a) => <AnnouncementItem key={a.id} item={a} />)}</ul>
      </CardContent>
    </Card>
  );
}
