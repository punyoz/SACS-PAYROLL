"use client";

import * as React from "react";
import { CalendarCheckIcon, FlagIcon, MessageSquareIcon, OctagonAlertIcon } from "lucide-react";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/portal/data-table";
import { AttendanceBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { formatTime, manilaDateKey } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { DecisionCell, FileDialog, FiledCell, HistoryButton, RequestStatus, useBranchView } from "./oversight-shared";
import { useUrlRange } from "@/components/portal/date-range-filter";
import { useUrlParam } from "@/components/portal/use-url-param";
import { AttendanceView } from "@/components/portal/attendance/attendance-view";
import { defaultRange } from "@/lib/portal/date-range";

/*
 * Branch Attendance (GET /api/admin/branch-oversight?view=attendance):
 * read-only daily or monthly logs of the Admin's branch. Attendance issues are
 * flagged by the system each night (Part E step 2); the Admin adds a Note or
 * Objects on the system's flag, which sends it to HR (2026-11-24: the manual
 * "Flag issue" is gone; earlier manual flags stay listed). Never edits a log.
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

  // The system's flag, as the Admin sees it.
  const FLAG_LABEL = { open: ["Flagged by the system", "gold"], admin_check: ["Waiting for your check", "gold"], with_hr: ["With HR", "info"], closed: ["Resolved", "success"], undone: ["Undone", "muted"] };
  const flagCell = (a) => {
    const [label, tone] = FLAG_LABEL[a.status] || [a.status, "muted"];
    return (
      <div className="max-w-64 space-y-0.5 whitespace-normal" data-testid="system-flag">
        <StatusBadge tone={tone}>{label}</StatusBadge>
        <p className="text-xs text-muted-foreground">{String(a.summary || "").replace(/^[^:]*:\s*/, "")}</p>
        {a.admin_note ? <p className="text-xs">{a.admin_objected ? "Objected" : "Your note"}: {a.admin_note}</p> : null}
      </div>
    );
  };
  const checkable = (a) => a && (a.status === "open" || a.status === "admin_check");

  const columns = [
    { key: "employee_name", header: "Employee", mobilePrimary: true, className: "font-medium", cell: (l) => <div><p>{l.employee_name}</p><p className="text-xs text-muted-foreground">{l.employee_code}</p></div>, searchValue: (l) => `${l.employee_name} ${l.employee_code}` },
    { key: "log_date", header: "Date", className: "whitespace-nowrap tabular-nums", cell: (l) => dateLabel(l.log_date) },
    { key: "time_in", header: "Time in", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (l.time_in ? formatTime(l.time_in) : "—") },
    { key: "time_out", header: "Time out", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (l.time_out ? formatTime(l.time_out) : "—") },
    { key: "hours", header: "Hours", align: "right", mobile: false, className: "tabular-nums", cell: (l) => (Number(l.total_hours) ? Number(l.total_hours).toFixed(2) : "—") },
    { key: "time", header: "Time", mobileOnly: true, cell: (l) => <span className="tabular-nums">{l.time_in ? formatTime(l.time_in) : "—"} – {l.time_out ? formatTime(l.time_out) : "—"} · {Number(l.total_hours) ? `${Number(l.total_hours).toFixed(2)} h` : "—"}</span> },
    { key: "status", header: "Status", mobileBadge: true, cell: (l) => <div><AttendanceBadge status={l.status} />{l.late_minutes ? <p className="mt-0.5 text-xs text-muted-foreground">{l.late_minutes} min late</p> : null}</div>, searchValue: (l) => l.status },
    { key: "flag", header: "Flag", cell: (l) => (l.auto_flag ? flagCell(l.auto_flag)
      : l.flag ? <div className="flex items-center gap-1"><RequestStatus status={l.flag.status} label={l.flag.status_label} /><HistoryButton request={l.flag} /></div>
        : <span className="text-xs text-muted-foreground">—</span>) },
    { key: "act", header: <span className="sr-only">Note or object</span>, align: "right", cell: (l) => (checkable(l.auto_flag) ? (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="outline" onClick={() => setTarget({ log: l, flag: l.auto_flag, action: "note" })}><MessageSquareIcon aria-hidden="true" />Note</Button>
        <Button size="sm" variant="outline" className="text-destructive" onClick={() => setTarget({ log: l, flag: l.auto_flag, action: "object" })}><OctagonAlertIcon aria-hidden="true" />Object</Button>
      </div>
    ) : null) },
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
  const autoFlags = (data?.auto_flags || []).filter((a) => !q || String(a.summary || "").toLowerCase().includes(q.toLowerCase()));
  const autoColumns = [
    { key: "summary", header: "Flag", mobilePrimary: true, cell: (a) => <p className="max-w-96 text-sm whitespace-normal">{a.summary}</p>, searchValue: (a) => a.summary },
    { key: "status", header: "Status", cell: (a) => <StatusBadge tone={(FLAG_LABEL[a.status] || [])[1] || "muted"}>{(FLAG_LABEL[a.status] || [a.status])[0]}</StatusBadge> },
    { key: "note", header: "Your note", cell: (a) => (a.admin_note ? <p className="max-w-64 text-xs whitespace-normal">{a.admin_objected ? "Objected: " : ""}{a.admin_note}</p> : <span className="text-xs text-muted-foreground">—</span>) },
  ];
  return (
    <>
      <AttendanceView
        title="Branch attendance"
        help="View only. The system flags attendance issues each night; add a note or object on a flag and it goes to HR."
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
        tabs={{ value: tab, onChange: setTab, options: [{ value: "all", label: "All records" }, { value: "flags", label: "Flags", count: (data?.auto_flags || []).filter((a) => checkable(a)).length || undefined }] }}
        footer={tab === "all" ? "Statuses are computed automatically from the branch's schedule. The record itself is never changed here." : "The system's flags for your branch, with your notes; earlier flags you sent by hand are kept below."}
        testId="admin-attendance"
      >
        {tab === "all" ? (
          <DataTable key="all" columns={columns} rows={data?.logs || []} loading={view.first} error={view.error} onRetry={view.load}
            searchable={false} stickyHeader striped pageSize={paging.pageSize} pageSizes={[10, 25, 50]}
            server={{ total: data?.total || 0, page: paging.page, pageSize: paging.pageSize, query: "", onChange: (next) => setPaging((c) => ({ page: next.page ?? c.page, pageSize: next.pageSize ?? c.pageSize })) }}
            empty={{ title: q ? `No employees match "${q}".` : "No attendance for this range", icon: CalendarCheckIcon }} caption="Branch attendance" minWidth={980} />
        ) : (
          <div className="space-y-4">
            <DataTable key="auto" columns={autoColumns} rows={autoFlags} rowKey={(a) => a.id} loading={view.first} error={view.error} onRetry={view.load} searchable={false} striped pageSize={10}
              empty={{ title: "No flags from the system", icon: FlagIcon }} caption="System attendance flags" minWidth={760} />
            {flags.length ? (
              <DataTable key="flags" columns={flagColumns} rows={flags} loading={view.first} error={view.error} onRetry={view.load} searchable={false} striped pageSize={10}
                empty={{ title: "No flags sent", icon: FlagIcon }} caption="Earlier flags you sent" minWidth={900} />
            ) : null}
          </div>
        )}
      </AttendanceView>

      <FileDialog open={Boolean(target)} onOpenChange={(o) => { if (!o) setTarget(null); }}
        title={`${target?.action === "object" ? "Object to the flag" : "Add a note"} — ${target?.log?.employee_name || ""}`}
        description={target ? `${dateLabel(target.log.log_date)} · ${target.log.status}. ${target.flag.summary}. It goes to HR; the record itself is not changed.` : ""}
        submitLabel={target?.action === "object" ? "Object" : "Send note to HR"}
        onSubmit={async (values) => {
          await fetchJson("/api/automation", jsonBody("PATCH", { id: target.flag.id, action: target.action, note: values.note }));
          notify(target.action === "object" ? "Objection sent to HR" : "Note sent to HR", "HR has been notified.", "success");
          await view.load();
        }} />
    </>
  );
}
