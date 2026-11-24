"use client";

import * as React from "react";
import { MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";

/*
 * The HR <-> branch Admin message thread on one item (2026-11-24): "Can you
 * confirm ...?" and the answer. Information only, never a decision; every
 * message is kept and logged (/api/branch-messages).
 */

const ROLE = { hr: "HR", admin: "Branch Admin", super_admin: "Super Admin" };
const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Message counts for a list's rows: { [id]: n }. */
export function useThreadCounts(itemType, ids, refreshKey = 0) {
  const [counts, setCounts] = React.useState({});
  const key = ids.filter(Boolean).slice(0, 500).join(",");
  React.useEffect(() => {
    if (!key) { setCounts({}); return undefined; }
    let alive = true;
    fetchJson(`/api/branch-messages?item_type=${itemType}&ids=${key}`).then((d) => { if (alive) setCounts(d.counts || {}); }).catch(() => {});
    return () => { alive = false; };
  }, [itemType, key, refreshKey]);
  return counts;
}

export function ItemThread({ itemType, itemId, title = "Messages", count = 0, onSent }) {
  const { notify } = usePortalSession();
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const id = `thread-${itemType}-${itemId}`;

  const load = React.useCallback(async () => {
    try { setMessages((await fetchJson(`/api/branch-messages?item_type=${itemType}&item_id=${itemId}`)).messages || []); }
    catch (e) { setMessages([]); notify("Messages not loaded", e.message, "error"); }
  }, [itemType, itemId, notify]);
  React.useEffect(() => { if (open) load(); }, [open, load]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      await fetchJson("/api/branch-messages", jsonBody("POST", { item_type: itemType, item_id: itemId, body }));
      setText("");
      await load();
      onSent?.();
    } catch (e) { notify("Not sent", e.message, "error"); } finally { setBusy(false); }
  }

  const n = messages ? messages.length : count;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="item-thread" aria-label={`${title}${n ? ` (${n})` : ""}`}>
        <MessageSquareIcon aria-hidden="true" />{n ? n : null}
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Between HR and the branch Admin. Information only: it never decides the item. Every message is kept.</DialogDescription>
          </DialogHeader>
          <ol className="max-h-72 space-y-2 overflow-y-auto" aria-label="Messages" data-testid="thread-messages">
            {messages === null ? <li className="text-sm text-muted-foreground">Loading…</li> : null}
            {messages && !messages.length ? <li className="text-sm text-muted-foreground">No messages yet.</li> : null}
            {(messages || []).map((m) => (
              <li key={m.id} className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">{m.author_name} · {ROLE[m.author_role] || m.author_role} · {when(m.created_at)}</p>
                <p className="text-sm whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
          <div className="space-y-1.5">
            <Label htmlFor={id}>Message</Label>
            <Textarea id={id} rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Can you confirm she was at the branch that morning?" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Close</Button>
            <Button onClick={send} disabled={busy || !text.trim()}>Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
