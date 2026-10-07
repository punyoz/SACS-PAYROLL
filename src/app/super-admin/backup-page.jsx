"use client";

import * as React from "react";
import {
  CheckCircle2Icon,
  ClipboardListIcon,
  CloudIcon,
  DatabaseIcon,
  DownloadIcon,
  InfoIcon,
  Loader2Icon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SettingsIcon,
  TableIcon,
  UsersIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson } from "@/lib/portal/api";
import { downloadCsv } from "@/lib/portal/attendance";
import { manilaDateKey } from "@/lib/portal/format";
import { cn } from "@/lib/utils";
import { HealthList } from "./dashboard-page";

/*
 * Backup & Recovery (loadSABackupStatus / exportSAData,
 * public/legacy/js/super-admin.js). Backups themselves are managed by
 * Supabase and are not visible to the app; this page reports only what it
 * checks (GET /api/admin/system) and offers CSV exports.
 */

const EXPORTS = [
  { type: "employees", label: "Employees", icon: UsersIcon },
  { type: "attendance", label: "Attendance", icon: ClipboardListIcon },
  { type: "payroll", label: "Payroll", icon: ReceiptTextIcon },
  { type: "audit", label: "Audit logs", icon: TableIcon },
];

const RECOVERY = [
  ["Database corruption", "Point-in-time restore via Supabase Dashboard", "30–60 min", "Supabase Support"],
  ["Accidental data deletion", "Row-level restore from audit history or CSV backup", "10–30 min", "Super Admin"],
  ["Auth service outage", "Supabase status page → escalate if unresolved", "Varies", "Supabase Support"],
  ["Full system restore", "Restore from Supabase backup snapshot", "1–4 hours", "Development Team"],
];

function serviceRows(system, error) {
  if (error) return [{ key: "db", icon: DatabaseIcon, label: "Supabase database", meta: error, pill: "Error", tone: "danger" }];
  if (!system) return [{ key: "db", icon: DatabaseIcon, label: "Supabase database", meta: "Could not reach system endpoint", pill: "Error", tone: "danger" }];
  const db = system.database_status || {};
  const dbOk = db.connection === "ok";
  const table = (key) => (db[key] === "ok"
    ? { meta: "Table available", pill: "Active", tone: "success" }
    : { meta: "Table missing", pill: "Missing", tone: "warning" });
  return [
    { key: "db", icon: DatabaseIcon, label: "Supabase database", meta: dbOk ? "Connection verified" : "Connection error", pill: dbOk ? "Online" : "Error", tone: dbOk ? "success" : "danger" },
    { key: "att", icon: ClipboardListIcon, label: "Attendance logs table", ...table("attendance_logs") },
    { key: "pay", icon: ReceiptTextIcon, label: "Payroll records table", ...table("payroll_records") },
    { key: "prof", icon: UsersIcon, label: "Profiles table", meta: `${system.system_stats?.total_users ?? "—"} accounts`, pill: "Active", tone: "success" },
    { key: "cfg", icon: SettingsIcon, label: "System configuration table", ...table("system_config") },
  ];
}

