"use client";

import * as React from "react";
import { DownloadIcon, FileUpIcon, PlusIcon, UserMinusIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { formatContactNumber } from "@/lib/portal/format";
import { EmployeeFormDialog } from "./employee-form-dialog";
import { EmployeeImportDialog } from "./employee-import-dialog";
import { SalaryChangeDialog } from "./salary-change-dialog";
import { BulkRowsDialog } from "@/components/portal/bulk-rows-dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { fetchJson as fetchJsonApi, jsonBody } from "@/lib/portal/api";
import { SEPARATION_REASONS } from "@/lib/employees/separation-rules";
import { downloadCsv } from "@/lib/portal/attendance";
import { UserAvatar } from "@/components/portal/user-avatar";
import { FilterTabs } from "@/components/portal/filter-tabs";

/*
 * User Management (loadHREmployees / renderHREmployeeTable,
 * public/legacy/js/hr.js): GET /api/hr/employees?archived=true (archived
 * rows always load so the Archived count is right) and /api/admin/branches.
 */

export function useBranches(refreshKey) {
  const [branches, setBranches] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    let timer = null;
    // A failed lookup used to leave every branch as "Unknown branch" until
    // the next refresh: try again a few times, a little later each time.
    const attempt = (n) => {
      fetchJson("/api/admin/branches")
        .then((data) => { if (!cancelled) setBranches(data.branches || []); })
        .catch(() => { if (!cancelled && n < 3) timer = setTimeout(() => attempt(n + 1), 1500 * (n + 1)); });
    };
    attempt(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshKey]);
  return branches;
}

