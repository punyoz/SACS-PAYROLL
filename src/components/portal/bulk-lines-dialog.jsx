"use client";

import * as React from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/portal/status-badge";
import { downloadCsv } from "@/lib/portal/attendance";

/*
 * Many of one action at once (scale scenarios SC-11 / HR-03 / HR-10,
 * 2026-10-22): paste one line per item, check them, then run them one by
 * one through the same API the single action uses (so every rule and audit
 * entry is the same). Every line gets its own result, and a report.
 *
 *   parseLine(text) -> { label, payload } | { error }    (a line of the textarea)
 *   run(payload) -> Promise                               (rejects with the reason)
 */
export function BulkLinesDialog({
  open, onOpenChange, title, description, placeholder, inputLabel = "One per line",
  parseLine, run, runLabel = "Run", extra = null, ready = true, onDone, reportName = "sacs-bulk-report.csv",
}) {
  const [text, setText] = React.useState("");
  const [items, setItems] = React.useState(null);     // [{ line, label, payload?, error?, ok? }]
  const [phase, setPhase] = React.useState("idle");    // idle | checked | running | done
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => { if (!open) { setText(""); setItems(null); setPhase("idle"); setProgress(0); } }, [open]);

  function check() {
    const seen = new Set();
    const parsed = text.split(/\r?\n/).map((raw, index) => ({ raw: raw.trim(), line: index + 1 })).filter((l) => l.raw)
      .map(({ raw, line }) => {
        if (seen.has(raw.toLowerCase())) return { line, label: raw, error: "Repeated line." };
        seen.add(raw.toLowerCase());
        const result = parseLine(raw);
        return { line, label: result.label || raw, payload: result.payload, error: result.error || null };
      });
    setItems(parsed);
    setPhase("checked");
  }

  async function start() {
    const list = items.map((item) => ({ ...item }));
    const todo = list.filter((item) => !item.error);
    setPhase("running");
    for (let i = 0; i < todo.length; i += 1) {
      try {
        await run(todo[i].payload);
        todo[i].ok = true;
      } catch (err) {
        todo[i].error = err.message || "Not done.";
      }
      setProgress(Math.round(((i + 1) / todo.length) * 100));
      setItems([...list.map((item) => todo.find((t) => t.line === item.line) || item)]);
    }
    setPhase("done");
    onDone?.(todo.filter((t) => t.ok).length);
  }

  const failed = (items || []).filter((item) => item.error);
  const passed = (items || []).length - failed.length;
  const done = (items || []).filter((item) => item.ok).length;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (phase !== "running") onOpenChange(next); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-lines">{inputLabel}</Label>
            <Textarea id="bulk-lines" rows={8} className="font-mono text-sm" placeholder={placeholder} value={text}
              onChange={(e) => { setText(e.target.value); setItems(null); setPhase("idle"); }} disabled={phase === "running"} />
          </div>
          {extra}
          {phase === "running" ? <div className="space-y-1"><Progress value={progress} aria-label="Progress" /><p className="text-xs text-muted-foreground">{progress}%</p></div> : null}
          {items ? (
            <div className="space-y-2">
              <p className="text-sm">
                <StatusBadge tone="success">{phase === "done" ? `${done} done` : `${passed} ready`}</StatusBadge>{" "}
                {failed.length ? <StatusBadge tone="danger">{failed.length} refused</StatusBadge> : null}
              </p>
              {failed.length ? (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
                  {failed.map((item) => <li key={item.line}><span className="font-medium">Line {item.line}</span> ({item.label}): {item.error}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {items ? (
            <Button variant="outline" onClick={() => downloadCsv(reportName, ["Line", "Item", "Result", "Reason"],
              items.map((item) => [item.line, item.label, item.ok ? "Done" : item.error ? "Refused" : "Not run", item.error || ""]))}>
              <DownloadIcon aria-hidden="true" />Report
            </Button>
          ) : null}
          {phase === "done" ? <Button onClick={() => onOpenChange(false)}>Done</Button>
            : phase === "checked" && passed ? <Button onClick={start} disabled={!ready}>{runLabel} ({passed})</Button>
              : <Button onClick={check} disabled={!text.trim() || phase === "running"}>{phase === "running" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Check</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
