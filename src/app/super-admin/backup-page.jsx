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
import { useConfirm } from "@/components/portal/confirm-dialog";
import { usePortalSession } from "@/components/portal/session";
import { FullBackupCard, PRIVACY_TEXT, RestoreGuideCard, downloadFile } from "./backup-sections";
import { fetchJson } from "@/lib/portal/api";
import { downloadCsv } from "@/lib/portal/attendance";
import { manilaDateKey } from "@/lib/portal/format";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

// From the dashboard page, which carries the chart library: loaded on demand
// so this page does not pull recharts into the portal's first download.
const HealthList = dynamic(() => import("./dashboard-page").then((m) => m.HealthList));

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

// What the school can really do (Supabase Pro, 2026-11-08): daily backups
// kept 7 days, restored from the Supabase dashboard. Point-in-time recovery
// is a paid add-on that is NOT enabled.
const RECOVERY = [
  ["Database corruption or a bad bulk change", "Restore the latest daily backup (Supabase Pro keeps 7 days) from Supabase Dashboard → Database → Backups. Changes made after that backup are lost and must be re-entered from the Excel / CSV exports.", "30–60 min (system offline while restoring)", "Super Admin with the Supabase project owner"],
  ["Accidental deletion of a few records", "Row-level restore: re-enter the rows from the audit history (old values are logged) or from the latest Excel / CSV export on this page.", "10–30 min", "Super Admin"],
  ["Point-in-time recovery (to an exact minute)", "Not enabled. It is a paid Supabase add-on; restores go back to the last daily backup only.", "—", "—"],
  ["Auth service outage", "Check status.supabase.com; escalate to Supabase Support if it is not resolved.", "Varies", "Supabase Support"],
  ["Full system restore", "Restore the latest daily backup in the Supabase dashboard (or rebuild a project from the code's migrations), redeploy the app, then re-enter later changes from the Excel exports. Sign-in accounts come back only with a database backup.", "1–4 hours", "Development Team"],
];

// The status check lists every account; on a slow connection it must not spin forever.
const STATUS_TIMEOUT_MS = 20_000;

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
  const [confirmDialog, confirm] = useConfirm();
  const [state, setState] = React.useState({ loading: true, system: null, error: null });
  const [exporting, setExporting] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), STATUS_TIMEOUT_MS);
    try {
      const system = await fetchJson("/api/admin/system", { signal: abort.signal });
      setState({ loading: false, system, error: null });
    } catch (error) {
      // Always say why (2026-11-08): it used to show nothing but loading bars.
      const message = error.name === "AbortError"
        ? `The status check did not answer within ${STATUS_TIMEOUT_MS / 1000} seconds. Press Refresh to try again.`
        : error.status ? `The server answered with an error (${error.status}): ${error.message || "status unavailable"}`
          : `Could not reach the server: ${error.message || "offline"}`;
      setState({ loading: false, system: null, error: message });
    } finally {
      clearTimeout(timer);
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
      // Read-only, every branch, for backup (2026-11-08): the server and the
      // database check it is the Super Admin; it is recorded in the audit log.
      const ok = await confirm({
        title: "Export payroll for every branch?",
        description: `${PRIVACY_TEXT} The export is read-only and is recorded in the audit log.`,
        confirmLabel: "Export payroll CSV",
      });
      if (!ok) return;
      setExporting(type);
      setFeedback({ text: "Preparing payroll export…", tone: "" });
      try {
        const result = await downloadFile("/api/admin/backup/payroll?format=csv", {}, { fallbackName: `sacs-payroll-${manilaDateKey()}.csv` });
        setFeedback({ text: `Payroll export downloaded (${result.name}).`, tone: "success" });
        notify("Export ready", "The payroll CSV was downloaded. Keep it private.", "success");
      } catch (error) {
        setFeedback({ text: error.message || "Payroll export failed.", tone: "error" });
      } finally {
        setExporting("");
      }
      return;
    }
    setExporting(type);
    setFeedback({ text: `Preparing ${type} export…`, tone: "" });
    const date = manilaDateKey();
    try {
      // Demo people (is_demo, 2026-11-08) are left out of every export.
      const demo = new Set(type === "audit" ? [] : (await fetchJson("/api/admin/backup/full")).demo_ids || []);
      if (type === "employees") {
        const data = await fetchJson("/api/hr/employees?archived=true");
        downloadCsv(
          `sacs-employees-${date}.csv`,
          ["Full Name", "Employee ID", "Role", "Type", "Position", "Status", "Email", "Date of Birth"],
          (data.employees || []).filter((e) => !demo.has(String(e.id))).map((e) => [e.full_name || "", e.employee_id || "", e.role || "", e.employee_type || "", e.position || "", e.employee_status || "", e.email || "", e.date_of_birth || ""]),
        );
      } else if (type === "attendance") {
        const data = await fetchJson("/api/hr/attendance?view=all");
        downloadCsv(
          `sacs-attendance-${date}.csv`,
          ["Employee", "Type", "Date", "Time In", "Time Out", "Hours", "Status"],
          (data.logs || []).filter((l) => !demo.has(String(l.employee_id))).map((l) => [l.employee_name || "", l.employee_type || "", l.date || "", l.time_in || "", l.time_out || "", l.total_hours ?? l.hours_worked ?? "", l.status || ""]),
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
        <StatCard label="Backups" value="Daily, 7 days" hint="Supabase Pro daily backups, restored from Supabase Dashboard → Database → Backups. Point-in-time recovery: not enabled." icon={CloudIcon} tone="info" />
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
          <CardDescription>Download a snapshot of key system data for offline backup, compliance, or disaster recovery. Payroll covers every branch, read-only.</CardDescription>
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

      <FullBackupCard refreshKey={refreshKey} />
      <RestoreGuideCard />

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Recovery procedures</CardTitle>
          <CardDescription>Who to contact and how long each recovery usually takes. Daily backups (7 days) are on; point-in-time recovery is not enabled.</CardDescription>
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
                    <TableCell className="whitespace-normal tabular-nums">{time}</TableCell>
                    <TableCell className="whitespace-normal">{contact}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      {confirmDialog}
    </>
  );
}
