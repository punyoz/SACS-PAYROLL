"use client";

import * as React from "react";
import {
  AlertTriangleIcon, ArchiveRestoreIcon, DatabaseBackupIcon, DownloadIcon, FileSpreadsheetIcon, Loader2Icon, LockKeyholeIcon, ShieldAlertIcon, XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";

/*
 * Backup & Recovery, Super Admin (2026-11-08):
 *   downloadFile      fetch a file the server streams, with progress, and save it
 *   FullBackupCard    the full data backup (.xlsx) and one group at a time
 *   RestoreGuideCard  what the files rebuild after a loss, and what they do not
 * Nothing is kept on the server: each file goes once to this browser.
 */

export const PRIVACY_TEXT = "This file contains salary and personal data, including government ID numbers (Data Privacy Act of 2012). Keep it private: store it encrypted and offline, and never email or share it.";

export { downloadFile } from "@/lib/portal/download";
import { downloadFile } from "@/lib/portal/download";

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
// About 120 bytes per row once compressed: only for the progress bar's estimate.
const estimateBytes = (rows) => Math.max(40_000, rows * 120);

export function FullBackupCard({ refreshKey }) {
  const { notify } = usePortalSession();
  const [info, setInfo] = React.useState({ loading: true, error: null, data: null });
  const [target, setTarget] = React.useState(null); // { key: "all" | group key, label, rows }
  const [password, setPassword] = React.useState("");
  const [agreed, setAgreed] = React.useState(false);
  const [error, setError] = React.useState("");
  const [run, setRun] = React.useState(null); // { label, received, estimate, phase, started }
  const controller = React.useRef(null);

  const load = React.useCallback(async () => {
    setInfo((c) => ({ ...c, loading: true, error: null }));
    try {
      setInfo({ loading: false, error: null, data: await fetchJson("/api/admin/backup/full") });
    } catch (err) {
      setInfo((c) => ({ loading: false, error: err.message || "Unable to load the backup groups.", data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = info.data;
  const totalRows = (data?.groups || []).reduce((n, g) => n + (g.rows || 0), 0);
  const left = data?.limit?.left ?? null;

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
      const result = await downloadFile("/api/admin/backup/full", jsonBody("POST", { password, groups: [chosen.key] }), {
        signal: abort.signal,
        fallbackName: "sacs-backup.xlsx",
        onProgress: (received) => setRun((c) => (c ? { ...c, received, phase: "Building and downloading the workbook…" } : c)),
      });
      setTarget(null);
      setPassword("");
      notify("Backup Downloaded", `${result.name} (${megabytes(result.bytes)}). Store it encrypted and offline.`, "success");
      await load();
    } catch (err) {
      if (err.name === "AbortError") {
        setError("Cancelled. Nothing was saved.");
      } else {
        setError(err.message || "The backup failed. Try again; if it keeps failing, download one group at a time.");
      }
    } finally {
      setRun(null);
      controller.current = null;
    }
  }

  const percent = run ? Math.min(99, Math.round((run.received / run.estimate) * 100)) : 0;

  return (
    <Card className="min-w-0 shadow-xs" data-testid="full-backup">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><DatabaseBackupIcon className="size-4 text-gold-text" aria-hidden="true" />Full data backup</CardTitle>
        <CardDescription>
          For emergencies such as data loss: an Excel workbook (.xlsx) with one sheet per table, for every branch. Built on the server in batches
          and sent once to this browser; nothing is kept on the server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert className="border-warning/40 bg-warning/5">
          <ShieldAlertIcon className="text-warning" aria-hidden="true" />
          <AlertTitle>Salary and personal data</AlertTitle>
          <AlertDescription>{PRIVACY_TEXT} You will be asked for your password; every download is recorded in the audit log.</AlertDescription>
        </Alert>
        {data?.environment_label ? (
          <p className="rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm text-info">This is the {data.environment_label} environment: files are labelled {data.environment_label} and hold test data only.</p>
        ) : null}
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium">Everything, every branch</p>
            <p className="text-xs text-muted-foreground">
              {info.loading && !data ? "Counting rows…" : `${(data?.groups || []).length} groups · ${totalRows.toLocaleString("en-PH")} rows`}
              {left !== null ? ` · ${left} of ${data.limit.per_window} downloads left in ${data.limit.window_minutes} minutes` : ""}
            </p>
          </div>
          <Button onClick={() => ask({ key: "all", label: "Full backup (all groups)", rows: totalRows })} disabled={!data || Boolean(run) || left === 0}>
            <FileSpreadsheetIcon aria-hidden="true" />Download full backup (.xlsx)
          </Button>
        </div>
        {info.error && !data ? <p role="alert" className="text-sm text-destructive">{info.error}</p> : null}
        <div>
          <p className="mb-2 text-sm font-medium">Or one group at a time</p>
          <ul className="grid gap-2 md:grid-cols-2">
            {(data?.groups || []).map((g) => (
              <li key={g.key} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{g.label}</p>
                  <p className="text-xs text-muted-foreground">{g.description}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{g.tables.length + g.computed.length} sheet{g.tables.length + g.computed.length === 1 ? "" : "s"} · {Number(g.rows || 0).toLocaleString("en-PH")} rows</p>
                </div>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => ask({ key: g.key, label: g.label, rows: g.rows })} disabled={Boolean(run) || left === 0} aria-label={`Download ${g.label} (.xlsx)`}>
                  <DownloadIcon aria-hidden="true" />.xlsx
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>

      <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open && !run) setTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={start} className="contents" noValidate>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><LockKeyholeIcon className="size-4 text-gold-text" aria-hidden="true" />Confirm it&apos;s you</DialogTitle>
              <DialogDescription>{target?.label}: every branch. Re-enter your password to start the download.</DialogDescription>
            </DialogHeader>
            <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"><AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{PRIVACY_TEXT}</p>
            <div className="space-y-1.5">
              <Label htmlFor="backup-password">Your password</Label>
              <Input id="backup-password" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} disabled={Boolean(run)} autoFocus />
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
  ["What the files are", "Each table sheet is a copy of one database table, with the database's own column names and values, every branch. The Employees, Users, Leave balances and Pay rates sheets are readable summaries."],
  ["Rebuilding lost rows", "Find the lost rows in the sheet of their table and give them to the developer (or the Supabase table editor's CSV import) to insert again. The ID columns keep the links between tables."],
  ["After a full loss", "First restore the latest daily database backup in the Supabase dashboard; then use these files to re-enter anything changed after that backup."],
  ["Check before using", "The last sheet, Row counts, compares the rows in the file with the database at the time it was made."],
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