export function BackupPage({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, system: null, error: null });
  const [exporting, setExporting] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const system = await fetchJson("/api/admin/system");
      setState({ loading: false, system, error: null });
    } catch (error) {
      // A reply that is not OK reads as "could not reach"; no reply at all as offline.
      setState({ loading: false, system: null, error: error.status ? null : (error.message || "Offline") });
    }
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const db = state.system?.database_status || {};
  const dbOk = db.connection === "ok";
  const tablesOk = ["attendance_logs", "payroll_records", "system_config"].every((key) => db[key] === "ok");
  const dbStatus = state.error ? "Offline" : !state.system ? "Error" : dbOk ? "Connected" : "Error";
  const integrity = !state.system || !dbOk ? "Unknown" : tablesOk ? "All reachable" : "Missing";

  async function exportData(type) {
    if (type === "payroll") {
      setFeedback({ text: "Payroll export requires accountant portal access.", tone: "warning" });
      return;
    }
    setExporting(type);
    setFeedback({ text: `Preparing ${type} export…`, tone: "" });
    const date = manilaDateKey();
    try {
      if (type === "employees") {
        const data = await fetchJson("/api/hr/employees?archived=true");
        downloadCsv(
          `sacs-employees-${date}.csv`,
          ["Full Name", "Employee ID", "Role", "Type", "Position", "Status", "Email", "Date of Birth"],
          (data.employees || []).map((e) => [e.full_name || "", e.employee_id || "", e.role || "", e.employee_type || "", e.position || "", e.employee_status || "", e.email || "", e.date_of_birth || ""]),
        );
      } else if (type === "attendance") {
        const data = await fetchJson("/api/hr/attendance?view=all");
        downloadCsv(
          `sacs-attendance-${date}.csv`,
          ["Employee", "Type", "Date", "Time In", "Time Out", "Hours", "Status"],
          (data.logs || []).map((l) => [l.employee_name || "", l.employee_type || "", l.date || "", l.time_in || "", l.time_out || "", l.total_hours ?? l.hours_worked ?? "", l.status || ""]),
        );
      } else {
        const data = await fetchJson("/api/admin/audit-logs?limit=1000");
        downloadCsv(
          `sacs-audit-${date}.csv`,
          ["Timestamp", "Module", "Action", "Entity Type", "Entity ID", "Description", "Status", "Source"],
          (data.logs || []).map((l) => [l.timestamp || l.created_at || "", l.module || "", l.action || "", l.entity_type || "", l.entity_id || "", l.description || "", l.status || "", l.source || ""]),
        );
      }
      setFeedback({ text: `${type} export downloaded successfully.`, tone: "success" });
      notify("Export ready", `The ${type} CSV was downloaded.`, "success");
    } catch (error) {
      setFeedback({ text: error.message || "Export failed.", tone: "error" });
    } finally {
      setExporting("");
    }
  }

  return (
    <>
      <Alert className="border-info/30 bg-info/5">
        <InfoIcon className="text-info" aria-hidden="true" />
        <AlertDescription>Database backups are managed through Supabase. Manual exports below are for emergency use and compliance archiving.</AlertDescription>
      </Alert>

      <section aria-label="Backup status" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Backups" value="Supabase" hint="Not visible to this app. Check Supabase Dashboard → Database → Backups." icon={CloudIcon} tone="info" />
        <StatCard label="Database status" value={dbStatus} hint="Supabase connection" icon={DatabaseIcon} tone={dbStatus === "Connected" ? "success" : "danger"} loading={state.loading && !state.system} />
        <StatCard label="Core tables" value={integrity} hint="Attendance, payroll and configuration tables reachable" icon={CheckCircle2Icon} tone={integrity === "All reachable" ? "success" : "warning"} loading={state.loading && !state.system} />
      </section>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Service status</CardTitle>
          <CardDescription>What the app can reach right now</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <HealthList rows={serviceRows(state.system, state.error)} loading={state.loading && !state.system && !state.error} />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Manual data export</CardTitle>
          <CardDescription>Download a snapshot of key system data for offline backup, compliance, or disaster recovery.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {EXPORTS.map(({ type, label, icon: Icon }) => (
              <Button key={type} variant="outline" className="justify-start" onClick={() => exportData(type)} disabled={Boolean(exporting)}>
                {exporting === type ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
                Export {label} CSV
                <DownloadIcon className="ml-auto opacity-60" aria-hidden="true" />
              </Button>
            ))}
          </div>
          <p
            role="status"
            aria-live="polite"
            className={cn("min-h-5 text-sm first-letter:uppercase", {
              "text-success": feedback.tone === "success",
              "text-destructive": feedback.tone === "error",
              "text-warning": feedback.tone === "warning",
              "text-muted-foreground": !feedback.tone,
            })}
          >
            {feedback.text}
          </p>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Recovery procedures</CardTitle>
          <CardDescription>Who to contact and how long each recovery usually takes</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-160">
              <TableCaption className="sr-only">Recovery procedures</TableCaption>
              <TableHeader>
                <TableRow><TableHead>Scenario</TableHead><TableHead>Action</TableHead><TableHead>Estimated time</TableHead><TableHead>Contact</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {RECOVERY.map(([scenario, action, time, contact]) => (
                  <TableRow key={scenario}>
                    <TableCell className="font-medium">{scenario}</TableCell>
                    <TableCell className="whitespace-normal">{action}</TableCell>
                    <TableCell className="tabular-nums">{time}</TableCell>
                    <TableCell>{contact}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
