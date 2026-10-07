"use client";

import * as React from "react";
import { ArchiveIcon, CheckCircle2Icon, PencilIcon, RefreshCwIcon, UserPlusIcon, UsersRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { STAFF_ROLE_LABELS, STAFF_ROLES } from "@/lib/portal/staff-rules";
import { cn } from "@/lib/utils";
import { AddStaffDialog, EditStaffDialog } from "./staff-account-dialogs";

/*
 * Admin & HR Accounts (loadSAUsers / renderSAUsersTable,
 * public/legacy/js/super-admin.js): GET /api/admin/users, kept to Super
 * Admin, Admin and HR logins, with the branches for the Branch column.
 * Employee and Accountant accounts belong to HR.
 */

export const ROLE_TONE = { super_admin: "info", admin: "gold", hr: "warning" };

const FILTERS = [
  { id: "all", label: "All" },
  { id: "admin", label: "Admin" },
  { id: "hr", label: "HR" },
  { id: "archived", label: "Archived" },
];

function lastLogin(user) {
  const signedIn = user.last_sign_in || user.last_sign_in_at;
  if (!signedIn) return "Never";
  const date = new Date(signedIn);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

export function AccountsPage({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, users: [], branches: [] });
  const [filter, setFilter] = React.useState("all");
  const [editing, setEditing] = React.useState({ open: false, user: null });
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    const [users, branches] = await Promise.allSettled([fetchJson("/api/admin/users"), fetchJson("/api/admin/branches")]);
    setState((current) => ({
      loading: false,
      error: users.status === "rejected" ? users.reason?.message || "Failed to load accounts." : null,
      users: users.status === "fulfilled" ? (users.value.users || []).filter((u) => STAFF_ROLES.includes(u.role)) : current.users,
      branches: branches.status === "fulfilled" ? branches.value.branches || [] : current.branches,
    }));
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  // HR serves every branch; a Super Admin has none.
  const branchLabel = React.useCallback((user) => {
    if (user?.role === "hr") return "All Branches";
    if (user?.role === "super_admin" || !user?.branch_id) return "—";
    return state.branches.find((b) => String(b.id) === String(user.branch_id))?.name || "Unknown branch";
  }, [state.branches]);

  const counts = {
    all: state.users.filter((u) => !u.archived).length,
    admin: state.users.filter((u) => u.role === "admin" && !u.archived).length,
    hr: state.users.filter((u) => u.role === "hr" && !u.archived).length,
    archived: state.users.filter((u) => u.archived).length,
  };

  const rows = state.users.filter((u) => {
    if (filter === "archived") return u.archived;
    if (filter === "all") return !u.archived;
    return u.role === filter && !u.archived;
  });

  const columns = React.useMemo(() => [
    { key: "full_name", header: "User", sortable: true, className: "font-medium", cell: (u) => u.full_name || "—", searchValue: (u) => u.full_name },
    { key: "staff_id", header: "ID", sortable: true, cell: (u) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{u.staff_id || "—"}</code>, searchValue: (u) => u.staff_id },
    { key: "email", header: "Email", sortable: true, className: "text-muted-foreground", cell: (u) => u.email || "—", searchValue: (u) => u.email },
    {
      key: "role",
      header: "Role",
      sortValue: (u) => STAFF_ROLE_LABELS[u.role] || "",
      searchValue: (u) => STAFF_ROLE_LABELS[u.role],
      cell: (u) => <StatusBadge tone={ROLE_TONE[u.role] || "muted"} dot={false}>{STAFF_ROLE_LABELS[u.role] || "—"}</StatusBadge>,
    },
    { key: "branch", header: "Branch", sortValue: branchLabel, searchValue: branchLabel, cell: branchLabel },
    {
      key: "status",
      header: "Status",
      sortValue: (u) => (u.archived ? 1 : 0),
      cell: (u) => (u.archived ? <StatusBadge tone="danger">Archived</StatusBadge> : <StatusBadge tone="success">Active</StatusBadge>),
    },
    { key: "last_login", header: "Last login", className: "whitespace-nowrap tabular-nums", sortValue: (u) => u.last_sign_in || u.last_sign_in_at || "", cell: lastLogin },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (u) => <Button variant="outline" size="sm" onClick={() => setEditing({ open: true, user: u })} aria-label={`Edit ${u.full_name || "account"}`}><PencilIcon aria-hidden="true" />Edit</Button>,
    },
  ], [branchLabel]);

  const first = state.loading && !state.users.length;

  return (
    <>
      <section aria-label="Accounts" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Admin & HR accounts" value={state.users.length} hint="Registered logins" icon={UsersRoundIcon} loading={first} />
        <StatCard label="Active" value={counts.all} hint="Can sign in" icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="Archived" value={counts.archived} hint="Deactivated accounts" icon={ArchiveIcon} tone="danger" loading={first} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Admin &amp; HR logins</CardTitle>
          <CardDescription>Super Admin, Admin and HR sign-in accounts. Archived accounts cannot sign in.</CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
            <Button size="sm" onClick={() => setAdding(true)}><UserPlusIcon aria-hidden="true" />Add staff account</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList className="h-auto flex-wrap">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.id} value={f.id} className="gap-1.5">
                  {f.label}
                  <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{counts[f.id] ?? 0}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <DataTable
            columns={columns}
            rows={rows}
            loading={first}
            error={state.error && !state.users.length ? state.error : null}
            onRetry={load}
            pageSize={15}
            searchPlaceholder="Search by name, ID, email, role or branch…"
            empty={{ title: "No accounts found", icon: UsersRoundIcon }}
            caption="Admin and HR accounts"
            minWidth={980}
          />
        </CardContent>
      </Card>

      <EditStaffDialog
        user={editing.user}
        branches={state.branches}
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        onSaved={load}
      />
      <AddStaffDialog branches={state.branches} open={adding} onOpenChange={setAdding} onSaved={load} />
    </>
  );
}
