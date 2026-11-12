"use client";

import * as React from "react";
import { CheckCircle2Icon, ClipboardPasteIcon, Loader2Icon, PlusIcon, ShieldCheckIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/portal/date-picker";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { cn } from "@/lib/utils";

/**
 * One "many at once" dialog for every bulk action (Register many cards,
 * Replace many cards, Offboard many, Move many): a row per employee, then
 * Check rows (the SERVER checks every row and writes nothing), then the action
 * runs ONLY the rows that passed, one by one through the same API as the
 * single action (same rules, one audit entry per row). Each row ends Ready /
 * Done or with the exact reason it failed. On a phone each row is a card and
 * the body scrolls between a fixed header and footer.
 *
 *   employees  [{ id, full_name, employee_code, branch_name, disabled?, hint? }]
 *   field      null | { key, label, kind: "digits" | "date", length?, placeholder?, min?, max? }
 *   info       (employee) => text for a read-only column (e.g. the current card), or null
 *   check(rows) -> Promise<[{ ok, error?, note? }]>   (same order as rows)
 *   run(row)    -> Promise                              (rejects with the reason)
 */
export const BULK_MAX_ROWS = 50;

let nextKey = 1;
const blank = () => ({ key: nextKey++, employee_id: "", value: "", result: null });

export function BulkRowsDialog({
  open, onOpenChange, title, description, employees, showBranch = true, field = null, info = null, infoLabel = "",
  pasteLabel, pastePlaceholder, check, run, actionLabel, extra = null, ready = true, notReadyText = "", onDone, testId = "bulk-rows",
}) {
  const [rows, setRows] = React.useState(() => [blank(), blank(), blank()]);
  const [paste, setPaste] = React.useState("");
  const [showPaste, setShowPaste] = React.useState(false);
  const [busy, setBusy] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [checked, setChecked] = React.useState(false);
  const bodyRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    setRows([blank(), blank(), blank()]);
    setPaste(""); setShowPaste(false); setMessage(""); setChecked(false); setBusy("");
  }, [open]);

  const byId = React.useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const options = React.useMemo(() => employees.map((e) => ({
    value: e.id,
    label: e.full_name,
    disabled: Boolean(e.disabled),
    description: [e.employee_code, showBranch ? e.branch_name : null, e.hint].filter(Boolean).join(" · "),
    keywords: `${e.employee_code || ""} ${e.branch_name || ""}`,
  })), [employees, showBranch]);

  const clean = (value) => (field?.kind === "digits" ? String(value || "").replace(/\D/g, "").slice(0, field.length || 64) : String(value || "").trim());
  const update = (key, patch) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch, result: null } : r)));
    setChecked(false);
  };
  const filled = rows.filter((r) => r.employee_id || r.value);
  // The same employee twice is marked on the row at once (the server refuses it too).
  const repeated = new Set(filled.map((r) => r.employee_id).filter((id, i, all) => id && all.indexOf(id) !== i));

  function addRow() {
    if (rows.length >= BULK_MAX_ROWS) { setMessage(`At most ${BULK_MAX_ROWS} rows at a time: run these first.`); return; }
    setRows((c) => [...c, blank()]);
    setChecked(false);
    setTimeout(() => bodyRef.current?.querySelector("[data-bulk-row]:last-of-type button[role=combobox], [data-bulk-row]:last-of-type button")?.focus(), 30);
  }

  // Enter in a row's value box (a reader types the number and Enter): the next row, or a new one.
  function onValueKeyDown(event, index) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const next = bodyRef.current?.querySelectorAll("[data-bulk-value]")?.[index + 1];
    if (next) next.focus(); else addRow();
  }

  function addPasted() {
    const byCode = new Map(employees.filter((e) => e.employee_code).map((e) => [String(e.employee_code).toLowerCase(), e]));
    const byName = new Map(employees.map((e) => [String(e.full_name || "").trim().toLowerCase(), e]));
    const added = paste.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [who = "", value = ""] = line.split(/[,;\t]/).map((p) => p.trim());
      const person = byCode.get(who.toLowerCase()) || byName.get(who.toLowerCase());
      const error = !person ? `No employee "${who}" you can act on (unknown ID, another branch, or not eligible).`
        : person.disabled ? `${person.full_name}: ${person.hint || "not eligible for this action"}.` : null;
      return { ...blank(), employee_id: person && !person.disabled ? person.id : "", value: field ? clean(value) : "", result: error ? { ok: false, error } : null, pasted: who };
    });
    if (!added.length) return;
    const kept = rows.filter((r) => r.employee_id || r.value);
    if (kept.length + added.length > BULK_MAX_ROWS) { setMessage(`At most ${BULK_MAX_ROWS} rows at a time: ${kept.length + added.length} would be too many.`); return; }
    setRows([...kept, ...added]);
    setPaste(""); setShowPaste(false); setChecked(false); setMessage("");
  }

  async function doCheck() {
    const todo = rows.filter((r) => r.employee_id || r.value);
    if (!todo.length) { setMessage("Add at least one row."); return; }
    if (todo.length > BULK_MAX_ROWS) { setMessage(`At most ${BULK_MAX_ROWS} rows at a time.`); return; }
    setBusy("check"); setMessage("");
    try {
      const results = await check(todo.map((r) => ({ employee_id: r.employee_id, value: r.value })));
      let i = 0;
      const next = rows.map((r) => ((r.employee_id || r.value) ? { ...r, result: results[i++] || { ok: false, error: "Not checked." } } : r));
      setRows(next);
      setChecked(true);
      const valid = results.filter((r) => r.ok).length;
      setMessage(`${valid} row${valid === 1 ? "" : "s"} ready${results.length - valid ? `, ${results.length - valid} with a problem to fix` : ""}.`);
    } catch (error) {
      setMessage(error.message || "Could not check the rows.");
    } finally {
      setBusy("");
    }
  }

  async function confirm() {
    if (!ready) return;
    setBusy("run");
    let done = 0;
    let failed = 0;
    const next = [];
    for (const r of rows) {
      if (!r.result?.ok || r.result.done) { if (r.employee_id || r.value) next.push(r); continue; }
      try {
        await run({ employee_id: r.employee_id, value: r.value, employee: byId.get(r.employee_id) });
        done += 1;
        next.push({ ...r, result: { ok: true, done: true, note: r.result.note } });
      } catch (error) {
        failed += 1;
        next.push({ ...r, result: { ok: false, error: error.message || "Not done." } });
      }
    }
    setRows(next.length ? next : [blank()]);
    setChecked(false);
    setBusy("");
    setMessage(`${done} done${failed ? `, ${failed} failed (reason on the row)` : ""}.`);
    onDone?.(done);
  }

  const readyCount = rows.filter((r) => r.result?.ok && !r.result.done).length;
  // Tailwind needs whole class names: the four layouts used.
  const cols = info && field ? "md:grid-cols-[2rem_minmax(0,1fr)_6.5rem_11rem_minmax(0,13rem)_2.5rem]"
    : field ? "md:grid-cols-[2rem_minmax(0,1fr)_11rem_minmax(0,13rem)_2.5rem]"
      : info ? "md:grid-cols-[2rem_minmax(0,1fr)_6.5rem_minmax(0,13rem)_2.5rem]"
        : "md:grid-cols-[2rem_minmax(0,1fr)_minmax(0,13rem)_2.5rem]";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-3xl lg:max-w-5xl" data-testid={testId}>
        <DialogHeader className="border-b p-4 pr-12 sm:p-6 sm:pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:px-6">
          <div className="space-y-2" role="table" aria-label={title}>
            <div role="row" className={cn("hidden gap-2 px-1 text-xs font-semibold text-muted-foreground md:grid", cols)}>
              <span role="columnheader">#</span><span role="columnheader">Employee</span>
              {info ? <span role="columnheader">{infoLabel}</span> : null}
              {field ? <span role="columnheader">{field.label}</span> : null}
              <span role="columnheader">Check</span><span role="columnheader" className="sr-only">Remove</span>
            </div>
            {rows.map((r, i) => {
              const person = byId.get(r.employee_id);
              const dup = repeated.has(r.employee_id);
              const bad = (r.result && !r.result.ok) || dup;
              return (
                <div key={r.key} role="row" data-bulk-row data-testid="bulk-row"
                  className={cn("grid gap-2 rounded-lg border p-3 md:items-center md:border-0 md:p-1", cols,
                    bad && "border-destructive/40 bg-destructive/5", r.result?.ok && !dup && "bg-success/5")}>
                  <span role="cell" className="text-xs font-medium text-muted-foreground tabular-nums" aria-label={`Row ${i + 1}`}>{i + 1}</span>
                  <div role="cell" className="min-w-0">
                    <Label htmlFor={`bulk-emp-${r.key}`} className="mb-1 text-xs md:sr-only">Employee</Label>
                    <SearchableSelect id={`bulk-emp-${r.key}`} label="Employee" value={r.employee_id} onValueChange={(v) => update(r.key, { employee_id: v })}
                      options={options} placeholder={r.pasted && !r.employee_id ? r.pasted : "Choose the employee"} searchPlaceholder="Search name, ID or branch…"
                      className="min-h-10" aria-invalid={bad || undefined} />
                  </div>
                  {info ? (
                    <div role="cell" className="text-sm tabular-nums">
                      <span className="mr-1 text-xs text-muted-foreground md:hidden">{infoLabel}:</span>{person ? info(person) || "—" : "—"}
                    </div>
                  ) : null}
                  {field ? (
                    <div role="cell">
                      <Label htmlFor={`bulk-val-${r.key}`} className="mb-1 text-xs md:sr-only">{field.label}</Label>
                      {field.kind === "date" ? (
                        <DatePicker id={`bulk-val-${r.key}`} value={r.value} min={field.min} max={field.max} onChange={(v) => update(r.key, { value: v || "" })} />
                      ) : (
                        <Input id={`bulk-val-${r.key}`} data-bulk-value inputMode="numeric" autoComplete="off" placeholder={field.placeholder} value={r.value}
                          onChange={(e) => update(r.key, { value: clean(e.target.value) })} onKeyDown={(e) => onValueKeyDown(e, i)}
                          className="h-10 tabular-nums" aria-invalid={bad || undefined} />
                      )}
                    </div>
                  ) : null}
                  <p role="cell" className={cn("text-xs", bad ? "text-destructive" : r.result?.ok ? "text-success" : "")} data-testid="bulk-result">
                    {dup && !r.result?.error ? <span className="inline-flex items-start gap-1"><XCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />This employee is on another row.</span>
                      : r.result ? (r.result.ok
                        ? <span className="inline-flex items-start gap-1"><CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>{r.result.done ? "Done" : "Ready"}{r.result.note ? <span className="block text-muted-foreground">{r.result.note}</span> : null}</span></span>
                        : <span className="inline-flex items-start gap-1"><XCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{r.result.error}</span>)
                        : <span className="text-muted-foreground">Not checked</span>}
                  </p>
                  <div role="cell" className="flex justify-end">
                    <Button type="button" variant="ghost" size="icon" className="size-10 md:size-9" aria-label={`Remove row ${i + 1}`} disabled={Boolean(busy)}
                      onClick={() => { setRows((c) => (c.length > 1 ? c.filter((x) => x.key !== r.key) : [blank()])); setChecked(false); }}>
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={addRow} disabled={Boolean(busy)}><PlusIcon aria-hidden="true" />Add row</Button>
            <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={() => setShowPaste((v) => !v)} aria-expanded={showPaste} disabled={Boolean(busy)}><ClipboardPasteIcon aria-hidden="true" />Paste several rows</Button>
          </div>
          {showPaste ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <Label htmlFor={`${testId}-paste`}>{pasteLabel}</Label>
              <Textarea id={`${testId}-paste`} rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={pastePlaceholder} className="font-mono text-sm" />
              <Button type="button" size="sm" onClick={addPasted} disabled={!paste.trim()}>Add these rows</Button>
            </div>
          ) : null}
          {extra}
        </div>

        <div className="space-y-2 border-t p-4 sm:px-6">
          {message ? <p role="status" aria-live="polite" className="text-sm">{message}</p> : null}
          {!ready && notReadyText && readyCount ? <p className="text-xs text-destructive">{notReadyText}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={() => onOpenChange(false)} disabled={Boolean(busy)}>Close</Button>
            <Button type="button" variant="outline" className="h-10 sm:h-9" onClick={doCheck} disabled={Boolean(busy) || !filled.length || repeated.size > 0}>
              {busy === "check" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <ShieldCheckIcon aria-hidden="true" />}Check rows
            </Button>
            <Button type="button" className="h-10 sm:h-9" onClick={confirm} disabled={Boolean(busy) || !checked || !readyCount || !ready}>
              {busy === "run" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}{actionLabel(readyCount)}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
