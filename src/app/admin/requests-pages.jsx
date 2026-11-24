"use client";

import * as React from "react";
import { CalendarClockIcon, ClockIcon, CreditCardIcon, RefreshCwIcon, SirenIcon, StarIcon, UsersRoundIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { ItemThread, useThreadCounts } from "@/components/portal/item-thread";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { INCIDENT_TYPES, RFID_ISSUE_TYPES } from "@/lib/branch-requests";
import { fetchJson } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { RequestsPage, useBranchView } from "./oversight-shared";
import { useMessageSelected } from "@/components/portal/message-selected";
import { HrDecision } from "./endorsement-pages";

/*
 * The branch Admin's pages (2026-11-24: view and monitor). The Admin FILES
 * only what the system cannot detect (incident reports, incentive proposals,
 * RFID issues), each with a preset remark; everything else the system checks
 * and sends straight to HR, and the Admin follows it here with HR's decision.
 */

export function IncidentReportsPage({ refreshKey }) {
  const today = manilaDateKey();
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="incident_report"
      icon={SirenIcon}
      title="Incident & AWOL reports"
      showTitle={false}
      description="Report an incident about an employee of your branch. A no-show goes straight to HR's AWOL Cases queue. HR handles and closes every case; you see its status here."
      buttonLabel="File a report"
      dialogDescription="HR is notified at once. You cannot close or decide the case."
      initial={{ incident_type: "no_show", incident_date: today }}
      fields={[
        { id: "employee_id", label: "Employee", type: "employee", wide: true },
        { id: "incident_type", label: "Kind of incident", type: "select", options: INCIDENT_TYPES },
        { id: "incident_date", label: "Date it happened", type: "date", max: today },
      ]}
      columns={[
        { key: "type", header: "Incident", cell: (r) => <div><p>{r.details?.incident_type_label}</p><p className="text-xs text-muted-foreground">{dateLabel(r.details?.incident_date)}</p>{r.outcome_ref ? <p className="text-xs text-info">In HR&apos;s AWOL Cases</p> : null}</div>, searchValue: (r) => r.details?.incident_type_label },
      ]}
      empty={{ title: "No reports filed", icon: SirenIcon }}
    />
  );
}

/** Schedules: HR changes work schedules; the Admin's earlier requests and HR's decisions stay listed (view only). */
export function ScheduleRequestsPage({ refreshKey }) {
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="schedule_request"
      readOnly
      messageSelected
      icon={CalendarClockIcon}
      title="Work schedules"
      description="HR changes work schedules and class loads; the system applies each change from its date. Earlier requests from your branch and HR's decisions are kept here. View only."
      columns={[
        { key: "change", header: "Requested change", cell: (r) => <div className="max-w-72 text-xs whitespace-normal"><p className="font-medium">{r.details?.request_type_label} · from {dateLabel(r.details?.effective_from)}</p>{r.details?.schedule_name ? <p>{r.details.schedule_name}</p> : null}<p>{r.details?.requested}</p></div>, searchValue: (r) => `${r.details?.schedule_name || ""} ${r.details?.requested || ""}` },
      ]}
      empty={{ title: "No schedule requests", icon: CalendarClockIcon }}
    />
  );
}

export function RfidIssuesPage({ refreshKey }) {
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="rfid_issue"
      icon={CreditCardIcon}
      title="RFID issue reports"
      description="Report a lost, broken or malfunctioning card or reader. A card reported lost is blocked at once (HR can reactivate or replace it). HR or the Super Admin fixes it and marks it Resolved."
      buttonLabel="Report an issue"
      initial={{ issue_type: "lost_card" }}
      fields={[
        { id: "issue_type", label: "Problem", type: "select", options: RFID_ISSUE_TYPES },
        { id: "employee_id", label: "Card holder (if a card)", type: "employee" },
        { id: "device", label: "Reader / location (if a reader)", type: "text", wide: true, placeholder: "e.g. Main gate reader" },
      ]}
      columns={[
        { key: "issue", header: "Problem", cell: (r) => <div className="text-xs"><p className="font-medium">{r.details?.issue_type_label}</p>{r.details?.device ? <p className="text-muted-foreground">{r.details.device}</p> : null}</div>, searchValue: (r) => r.details?.issue_type_label },
      ]}
      empty={{ title: "No RFID issues reported", icon: CreditCardIcon }}
    />
  );
}

