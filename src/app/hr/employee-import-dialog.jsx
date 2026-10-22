"use client";

import * as React from "react";
import { DownloadIcon, FileUpIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { downloadCsv } from "@/lib/portal/attendance";
import { IMPORT_BATCH_SIZE, IMPORT_COLUMNS, IMPORT_MAX_ROWS, importTemplateCsv, readImportFile } from "@/lib/employees/csv-import";

/*
 * HR → User Management → Import CSV (POST /api/admin/employees/import;
 * scenarios SC-10 / HR-02). Download the template, fill one row per new
 * employee, check the file (nothing is created), then import the rows that
 * passed. Every row gets a result; the refused ones can be downloaded as an
 * error report, fixed and imported again.
 */

function downloadTemplate() {
  const blob = new Blob([`﻿${importTemplateCsv()}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sacs-employee-import-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function EmployeeImportDialog({ open, onOpenChange, onImported }) {
  const { notify } = usePortalSession();
  const [file, setFile] = React.useState(null);        // { name, rows, unknown, missing }
  const [results, setResults] = React.useState(null);  // [{ line, ok, name, email, error, employee_id }]
  const [phase, setPhase] = React.useState("idle");     // idle | checking | checked | importing | done
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) { setFile(null); setResults(null); setPhase("idle"); setProgress(0); setError(""); }
  }, [open]);

  async function pick(event) {
    const chosen = event.target.files?.[0];
    setResults(null); setPhase("idle"); setError("");
    if (!chosen) { setFile(null); return; }
    const parsed = readImportFile(await chosen.text());
    if (parsed.missing.length) setError(`Missing columns: ${parsed.missing.join(", ")}. Use the template.`);
    else if (!parsed.rows.length) setError("The file has no employee rows.");
    else if (parsed.rows.length > IMPORT_MAX_ROWS) setError(`At most ${IMPORT_MAX_ROWS} employees per file.`);
    setFile({ name: chosen.name, ...parsed });
  }

  async function check() {
    setPhase("checking"); setError("");
    try {
      const data = await fetchJson("/api/admin/employees/import", jsonBody("POST", { rows: file.rows, dry_run: true }));
      setResults(data.results || []);
      setPhase("checked");
    } catch (err) {
      setError(err.message || "The file could not be checked.");
      setPhase("idle");
    }
  }

  async function runImport() {
    const passed = new Set((results || []).filter((r) => r.ok).map((r) => r.line));
    const rows = file.rows.filter((row) => passed.has(row.line));
    const outcome = new Map((results || []).filter((r) => !r.ok).map((r) => [r.line, r]));
    setPhase("importing"); setProgress(0); setError("");
    for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
      const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
      try {
        const data = await fetchJson("/api/admin/employees/import", jsonBody("POST", { rows: batch }));
        (data.results || []).forEach((r) => outcome.set(r.line, r));
      } catch (err) {
        batch.forEach((row) => outcome.set(row.line, { line: row.line, ok: false, name: `${row.values.first_name || ""} ${row.values.last_name || ""}`.trim(), email: row.values.email, error: err.message || "Not created." }));
      }
      setProgress(Math.round(((i + batch.length) / rows.length) * 100));
    }
    const all = [...outcome.values()].sort((a, b) => a.line - b.line);
    setResults(all);
    setPhase("done");
    const created = all.filter((r) => r.ok).length;
    notify("Import Finished", `${created} employee${created === 1 ? "" : "s"} created${all.length - created ? `, ${all.length - created} refused (see the report)` : ""}.`, created ? "success" : "error");
    if (created) onImported?.();
  }

  function downloadReport() {
    downloadCsv("sacs-employee-import-report.csv", ["Line", "Name", "Email", "Result", "Employee ID / reason"],
      (results || []).map((r) => [r.line, r.name, r.email, r.ok ? (phase === "done" ? "Created" : "OK") : "Refused", r.ok ? r.employee_id || "" : r.error]));
  }

  const ok = (results || []).filter((r) => r.ok).length;
  const refused = (results || []).length - ok;
  const busy = phase === "checking" || phase === "importing";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import employees from CSV</DialogTitle>
          <DialogDescription>One row per new employee, with the same fields as Add employee ({IMPORT_COLUMNS.length} columns). Check the file first: nothing is created until you import. Each new employee gets an ID and the default password, as when added by hand.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="outline" onClick={downloadTemplate}><DownloadIcon aria-hidden="true" />Download template</Button>
            <div className="min-w-60 flex-1 space-y-1.5">
              <Label htmlFor="emp-import-file">CSV file</Label>
              <Input id="emp-import-file" type="file" accept=".csv,text/csv" onChange={pick} disabled={busy} />
            </div>
          </div>
          {file ? <p className="text-sm text-muted-foreground">{file.name}: {file.rows.length} row{file.rows.length === 1 ? "" : "s"}{file.unknown.length ? ` · ignored columns: ${file.unknown.join(", ")}` : ""}</p> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {phase === "importing" ? <div className="space-y-1"><Progress value={progress} aria-label="Import progress" /><p className="text-xs text-muted-foreground">{progress}%</p></div> : null}
          {results ? (
            <div className="space-y-2">
              <p className="text-sm">
                <StatusBadge tone="success">{ok} {phase === "done" ? "created" : "ready"}</StatusBadge>{" "}
                {refused ? <StatusBadge tone="danger">{refused} refused</StatusBadge> : null}
              </p>
              {refused ? (
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
                  {results.filter((r) => !r.ok).map((r) => <li key={r.line}><span className="font-medium">Line {r.line}</span> {r.name ? `(${r.name})` : ""}: {r.error}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {results ? <Button variant="outline" onClick={downloadReport}><DownloadIcon aria-hidden="true" />Download report</Button> : null}
          {phase === "checked" && ok ? (
            <Button onClick={runImport}><FileUpIcon aria-hidden="true" />Import {ok} employee{ok === 1 ? "" : "s"}</Button>
          ) : phase !== "done" ? (
            <Button onClick={check} disabled={!file || Boolean(error) || busy}>{phase === "checking" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Check file</Button>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
