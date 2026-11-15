"use client";

import * as React from "react";
import {
  CheckCircle2Icon,
  ClipboardListIcon,
  CloudIcon,
  DatabaseIcon,
  InfoIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/portal/stat-card";
import { BackupCard, RestoreGuideCard } from "./backup-sections";
import { fetchJson } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

// From the dashboard page, which carries the chart library: loaded on demand
// so this page does not pull recharts into the portal's first download.
const HealthList = dynamic(() => import("./dashboard-page").then((m) => m.HealthList));

/*
 * Backup & Recovery (loadSABackupStatus / exportSAData,
 * public/legacy/js/super-admin.js). Backups themselves are managed by
 * Supabase and are not visible to the app; this page reports only what it
 * checks (GET /api/admin/system) and offers the CSV backup.
 */

// What the school can really do (Supabase Pro, 2026-11-08): daily backups
// kept 7 days, restored from the Supabase dashboard. Point-in-time recovery
// is a paid add-on that is NOT enabled.
const RECOVERY = [
  ["Database corruption or a bad bulk change", "Restore the latest daily backup (Supabase Pro keeps 7 days) from Supabase Dashboard → Database → Backups. Changes made after that backup are lost and must be re-entered from the CSV backup.", "30–60 min (system offline while restoring)", "Super Admin with the Supabase project owner"],
  ["Accidental deletion of a few records", "Row-level restore: re-enter the rows from the audit history (old values are logged) or from the latest CSV backup on this page.", "10–30 min", "Super Admin"],
  ["Point-in-time recovery (to an exact minute)", "Not enabled. It is a paid Supabase add-on; restores go back to the last daily backup only.", "—", "—"],
  ["Auth service outage", "Check status.supabase.com; escalate to Supabase Support if it is not resolved.", "Varies", "Supabase Support"],
  ["Full system restore", "Restore the latest daily backup in the Supabase dashboard (or rebuild a project from the code's migrations), redeploy the app, then re-enter later changes from the CSV backup. Sign-in accounts come back only with a database backup.", "1–4 hours", "Development Team"],
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
  const [state, setState] = React.useState({ loading: true, system: null, error: null });

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

  return (
    <>
      <Alert className="border-info/30 bg-info/5">
        <InfoIcon className="text-info" aria-hidden="true" />
        <AlertDescription>Database backups are managed through Supabase. The CSV backup below is for emergency use and compliance archiving.</AlertDescription>
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

      <BackupCard refreshKey={refreshKey} />
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
    </>
  );
}
