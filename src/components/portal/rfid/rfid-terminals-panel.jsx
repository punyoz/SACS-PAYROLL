"use client";

import * as React from "react";
import { Loader2Icon, PlusIcon, RadioTowerIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, hardNavigate, jsonBody } from "@/lib/portal/api";
import { dateTime } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * RFID Terminals (/api/rfid/terminals, 20261021030000): the readers, named
 * per branch. A kiosk is opened on one of them (Open RFID Terminal); its taps
 * are recorded against it and its last tap shows here, so a reader that has
 * gone quiet is easy to spot. Switching a terminal off, or resetting its key,
 * locks every kiosk opened on it until someone unlocks it again.
 *
 * canAdd false (HR, 2026-10-26): no Add terminal. Each branch Admin adds its
 * own branch's terminals; HR views, renames, switches and resets them.
 */

const EVERY_BRANCH = "__all__";

export function RfidTerminalsPanel({ refreshKey, showOpen = true, canAdd = true }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [dialog, setDialog] = React.useState(null);   // { kind: add | rename | off | on | reset, terminal? }
  const [input, setInput] = React.useState({});
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/rfid/terminals");
      if (data.available === false) throw new Error(data.error || "RFID terminals are not set up yet.");
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState((c) => ({ loading: false, error: err.message || "Unable to load terminals.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  // Last-tap times move while the page is open.
  React.useEffect(() => { const timer = setInterval(load, 60000); return () => clearInterval(timer); }, [load]);

  const data = state.data;
  const first = state.loading && !data;
  const branches = data?.branches || [];

  function open(kind, terminal = null) {
    setDialog({ kind, terminal });
    setInput({ name: terminal?.name || "", branch: terminal ? terminal.branch_id || EVERY_BRANCH : branches[0]?.id || EVERY_BRANCH, reason: "" });
    setError("");
  }

  async function submit(event) {
    event?.preventDefault();
    const { kind, terminal } = dialog;
    setError("");
    if (["add", "rename"].includes(kind) && input.name.trim().length < 2) { setError("Name the terminal (e.g. Main Gate)."); return; }
    if (["off", "reset"].includes(kind) && input.reason.trim().length < 5) { setError("Give the reason (at least 5 characters)."); return; }
    setBusy(true);
    try {
      const branchId = input.branch === EVERY_BRANCH ? null : input.branch;
      if (kind === "add") await fetchJson("/api/rfid/terminals", jsonBody("POST", { name: input.name.trim(), branch_id: branchId }));
      else await fetchJson("/api/rfid/terminals", jsonBody("PATCH", {
        terminal_id: terminal.id,
        ...(kind === "rename" ? { name: input.name.trim(), branch_id: branchId } : {}),
        ...(kind === "off" ? { status: "inactive" } : kind === "on" ? { status: "active" } : {}),
        ...(kind === "reset" ? { reset_key: true } : {}),
        reason: input.reason.trim(),
      }));
      const words = {
        add: ["Terminal Added", "Open the RFID Terminal on that computer and choose it."],
        rename: ["Terminal Updated", ""],
        off: ["Terminal Switched Off", "Its kiosks stop recording until it is switched on and unlocked again."],
        on: ["Terminal Switched On", "Unlock the kiosk on it again to record taps."],
        reset: ["Terminal Key Reset", "Every kiosk opened on it must be unlocked again."],
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
    { key: "name", header: "Terminal", sortable: true, className: "font-medium", searchValue: (t) => `${t.name} ${t.branch_name}` },
    { key: "branch_name", header: "Branch", sortable: true },
    { key: "status", header: "Status", cell: (t) => <div className="max-w-48 space-y-1 whitespace-normal"><StatusBadge tone={t.status === "active" ? "success" : "muted"}>{t.status_label}</StatusBadge>{t.status !== "active" && t.status_reason ? <p className="text-xs text-muted-foreground">{t.status_reason}</p> : null}</div> },
    { key: "last_tap_at", header: "Last tap", sortValue: (t) => t.last_tap_at || "", cell: (t) => <div className="text-xs whitespace-nowrap"><StatusBadge tone={t.health_tone} dot={false}>{t.health_label}</StatusBadge><span className="mt-1 block text-muted-foreground">{t.last_tap_at ? dateTime(t.last_tap_at) : "—"}</span></div> },
    { key: "created", header: "Added by", cell: (t) => <div className="text-xs whitespace-nowrap">{t.created_by_name} · {t.created_by_role}<span className="block text-muted-foreground">{dateTime(t.created_at)}</span></div> },
    {
      key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (t) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={() => open("rename", t)}>Edit</Button>
          {t.status === "active"
            ? <><Button size="sm" variant="outline" onClick={() => open("reset", t)}>Reset key</Button><Button size="sm" variant="outline" className="text-destructive" onClick={() => open("off", t)}>Switch off</Button></>
            : <Button size="sm" variant="outline" onClick={() => open("on", t)}>Switch on</Button>}
        </div>
      ),
    },
  ];

  const titles = {
    add: ["Add a terminal", "A reader at a gate or office. Name it so taps show where they came from."],
    rename: ["Edit terminal", "Rename it or move it to another branch."],
    off: ["Switch off this terminal", "Its kiosks stop recording taps at once."],
    on: ["Switch on this terminal", "Then unlock the RFID Terminal on it again."],
    reset: ["Reset this terminal's key", "Every kiosk opened on it is locked and must be unlocked again (e.g. a PC was moved or stolen)."],
  };

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><RadioTowerIcon className="size-4 text-gold-text" aria-hidden="true" />RFID terminals</CardTitle>
        <CardDescription>Each reader by branch, whether it is on, and when it last took a tap. A terminal with no recent taps may be offline.</CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          {canAdd ? <Button variant="outline" size="sm" onClick={() => open("add")} disabled={!data}><PlusIcon aria-hidden="true" />Add terminal</Button> : null}
          {showOpen ? <Button size="sm" onClick={() => hardNavigate("/rfid-terminal")} disabled={!data?.terminals?.some((t) => t.status === "active")}>Open RFID Terminal</Button> : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={data?.terminals || []} loading={first} error={state.error} onRetry={load} pageSize={10}
          searchPlaceholder="Search terminal or branch…" caption="RFID terminals" minWidth={900}
          empty={{ title: "No terminals yet", description: canAdd ? "Add one, then open the RFID Terminal on that computer." : "A branch Admin adds its terminals (Maintenance → RFID terminals).", icon: RadioTowerIcon }} />
      </CardContent>

      <Dialog open={Boolean(dialog)} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          {dialog ? (
            <form onSubmit={submit} className="contents">
              <DialogHeader>
                <DialogTitle>{titles[dialog.kind][0]}{dialog.terminal ? ` — ${dialog.terminal.name}` : ""}</DialogTitle>
                <DialogDescription>{titles[dialog.kind][1]}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                {["add", "rename"].includes(dialog.kind) ? (
                  <>
                    <div className="space-y-1.5"><Label htmlFor="rt-name">Name</Label><Input id="rt-name" maxLength={60} placeholder="e.g. Main Gate" value={input.name} onChange={(e) => setInput((c) => ({ ...c, name: e.target.value }))} autoFocus /></div>
                    {data?.can_all_branches || branches.length > 1 ? (
                      <div className="space-y-1.5"><Label htmlFor="rt-branch">Branch</Label>
                        <Select value={input.branch} onValueChange={(v) => setInput((c) => ({ ...c, branch: v }))}>
                          <SelectTrigger id="rt-branch" className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {data?.can_all_branches ? <SelectItem value={EVERY_BRANCH}>All branches (any card)</SelectItem> : null}
                            {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {["off", "reset", "on"].includes(dialog.kind) ? (
                  <div className="space-y-1.5"><Label htmlFor="rt-reason">{dialog.kind === "on" ? "Note (optional)" : "Reason"}</Label><Input id="rt-reason" maxLength={300} value={input.reason} onChange={(e) => setInput((c) => ({ ...c, reason: e.target.value }))} autoFocus /></div>
                ) : null}
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
                <Button type="submit" disabled={busy} variant={dialog.kind === "off" || dialog.kind === "reset" ? "destructive" : "default"}>
                  {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
                  {{ add: "Add terminal", rename: "Save", off: "Switch off", on: "Switch on", reset: "Reset key" }[dialog.kind]}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
