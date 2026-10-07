"use client";

import * as React from "react";
import { CheckCircle2Icon, DownloadIcon, ListIcon, ScrollTextIcon, SearchIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { StatCard } from "@/components/portal/stat-card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson } from "@/lib/portal/api";
import { downloadCsv } from "@/lib/portal/attendance";
import { logAuditMovement } from "@/lib/portal/audit";

/*
 * Audit Logs (loadAuditLogs / exportAuditLogsCsv, public/legacy/js/admin.js):
 * GET /api/admin/audit-logs?module=&action=&search=&limit=250. The search is
 * server-side (it combines with the row limit), so typing waits 300 ms, and
 * an older reply landing after a newer one is ignored.
 */

const MODULES = [["all", "All modules"], ["ui", "UI"], ["employees", "Employees"], ["attendance", "Attendance"], ["reports", "Reports"]];
const ACTIONS = [["all", "All actions"], ["event", "Event"], ["create", "Create"], ["update", "Update"], ["archive", "Archive"], ["restore", "Restore"], ["delete", "Delete"], ["approve", "Approve"], ["reject", "Reject"], ["view", "View"]];
const ROLE_LABELS = { super_admin: "Super Admin", admin: "Admin", hr: "HR", accountant: "Accountant", employee: "Employee" };

/** "Oct 07, 2026, 08:01 AM" (formatDateTime, admin.js). */
export function formatAuditTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function Actor({ log }) {
  const name = String(log?.actor_name || "").trim();
  const role = String(log?.actor_role || "").trim().toLowerCase();
  if (!name && !role) return <span className="text-muted-foreground">—</span>;
  const roleLabel = ROLE_LABELS[role] || role.replaceAll("_", " ");
  return (
    <div>
      <p>{name || "Unknown user"}</p>
      {roleLabel ? <p className="text-xs text-muted-foreground">{roleLabel}</p> : null}
    </div>
  );
}

export const AUDIT_COLUMNS = [
  { key: "created_at", header: "Timestamp", className: "whitespace-nowrap tabular-nums", sortValue: (l) => l.created_at || "", cell: (l) => formatAuditTime(l.created_at) },
  { key: "actor", header: "Performed by", cell: (l) => <Actor log={l} /> },
  { key: "module", header: "Module", className: "capitalize", cell: (l) => String(l.module || "").replaceAll("_", " ") },
  { key: "action", header: "Action", className: "capitalize", cell: (l) => String(l.action || "").replaceAll("_", " ") },
  { key: "entity", header: "Entity", className: "max-w-48 truncate text-xs text-muted-foreground", cell: (l) => `${l.entity_type || ""}${l.entity_id ? ` · ${l.entity_id}` : ""}` || "—" },
  { key: "description", header: "Description", className: "min-w-64 whitespace-normal", cell: (l) => l.description || "No description provided." },
  {
    key: "status",
    header: "Status",
    cell: (l) => {
      const status = String(l.status || "").toLowerCase();
      return <StatusBadge tone={status === "success" ? "success" : status === "failed" ? "danger" : "gold"} className="capitalize">{status || "—"}</StatusBadge>;
    },
  },
  { key: "source", header: "Source", cell: (l) => l.source || "api" },
];

export function AuditLogsPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [module, setModule] = React.useState("all");
  const [action, setAction] = React.useState("all");
  const [state, setState] = React.useState({ loading: true, error: null, logs: [], summary: { total: 0, success: 0, failed: 0 } });
  const seq = React.useRef(0);

  // Typing waits 300 ms before asking the server.
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const params = new URLSearchParams({ module, action, search: query, limit: "250" });
      const payload = await fetchJson(`/api/admin/audit-logs?${params}`);
      if (mine !== seq.current) return;
      setState({ loading: false, error: null, logs: payload.logs || [], summary: payload.summary || { total: 0, success: 0, failed: 0 } });
    } catch (error) {
      if (mine !== seq.current) return;
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load audit logs" }));
    }
  }, [module, action, query]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  function exportCsv() {
    if (!state.logs.length) {
      notify("Nothing to export", "No audit logs available to export.", "info");
      return;
    }
    downloadCsv(
      "sacs-audit-logs.csv",
      ["Timestamp", "Module", "Action", "Entity Type", "Entity ID", "Description", "Status", "Source"],
      state.logs.map((l) => [formatAuditTime(l.created_at), l.module || "", l.action || "", l.entity_type || "", l.entity_id || "", l.description || "", l.status || "", l.source || ""]),
    );
    logAuditMovement({
      module: "ui",
      action: "export_csv",
      entity_type: "audit_logs",
      entity_id: "audit_logs",
      description: "Admin exported audit logs CSV.",
      source: "ui",
      metadata: { row_count: state.logs.length },
    });
  }

  const first = state.loading && !state.logs.length;

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total logs" value={state.summary.total || 0} icon={ListIcon} loading={first} />
        <StatCard label="Successful" value={state.summary.success || 0} icon={CheckCircle2Icon} tone="success" loading={first} />
        <StatCard label="Failed" value={state.summary.failed || 0} icon={XCircleIcon} tone="danger" loading={first} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardContent className="space-y-4">
          <div className="grid items-end gap-3 md:grid-cols-[1.4fr_1fr_1fr_auto]">
            <div className="space-y-2">
              <Label htmlFor="adm-audit-search">Search logs</Label>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="adm-audit-search" type="search" className="pl-8" placeholder="Module, action, description, entity" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adm-audit-module">Module</Label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger id="adm-audit-module" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{MODULES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adm-audit-action">Action</Label>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger id="adm-audit-action" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{ACTIONS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={exportCsv} disabled={!state.logs.length}><DownloadIcon aria-hidden="true" />Export CSV</Button>
          </div>

          <DataTable
            columns={AUDIT_COLUMNS}
            rows={state.logs}
            loading={state.loading}
            error={state.error}
            onRetry={load}
            searchable={false}
            pageSize={20}
            empty={{ title: "No audit logs found for current filters", icon: ScrollTextIcon }}
            caption="Audit logs"
            minWidth={1100}
          />
        </CardContent>
      </Card>
    </>
  );
}
