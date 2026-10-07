"use client";

import * as React from "react";
import { CalendarRangeIcon, ClipboardCopyIcon, FileSpreadsheetIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";

/*
 * Date-range timesheet (generateTimesheet / tsCopyTable / tsExportExcel,
 * public/legacy/js/employee.js): GET /api/employee/timesheet with the same
 * parameters; Copy and Excel act on the rows the search shows.
 */

const HEADERS = ["Date", "Day", "Shift Type", "Shift In", "Shift Out", "Time In", "Time Out", "Required Hours", "Tardiness", "Undertime", "Leave w/ Pay"];

const rowCells = (r) => [
  r.date, r.day, r.shift_type,
  r.shift_in || "", r.shift_out || "",
  r.time_in || "", r.time_out || "",
  r.required_hours, r.tardiness, r.undertime, r.leave_with_pay,
];

const ROW_TYPE = {
  rest: { label: "Rest day", tone: "muted", row: "bg-muted/50" },
  holiday: { label: "Holiday", tone: "gold", row: "bg-brand-gold/8" },
  special: { label: "Special", tone: "gold", row: "bg-brand-gold/5" },
  leave: { label: "Leave", tone: "info", row: "bg-info/5" },
};

const COLUMNS = [
  {
    key: "date",
    header: "Date",
    sortable: true,
    className: "font-medium",
    cell: (r) => (
      <span className="flex items-center gap-2">
        {r.date}
        {ROW_TYPE[r.row_type] ? <StatusBadge tone={ROW_TYPE[r.row_type].tone} dot={false} className="px-1.5 py-0 text-[10px]">{ROW_TYPE[r.row_type].label}</StatusBadge> : null}
      </span>
    ),
    searchValue: (r) => r.date,
  },
  { key: "day", header: "Day" },
  { key: "shift_type", header: "Shift type" },
  { key: "shift_in", header: "Shift in", className: "tabular-nums whitespace-nowrap", cell: (r) => r.shift_in || "" },
  { key: "shift_out", header: "Shift out", className: "tabular-nums whitespace-nowrap", cell: (r) => r.shift_out || "" },
  { key: "time_in", header: "Time in", className: "tabular-nums whitespace-nowrap", cell: (r) => r.time_in || "" },
  { key: "time_out", header: "Time out", className: "tabular-nums whitespace-nowrap", cell: (r) => r.time_out || "" },
  { key: "required_hours", header: "Required hours", align: "center", sortable: true },
  { key: "tardiness", header: "Tardiness", align: "center", sortable: true },
  { key: "undertime", header: "Undertime", align: "center", sortable: true },
  { key: "leave_with_pay", header: "Leave w/ pay", align: "center" },
];

// The search matches what the legacy search did: date, day, shift, times and status.
const SEARCH_COLUMNS = COLUMNS.map((column) => (["shift_in", "shift_out", "time_in", "time_out"].includes(column.key)
  ? { ...column, searchValue: (r) => r[column.key] }
  : column));

export function TimesheetPage() {
  const { ctx, notify } = usePortalSession();
  const today = manilaDateKey();
  const [start, setStart] = React.useState(`${today.slice(0, 7)}-01`);
  const [end, setEnd] = React.useState(today);
  const [errors, setErrors] = React.useState({});
  const [state, setState] = React.useState({ rows: [], loading: false, error: null, generated: false });

  async function generate(event) {
    event?.preventDefault();
    const next = {};
    if (!start) next.start = "Start date is required.";
    if (!end) next.end = "End date is required.";
    if (start && end && start > end) next.end = "End date must be on or after the start date.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setState((current) => ({ ...current, loading: true, error: null, generated: true }));
    try {
      const params = new URLSearchParams({ email: String(ctx?.email || "").trim(), start_date: start, end_date: end });
      const response = await apiFetch(`/api/employee/timesheet?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to load timesheet data.");
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setState({ rows: Array.isArray(data.records) ? data.records : [], loading: false, error: null, generated: true });
    } catch (error) {
      setState({ rows: [], loading: false, error: error.message, generated: true });
    }
  }

  function copy(rows) {
    if (!rows.length) return;
    const text = [HEADERS.join("\t"), ...rows.map((r) => rowCells(r).join("\t"))].join("\n");
    navigator.clipboard?.writeText(text)
      .then(() => notify("Copied", "Timesheet copied to clipboard.", "success"))
      .catch(() => notify("Copy failed", "Your browser blocked the clipboard. Use Excel instead.", "error"));
  }

  function exportCsv(rows) {
    if (!rows.length) return;
    const name = String(ctx?.full_name || "employee").trim().replace(/\s+/g, "_");
    // A cell starting with = + - @ (or tab / CR) runs as a formula in Excel;
    // a leading ' keeps it text. Plain numbers such as -12.50 are left alone.
    const csvText = (v) => {
      const s = String(v);
      return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    };
    const csv = [HEADERS, ...rows.map(rowCells)]
      .map((row) => row.map((v) => `"${csvText(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `timesheet_${name}_${start}_${end}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>Choose a date range</CardTitle>
          <CardDescription>Pick the first and last day, then generate your timesheet.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={generate} noValidate className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            <div className="space-y-2">
              <Label htmlFor="ts-start-date">Start date</Label>
              <DatePicker id="ts-start-date" value={start} onChange={setStart} aria-invalid={Boolean(errors.start) || undefined} />
              {errors.start ? <p className="text-sm text-destructive">{errors.start}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ts-end-date">End date</Label>
              <DatePicker id="ts-end-date" value={end} onChange={setEnd} aria-invalid={Boolean(errors.end) || undefined} />
              {errors.end ? <p className="text-sm text-destructive">{errors.end}</p> : null}
            </div>
            <Button type="submit" className="sm:mt-[1.375rem]" disabled={state.loading}>
              {state.loading ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Generating…</> : "Generate"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Timesheet</CardTitle>
          <CardDescription>Shift times, your taps, and the hours payroll counts.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={SEARCH_COLUMNS}
            rows={state.rows}
            loading={state.loading}
            error={state.error}
            onRetry={generate}
            rowKey={(r) => r.date}
            rowClassName={(r) => ROW_TYPE[r.row_type]?.row}
            searchPlaceholder="Search timesheet…"
            toolbar={(rows) => (
              <>
                <Button variant="outline" size="sm" onClick={() => copy(rows)} disabled={!rows.length}>
                  <ClipboardCopyIcon aria-hidden="true" />Copy
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportCsv(rows)} disabled={!rows.length}>
                  <FileSpreadsheetIcon aria-hidden="true" />Excel
                </Button>
              </>
            )}
            empty={state.generated
              ? { title: "No records found", description: "Nothing was recorded in this date range.", icon: CalendarRangeIcon }
              : { title: "No timesheet yet", description: "Select a date range above and click Generate.", icon: CalendarRangeIcon }}
            caption="Timesheet"
            minWidth={900}
          />
        </CardContent>
      </Card>
    </>
  );
}
