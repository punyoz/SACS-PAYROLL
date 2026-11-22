"use client";

import * as React from "react";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EMPTY_REMARK, RemarkField, remarkProblem } from "@/components/portal/remark-field";

/*
 * A bulk action (Part F, 2026-11-22): a summary of the rows first, one remark
 * for all of them when the decision takes one, then each row is sent on its
 * own (the server checks every one, and each decision is audited on its own,
 * Part H) and the result is listed row by row: done, or why not. Never a
 * silent partial failure.
 *
 *   rows        the selected rows
 *   label(row)  the row's name in the summary and results
 *   decision    approve | reject | … (with entityType: a RemarkField), or null
 *   run(row, remark) → resolves (done) or throws Error(reason)
 */
export function BulkActionDialog({ open, title, description, rows = [], label = (r) => r.id, decision = null, entityType = null, confirmLabel = "Confirm", destructive = false, onClose, onDone, run }) {
  const [remark, setRemark] = React.useState(EMPTY_REMARK);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState(null);
  React.useEffect(() => { if (open) { setRemark(EMPTY_REMARK); setError(""); setBusy(false); setResults(null); } }, [open]);
  if (!open) return null;

  async function go() {
    if (decision && entityType) {
      const problem = remarkProblem(remark, decision);
      if (problem) { setError(problem); return; }
    }
    setBusy(true);
    setError("");
    const out = [];
    // One at a time: each is its own decision (and transaction) on the server.
    for (const row of rows) {
      try {
        await run(row, decision ? { code: remark.code || null, extra: String(remark.extra || "").trim() } : null);
        out.push({ row, ok: true });
      } catch (e) {
        out.push({ row, ok: false, reason: e?.message || "Not saved." });
      }
      setResults([...out]);
    }
    setBusy(false);
    onDone?.(out);
  }

  const done = results?.filter((r) => r.ok).length || 0;
  const failed = results ? results.length - done : 0;
  const finished = results && results.length === rows.length && !busy;
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose?.(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="bulk-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description || `${rows.length} item${rows.length === 1 ? "" : "s"} selected.`}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2 text-sm" aria-label={results ? "Results" : "Selected"}>
          {rows.map((row, i) => {
            const result = results?.find((r) => r.row === row);
            return (
              <li key={i} className="flex items-start gap-2" data-testid="bulk-row">
                {result ? (result.ok
                  ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
                  : <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Not done" />) : <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />}
                <span className="min-w-0">
                  <span>{label(row)}</span>
                  {result && !result.ok ? <span className="block text-xs text-destructive">{result.reason}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
        {decision && entityType && !results ? (
          <RemarkField id="bulk-remark" decision={decision} entityType={entityType} label={`Remark for all ${rows.length}`}
            value={remark} onChange={(v) => { setRemark(v); setError(""); }} error={error} disabled={busy} />
        ) : null}
        {finished ? (
          <p role="status" className="text-sm" data-testid="bulk-summary">
            {done} done{failed ? `, ${failed} not done (see the reasons above)` : ""}.
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-2">
          {finished ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant={destructive ? "destructive" : "default"} onClick={go} disabled={busy || !rows.length}>
                {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{confirmLabel} ({rows.length})
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bulk decisions on a DataTable (Part F): the table's `selection` prop and the
 * dialog, for approve / reject (or any decisions). send(row, decision, remark)
 * throws Error(reason) when the server refuses the row.
 *   decisions: [{ decision, label, destructive? }]
 */
export function useBulkDecisions({ send, entityType, isSelectable, label, rowLabel = label, decisions, onDone, title = (d) => `${d.label} the selected` }) {
  const [selected, setSelected] = React.useState(() => new Set());
  const [bulk, setBulk] = React.useState(null); // { d, rows }
  const selection = {
    selected, onChange: setSelected, rowId: (r) => r.id, isSelectable, label,
    actions: (rows) => decisions.map((d) => (
      <Button key={d.decision} size="sm" variant={d.destructive ? "outline" : "default"} className={d.destructive ? "text-destructive" : undefined}
        onClick={() => setBulk({ d, rows })}>{d.label} selected</Button>
    )),
  };
  const dialog = (
    <BulkActionDialog
      open={Boolean(bulk)}
      title={bulk ? title(bulk.d) : ""}
      rows={bulk?.rows || []}
      label={rowLabel}
      decision={bulk?.d.decision}
      entityType={entityType}
      destructive={Boolean(bulk?.d.destructive)}
      confirmLabel={bulk?.d.label || "Confirm"}
      run={(row, remark) => send(row, bulk.d.decision, remark)}
      onDone={onDone}
      onClose={() => { setBulk(null); setSelected(new Set()); }}
    />
  );
  return { selection, dialog };
}
