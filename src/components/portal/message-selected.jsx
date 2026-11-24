"use client";

import * as React from "react";
import { Loader2Icon, MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";

const BODY_MAX = 1000; // the thread limit (src/app/api/branch-messages/route.js)
const MANY_MAX = 50;

/**
 * Branch Review (2026-11-26): the branch Admin selects several items (checkboxes, "select all") and sends
 * ONE message to HR about them; it goes into each item's HR <-> Admin thread (POST /api/branch-messages
 * { items, body }). Information only: no decision, no endorsement.
 *   const msg = useMessageSelected({ itemType: "leave_request", label: (r) => r.employee_name, onSent });
 *   <DataTable selection={msg.selection} … />  {msg.dialog}
 */
export function useMessageSelected({ itemType, label, onSent, itemTypeOf = null }) {
  const { notify } = usePortalSession();
  const [selected, setSelected] = React.useState(() => new Set());
  const [rows, setRows] = React.useState(null);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const selection = {
    selected, onChange: setSelected, rowId: (r) => r.id, label,
    actions: (chosen) => (
      <Button size="sm" onClick={() => { setRows(chosen); setText(""); setError(""); }} data-testid="message-selected">
        <MessageSquareIcon aria-hidden="true" />Message HR about selected
      </Button>
    ),
  };

  async function send() {
    const body = text.trim();
    if (!body) { setError("Write the message."); return; }
    if (rows.length > MANY_MAX) { setError(`Select at most ${MANY_MAX} items.`); return; }
    setBusy(true);
    setError("");
    try {
      const data = await fetchJson("/api/branch-messages", jsonBody("POST", { items: rows.map((r) => ({ item_type: itemTypeOf ? itemTypeOf(r) : itemType, item_id: r.id })), body }));
      notify("Message sent to HR", `On ${data.sent} item${data.sent === 1 ? "" : "s"}; it is in each item's messages.`, "success");
      setRows(null);
      setSelected(new Set());
      onSent?.();
    } catch (e) {
      setError(e.message || "Not sent.");
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={Boolean(rows)} onOpenChange={(open) => { if (!open && !busy) setRows(null); }}>
      <DialogContent className="sm:max-w-lg" data-testid="message-selected-dialog">
        <DialogHeader>
          <DialogTitle>Message HR about {rows?.length || 0} item{rows?.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>One message, added to each item&apos;s messages with HR. Information only: it does not decide or endorse anything.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 text-sm" aria-label="Selected items">
          {(rows || []).map((r) => <li key={r.id}>{label(r)}</li>)}
        </ul>
        <div className="space-y-1.5">
          <Label htmlFor="message-selected-text">Message</Label>
          <Textarea id="message-selected-text" rows={4} maxLength={BODY_MAX} value={text} onChange={(e) => { setText(e.target.value); setError(""); }} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setRows(null)} disabled={busy}>Cancel</Button>
          <Button onClick={send} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Send to HR</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { selection, dialog };
}