export function EmployeesPage({ refreshKey }) {
  const branches = useBranches(refreshKey);
  const [state, setState] = React.useState({ loading: true, error: null, employees: [] });
  const [filter, setFilter] = React.useState("all");
  const [branch, setBranch] = React.useState("all");
  const [dialog, setDialog] = React.useState(null); // { mode, employee }
  const [salaryFor, setSalaryFor] = React.useState(null); // Change salary (2026-10-26)
  // Import CSV: onboard many at once (scenario SC-10 / HR-02).
  const [importing, setImporting] = React.useState(false);
  // Offboard many (scenario HR-03): one line per employee, the same reason.
  const [offboarding, setOffboarding] = React.useState(false);
  const [offboard, setOffboard] = React.useState({ reason: "End of contract", note: "" });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: !current.employees.length, error: null }));
    try {
      const data = await fetchJson("/api/hr/employees?archived=true");
      setState({ loading: false, error: null, employees: data.employees || [] });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load employees." }));
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  // Licensed-teacher status per Teaching employee (/api/hr/teacher-license);
  // empty before 20261009010000, when the column just shows a dash.
  const [licenses, setLicenses] = React.useState(() => new Map());
  React.useEffect(() => {
    let alive = true;
    fetchJson("/api/hr/teacher-license")
      .then((data) => { if (alive) setLicenses(new Map((data.teachers || []).map((t) => [t.employee_id, t.status]))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [refreshKey, dialog]);

  const branchName = React.useCallback((id) => {
    if (!id) return "";
    return branches.find((b) => String(b.id) === String(id))?.name || "Unknown branch";
  }, [branches]);

  const inBranch = state.employees.filter((e) => {
    if (branch === "all") return true;
    if (branch === "unassigned") return !e.branch_id;
    return String(e.branch_id || "") === branch;
  });
  const active = inBranch.filter((e) => !e.archived);
  const counts = {
    all: active.length,
    teaching: active.filter((e) => e.employee_type?.toLowerCase() === "teaching").length,
    "non-teaching": active.filter((e) => e.employee_type?.toLowerCase() === "non-teaching").length,
    archived: inBranch.filter((e) => e.archived).length,
  };
  const rows = filter === "archived" ? inBranch.filter((e) => e.archived)
    : filter === "teaching" ? active.filter((e) => e.employee_type?.toLowerCase() === "teaching")
      : filter === "non-teaching" ? active.filter((e) => e.employee_type?.toLowerCase() === "non-teaching")
        : active;

  const columns = React.useMemo(() => [
    {
      key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (e) => e.full_name,
      cell: (e) => <span className="flex items-center gap-2"><UserAvatar userId={e.id} name={e.full_name} className="size-7" fallbackClassName="text-[10px]" />{e.full_name}</span>,
    },
    { key: "employee_id", header: "ID", className: "font-mono text-xs", cell: (e) => e.employee_id || "—", searchValue: (e) => e.employee_id },
    { key: "employee_type", header: "Type", cell: (e) => e.employee_type || "—" },
    { key: "position", header: "Position", cell: (e) => e.position || "—", searchValue: (e) => e.position },
    {
      key: "license",
      header: "License",
      cell: (e) => {
        const status = licenses.get(e.id);
        return status && status.code !== "not_licensed" ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge> : <span className="text-muted-foreground">—</span>;
      },
    },
    { key: "cp_number", header: "Contact number", className: "tabular-nums whitespace-nowrap", cell: (e) => formatContactNumber(e.cp_number) || "—" },
    { key: "branch", header: "Branch", sortValue: (e) => branchName(e.branch_id), cell: (e) => branchName(e.branch_id) || "—", searchValue: (e) => branchName(e.branch_id) },
    { key: "date_hired", header: "Date hired", sortable: true, className: "whitespace-nowrap", cell: (e) => e.date_hired || "—" },
    {
      key: "status",
      header: "Status",
      cell: (e) => (e.archived
        ? <StatusBadge tone="danger">Archived</StatusBadge>
        : <StatusBadge tone={e.employee_status?.toLowerCase() === "active" ? "success" : "gold"}>{e.employee_status || "Active"}</StatusBadge>),
    },
    { key: "email", header: "Email", className: "text-xs text-muted-foreground", cell: (e) => e.email || "—", searchValue: (e) => e.email },
    {
      key: "edit", header: <span className="sr-only">Edit</span>, align: "right",
      cell: (e) => (
        <div className="flex justify-end gap-1.5">
          {/* A raise (or any salary change) has its own flow: the month it starts and a reason. */}
          {!e.archived && ["employee", "accountant"].includes(String(e.role || "employee").toLowerCase())
            ? <Button variant="outline" size="sm" onClick={() => setSalaryFor(e)}>Salary</Button> : null}
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "edit", employee: e })}>Edit</Button>
        </div>
      ),
    },
  ], [branchName, licenses]);

  // The list as shown (tab and branch filter), for a master list or a
  // report (scenario SC-13). Government IDs are left out (data privacy).
  function exportList() {
    downloadCsv(`sacs-employees-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Employee ID", "Name", "Email", "Branch", "Type", "Position", "Status", "Date hired", "Contact number"],
      rows.map((e) => [e.employee_id || "", e.full_name || "", e.email || "", branchName(e.branch_id) || "", e.employee_type || "", e.position || "",
        e.archived ? "Archived" : e.employee_status || "Active", e.date_hired || "", e.cp_number || ""]));
  }

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Staff list</CardTitle>
          <CardDescription>Employee and Accountant accounts in every branch.</CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportList} disabled={!rows.length}><DownloadIcon aria-hidden="true" />Export CSV</Button>
            <Button variant="outline" onClick={() => setImporting(true)}><FileUpIcon aria-hidden="true" />Import CSV</Button>
            <Button variant="outline" onClick={() => setOffboarding(true)}><UserMinusIcon aria-hidden="true" />Offboard many</Button>
            <Button onClick={() => setDialog({ mode: "add" })}><PlusIcon aria-hidden="true" />Add employee</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTable
            toolbar={(
              <>
                <FilterTabs value={filter} onValueChange={setFilter} label="Employee filter" options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "teaching", label: "Teaching", count: counts.teaching },
                  { value: "non-teaching", label: "Non-Teaching", count: counts["non-teaching"] },
                  { value: "archived", label: "Archived", count: counts.archived },
                ]} />
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger className="w-48" aria-label="Filter by branch"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All branches</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {branches.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            )}
            columns={columns}
            rows={rows}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search name, ID, email, position or branch…"
            empty={{ title: "No employees found", icon: UsersIcon }}
            caption="Staff list"
            minWidth={1100}
          />
        </CardContent>
      </Card>

      <SalaryChangeDialog employee={salaryFor} open={Boolean(salaryFor)} onOpenChange={(open) => { if (!open) setSalaryFor(null); }} onSaved={load} />
      <EmployeeFormDialog
        mode={dialog?.mode || "add"}
        employee={dialog?.employee || null}
        branches={branches}
        defaultBranch={branch !== "all" && branch !== "unassigned" ? branch : ""}
        branchName={branchName}
        open={Boolean(dialog)}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        onSaved={load}
      />
      <EmployeeImportDialog open={importing} onOpenChange={setImporting} onImported={load} />
      <BulkRowsDialog
        open={offboarding}
        onOpenChange={setOffboarding}
        testId="offboard-many"
        title="Offboard many employees"
        description="Choose each employee and their last day. Each becomes Separated from that day: no more taps, card deactivated, pay settled through Final Pay. Check first: only the rows that pass are separated."
        employees={state.employees
          .filter((e) => !e.archived && e.employee_status !== "Separated")
          .map((e) => ({
            id: e.id, full_name: e.full_name, employee_code: e.employee_id, branch_name: branchName(e.branch_id),
            ...(String(e.role || "employee").toLowerCase() === "hr" ? { disabled: true, hint: "an HR login is separated by the Super Admin" } : {}),
          }))}
        showBranch={branches.length > 1}
        field={{ key: "effective", label: "Last day", kind: "date" }}
        pasteLabel="One line per employee: their employee ID (or name), then the last day (YYYY-MM-DD)"
        pastePlaceholder={"SACS-0101, 2027-05-31\nSACS-0102, 2027-05-31"}
        check={async (rows) => (await fetchJsonApi("/api/hr/employees", jsonBody("PATCH", {
          action: "check_separation", reason: offboard.reason, note: offboard.note.trim(),
          rows: rows.map((r) => ({ employee_id: r.employee_id, effective: /^\d{4}-\d{2}-\d{2}$/.test(r.value) ? r.value : "" })),
        }))).results}
        run={(row) => fetchJsonApi("/api/hr/employees", jsonBody("PATCH", { id: row.employee_id, action: "separate", effective: row.value, reason: offboard.reason, note: offboard.note.trim() }))}
        actionLabel={(n) => `Separate ${n || ""} employee${n === 1 ? "" : "s"}`}
        ready={!["Terminated", "Other"].includes(offboard.reason) || offboard.note.trim().length >= 10}
        notReadyText="State the grounds in the note (at least 10 characters)."
        onDone={(n) => { if (n) load(); }}
        extra={(
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="off-reason">Reason</Label>
              <Select value={offboard.reason} onValueChange={(reason) => setOffboard((c) => ({ ...c, reason }))}>
                <SelectTrigger id="off-reason" className="h-10 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{SEPARATION_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="off-note">{["Terminated", "Other"].includes(offboard.reason) ? "Grounds (required)" : "Note (optional)"}</Label>
              <Input id="off-note" className="h-10" maxLength={1000} value={offboard.note} onChange={(e) => setOffboard((c) => ({ ...c, note: e.target.value }))} />
            </div>
          </div>
        )}
      />
    </>
  );
}
