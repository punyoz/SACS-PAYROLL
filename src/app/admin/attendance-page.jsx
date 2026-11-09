"use client";

import * as React from "react";
import { CalendarCheckIcon, FlagIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/portal/data-table";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { formatTime, manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { DecisionCell, FileDialog, FiledCell, HistoryButton, RequestStatus, fileRequest, useBranchView } from "./oversight-shared";
import { useUrlRange } from "@/components/portal/date-range-filter";
import { useUrlParam } from "@/components/portal/use-url-param";
import { AttendanceView } from "@/components/portal/attendance/attendance-view";
import { defaultRange } from "@/lib/portal/date-range";

/*
 * Branch Attendance (GET /api/admin/branch-oversight?view=attendance):
 * read-only daily or monthly logs of the Admin's branch. "Flag issue" sends a
 * record to HR with a note (Pending until HR marks it Resolved); the Admin
 * never edits a log.
 */

export function AttendancePage({ refreshKey }) {
  const { notify } = usePortalSession();
  const today = manilaDateKey();
  // The shared attendance view (redesign 2026-11-09): own branch only (the
  // server limits it), This cutoff by default, range and filters in the address.
  const fallback = React.useMemo(() => defaultRange(), []);
  const [range, setRange] = useUrlRange("adm_att", fallback);
  const [tab, setTab] = useUrlParam("adm_att_tab", "all");
  const [status, setStatus] = useUrlParam("adm_att_status", "all");
  const [day, setDay] = useUrlParam("adm_att_day", "all");
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [paging, setPaging] = React.useState({ page: 1, pageSize: 25 });
  React.useEffect(() => {
    const timer = setTimeout(() => { setQ(search.trim()); setPaging((c) => ({ ...c, page: 1 })); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const [target, setTarget] = React.useState(null);
  const from = range.from;
  const to = range.to > today ? today : range.to;
  const view = useBranchView("attendance", {
    from, to, page: paging.page, page_size: paging.pageSize, q,
    status: status === "all" ? "" : status, day: day === "all" ? "" : day,
  }, refreshKey);
  const data = view.data;
  const page = (fn) => (v) => { fn(v); setPaging((c) => ({ ...c, page: 1 })); };
  const exportQuery = new URLSearchParams({ view: "attendance", from, to, ...(q ? { q } : {}), ...(status !== "all" ? { status } : {}), ...(day !== "all" ? { day } : {}) });

  const columns = [
    { key: "employee_name", header: "Employee", mobilePrimary: true, className: "font-medium", cell: (l) => <div><p>{l.employee_name}</p><p className="text-xs text-muted-foreground">{l.employee_code}</p></div>, searchValue: (l) => `${l.employee_name} ${l.employee_code}` },
    { key: "log_date", header: "Date", className: "whitespace-nowrap tabular-nums", cell: (l) => dateLabel(l.log_date) },
    { key: "time_in", header: "Time in", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (l.time_in ? formatTime(l.time_in) : "—") },
    { key: "time_out", header: "Time out", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (l.time_out ? formatTime(l.time_out) : "—") },
    { key: "hours", header: "Hours", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (Number(l.total_hours) ? Number(l.total_hours).toFixed(2) : "—") },
    { key: "time", header: "Time", mobileOnly: true, cell: (l) => <span className="tabular-nums">{l.time_in ? formatTime(l.time_in) : "—"} – {l.time_out ? formatTime(l.time_out) : "—"} · {Number(l.total_hours) ? `${Number(l.total_hours).toFixed(2)} h` : "—"}</span> },
    { key: "status", header: "Status", mobileBadge: true, sortValue: (l) => l.status, cell: (l) => <div><AttendanceBadge status={l.status} />{l.late_minutes ? <p className="mt-0.5 text-xs text-muted-foreground">{l.late_minutes} min late</p> : null}</div>, searchValue: (l) => l.status },
    { key: "flag", header: "Flag", cell: (l) => (l.flag ? <div className="flex items-center gap-1"><RequestStatus status={l.flag.status} label={l.flag.status_label} /><HistoryButton request={l.flag} /></div> : <span className="text-xs text-muted-foreground">—</span>) },
    { key: "act", header: <span className="sr-only">Flag issue</span>, align: "right", cell: (l) => (l.flag?.status === "pending" ? null : <Button size="sm" variant="outline" onClick={() => setTarget(l)}><FlagIcon aria-hidden="true" />Flag issue</Button>) },
  ];

  const flagColumns = [
    { key: "employee_name", header: "Employee", mobilePrimary: true, className: "font-medium", cell: (r) => r.details?.employee_name || "—", searchValue: (r) => r.details?.employee_name },
    { key: "day", header: "Record", cell: (r) => <div className="text-xs"><p>{dateLabel(r.details?.log_date)}</p><p className="text-muted-foreground">{r.details?.log_status}</p></div> },
    { key: "admin_note", header: "Your note", cell: (r) => <p className="max-w-64 text-xs whitespace-normal">{r.admin_note}</p> },
    { key: "filed", header: "Sent", cell: (r) => <FiledCell request={r} /> },
    { key: "status", header: "Status", cell: (r) => <RequestStatus status={r.status} label={r.status_label} /> },
    { key: "decision", header: "HR", cell: (r) => <DecisionCell request={r} /> },
    { key: "history", header: <span className="sr-only">History</span>, align: "right", cell: (r) => <HistoryButton request={r} /> },
  ];

  const flags = (data?.flags || []).filter((r) => !q || String(r.details?.employee_name || "").toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <AttendanceView
        title="Branch attendance"
        help="View only. To question a record, flag it: HR checks it and marks it Resolved."
        actions={{ onRefresh: view.load, refreshing: view.loading, exportHref: `/api/admin/branch-oversight?${exportQuery}`, exportLabel: "branch attendance", exportDisabled: !data?.total }}
        summary={{ counts: data?.counts || {}, active: status, loading: view.first, onSelect: (s2) => { setTab("all"); page(setStatus)(s2); } }}
        toolbar={{
          search: { value: search, onChange: setSearch },
          range: { value: range, onChange: page((next) => { setRange(next); setDay("all"); }), maxDays: 62, idPrefix: "adm-att" },
          status: tab === "all" ? { value: status, onChange: page(setStatus) } : null,
          day: tab === "all" ? { value: day, onChange: page(setDay), options: (data?.days || []).map((d) => [d, dateLabel(d)]) } : null,
          onReset: () => { setSearch(""); setQ(""); setStatus("all"); setDay("all"); setRange(fallback); setPaging((c) => ({ ...c, page: 1 })); },
          count: view.first ? null : tab === "all" ? data?.total ?? 0 : flags.length,
        }}
        tabs={{ value: tab, onChange: setTab, options: [{ value: "all", label: "All records" }, { value: "flags", label: "Flags sent to HR", count: (data?.flags || []).filter((f) => f.status === "pending").length || undefined }] }}
        footer={tab === "all" ? "Statuses are computed automatically from the branch's schedule. Flag a record to send it to HR; the record itself is never changed here." : "Every record you flagged, with HR's resolution. Kept for good."}
        testId="admin-attendance"
      >
        {tab === "all" ? (
          <DataTable key="all" columns={columns} rows={data?.logs || []} loading={view.first} error={view.error} onRetry={view.load}
            searchable={false} stickyHeader striped pageSize={paging.pageSize} pageSizes={[10, 25, 50]}
            server={{ total: data?.total || 0, page: paging.page, pageSize: paging.pageSize, query: "", onChange: (next) => setPaging((c) => ({ page: next.page ?? c.page, pageSize: next.pageSize ?? c.pageSize })) }}
            empty={{ title: q ? `No employees match "${q}".` : "No attendance for this range", icon: CalendarCheckIcon }} caption="Branch attendance" minWidth={980} />
        ) : (
          <DataTable key="flags" columns={flagColumns} rows={flags} loading={view.first} error={view.error} onRetry={view.load} searchable={false} striped pageSize={10}
            empty={{ title: "No flags sent", icon: FlagIcon }} caption="Attendance flags" minWidth={900} />
        )}
      </AttendanceView>

      <FileDialog open={Boolean(target)} onOpenChange={(o) => { if (!o) setTarget(null); }}
        title={`Flag issue — ${target?.employee_name || ""}`}
        description={target ? `${dateLabel(target.log_date)} · ${target.status}${target.time_in ? ` · in ${formatTime(target.time_in)}` : ""}${target.time_out ? ` · out ${formatTime(target.time_out)}` : ""}. HR is notified; the record itself is not changed.` : ""}
        submitLabel="Flag for HR"
        onSubmit={async (values) => {
          await fileRequest("attendance_flag", { ref_id: target.id, note: values.note });
          notify("Flagged for HR", "HR has been notified.", "success");
          await view.load();
        }} />
    </>
  );
}
