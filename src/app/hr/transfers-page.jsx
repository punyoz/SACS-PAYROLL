"use client";

import * as React from "react";
import { Building2Icon, Loader2Icon, RefreshCwIcon, UserMinusIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BranchGroupedTable } from "@/components/portal/branch-grouped-table";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { useBranches } from "./employees-page";

/*
 * Transfer Requests (loadHrBranchAssignment / submitHrBranchAssign /
 * loadHrTransferHistory, public/legacy/js/hr.js): GET
 * /api/admin/branch-employees (Employee and Accountant accounts only),
 * GET and POST /api/admin/transfer-requests. A transfer applies at once.
 */

const BRANCH_TONES = ["success", "gold", "info", "warning"];
const fmt = (value) => (value ? new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—");

function TransferDialog({ employee, branches, onOpenChange, onDone }) {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const [branch, setBranch] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [error, setError] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!employee) return;
    setBranch("");
    setRemarks("");
    setError("");
    setFeedback({ text: "", ok: false });
  }, [employee]);

  // Active branches other than the one the employee is already in.
  const destinations = branches.filter((b) => String(b.status || "Active").toLowerCase() === "active" && b.id !== employee?.branch);
  const moving = Boolean(employee?.branch);

  async function submit(event) {
    event.preventDefault();
    if (!employee?.id) { setFeedback({ text: "Employee is missing. Please close and try again.", ok: false }); return; }
    if (!branch) { setError("Choose the destination branch."); setFeedback({ text: "Choose the destination branch.", ok: false }); return; }
    setError("");
    const destination = branches.find((b) => b.id === branch);
    const ok = await confirm({
      title: `${moving ? "Transfer" : "Assign"} ${employee.full_name || "this employee"} to ${destination?.name || "the selected branch"}?`,
      description: "The change applies immediately and is recorded in Transfer History.",
      confirmLabel: moving ? "Transfer" : "Assign",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await fetchJson("/api/admin/transfer-requests", jsonBody("POST", { employee_id: employee.id, to_branch_id: branch, remarks: remarks.trim() }));
      const branchName = result.to_branch_name || destination?.name || "the new branch";
      setFeedback({ text: `Moved to ${branchName}.`, ok: true });
      notify("Employee Transferred", `${employee.full_name || "Employee"} now belongs to ${branchName}.`, "success");
      await onDone();
      setTimeout(() => onOpenChange(false), 600);
    } catch (err) {
      setFeedback({ text: err.message || "Failed to transfer employee.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={Boolean(employee)} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{moving ? "Transfer employee" : "Assign branch"}</DialogTitle>
            <DialogDescription>The move applies immediately and is kept in Transfer History.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hr-f-employee-display">Employee</Label>
              <Input id="hr-f-employee-display" readOnly tabIndex={-1} className="bg-muted text-muted-foreground" value={employee ? `${employee.full_name} (${employee.employee_id || "N/A"})` : ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hr-f-current-branch">Current branch</Label>
              <Input id="hr-f-current-branch" readOnly tabIndex={-1} className="bg-muted text-muted-foreground" value={employee?.branch ? (employee.branch_label || "Unknown branch") : "Unassigned"} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hr-ba-destination">Destination branch</Label>
              <Select value={branch} onValueChange={(v) => { setBranch(v); setError(""); }} disabled={!destinations.length}>
                <SelectTrigger id="hr-ba-destination" className="w-full" aria-invalid={Boolean(error) || undefined}>
                  <SelectValue placeholder={destinations.length ? "Select destination branch" : "No other active branch available"} />
                </SelectTrigger>
                <SelectContent>{destinations.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="hr-ba-remarks">Remarks <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea id="hr-ba-remarks" rows={3} maxLength={300} placeholder="Reason for the transfer" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            {feedback.text ? <p role="status" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p> : null}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : moving ? "Transfer now" : "Assign now"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

export function TransfersPage({ refreshKey }) {
  const branches = useBranches(refreshKey);
  const [roster, setRoster] = React.useState({ loading: true, error: null, employees: [] });
  const [history, setHistory] = React.useState({ loading: true, error: null, rows: [] });
  const [filter, setFilter] = React.useState("all");
  const [editing, setEditing] = React.useState(null);

  const load = React.useCallback(async () => {
    setRoster((c) => ({ ...c, loading: !c.employees.length, error: null }));
    setHistory((c) => ({ ...c, loading: !c.rows.length, error: null }));
    const [rosterResult, historyResult] = await Promise.allSettled([
      fetchJson("/api/admin/branch-employees"),
      fetchJson("/api/admin/transfer-requests"),
    ]);
    if (rosterResult.status === "fulfilled") {
      // HR manages Employee and Accountant accounts only.
      setRoster({ loading: false, error: null, employees: (rosterResult.value.employees || []).filter((e) => e.role === "employee" || e.role === "accountant") });
    } else {
      setRoster((c) => ({ ...c, loading: false, error: rosterResult.reason?.message || "Failed to load branch assignments" }));
    }
    if (historyResult.status === "fulfilled") setHistory({ loading: false, error: null, rows: historyResult.value.requests || [] });
    else setHistory((c) => ({ ...c, loading: false, error: historyResult.reason?.message || "Failed to load transfer history." }));
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const all = roster.employees;
  const unassigned = all.filter((e) => !e.branch).length;
  const countFor = (id) => all.filter((e) => e.branch === id).length;
  // Unassigned first (they need an Assign), then branches in list order.
  const rank = (e) => {
    if (!e.branch) return -1;
    const idx = branches.findIndex((b) => b.id === e.branch);
    return idx >= 0 ? idx : branches.length;
  };
  const rows = all
    .filter((e) => (filter === "all" ? true : filter === "unassigned" ? !e.branch : e.branch === filter))
    .sort((a, b) => rank(a) - rank(b) || String(a.full_name || "").localeCompare(String(b.full_name || "")));

  const branchCell = (e) => {
    if (!e.branch) return <StatusBadge tone="danger">Unassigned</StatusBadge>;
    const idx = branches.findIndex((b) => b.id === e.branch);
    const inactive = e.branch_status && e.branch_status !== "Active" ? " (Inactive)" : "";
    return <StatusBadge tone={idx >= 0 ? BRANCH_TONES[idx % BRANCH_TONES.length] : "muted"} dot={false}>{`${e.branch_label || "Unknown branch"}${inactive}`}</StatusBadge>;
  };

  const columns = [
    { key: "full_name", header: "Employee", className: "font-medium", cell: (e) => e.full_name || "" },
    { key: "employee_id", header: "Employee ID", className: "tabular-nums", cell: (e) => e.employee_id || "—" },
    { key: "type", header: "Type", cell: (e) => <StatusBadge tone={e.employee_type === "Non-Teaching" ? "gold" : "info"} dot={false}>{e.employee_type || "Teaching"}</StatusBadge> },
    { key: "position", header: "Position", cell: (e) => e.position || "—" },
    { key: "branch", header: "Branch", cell: branchCell },
    { key: "assigned", header: "Assigned at", className: "whitespace-nowrap text-xs", cell: (e) => (e.assigned_at ? new Date(e.assigned_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—") },
    {
      key: "action",
      header: <span className="sr-only">Action</span>,
      align: "right",
      cell: (e) => (e.branch
        ? <Button variant="outline" size="sm" onClick={() => setEditing(e)}>Transfer</Button>
        : <Button size="sm" onClick={() => setEditing(e)}>Assign</Button>),
    },
  ];

  const historyColumns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", cell: (r) => r.employee_name || "—", searchValue: (r) => r.employee_name },
    { key: "from", header: "From branch", cell: (r) => r.from_branch_name || (r.from_branch_id ? "Unknown branch" : "Unassigned"), searchValue: (r) => r.from_branch_name },
    { key: "to", header: "To branch", cell: (r) => r.to_branch_name || "Unknown branch", searchValue: (r) => r.to_branch_name },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const s = String(r.status || "").toLowerCase();
        const label = s === "approved" ? "Transferred" : s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
        return <StatusBadge tone={s === "approved" ? "success" : s === "rejected" ? "danger" : "gold"}>{label}</StatusBadge>;
      },
    },
    { key: "remarks", header: "Remarks", className: "max-w-56 whitespace-normal text-muted-foreground", cell: (r) => r.remarks || "—" },
    { key: "created_at", header: "Requested", className: "whitespace-nowrap text-xs", sortValue: (r) => r.created_at || "", cell: (r) => fmt(r.created_at) },
    { key: "reviewed_at", header: "Decided", className: "whitespace-nowrap text-xs", sortValue: (r) => r.reviewed_at || "", cell: (r) => fmt(r.reviewed_at) },
  ];

  const first = roster.loading && !all.length;

  return (
    <>
      <section aria-label="Employees by branch" className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Total employees" value={all.length} hint="All active employees" icon={UsersIcon} loading={first} />
        <StatCard label="Unassigned" value={unassigned} hint="Not yet in a branch" icon={UserMinusIcon} tone="danger" loading={first} />
        {branches.map((b, i) => (
          <StatCard key={b.id} label={b.name} value={countFor(b.id)} hint="Branch campus" icon={Building2Icon} tone={["success", "gold", "info", "primary"][i % 4]} loading={first} />
        ))}
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Employee branch list</CardTitle>
          <CardDescription>Where every Employee and Accountant is assigned.</CardDescription>
          <CardAction><Button variant="outline" size="sm" onClick={load} disabled={roster.loading}><RefreshCwIcon className={cn(roster.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="all">All ({all.length})</TabsTrigger>
                <TabsTrigger value="unassigned">Unassigned ({unassigned})</TabsTrigger>
                {branches.map((b) => <TabsTrigger key={b.id} value={b.id}>{b.name} ({countFor(b.id)})</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
          {!branches.length && !first ? <p className="text-sm text-muted-foreground">No branches configured — ask the Super Admin to add branches first.</p> : null}
          <BranchGroupedTable
            columns={columns}
            rows={rows}
            groupOf={(e) => e.branch || ""}
            groupLabel={(key, e) => (key ? e.branch_label || branches.find((b) => b.id === key)?.name || "Unknown branch" : "Unassigned")}
            search={(e) => [e.full_name, e.employee_id, e.email].join(" ")}
            searchPlaceholder="Search by name or employee ID…"
            loading={first}
            error={roster.error}
            onRetry={load}
            empty="No employees found."
            caption="Employee branch list"
            minWidth={860}
          />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Transfer history</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={historyColumns}
            rows={history.rows}
            loading={history.loading}
            error={history.error}
            onRetry={load}
            pageSize={10}
            searchPlaceholder="Search employee or branch…"
            empty={{ title: "No transfers yet", icon: Building2Icon }}
            caption="Transfer history"
            minWidth={900}
          />
        </CardContent>
      </Card>

      <TransferDialog employee={editing} branches={branches} onOpenChange={(open) => { if (!open) setEditing(null); }} onDone={load} />
    </>
  );
}
