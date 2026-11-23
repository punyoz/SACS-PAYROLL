"use client";

import { Skeleton } from "@/components/ui/skeleton";
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
import { EMPLOYMENT_STATUS_OPTIONS, EMPLOYMENT_TYPE_OPTIONS } from "@/lib/employees/classification";
import { useUrlParam } from "@/components/portal/use-url-param";

/*
 * User Management (loadHREmployees / renderHREmployeeTable,
 * public/legacy/js/hr.js): GET /api/hr/employees?archived=true (archived
 * rows always load so the Archived count is right) and /api/admin/branches.
 */

export function useBranches(refreshKey, { withStatus = false } = {}) {
  const [branches, setBranches] = React.useState([]);
  // Loaded, or given up after the retries: only then is a branch truly "Unknown" (2026-11-22).
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    let timer = null;
    // A failed lookup used to leave every branch as "Unknown branch" until
    // the next refresh: try again a few times, a little later each time.
    const attempt = (n) => {
      fetchJson("/api/admin/branches")
        .then((data) => { if (!cancelled) { setBranches(data.branches || []); setLoaded(true); } })
        .catch(() => {
          if (cancelled) return;
          if (n < 3) timer = setTimeout(() => attempt(n + 1), 1500 * (n + 1));
          else setLoaded(true);
        });
    };
    attempt(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshKey]);
  return withStatus ? { branches, loaded } : branches;
}

