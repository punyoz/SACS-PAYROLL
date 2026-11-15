"use client";

import { PasswordInput } from "@/components/portal/password-input";
import * as React from "react";
import {
  AlertTriangleIcon, ArchiveRestoreIcon, ClipboardListIcon, DatabaseBackupIcon, DownloadIcon, FileArchiveIcon, Loader2Icon, LockKeyholeIcon,
  ReceiptTextIcon, RotateCcwIcon, ShieldAlertIcon, TableIcon, UsersIcon, XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";

/*
 * Backup & Recovery, Super Admin (2026-11-08; one CSV backup 2026-11-15):
 *   downloadFile      fetch a file the server streams, with progress, and save it
 *   BackupCard        the backup: everything (.zip of CSVs), quick CSVs, one group at a time
 *   RestoreGuideCard  what the files rebuild after a loss, and what they do not
 * Nothing is kept on the server: each file goes once to this browser.
 */

export const PRIVACY_TEXT = "This file contains salary and personal data, including government ID numbers (Data Privacy Act of 2012). Keep it private: store it encrypted and offline, and never email or share it.";

export { downloadFile } from "@/lib/portal/download";
import { downloadFile } from "@/lib/portal/download";

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
// About 120 bytes per row once compressed: only for the progress bar's estimate.
const estimateBytes = (rows) => Math.max(40_000, rows * 120);

// Shortcuts: each downloads its group's main CSV (the same columns as in the full backup).
const SHORTCUTS = [
  { group: "employees", file: "employees", label: "Employees", icon: UsersIcon },
  { group: "attendance", file: "attendance_logs", label: "Attendance", icon: ClipboardListIcon },
  { group: "payroll", file: "payroll_entries", label: "Payroll (payslips)", icon: ReceiptTextIcon },
  { group: "audit", file: "audit_logs", label: "Audit logs", icon: TableIcon },
];
const ALL_BRANCHES = "all";
const filterQuery = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

export function BackupCard({ refreshKey }) {
  const { notify } = usePortalSession();
  const [info, setInfo] = React.useState({ loading: true, error: null, data: null });
  const [filters, setFilters] = React.useState({ from: "", to: "", branch: "" });
  const [target, setTarget] = React.useState(null); // { groups, file?, label, rows }
  const [password, setPassword] = React.useState("");
  const [agreed, setAgreed] = React.useState(false);
  const [error, setError] = React.useState("");
  const [run, setRun] = React.useState(null); // { label, received, estimate, phase, started }
  const controller = React.useRef(null);

  const load = React.useCallback(async (applied) => {
    setInfo((c) => ({ ...c, loading: true, error: null }));
    try {
      const query = filterQuery(applied);
      setInfo({ loading: false, error: null, data: await fetchJson(`/api/admin/backup/full${query ? `?${query}` : ""}`) });
    } catch (err) {
      setInfo((c) => ({ loading: false, error: err.message || "Unable to load the backup groups.", data: c.data }));
    }
  }, []);
  // Counts follow the filters (a short pause while dates are typed).
  React.useEffect(() => {
    const timer = setTimeout(() => load(filters), 250);
    return () => clearTimeout(timer);
  }, [load, filters, refreshKey]);

  const data = info.data;
  const groups = data?.groups || [];
  const totalRows = groups.reduce((n, g) => n + (g.rows || 0), 0);
  const totalFiles = groups.reduce((n, g) => n + (g.files || 0), 0);
  const left = data?.limit?.left ?? null;
  const busy = Boolean(run) || left === 0 || !data;
  const filtered = Boolean(filters.from || filters.to || filters.branch);
  const branchName = data?.branches?.find((b) => b.id === filters.branch)?.name;
  const scope = `${branchName || "every branch"}${filters.from || filters.to ? `, ${filters.from || "the beginning"} to ${filters.to || "today"}` : ""}`;

  function ask(next) {
    setTarget(next);
    setPassword("");
    setAgreed(false);
    setError("");
  }

  async function start(event) {
    event.preventDefault();
    if (!password) { setError("Enter your password."); return; }
    if (!agreed) { setError("Confirm that you will keep the file private."); return; }
    const chosen = target;
    const abort = new AbortController();
    controller.current = abort;
    setError("");
    setRun({ label: chosen.label, received: 0, estimate: estimateBytes(chosen.rows || 0), phase: "Checking your password…", started: Date.now() });
    try {
      const body = { password, groups: chosen.groups, ...(chosen.file ? { file: chosen.file } : {}), filters };
      const result = await downloadFile("/api/admin/backup/full", jsonBody("POST", body), {
        signal: abort.signal,
        fallbackName: chosen.single ? "sacs-payroll.csv" : "sacs-payroll.zip",
        onProgress: (received) => setRun((c) => (c ? { ...c, received, phase: "Building and downloading the files…" } : c)),
      });
      setTarget(null);
      setPassword("");
      notify("Backup Downloaded", `${result.name} (${megabytes(result.bytes)}). Store it encrypted and offline.`, "success");
      await load(filters);
    } catch (err) {
      if (err.name === "AbortError") setError("Cancelled. Nothing was saved.");
      else setError(err.message || "The backup failed. Try again; if it keeps failing, download one group at a time.");
    } finally {
      setRun(null);
      controller.current = null;
    }
  }

  const percent = run ? Math.min(99, Math.round((run.received / run.estimate) * 100)) : 0;
  const countOf = (key) => Number(data?.counts?.[key] || 0);

  return (
    <Card className="min-w-0 shadow-xs" data-testid="backup">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><DatabaseBackupIcon className="size-4 text-gold-text" aria-hidden="true" />Backup</CardTitle>
        <CardDescription>Download a snapshot of system data as CSV files for offline backup, compliance or disaster recovery. Every branch. Read-only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert className="border-warning/40 bg-warning/5">
          <ShieldAlertIcon className="text-warning" aria-hidden="true" />
          <AlertTitle>Salary and personal data</AlertTitle>
          <AlertDescription>{PRIVACY_TEXT} You will be asked for your password; every download is recorded in the audit log. Nothing is kept on the server: each file goes once to this browser.</AlertDescription>
        </Alert>
        {data?.environment_label ? (
          <p className="rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm text-info">This is the {data.environment_label} environment: files are labelled {data.environment_label} and hold test data only.</p>
        ) : null}

        <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.4fr_auto] lg:items-end" data-testid="backup-filters">
          <legend className="px-1 text-sm font-medium">Filters (optional)</legend>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="backup-from">From</Label>
            <DatePicker id="backup-from" value={filters.from} onChange={(v) => setFilters((f) => ({ ...f, from: v || "" }))} max={filters.to || undefined} placeholder="The beginning" className="w-full" disabled={Boolean(run)} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="backup-to">To</Label>
            <DatePicker id="backup-to" value={filters.to} onChange={(v) => setFilters((f) => ({ ...f, to: v || "" }))} min={filters.from || undefined} placeholder="Today" className="w-full" disabled={Boolean(run)} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="backup-branch">Branch</Label>
            <Select value={filters.branch || ALL_BRANCHES} onValueChange={(v) => setFilters((f) => ({ ...f, branch: v === ALL_BRANCHES ? "" : v }))} disabled={Boolean(run)}>
              <SelectTrigger id="backup-branch" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_BRANCHES}>Every branch</SelectItem>
                {(data?.branches || []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={() => setFilters({ from: "", to: "", branch: "" })} disabled={!filtered || Boolean(run)}><RotateCcwIcon aria-hidden="true" />Clear</Button>
          <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
            Dates apply to attendance, leave, payroll and audit logs; the branch to every file that belongs to a branch. Default: everything. The filters are written in the README and the file name.
          </p>
        </fieldset>

        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium">Download everything</p>
            <p className="text-xs text-muted-foreground" data-testid="backup-total">
              {info.loading && !data ? "Counting rows…" : `One ZIP: ${totalFiles} CSV files + README · ${totalRows.toLocaleString("en-PH")} rows · ${scope}`}
              {left !== null ? ` · ${left} of ${data.limit.per_window} downloads left in ${data.limit.window_minutes} minutes` : ""}
            </p>
          </div>
          <Button onClick={() => ask({ groups: ["all"], label: "Everything", rows: totalRows })} disabled={busy}>
            <FileArchiveIcon aria-hidden="true" />Download everything (.zip)
          </Button>
        </div>
        {info.error ? <p role="alert" className="text-sm text-destructive">{info.error}</p> : null}

        <div>
          <p className="mb-2 text-sm font-medium">Quick downloads <span className="font-normal text-muted-foreground">(the main CSV of a group)</span></p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {SHORTCUTS.map(({ group, file, label: name, icon: Icon }) => (
              <Button key={file} variant="outline" className="justify-start" disabled={busy} aria-label={`Download ${name} CSV`}
                onClick={() => ask({ groups: [group], file, single: true, label: `${name} CSV`, rows: countOf(file) })}>
                <Icon aria-hidden="true" />{name}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{data ? countOf(file).toLocaleString("en-PH") : "…"}</span>
                <DownloadIcon className="opacity-60" aria-hidden="true" />
              </Button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Or one group at a time</p>
          <ul className="grid gap-2 md:grid-cols-2">
            {groups.map((g) => {
              const single = g.files === 1;
              return (
                <li key={g.key} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2" data-testid={`backup-group-${g.key}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{g.label}</p>
                    <p className="text-xs text-muted-foreground">{g.description}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-muted-foreground" data-testid="backup-group-count">
                      {g.files} file{g.files === 1 ? "" : "s"} · {Number(g.rows || 0).toLocaleString("en-PH")} rows
                      {g.key === "users" && data?.demo_accounts_left_out ? ` · ${data.demo_accounts_left_out} demo account${data.demo_accounts_left_out === 1 ? "" : "s"} left out` : ""}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" disabled={busy} aria-label={`Download ${g.label} (${single ? ".csv" : ".zip"})`}
                    onClick={() => ask({ groups: [g.key], single, label: g.label, rows: g.rows })}>
                    <DownloadIcon aria-hidden="true" />{single ? ".csv" : ".zip"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>

      <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open && !run) setTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={start} className="contents" noValidate>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><LockKeyholeIcon className="size-4 text-gold-text" aria-hidden="true" />Confirm it&apos;s you</DialogTitle>
              <DialogDescription>{target?.label}: {scope}. Re-enter your password to start the download.</DialogDescription>
            </DialogHeader>
            <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"><AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{PRIVACY_TEXT}</p>
            <div className="space-y-1.5">
              <Label htmlFor="backup-password">Your password</Label>
              <PasswordInput id="backup-password" autoComplete="current-password" value={password} onChange={(v) => { setPassword(v); setError(""); }} disabled={Boolean(run)} autoFocus />
            </div>
            <label className="flex min-h-10 cursor-pointer items-start gap-2 text-sm">
              <Checkbox checked={agreed} onCheckedChange={(v) => { setAgreed(Boolean(v)); setError(""); }} disabled={Boolean(run)} className="mt-0.5" aria-label="I will keep this file private" />
              <span>I will store this file encrypted and offline, and will not share it.</span>
            </label>
            {run ? (
              <div className="space-y-1.5" role="status" aria-live="polite" data-testid="backup-progress">
                <Progress value={percent} aria-label="Backup progress" />
                <p className="flex justify-between text-xs text-muted-foreground"><span>{run.phase}</span><span className="tabular-nums">{megabytes(run.received)}</span></p>
              </div>
            ) : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="gap-2 sm:gap-2">
              {run ? (
                <Button type="button" variant="outline" onClick={() => controller.current?.abort()}><XIcon aria-hidden="true" />Cancel download</Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => setTarget(null)}>Close</Button>
              )}
              <Button type="submit" disabled={Boolean(run)}>{run ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}{run ? "Downloading…" : "Download"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const RESTORE_STEPS = [
  ["What the files are", "One CSV per database table, readable columns first and the internal UUIDs last. employees.csv, users_and_accounts.csv, leave_balances.csv and pay_rates.csv are readable summaries."],
  ["Rebuilding lost rows", "Find the lost rows in the CSV of their table and give them to the developer to insert again. The UUID columns keep the links between tables. There is no import screen in the app."],
  ["After a full loss", "First restore the latest daily database backup in the Supabase dashboard; then use these files to re-enter anything changed after that backup."],
  ["Check before using", "README.txt in every ZIP lists each file's row count and SHA-256 checksum, the filters used and what every column means."],
];

const NOT_RESTORED = [
  "Sign-in accounts and passwords (people must be re-invited or given new passwords; the Users sheet lists who had an account)",
  "Files in Storage: profile photos, leave proofs, license scans",
  "The database structure, functions and security rules (those come from the migrations in the code repository)",
  "Sign-in codes, throttling and bell notifications (not backed up)",
];

export function RestoreGuideCard() {
  return (
    <Card className="min-w-0 shadow-xs" data-testid="restore-guide">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArchiveRestoreIcon className="size-4 text-gold-text" aria-hidden="true" />Restore guide</CardTitle>
        <CardDescription>How the exported files help rebuild data after a loss, and what they cannot restore.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <ol className="space-y-2 text-sm">
          {RESTORE_STEPS.map(([title, text], i) => (
            <li key={title} className="flex gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
              <span><span className="font-medium">{title}.</span> <span className="text-muted-foreground">{text}</span></span>
            </li>
          ))}
        </ol>
        <div className="rounded-lg border border-dashed p-3">
          <p className="text-sm font-medium">The files do NOT restore</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {NOT_RESTORED.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {/* Decided 2026-11-08. */}
          <p data-testid="uploads-not-included" className="mt-2 text-sm font-medium text-warning">Uploaded files are not included in this export and must be backed up separately.</p>
        </div>
      </CardContent>
    </Card>
  );
}