const hm = (t) => String(t || "").slice(0, 5);
const SUB_STATUS = (s) => (s.needs_substitute ? "Waiting for HR to pick a teacher" : s.status === "pending" ? "Waiting for HR" : s.status === "approved" ? "Approved" : s.status === "rejected" ? "Rejected" : "Cancelled");

/** Overtime & substitute teaching (view only): the branch's overtime requests and substitutions with HR's decision. */
export function OvertimeConfirmationsPage({ refreshKey }) {
  const [tab, setTab] = React.useState("overtime");
  const view = useBranchView("overtime", {}, refreshKey);
  const [subs, setSubs] = React.useState({ loading: true, rows: [], error: null });
  const loadSubs = React.useCallback(async () => {
    try { setSubs({ loading: false, rows: (await fetchJson("/api/substitutions")).substitutions || [], error: null }); }
    catch (e) { setSubs((c) => ({ ...c, loading: false, error: e.message })); }
  }, []);
  React.useEffect(() => { loadSubs(); }, [loadSubs, refreshKey]);
  const overtime = view.data?.overtime || [];
  const otCounts = useThreadCounts("overtime_request", overtime.map((r) => r.id), view.data);
  const subCounts = useThreadCounts("substitution", subs.rows.map((r) => r.id), subs.rows.length);
  const otMsg = useMessageSelected({ itemType: "overtime_request", label: (r) => `${r.employee_name} · overtime ${dateLabel(r.request_date)}`, onSent: view.load });
  const subMsg = useMessageSelected({ itemType: "substitution", label: (s) => `${s.absent_name} · substitution ${dateLabel(s.sub_date)}`, onSent: loadSubs });
  const otColumns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.employee_name} ${r.employee_code}` },
    { key: "day", header: "Day", sortValue: (r) => r.request_date, cell: (r) => <div className="text-xs"><p>{dateLabel(r.request_date)}</p><p className="text-muted-foreground">{hm(r.planned_start)}–{hm(r.planned_end)}{r.late_filing ? " · filed late" : ""}</p></div> },
    { key: "reason", header: "Reason", cell: (r) => <p className="max-w-56 text-xs whitespace-normal">{r.reason}</p>, searchValue: (r) => r.reason },
    { key: "hr", header: "HR decision", cell: (r) => <HrDecision status={r.status} label={r.status === "pending" ? "Waiting for HR" : r.status[0].toUpperCase() + r.status.slice(1)} by={r.decided_by_name} at={r.decided_at} remark={r.decision_note} /> },
    { key: "msg", header: <span className="sr-only">Messages</span>, align: "right", cell: (r) => <ItemThread itemType="overtime_request" itemId={r.id} count={otCounts[r.id] || 0} title={`Messages · ${r.employee_name}`} /> },
  ];
  const subColumns = [
    { key: "absent", header: "Absent teacher", className: "font-medium", cell: (s) => s.absent_name, searchValue: (s) => `${s.absent_name} ${s.substitute_name || ""}` },
    { key: "day", header: "Day", sortValue: (s) => s.sub_date, cell: (s) => <div className="text-xs"><p>{dateLabel(s.sub_date)}</p><p className="text-muted-foreground">{hm(s.start_time)}–{hm(s.end_time)} · {s.periods} period{s.periods === 1 ? "" : "s"}</p></div> },
    { key: "sub", header: "Substitute", cell: (s) => <span className="text-xs">{s.substitute_name || "Not picked yet"}</span> },
    { key: "hr", header: "HR decision", cell: (s) => <HrDecision status={s.needs_substitute ? "pending" : s.status} label={SUB_STATUS(s)} by={s.decided_by_name} at={s.decided_at} remark={s.decision_note} /> },
    { key: "msg", header: <span className="sr-only">Messages</span>, align: "right", cell: (s) => <ItemThread itemType="substitution" itemId={s.id} count={subCounts[s.id] || 0} title={`Messages · ${s.absent_name}`} /> },
  ];
  const loading = tab === "overtime" ? view.loading : subs.loading;
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ClockIcon className="size-4 text-gold-text" aria-hidden="true" />Overtime & substitute teaching</CardTitle>
        <CardDescription>Your branch&apos;s overtime requests and substitutions. The system prepares each one (a teacher&apos;s approved leave proposes the substitution) and sends it straight to HR; HR decides and the taps confirm the pay. View only.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={() => { view.load(); loadSubs(); }} disabled={loading}><RefreshCwIcon className={cn(loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        {tab === "overtime" ? (
          <DataTable key="ot" toolbar={<FilterTabs value={tab} onValueChange={setTab} label="Show" options={[{ value: "overtime", label: "Overtime" }, { value: "subs", label: "Substitutions" }]} />}
            columns={otColumns} rows={overtime} loading={view.first} error={view.error} onRetry={view.load}
            searchPlaceholder="Search name, ID or details…" empty={{ title: "No overtime requests", icon: ClockIcon }} caption="Branch overtime requests" minWidth={900}
            selection={otMsg.selection} />
        ) : (
          <DataTable key="subs" toolbar={<FilterTabs value={tab} onValueChange={setTab} label="Show" options={[{ value: "overtime", label: "Overtime" }, { value: "subs", label: "Substitutions" }]} />}
            columns={subColumns} rows={subs.rows} loading={subs.loading && !subs.rows.length} error={subs.error} onRetry={loadSubs}
            searchPlaceholder="Search name, ID or details…" empty={{ title: "No substitutions", icon: UsersRoundIcon }} caption="Branch substitutions" minWidth={900}
            selection={subMsg.selection} />
        )}
        {otMsg.dialog}
        {subMsg.dialog}
      </CardContent>
    </Card>
  );
}

export function IncentiveEndorsementsPage({ refreshKey }) {
  const today = manilaDateKey();
  const month = today.slice(0, 7);
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="incentive_endorsement"
      exportable
      messageSelected
      icon={StarIcon}
      title="Incentive proposals"
      description="Propose a discretionary incentive or overload pay for an employee of your branch (what the system cannot compute). HR approves it; it is then added to payroll. Rule-based incentives are computed by the system after the cutoff and go to HR directly."
      buttonLabel="Propose an incentive"
      initial={{ kind: "incentive", item_date: today }}
      banner={(data) => {
        const c = data?.cutoffs?.[month];
        if (!c) return null;
        return (
          <Alert className="border-info/40 bg-info/8">
            <CalendarClockIcon className="text-info" aria-hidden="true" />
            <AlertDescription>
              <p><strong className="text-foreground">Incentive &amp; overload cutoff for {c.month_label}: {c.cutoff_label}</strong> (the day before the 2nd-half payslip day, {c.payslip_day_label}). An incentive counts by the day HR approves it: approved after {c.cutoff_label}, it moves to {c.next_month_label}&apos;s payroll.</p>
            </AlertDescription>
          </Alert>
        );
      }}
      fields={[
        { id: "employee_id", label: "Employee", type: "employee", wide: true },
        { id: "kind", label: "Type", type: "select", options: { incentive: "Incentive (₱)", overload: "Overload (hours)" } },
        { id: "item_date", label: "Date it is for", type: "date", min: "2026-10-01" },
        { id: "amount", label: "Amount (₱)", type: "number", min: "0", step: "0.01", when: (v) => v.kind !== "overload" },
        { id: "hours", label: "Overload hours", type: "number", min: "0", step: "0.25", when: (v) => v.kind === "overload" },
        { id: "description", label: "What it is for", type: "text", wide: true, placeholder: "e.g. Coaching the quiz bee team" },
      ]}
      columns={[
        { key: "item", header: "Proposed", cell: (r) => <div className="text-xs"><p className="font-medium">{r.details?.kind === "overload" ? `Overload ${r.details?.hours} h` : money(r.details?.amount)}</p><p className="max-w-56 whitespace-normal text-muted-foreground">{r.details?.description} · {dateLabel(r.details?.item_date)}</p></div>, searchValue: (r) => r.details?.description },
      ]}
      empty={{ title: "No proposals yet", icon: StarIcon }}
    />
  );
}