export function EmployeesPage({ refreshKey }) {
  const { branches, loaded: branchesLoaded } = useBranches(refreshKey, { withStatus: true });
  const [state, setState] = React.useState({ loading: true, error: null, employees: [] });
  // Kept in the address (a dashboard link opens a filtered list).
  const [filter, setFilter] = useUrlParam("emp_filter", "all");
  const [branch, setBranch] = React.useState("all");
  // Employment status and type filters (Part A).
  const [empStatus, setEmpStatus] = useUrlParam("emp_status", "all");
  const [dialog, setDialog] = React.useState(null); // { mode, employee }
  // ?emp_open=<id> (Action needed → Salary not set): opens that employee's record once loaded.
  const [openId, setOpenId] = useUrlParam("emp_open", "");
  const [salaryFor, setSalaryFor] = React.useState(null); // Change salary (2026-10-26)
  // Import CSV: onboard many at once (scenario SC-10 / HR-02).
  const [importing, setImporting] = React.useState(false);
  // Offboard (scenario HR-03), from the list's selection (Part F): one line per employee, the same reason.
  const [offboarding, setOffboarding] = React.useState(false);
  const [offboardIds, setOffboardIds] = React.useState([]);
  const [selected, setSelected] = React.useState(() => new Set());
  const [offboard, setOffboard] = React.useState({ reason: "End of contract", note: "" });

  React.useEffect(() => {
    if (!openId || state.loading) return;
    const found = state.employees.find((e) => String(e.id) === String(openId));
    if (found) setDialog({ mode: "edit", employee: found });
    setOpenId("");
  }, [openId, state.loading, state.employees, setOpenId]);

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
    maintenance: active.filter((e) => e.staff_group === "Maintenance").length,
    archived: inBranch.filter((e) => e.archived).length,
    unconfirmed: active.filter((e) => e.classification_unconfirmed).length,
  };
  // Memoized: DataTable reports its rows back through onRowsShown (setShownRows), so a new array every render loops forever.
  const rows = React.useMemo(() => {
    const list = state.employees.filter((e) => (branch === "all" ? true : branch === "unassigned" ? !e.branch_id : String(e.branch_id || "") === branch));
    const classified = list
      .filter((e) => empStatus === "all" || e.employment_status === empStatus);
    if (filter === "archived") return classified.filter((e) => e.archived);
    const live = classified.filter((e) => !e.archived);
    if (filter === "unconfirmed") return live.filter((e) => e.classification_unconfirmed);
    // Maintenance: a group within Non-Teaching (2026-11-23).
    if (filter === "maintenance") return live.filter((e) => e.staff_group === "Maintenance");
    return filter === "all" ? live : live.filter((e) => e.employee_type?.toLowerCase() === filter);
  }, [state.employees, branch, filter, empStatus]);

  const columns = React.useMemo(() => [
    {
      key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (e) => e.full_name,
      cell: (e) => <span className="flex items-center gap-2"><UserAvatar userId={e.id} name={e.full_name} className="size-7" fallbackClassName="text-[10px]" />{e.full_name}</span>,
    },
    { key: "employee_id", header: "ID", className: "font-mono text-xs", cell: (e) => e.employee_id || "—", searchValue: (e) => e.employee_id },
    { key: "employee_type", header: "Category", cell: (e) => [e.employee_type, e.staff_group].filter(Boolean).join(" · ") || "—", searchValue: (e) => `${e.employee_type || ""} ${e.staff_group || ""}` },
    {
      key: "employment_status", header: "Employment", sortable: true, sortValue: (e) => `${e.employment_status}`,
      searchValue: (e) => `${e.employment_status || ""}`,
      cell: (e) => (
        <div className="whitespace-nowrap">
          <span>{[e.employment_status].filter(Boolean).join(" · ") || "—"}</span>
          {e.classification_unconfirmed ? <StatusBadge tone="warning" className="ml-1.5">Needs HR confirmation</StatusBadge> : null}
        </div>
      ),
    },
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
    { key: "branch", header: "Branch", sortValue: (e) => branchName(e.branch_id), cell: (e) => (e.branch_id && !branchesLoaded
      // Still loading the branch names: say so, never "Unknown branch" (2026-11-22).
      ? <Skeleton className="h-4 w-24" aria-busy="true" aria-label="Loading branch" />
      : branchName(e.branch_id) || "—"), searchValue: (e) => branchName(e.branch_id) },
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
          {!e.archived && ["employee", "accountant", "hr"].includes(String(e.role || "employee").toLowerCase())
            ? <Button variant="outline" size="sm" onClick={() => setSalaryFor(e)}>Salary</Button> : null}
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "edit", employee: e })}>Edit</Button>
        </div>
      ),
    },
  ], [branchName, branchesLoaded, licenses]);

  // The list as shown (tab, branch filter and the search box, 2026-11-19), for a master list or a
  // report (scenario SC-13). Government IDs are left out (data privacy).
  const [shownRows, setShownRows] = React.useState(null);
  function exportList() {
    downloadCsv(`sacs-employees-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Employee ID", "Name", "Email", "Branch", "Type", "Group", "Employment status", "Position", "Status", "Date hired", "Contact number"],
      (shownRows || rows).map((e) => [e.employee_id || "", e.full_name || "", e.email || "", branchName(e.branch_id) || "", e.employee_type || "", e.staff_group || "",
        e.employment_status || "", e.position || "",
        e.archived ? "Archived" : e.employee_status || "Active", e.date_hired || "", e.cp_number || ""]));
  }

  return (
    <>
      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Staff list</CardTitle>
          <CardDescription>HR, Accountant and Employee accounts in every branch.</CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={exportList} disabled={!(shownRows || rows).length}><DownloadIcon aria-hidden="true" />Export CSV</Button>
            <Button variant="outline" onClick={() => setImporting(true)}><FileUpIcon aria-hidden="true" />Import CSV</Button>
            {/* Part F: offboarding starts from the selected rows in the list (Offboard selected). */}
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
                  { value: "maintenance", label: "Maintenance", count: counts.maintenance },
                  { value: "archived", label: "Archived", count: counts.archived },
                  ...(counts.unconfirmed ? [{ value: "unconfirmed", label: "Needs HR confirmation", count: counts.unconfirmed }] : []),
                ]} />
                <Select value={empStatus} onValueChange={setEmpStatus}>
                  <SelectTrigger className="w-44" aria-label="Filter by employment status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    {EMPLOYMENT_STATUS_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                  </SelectContent>
                </Select>
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
            onRowsShown={setShownRows}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search name, ID, email, position or branch…"
            empty={{ title: "No employees found", icon: UsersIcon }}
            caption="Staff list"
            minWidth={1100}
            selection={{
              selected, onChange: setSelected, rowId: (e) => e.id,
              // Active people only; an HR login is separated by the Super Admin.
              isSelectable: (e) => !e.archived && e.employee_status !== "Separated" && String(e.role || "employee").toLowerCase() !== "hr",
              label: (e) => e.full_name,
              actions: (rows) => (
                <Button size="sm" variant="outline" onClick={() => { setOffboardIds(rows.map((r) => r.id)); setOffboarding(true); }}>
                  <UserMinusIcon aria-hidden="true" />Offboard selected
                </Button>
              ),
            }}
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
        onOpenChange={(o) => { setOffboarding(o); if (!o) setSelected(new Set()); }}
        initialIds={offboardIds}
        testId="offboard-many"
        title="Offboard the selected employees"
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
