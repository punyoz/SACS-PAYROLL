"use client";

import * as React from "react";
import { PlusIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { formatContactNumber } from "@/lib/portal/format";
import { EmployeeFormDialog } from "./employee-form-dialog";

/*
 * User Management (loadHREmployees / renderHREmployeeTable,
 * public/legacy/js/hr.js): GET /api/hr/employees?archived=true (archived
 * rows always load so the Archived count is right) and /api/admin/branches.
 */

export function useBranches(refreshKey) {
  const [branches, setBranches] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    fetchJson("/api/admin/branches")
      .then((data) => { if (!cancelled) setBranches(data.branches || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);
  return branches;
}

export function EmployeesPage({ refreshKey }) {
  const branches = useBranches(refreshKey);
  const [state, setState] = React.useState({ loading: true, error: null, employees: [] });
  const [filter, setFilter] = React.useState("all");
  const [branch, setBranch] = React.useState("all");
  const [dialog, setDialog] = React.useState(null); // { mode, employee }

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
    { key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (e) => e.full_name },
    { key: "employee_id", header: "ID", className: "font-mono text-xs", cell: (e) => e.employee_id || "—", searchValue: (e) => e.employee_id },
    { key: "employee_type", header: "Type", cell: (e) => e.employee_type || "—" },
    { key: "position", header: "Position", cell: (e) => e.position || "—", searchValue: (e) => e.position },
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
    { key: "edit", header: <span className="sr-only">Edit</span>, align: "right", cell: (e) => <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "edit", employee: e })}>Edit</Button> },
  ], [branchName]);

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Staff list</CardTitle>
          <CardDescription>Employee and Accountant accounts in every branch.</CardDescription>
          <CardAction><Button onClick={() => setDialog({ mode: "add" })}><PlusIcon aria-hidden="true" />Add employee</Button></CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList className="flex-wrap">
                <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
                <TabsTrigger value="teaching">Teaching ({counts.teaching})</TabsTrigger>
                <TabsTrigger value="non-teaching">Non-Teaching ({counts["non-teaching"]})</TabsTrigger>
                <TabsTrigger value="archived">Archived ({counts.archived})</TabsTrigger>
              </TabsList>
            </Tabs>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="w-full md:w-56" aria-label="Filter by branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {branches.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DataTable
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
    </>
  );
}
