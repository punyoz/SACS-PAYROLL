"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { CheckCircle2Icon, ClockAlertIcon, DownloadIcon, FileBarChartIcon, ListIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BranchGroupedTable } from "@/components/portal/branch-grouped-table";
import { DatePicker } from "@/components/portal/date-picker";
import { EmptyState } from "@/components/portal/empty-state";
import { StatCard } from "@/components/portal/stat-card";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson } from "@/lib/portal/api";
import { downloadCsv } from "@/lib/portal/attendance";

/*
 * HR Reports (loadHRReports / exportHRReportCsv, public/legacy/js/hr.js):
 * GET /api/hr/reports?type=attendance&from=&to= or ?type=employees. Rows
 * are grouped by branch (Unassigned last), then employee name.
 */

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Branch name A–Z with Unassigned last, then employee (hrReportSortByBranch). */
function sortByBranch(records, nameKey) {
  const branchKey = (r) => (r.branch_id ? r.branch_name || "Unknown branch" : "￿");
  return [...records].sort((a, b) => branchKey(a).localeCompare(branchKey(b)) || String(a[nameKey] || "").localeCompare(String(b[nameKey] || "")));
}

const ATT_CHART = {
  present: { label: "Present", color: "var(--chart-1)" },
  late: { label: "Late", color: "var(--chart-2)" },
  absent: { label: "Absent", color: "var(--destructive)" },
};

