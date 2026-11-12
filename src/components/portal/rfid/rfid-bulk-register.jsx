"use client";

import * as React from "react";
import { CheckCircle2Icon, ClipboardPasteIcon, Loader2Icon, PlusIcon, ShieldCheckIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { RFID_UID_LENGTH } from "@/lib/input-limits";
import { cn } from "@/lib/utils";

/**
 * Register many RFID cards at once (alpha test A4).
 *
 *   1. Rows: an employee (searchable by name; ID and branch shown small) and
 *      the card number in its own field. Add row, or paste several lines
 *      ("Name or employee ID, card number").
 *   2. Check: the server checks every row (missing fields, 10 digits, the
 *      same card or employee twice, a card number already on file, an
 *      employee who already has an active card) and writes nothing.
 *   3. Confirm: registers ONLY the rows that passed. Rows that failed stay
 *      listed with their reason, to fix and check again.
 * On a phone each row is a stacked card.
 */

let nextKey = 1;
const blank = () => ({ key: nextKey++, employee_id: "", uid: "", result: null });
const digits = (value) => String(value || "").replace(/\D/g, "").slice(0, RFID_UID_LENGTH);

export function RfidBulkRegisterDialog({ open, onOpenChange, employees, onDone }) {
  const [rows, setRows] = React.useState(() => [blank(), blank(), blank()]);
  const [paste, setPaste] = React.useState("");
  const [showPaste, setShowPaste] = React.useState(false);
  const [busy, setBusy] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setRows([blank(), blank(), blank()]);
    setPaste(""); setShowPaste(false); setMessage(""); setChecked(false); setBusy("");
  }, [open]);

  const options = React.useMemo(() => employees.map((e) => ({
    value: e.id,
    label: e.full_name,
    description: [e.employee_code, e.branch_name, e.has_active_card ? "has an active card" : null].filter(Boolean).join(" · "),
    keywords: `${e.employee_code || ""} ${e.branch_name || ""}`,
  })), [employees]);

  const update = (key, patch) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch, result: null } : r)));
    setChecked(false);
  };

  function addPasted() {
    const byName = new Map(employees.map((e) => [String(e.full_name || "").trim().toLowerCase(), e]));
    const byCode = new Map(employees.filter((e) => e.employee_code).map((e) => [String(e.employee_code).toLowerCase(), e]));
    const added = paste.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/[,;\t]/).map((p) => p.trim());
      const who = parts[0] || "";
      const person = byCode.get(who.toLowerCase()) || byName.get(who.toLowerCase());
      return { ...blank(), employee_id: person?.id || "", uid: digits(parts[1]), result: person ? null : { ok: false, error: `No employee "${who}" in your reach.` } };
    });
    if (!added.length) return;
    setRows((current) => [...current.filter((r) => r.employee_id || r.uid), ...added]);
    setPaste(""); setShowPaste(false); setChecked(false);
  }

  const filled = rows.filter((r) => r.employee_id || r.uid);

  async function check() {
    if (!filled.length) { setMessage("Add at least one row."); return; }
    setBusy("check"); setMessage("");
    try {
      const data = await fetchJson("/api/rfid/cards", jsonBody("POST", { action: "check", rows: filled.map((r) => ({ employee_id: r.employee_id, uid: r.uid })) }));
      setRows((current) => {
        let i = 0;
        return current.map((r) => ((r.employee_id || r.uid) ? { ...r, result: data.results[i++] } : r));
      });
      setChecked(true);
      setMessage(`${data.valid} row${data.valid === 1 ? "" : "s"} ready to register${data.invalid ? `, ${data.invalid} with a problem to fix` : ""}.`);
    } catch (error) {
      setMessage(error.message || "Could not check the rows.");
    } finally {
      setBusy("");
    }
  }

  async function confirm() {
    const ready = rows.filter((r) => r.result?.ok);
    if (!ready.length) return;
    setBusy("confirm");
    let saved = 0;
    const next = [];
    for (const r of rows) {
      if (!r.result?.ok) { if (r.employee_id || r.uid) next.push(r); continue; }
      try {
        await fetchJson("/api/rfid/cards", jsonBody("POST", { action: "register", employee_id: r.employee_id, uid: r.uid, reason: "Bulk registration" }));
        saved += 1;
      } catch (error) {
        next.push({ ...r, result: { ok: false, error: error.message || "Not registered." } });
      }
    }
    setRows(next.length ? next : [blank()]);
    setChecked(false);
    setBusy("");
    setMessage(`${saved} card${saved === 1 ? "" : "s"} registered.${next.length ? ` ${next.length} row${next.length === 1 ? "" : "s"} left to fix.` : ""}`);
    onDone?.(saved);
  }

  const readyCount = rows.filter((r) => r.result?.ok).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" data-testid="rfid-bulk">
        <DialogHeader>
          <DialogTitle>Register many cards</DialogTitle>
          <DialogDescription>Choose each employee by name and type (or tap) their card number. Check first: only the rows that pass are registered.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2" role="table" aria-label="Cards to register">
          <div role="row" className="hidden grid-cols-[2rem_minmax(0,1fr)_11rem_minmax(0,14rem)_2.5rem] gap-2 px-1 text-xs font-semibold text-muted-foreground md:grid">
            <span role="columnheader">#</span><span role="columnheader">Employee</span><span role="columnheader">Card number</span><span role="columnheader">Check</span><span role="columnheader" className="sr-only">Remove</span>
          </div>
          {rows.map((r, i) => (
            <div key={r.key} role="row" data-testid="bulk-row"
              className={cn("grid gap-2 rounded-lg border p-2 md:grid-cols-[2rem_minmax(0,1fr)_11rem_minmax(0,14rem)_2.5rem] md:items-center md:border-0 md:p-1",
                r.result && !r.result.ok && "border-destructive/40 bg-destructive/5 md:bg-destructive/5", r.result?.ok && "md:bg-success/5")}>
              <span role="cell" className="text-xs font-medium text-muted-foreground tabular-nums" aria-label={`Row ${i + 1}`}>{i + 1}</span>
              <div role="cell" className="min-w-0">
                <Label htmlFor={`bulk-emp-${r.key}`} className="mb-1 text-xs md:sr-only">Employee</Label>
                <SearchableSelect id={`bulk-emp-${r.key}`} label="Employee" value={r.employee_id} onValueChange={(v) => update(r.key, { employee_id: v })}
                  options={options} placeholder="Choose the employee" searchPlaceholder="Search name, ID or branch…" />
              </div>
              <div role="cell">
                <Label htmlFor={`bulk-uid-${r.key}`} className="mb-1 text-xs md:sr-only">Card number</Label>
                <Input id={`bulk-uid-${r.key}`} inputMode="numeric" autoComplete="off" placeholder={`${RFID_UID_LENGTH} digits`} value={r.uid}
                  onChange={(e) => update(r.key, { uid: digits(e.target.value) })} className="tabular-nums" aria-invalid={r.result && !r.result.ok ? true : undefined} />
              </div>
              <p role="cell" className={cn("text-xs", r.result?.ok ? "text-success" : "text-destructive")} data-testid="bulk-result">
                {r.result ? (r.result.ok ? <span className="inline-flex items-center gap-1"><CheckCircle2Icon className="size-3.5" aria-hidden="true" />Ready</span>
                  : <span className="inline-flex items-start gap-1"><XCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{r.result.error}</span>) : <span className="text-muted-foreground">Not checked</span>}
              </p>
              <div role="cell" className="flex justify-end">
                <Button type="button" variant="ghost" size="icon" className="size-10 md:size-9" aria-label={`Remove row ${i + 1}`}
                  onClick={() => { setRows((c) => (c.length > 1 ? c.filter((x) => x.key !== r.key) : [blank()])); setChecked(false); }}>
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((c) => [...c, blank()])}><PlusIcon aria-hidden="true" />Add row</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowPaste((v) => !v)} aria-expanded={showPaste}><ClipboardPasteIcon aria-hidden="true" />Paste several rows</Button>
        </div>
        {showPaste ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <Label htmlFor="bulk-paste">One line per card: the employee&apos;s name or ID, then the card number</Label>
            <Textarea id="bulk-paste" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Maria Santos, 0012345678\nSACS-0102, 0012345679"} />
            <Button type="button" size="sm" onClick={addPasted} disabled={!paste.trim()}>Add these rows</Button>
          </div>
        ) : null}

        {message ? <p role="status" aria-live="polite" className="text-sm">{message}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={Boolean(busy)}>Close</Button>
          <Button type="button" variant="outline" onClick={check} disabled={Boolean(busy) || !filled.length}>
            {busy === "check" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <ShieldCheckIcon aria-hidden="true" />}Check rows
          </Button>
          <Button type="button" onClick={confirm} disabled={Boolean(busy) || !checked || !readyCount}>
            {busy === "confirm" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Register {readyCount || ""} card{readyCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
