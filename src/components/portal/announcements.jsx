"use client";

import * as React from "react";
import { ChevronRightIcon, Loader2Icon, MegaphoneIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
import { UserAvatar } from "@/components/portal/user-avatar";
import { openPortalPage } from "@/lib/portal/navigate";

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
  const [viewing, setViewing] = React.useState(null);
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
            { key: "title", header: "Announcement", sortable: true, cell: (a) => <button type="button" onClick={() => setViewing(a)} className="max-w-96 rounded text-left whitespace-normal hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"><p className="font-medium">{a.title}</p><p className="line-clamp-2 text-xs text-muted-foreground whitespace-pre-wrap">{a.body}</p></button>, searchValue: (a) => `${a.title} ${a.body} ${a.audience_label}` },
            { key: "audience_label", header: "For", sortable: true, cell: (a) => <AudienceBadge item={a} /> },
            { key: "category", header: "Type", cell: (a) => <StatusBadge tone={CATEGORY_TONE[a.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[a.category] || a.category}</StatusBadge> },
            { key: "created_at", header: "Posted", sortable: true, cell: (a) => <div className="text-xs"><p className="flex items-center gap-1.5"><UserAvatar userId={a.created_by} name={a.created_by_name} className="size-5" fallbackClassName="text-[8px]" ring={false} />{a.created_by_name}</p><p className="text-muted-foreground">{dateTime(a.created_at)}</p>{a.updated_at && a.updated_at !== a.created_at && a.status !== "deleted" ? <p className="text-muted-foreground">Edited {dateTime(a.updated_at)}</p> : null}</div>, searchValue: (a) => a.created_by_name },
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
      <AnnouncementDetails item={viewing} onClose={() => setViewing(null)} />
      {confirmDialog}
    </>
  );
}

const PAGE_FOR_ROLE = { employee: "emp-announcements", accountant: "ac-announcements", admin: "adm-announcements", hr: "hr-announcements", super_admin: "sa-announcements" };

/**
 * One announcement in full (alpha test A2): opened by clicking it in a list,
 * the dashboard card or the management table. Keyboard: Enter / Space open,
 * Escape closes and focus returns to the row.
 */
export function AnnouncementDetails({ item, onClose }) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="announcement-details">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 break-words">{item.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <StatusBadge tone={CATEGORY_TONE[item.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[item.category] || item.category}</StatusBadge>
                  <AudienceBadge item={item} />
                </div>
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm whitespace-pre-wrap break-words">{item.body}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-3 text-xs">
              <dt className="text-muted-foreground">Posted by</dt>
              <dd className="flex items-center gap-1.5"><UserAvatar userId={item.created_by} name={item.created_by_name} className="size-5" fallbackClassName="text-[8px]" ring={false} />{item.created_by_name}</dd>
              <dt className="text-muted-foreground">Posted</dt><dd>{dateTime(item.created_at)}</dd>
              {item.updated_at && item.updated_at !== item.created_at ? <><dt className="text-muted-foreground">Edited</dt><dd>{dateTime(item.updated_at)}</dd></> : null}
              <dt className="text-muted-foreground">For</dt><dd>{item.audience_label}</dd>
              {item.expires_on ? <><dt className="text-muted-foreground">Shown until</dt><dd>{dateLabel(item.expires_on)}</dd></> : null}
            </dl>
            <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AnnouncementItem({ item, onOpen }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(item)} data-testid="announcement-item"
        className="w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{item.title}</span>
          <StatusBadge tone={CATEGORY_TONE[item.category] || "muted"} dot={false}>{ANNOUNCEMENT_CATEGORIES[item.category] || item.category}</StatusBadge>
          <AudienceBadge item={item} />
        </span>
        <span className="mt-1 line-clamp-3 block text-sm whitespace-pre-wrap text-muted-foreground">{item.body}</span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserAvatar userId={item.created_by} name={item.created_by_name} className="size-5" fallbackClassName="text-[8px]" ring={false} />
          {item.created_by_name} · {dateTime(item.created_at)}{item.expires_on ? ` · until ${dateLabel(item.expires_on)}` : ""}
        </span>
      </button>
    </li>
  );
}

/** Everyone's full list: what is current for them (read only). */
export function AnnouncementsFeed({ refreshKey, description }) {
  const { loading, error, data, load } = useAnnouncements(false, refreshKey);
  const [open, setOpen] = React.useState(null);
  const rows = data?.announcements || [];
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle>
        {/* Readers (Accountant, Employee) never post: say who does (alpha test A9). */}
        <CardDescription>{description || "For the whole school and for your branch. Announcements are posted by HR, the branch Admin and the Super Admin. Select one to read it in full."}</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        {error && !rows.length ? <ErrorState message={error} onRetry={load} />
          : loading && !data ? <p className="text-sm text-muted-foreground">Loading…</p>
            : rows.length ? <ul className="space-y-3">{rows.map((a) => <AnnouncementItem key={a.id} item={a} onOpen={setOpen} />)}</ul>
              : <EmptyState title="No announcements right now" icon={MegaphoneIcon} />}
      </CardContent>
      <AnnouncementDetails item={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

/**
 * The dashboard card (alpha test B4): the latest five as compact rows
 * (title, date, audience / type), a fixed height that never grows, and
 * "View all". Hidden when there are none.
 */
export function AnnouncementsCard({ refreshKey }) {
  const { role } = usePortalSession();
  const { loading, data } = useAnnouncements(false, refreshKey);
  const [open, setOpen] = React.useState(null);
  const all = data?.announcements || [];
  const items = all.slice(0, 5);
  if (loading || !items.length) return null;
  const page = PAGE_FOR_ROLE[role];
  return (
    <Card className="min-w-0 shadow-xs" data-testid="announcements-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MegaphoneIcon className="size-4 text-gold-text" aria-hidden="true" />Announcements</CardTitle>
        <CardDescription>The latest {items.length} of {all.length}</CardDescription>
        {page ? <CardAction><Button variant="ghost" size="sm" onClick={() => openPortalPage(page)}>View all<ChevronRightIcon aria-hidden="true" /></Button></CardAction> : null}
      </CardHeader>
      <CardContent>
        <ul className="max-h-72 divide-y overflow-hidden" aria-label="Latest announcements">
          {items.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpen(a)} data-testid="announcement-row"
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{dateLabel(String(a.created_at).slice(0, 10))} · {a.audience_label} · {ANNOUNCEMENT_CATEGORIES[a.category] || a.category}</span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
      <AnnouncementDetails item={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