export function ReportsPage() {
  const { notify } = usePortalSession();
  const [type, setType] = React.useState("attendance");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState(localDateKey());
  const [state, setState] = React.useState({ loading: false, error: null, type: null, rows: [], meta: {}, from: "", to: "" });

  async function generate(event) {
    event?.preventDefault();
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      let url = `/api/hr/reports?type=${type}`;
      const toKey = to || localDateKey();
      if (type === "attendance") {
        if (from) url += `&from=${from}`;
        url += `&to=${toKey}`;
      }
      const data = await fetchJson(url);
      const rows = sortByBranch(data.records || [], type === "attendance" ? "employee_name" : "full_name");
      setState({ loading: false, error: null, type, rows, meta: data, from, to: toKey });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message || "Failed to load report." }));
    }
  }

  function exportCsv() {
    if (!state.rows.length) { notify("Nothing to export", "No report data to export. Generate a report first.", "info"); return; }
    if (state.type === "attendance") {
      downloadCsv(`sacs-hr-attendance-report-${localDateKey()}.csv`,
        ["Branch", "Employee", "Type", "Present", "Late", "Absent", "On Leave", "Total Hours"],
        state.rows.map((r) => [r.branch_name || "", r.employee_name || "", r.employee_type || "", r.present ?? 0, r.late ?? 0, r.absent ?? 0, r.on_leave ?? 0, Number(r.total_hours || 0).toFixed(2)]));
    } else {
      downloadCsv(`sacs-hr-employees-report-${localDateKey()}.csv`,
        ["Branch", "Employee", "ID", "Type", "Position", "Status", "Email"],
        state.rows.map((r) => [r.branch_name || "", r.full_name || "", r.employee_id || "", r.employee_type || "", r.position || "", r.employee_status || "", r.email || ""]));
    }
  }

  const isAttendance = state.type === "attendance";
  const sum = (key) => state.rows.reduce((s, r) => s + (r[key] || 0), 0);
  const stats = state.type === null ? null : isAttendance
    ? [["Total records", state.rows.length, ListIcon, "primary"], ["Present days", sum("present"), CheckCircle2Icon, "success"], ["Late days", sum("late"), ClockAlertIcon, "gold"], ["Absent days", sum("absent"), XCircleIcon, "danger"]]
    : [["Total records", state.meta.total || state.rows.length, ListIcon, "primary"], ["Active", state.meta.active ?? 0, CheckCircle2Icon, "success"], ["Archived", state.meta.archived ?? 0, XCircleIcon, "danger"], ["Teaching", state.rows.filter((r) => r.employee_type?.toLowerCase() === "teaching").length, FileBarChartIcon, "gold"]];

  // Totals per branch, for the chart.
  const byBranch = React.useMemo(() => {
    if (!isAttendance) return [];
    const map = new Map();
    state.rows.forEach((r) => {
      const key = r.branch_name || "Unassigned";
      const entry = map.get(key) || { branch: key, present: 0, late: 0, absent: 0 };
      entry.present += r.present || 0;
      entry.late += r.late || 0;
      entry.absent += r.absent || 0;
      map.set(key, entry);
    });
    return [...map.values()];
  }, [state.rows, isAttendance]);

  const columns = isAttendance ? [
    { key: "employee_name", header: "Employee", className: "font-medium", cell: (r) => r.employee_name || "—" },
    { key: "employee_type", header: "Type", cell: (r) => r.employee_type || "—" },
    { key: "present", header: "Present", align: "right", className: "tabular-nums text-success", cell: (r) => r.present ?? 0 },
    { key: "late", header: "Late", align: "right", className: "tabular-nums text-warning", cell: (r) => r.late ?? 0 },
    { key: "absent", header: "Absent", align: "right", className: "tabular-nums text-destructive", cell: (r) => r.absent ?? 0 },
    { key: "on_leave", header: "On leave", align: "right", className: "tabular-nums text-info", cell: (r) => r.on_leave ?? 0 },
    { key: "hours", header: "Total hours", align: "right", className: "tabular-nums", cell: (r) => `${Number(r.total_hours || 0).toFixed(1)}h` },
  ] : [
    { key: "full_name", header: "Employee", className: "font-medium", cell: (r) => <>{r.full_name || "—"}{r.archived ? <span className="ml-1 text-xs text-destructive">(Archived)</span> : null}</> },
    { key: "employee_id", header: "ID", className: "font-mono text-xs", cell: (r) => r.employee_id || "—" },
    { key: "employee_type", header: "Type", cell: (r) => r.employee_type || "—" },
    { key: "position", header: "Position", cell: (r) => r.position || "—" },
    { key: "status", header: "Status", cell: (r) => r.employee_status || "Active" },
    { key: "email", header: "Email", className: "text-xs text-muted-foreground", cell: (r) => r.email || "—" },
  ];

  return (
    <>
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>Report options</CardTitle>
          <CardDescription>Choose a report and, for attendance, a date range.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={generate} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
            <div className="space-y-2">
              <Label htmlFor="hr-report-type">Report type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="hr-report-type" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="attendance">Attendance report</SelectItem>
                  <SelectItem value="employees">Employee records</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === "attendance" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="hr-report-from">From date</Label>
                  <DatePicker id="hr-report-from" value={from} onChange={setFrom} placeholder="Start of records" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hr-report-to">To date</Label>
                  <DatePicker id="hr-report-to" value={to} onChange={setTo} />
                </div>
              </>
            ) : <div className="hidden md:col-span-2 md:block" />}
            <Button type="submit" disabled={state.loading}>{state.loading ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Generating…</> : "Generate"}</Button>
          </form>
        </CardContent>
      </Card>

      {stats ? (
        <section aria-label="Report summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map(([label, value, Icon, tone]) => <StatCard key={label} label={label} value={value} icon={Icon} tone={tone} loading={state.loading} />)}
        </section>
      ) : null}

      {isAttendance && byBranch.length ? (
        <Card className="min-w-0 shadow-xs">
          <CardHeader>
            <CardTitle>Attendance by branch</CardTitle>
            <CardDescription>Days present, late and absent{state.from ? ` · ${state.from} to ${state.to}` : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={ATT_CHART} className="h-[260px] w-full">
              <BarChart accessibilityLayer data={byBranch} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="branch" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} fontSize={11} />
                <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="present" fill="var(--color-present)" radius={[4, 4, 0, 0]} maxBarSize={36} />
                <Bar dataKey="late" fill="var(--color-late)" radius={[4, 4, 0, 0]} maxBarSize={36} />
                <Bar dataKey="absent" fill="var(--color-absent)" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      ) : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>{state.type === null ? "Report results" : isAttendance ? `Attendance report${state.from ? ` · ${state.from} to ${state.to}` : ""}` : "Employee records report"}</CardTitle>
        </CardHeader>
        <CardContent>
          {state.type === null && !state.loading && !state.error ? (
            <EmptyState icon={FileBarChartIcon} title="No report yet" description="Choose the options above and select Generate." />
          ) : (
            <BranchGroupedTable
              key={state.type}
              columns={columns}
              rows={state.rows}
              groupOf={(r) => r.branch_name || ""}
              groupLabel={(key) => key || "Unassigned"}
              search={(r) => [r.employee_name, r.full_name, r.employee_id, r.branch_name, r.employee_type, r.position, r.email].join(" ")}
              searchPlaceholder="Search name, ID, branch, type, position or email…"
              loading={state.loading}
              error={state.error}
              onRetry={generate}
              toolbar={<Button variant="outline" size="sm" onClick={exportCsv} disabled={!state.rows.length}><DownloadIcon aria-hidden="true" />Export CSV</Button>}
              caption="Report results"
              minWidth={760}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
