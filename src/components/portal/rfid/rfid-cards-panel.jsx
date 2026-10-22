"use client";

import * as React from "react";
import { CreditCardIcon, HistoryIcon, ListPlusIcon, Loader2Icon, PlusIcon, RefreshCwIcon, ScanLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BulkLinesDialog } from "@/components/portal/bulk-lines-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { useUrlParam } from "@/components/portal/use-url-param";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { CARD_STATUS_LABELS, CARD_STATUS_TONES } from "@/lib/rfid/cards";
import { cn } from "@/lib/utils";

/*
 * RFID Cards (/api/rfid/cards, 20261021030000): the same cards for HR, the
 * Super Admin (every branch) and each branch's Admin (its own branch). A card
 * is Active, Inactive, Lost or Replaced; only an Active card records
 * attendance. Every action is kept in the card history.
 *
 * A reader types the card's number and Enter, so the UID field takes a tap
 * directly; typing the number is the fallback when no reader is connected.
 */

const STATUS_TABS = ["all", "active", "inactive", "lost", "replaced"];
const ALL = "all";

export function RfidCardsPanel({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [statusParam, setStatus] = useUrlParam("rf_status", ALL);
  const [branchParam, setBranch] = useUrlParam("rf_branch", ALL);
  const status = STATUS_TABS.includes(statusParam) ? statusParam : ALL;
  const [dialog, setDialog] = React.useState(null);   // { kind: register | replace | deactivate | mark_lost | reactivate | history, card? }
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const uidRef = React.useRef(null);
  // Many cards at once: new cards for a batch of hires, or a mass replacement
  // (scenarios SC-11 / HR-10, 2026-10-22).
  const [bulk, setBulk] = React.useState(false);
  const [bulkInput, setBulkInput] = React.useState({ mode: "register", reason: "", lost: false });

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/rfid/cards");
      if (data.available === false) throw new Error(data.error || "RFID cards are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load RFID cards.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const first = state.loading && !data;
  const branches = data?.branches || [];
  const branch = branchParam === ALL || branches.some((b) => b.id === branchParam) ? branchParam : ALL;
  const cards = (data?.cards || []).filter((c) => (status === ALL || c.status === status) && (branch === ALL || c.branch_id === branch));
  const count = (s) => (data?.cards || []).filter((c) => c.status === s && (branch === ALL || c.branch_id === branch)).length;
  const events = (data?.events || []).filter((e) => !dialog?.card || e.card_id === dialog.card.id);

  function open(kind, card = null) {
    setDialog({ kind, card });
    setInput({ employee: "", uid: "", reason: "", lost: kind === "replace" });
    setError("");
    if (["register", "replace"].includes(kind)) setTimeout(() => uidRef.current?.focus(), 80);
  }

  async function submit(event) {
    event?.preventDefault();
    const { kind, card } = dialog;
    const uid = String(input.uid || "").replace(/\D/g, "");
    setError("");
    if (kind === "register" && !input.employee) { setError("Choose the employee."); return; }
    if (["register", "replace"].includes(kind) && !/^\d{1,16}$/.test(uid)) { setError("Tap the card on the reader, or type its number (digits only, up to 16)."); return; }
    if (kind !== "register" && String(input.reason || "").trim().length < 5) { setError("Give the reason (at least 5 characters)."); return; }
    setBusy(true);
    try {
      if (kind === "register") {
        await fetchJson("/api/rfid/cards", jsonBody("POST", { action: "register", employee_id: input.employee, uid, reason: input.reason.trim() }));
      } else if (kind === "replace") {
        await fetchJson("/api/rfid/cards", jsonBody("PATCH", { action: "replace", card_id: card.id, new_uid: uid, reason: input.reason.trim(), lost: input.lost }));
      } else {
        await fetchJson("/api/rfid/cards", jsonBody("PATCH", { action: kind, card_id: card.id, reason: input.reason.trim() }));
      }
      const words = {
        register: ["Card Registered", "It records attendance from the next tap."],
        replace: ["Card Replaced", "The old card no longer records attendance."],
        deactivate: ["Card Deactivated", "It no longer records attendance."],
        mark_lost: ["Card Marked Lost", "It can never be used again."],
        reactivate: ["Card Reactivated", "It records attendance again."],
      };
      notify(words[kind][0], words[kind][1], "success");
      setDialog(null);
      await load();
    } catch (err) {
      setError(err.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, cell: (c) => <div><p className="font-medium">{c.employee_name}</p>{c.employee_code ? <p className="text-xs text-muted-foreground">{c.employee_code}</p> : null}</div>, searchValue: (c) => `${c.employee_name} ${c.employee_code || ""} ${c.uid_last4}` },
    { key: "branch_name", header: "Branch", sortable: true },
    { key: "uid_masked", header: "Card UID", className: "font-mono text-xs", cell: (c) => c.uid_masked },
    {
      key: "status", header: "Status", sortValue: (c) => c.status_label, cell: (c) => (
        <div className="max-w-56 space-y-1 whitespace-normal">
          <StatusBadge tone={CARD_STATUS_TONES[c.status] || "muted"}>{c.status_label}</StatusBadge>
          {c.status !== "active" && c.status_reason ? <p className="text-xs text-muted-foreground">{c.status_reason}</p> : null}
        </div>
      ),
    },
    { key: "registered", header: "Registered by", sortValue: (c) => c.registered_at, cell: (c) => <div className="text-xs whitespace-nowrap">{c.registered_by_name} · {c.registered_by_role}<span className="block text-muted-foreground">{dateTime(c.registered_at)}</span></div>, searchValue: (c) => c.registered_by_name },
    { key: "changed", header: "Last change", cell: (c) => (c.status_changed_at ? <div className="text-xs whitespace-nowrap">{c.status_changed_by_name} · {c.status_changed_by_role}<span className="block text-muted-foreground">{dateTime(c.status_changed_at)}</span></div> : <span className="text-xs text-muted-foreground">—</span>) },
    {
      key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (c) => (
        <div className="flex justify-end gap-1.5">
          {c.status === "active" ? (
            <>
              <Button size="sm" variant="outline" onClick={() => open("replace", c)}>Replace</Button>
              <Button size="sm" variant="outline" onClick={() => open("deactivate", c)}>Deactivate</Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => open("mark_lost", c)}>Lost</Button>
            </>
          ) : null}
          {c.status === "inactive" && !c.employee_archived ? <Button size="sm" variant="outline" onClick={() => open("reactivate", c)}>Reactivate</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => open("history", c)} aria-label={`History of ${c.employee_name}'s card`}><HistoryIcon aria-hidden="true" /></Button>
        </div>
      ),
    },
  ];

  const historyColumns = [
    { key: "created_at", header: "When", sortable: true, className: "whitespace-nowrap text-xs", cell: (e) => dateTime(e.created_at) },
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (e) => e.employee_name },
    { key: "uid_masked", header: "Card", className: "font-mono text-xs" },
    { key: "action_label", header: "Action", cell: (e) => <StatusBadge tone={e.action === "registered" || e.action === "reactivated" ? "success" : e.action === "marked_lost" ? "danger" : e.action === "replaced" ? "gold" : "muted"} dot={false}>{e.action_label}</StatusBadge>, searchValue: (e) => e.action_label },
    { key: "change", header: "Status", className: "text-xs whitespace-nowrap", cell: (e) => (e.from_status ? `${e.from_status} → ${e.to_status}` : e.to_status) },
    { key: "actor", header: "By", className: "text-xs whitespace-nowrap", cell: (e) => `${e.actor_name} · ${e.actor_role}`, searchValue: (e) => e.actor_name },
    { key: "reason", header: "Why", cell: (e) => <p className="max-w-64 text-xs whitespace-normal text-muted-foreground">{e.reason || "—"}</p> },
  ];

  const titles = {
    register: ["Register an RFID card", "Choose the employee, then tap the card on the reader (or type its number)."],
    replace: ["Replace this card", "The old card stops recording attendance at once. Tap the new card on the reader."],
    deactivate: ["Deactivate this card", "For a resigned or transferred employee. It no longer records attendance; it can be reactivated later."],
    mark_lost: ["Mark this card lost", "It never records attendance again and its number can never be reused. Register or replace a card for the employee."],
    reactivate: ["Reactivate this card", "It records attendance again. The employee must have no other active card."],
    history: ["Card history", "Every action on this card: who, their role, when and why. Kept for good."],
  };
  const employees = data?.employees || [];
  const chosen = employees.find((e) => e.id === input.employee);

  return (
    <>
      <section aria-label="Cards" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active" value={count("active")} icon={CreditCardIcon} tone="success" loading={first} />
        <StatCard label="Inactive" value={count("inactive")} icon={CreditCardIcon} loading={first} />
        <StatCard label="Lost" value={count("lost")} icon={CreditCardIcon} tone="danger" loading={first} />
        <StatCard label="Replaced" value={count("replaced")} icon={CreditCardIcon} tone="gold" loading={first} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CreditCardIcon className="size-4 text-gold-text" aria-hidden="true" />RFID cards</CardTitle>
          <CardDescription>Only an Active card records attendance. One active card per employee; a card number belongs to one employee.</CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            <Button variant="outline" size="sm" onClick={() => setBulk(true)} disabled={!employees.length}><ListPlusIcon aria-hidden="true" />Many cards</Button>
            <Button size="sm" onClick={() => open("register")} disabled={!employees.length}><PlusIcon aria-hidden="true" />Register card</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={status} onValueChange={setStatus} className="overflow-x-auto">
              <TabsList className="w-max">{STATUS_TABS.map((s) => <TabsTrigger key={s} value={s}>{s === ALL ? "All" : CARD_STATUS_LABELS[s]}</TabsTrigger>)}</TabsList>
            </Tabs>
            {branches.length > 1 ? (
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger size="sm" className="w-44" aria-label="Branch"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All branches</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <DataTable columns={columns} rows={cards} loading={first} error={state.error} onRetry={load} pageSize={15}
            searchPlaceholder="Search employee, ID or last 4 digits…" caption="RFID cards" minWidth={1040}
            empty={{ title: status === ALL ? "No cards registered yet" : `No ${CARD_STATUS_LABELS[status].toLowerCase()} cards`, icon: CreditCardIcon }} />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><HistoryIcon className="size-4" aria-hidden="true" />Card history</CardTitle>
          <CardDescription>Every registration, replacement, deactivation and reactivation: who did it, their role, when and why. Never removed.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={historyColumns} rows={(data?.events || []).filter((e) => branch === ALL || (data?.cards || []).some((c) => c.id === e.card_id && c.branch_id === branch))}
            loading={first} error={state.error} onRetry={load} pageSize={10} searchPlaceholder="Search employee or person…"
            caption="RFID card history" minWidth={900} empty={{ title: "No card actions yet", icon: HistoryIcon }} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className={cn(dialog?.kind === "history" ? "sm:max-w-3xl" : "sm:max-w-md")}>
          {dialog ? (
            <form onSubmit={submit} className="contents">
              <DialogHeader>
                <DialogTitle>{titles[dialog.kind][0]}{dialog.card ? ` — ${dialog.card.employee_name}` : ""}</DialogTitle>
                <DialogDescription>{titles[dialog.kind][1]}</DialogDescription>
              </DialogHeader>
              {dialog.kind === "history" ? (
                <DataTable columns={historyColumns.filter((c) => c.key !== "employee_name")} rows={events} pageSize={8} searchable={false}
                  caption="This card's history" minWidth={640} empty={{ title: "No actions", icon: HistoryIcon }} />
              ) : (
                <div className="grid gap-3">
                  {dialog.card ? <p className="text-sm">Card {dialog.card.uid_masked} · {dialog.card.branch_name} · <StatusBadge tone={CARD_STATUS_TONES[dialog.card.status]}>{dialog.card.status_label}</StatusBadge></p> : null}
                  {dialog.kind === "register" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="rf-emp">Employee</Label>
                      <Select value={input.employee} onValueChange={(v) => { setInput((c) => ({ ...c, employee: v })); setTimeout(() => uidRef.current?.focus(), 50); }}>
                        <SelectTrigger id="rf-emp" className="w-full"><SelectValue placeholder="Choose the employee" /></SelectTrigger>
                        <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id} disabled={e.has_active_card}>{`${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ""} — ${e.branch_name}${e.has_active_card ? " · has a card" : ""}`}</SelectItem>)}</SelectContent>
                      </Select>
                      {chosen?.has_active_card ? <p className="text-xs text-destructive">Already has an active card: use Replace on it.</p> : null}
                    </div>
                  ) : null}
                  {["register", "replace"].includes(dialog.kind) ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="rf-uid" className="flex items-center gap-1.5"><ScanLineIcon className="size-4 text-gold-text" aria-hidden="true" />{dialog.kind === "replace" ? "New card UID" : "Card UID"}</Label>
                      <Input id="rf-uid" ref={uidRef} inputMode="numeric" autoComplete="off" maxLength={16} className="h-11 font-mono text-base"
                        placeholder="Tap the card now, or type its number" value={input.uid}
                        onChange={(e) => { setInput((c) => ({ ...c, uid: e.target.value.replace(/\D/g, "") })); setError(""); }} />
                      <p className="text-xs text-muted-foreground">The reader types the number and Enter. No reader? Type the number printed on the card.</p>
                    </div>
                  ) : null}
                  {dialog.kind === "replace" ? (
                    <label className="flex items-start gap-2 text-sm"><Checkbox checked={input.lost} onCheckedChange={(v) => setInput((c) => ({ ...c, lost: v === true }))} className="mt-0.5" /><span>The old card was lost (not just damaged): mark it Lost.</span></label>
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="rf-reason">{dialog.kind === "register" ? "Note (optional)" : "Reason"}</Label>
                    <Input id="rf-reason" maxLength={300} value={input.reason} placeholder={dialog.kind === "register" ? "e.g. New hire" : "Required, at least 5 characters"}
                      onChange={(e) => { setInput((c) => ({ ...c, reason: e.target.value })); setError(""); }} />
                  </div>
                  {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={busy}>{dialog.kind === "history" ? "Close" : "Cancel"}</Button>
                {dialog.kind !== "history" ? (
                  <Button type="submit" disabled={busy || (dialog.kind === "register" && chosen?.has_active_card)} variant={dialog.kind === "mark_lost" || dialog.kind === "deactivate" ? "destructive" : "default"}>
                    {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
                    {{ register: "Register card", replace: "Replace card", deactivate: "Deactivate", mark_lost: "Mark lost", reactivate: "Reactivate" }[dialog.kind]}
                  </Button>
                ) : null}
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <BulkLinesDialog
        open={bulk}
        onOpenChange={setBulk}
        title={bulkInput.mode === "replace" ? "Replace many cards" : "Register many cards"}
        description={bulkInput.mode === "replace"
          ? "One line per employee: their employee ID and the NEW card number. The old card stops recording attendance at once."
          : "One line per employee: their employee ID and the card number (a reader types it). Each employee may have one active card."}
        placeholder={"SACS-0101, 1234567890\nSACS-0102, 1234567891"}
        inputLabel="Employee ID, card number"
        reportName={`sacs-rfid-${bulkInput.mode}-report.csv`}
        runLabel={bulkInput.mode === "replace" ? "Replace" : "Register"}
        ready={bulkInput.reason.trim().length >= (bulkInput.mode === "replace" ? 5 : 0)}
        parseLine={(text) => {
          const [code, number] = text.split(/[,;\t]/).map((part) => part.trim());
          const person = employees.find((e) => String(e.employee_code || "").toLowerCase() === String(code || "").toLowerCase());
          if (!person) return { label: text, error: `No employee with ID ${code || "(blank)"} in reach.` };
          const uid = String(number || "").replace(/\D/g, "");
          if (!uid || uid.length > 16) return { label: person.full_name, error: "The card number must be 1-16 digits." };
          if (bulkInput.mode === "register") {
            if (person.has_active_card) return { label: person.full_name, error: "Already has an active card (use Replace)." };
            return { label: `${person.full_name} → ${uid}`, payload: { employee: person, uid } };
          }
          const card = (data?.cards || []).find((c) => c.employee_id === person.id && c.status === "active");
          if (!card) return { label: person.full_name, error: "Has no active card to replace (use Register)." };
          return { label: `${person.full_name} → ${uid}`, payload: { card, uid } };
        }}
        run={(item) => (bulkInput.mode === "replace"
          ? fetchJson("/api/rfid/cards", jsonBody("PATCH", { action: "replace", card_id: item.card.id, new_uid: item.uid, reason: bulkInput.reason.trim(), lost: bulkInput.lost }))
          : fetchJson("/api/rfid/cards", jsonBody("POST", { action: "register", employee_id: item.employee.id, uid: item.uid, reason: bulkInput.reason.trim() || "Bulk registration" })))}
        onDone={(n) => { if (n) { notify("Cards Saved", `${n} card${n === 1 ? "" : "s"} ${bulkInput.mode === "replace" ? "replaced" : "registered"}.`, "success"); load(); } }}
        extra={(
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rf-bulk-mode">Action</Label>
              <Select value={bulkInput.mode} onValueChange={(mode) => setBulkInput((c) => ({ ...c, mode }))}>
                <SelectTrigger id="rf-bulk-mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="register">Register new cards</SelectItem><SelectItem value="replace">Replace cards</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rf-bulk-reason">{bulkInput.mode === "replace" ? "Reason (required)" : "Reason (optional)"}</Label>
              <Input id="rf-bulk-reason" maxLength={300} placeholder={bulkInput.mode === "replace" ? "e.g. New card batch 2027" : "e.g. June 2027 hires"} value={bulkInput.reason} onChange={(e) => setBulkInput((c) => ({ ...c, reason: e.target.value }))} />
            </div>
            {bulkInput.mode === "replace" ? (
              <label className="flex items-start gap-2 text-sm sm:col-span-2"><Checkbox checked={bulkInput.lost} onCheckedChange={(v) => setBulkInput((c) => ({ ...c, lost: v === true }))} className="mt-0.5" /><span>The old cards were lost (their numbers can never be used again)</span></label>
            ) : null}
          </div>
        )}
      />
    </>
  );
}
