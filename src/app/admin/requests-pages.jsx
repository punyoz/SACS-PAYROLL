"use client";

import * as React from "react";
import { CalendarClockIcon, ClockIcon, CreditCardIcon, SirenIcon, StarIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { manilaDateKey } from "@/lib/portal/format";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { INCIDENT_TYPES, OVERTIME_TYPES, RFID_ISSUE_TYPES, SCHEDULE_REQUEST_TYPES } from "@/lib/branch-requests";
import { RequestsPage } from "./oversight-shared";

/*
 * The branch Admin's reports and requests to HR (/api/admin/branch-oversight,
 * kind = …). The Admin files; HR (or, for RFID, the Super Admin) decides;
 * every one stays listed with its status, HR's remark and history.
 */

export function IncidentReportsPage({ refreshKey }) {
  const today = manilaDateKey();
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="incident_report"
      icon={SirenIcon}
      title="Incident & AWOL reports"
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

export function ScheduleRequestsPage({ refreshKey }) {
  const today = manilaDateKey();
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="schedule_request"
      icon={CalendarClockIcon}
      title="Work schedule & class-load requests"
      description="Ask HR to change an employee's work schedule or class load. HR approves or rejects it and applies an approved change in Work Schedules."
      buttonLabel="Request a change"
      initial={{ request_type: "schedule", effective_from: today }}
      fields={[
        { id: "employee_id", label: "Employee", type: "employee", wide: true },
        { id: "request_type", label: "Change", type: "select", options: SCHEDULE_REQUEST_TYPES },
        { id: "effective_from", label: "Starting", type: "date", min: today },
        { id: "requested", label: "What should change", type: "textarea", wide: true, placeholder: "e.g. 7:00 AM – 3:00 PM from Monday; or add Grade 8 Math (5 hours a week)" },
      ]}
      columns={[
        { key: "change", header: "Requested change", cell: (r) => <div className="max-w-72 text-xs whitespace-normal"><p className="font-medium">{r.details?.request_type_label} · from {dateLabel(r.details?.effective_from)}</p><p>{r.details?.requested}</p></div>, searchValue: (r) => r.details?.requested },
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
      description="Report a lost, broken or malfunctioning card or reader. HR or the Super Admin fixes it and marks it Resolved."
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

export function OvertimeConfirmationsPage({ refreshKey }) {
  const today = manilaDateKey();
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="overtime_confirmation"
      icon={ClockIcon}
      title="Overtime & substitute teaching"
      description="Confirm (Endorse) that overtime or substitute teaching really happened, or say it did not (Not endorse). The Accountant sees your confirmation before paying it."
      buttonLabel="Confirm work"
      dialogDescription="Endorse = it happened. Not endorse = it did not happen as claimed."
      decisions
      initial={{ work_type: "overtime", work_date: today }}
      fields={[
        { id: "employee_id", label: "Employee", type: "employee", wide: true },
        { id: "work_type", label: "Work", type: "select", options: OVERTIME_TYPES },
        { id: "work_date", label: "Day", type: "date", max: today },
        { id: "hours", label: "Hours", type: "number", min: "0.25", max: "24", step: "0.25" },
        { id: "covered_for", label: "Covered for (substitute)", type: "text", when: (v) => v.work_type === "substitute", placeholder: "Teacher / class" },
      ]}
      columns={[
        { key: "work", header: "Work", cell: (r) => <div className="text-xs"><p className="font-medium">{r.details?.work_type_label} · {r.details?.hours} h</p><p className="text-muted-foreground">{dateLabel(r.details?.work_date)}{r.details?.covered_for ? ` · for ${r.details.covered_for}` : ""}</p></div>, searchValue: (r) => r.details?.work_type_label },
      ]}
      empty={{ title: "No confirmations yet", icon: ClockIcon }}
    />
  );
}

export function IncentiveEndorsementsPage({ refreshKey }) {
  const today = manilaDateKey();
  const month = today.slice(0, 7);
  return (
    <RequestsPage
      refreshKey={refreshKey}
      kind="incentive_endorsement"
      icon={StarIcon}
      title="Incentive recommendations"
      description="Recommend an incentive or overload pay for an employee of your branch. HR approves it; it is then added to payroll."
      buttonLabel="Recommend an incentive"
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
        { key: "item", header: "Recommended", cell: (r) => <div className="text-xs"><p className="font-medium">{r.details?.kind === "overload" ? `Overload ${r.details?.hours} h` : money(r.details?.amount)}</p><p className="max-w-56 whitespace-normal text-muted-foreground">{r.details?.description} · {dateLabel(r.details?.item_date)}</p></div>, searchValue: (r) => r.details?.description },
      ]}
      empty={{ title: "No recommendations yet", icon: StarIcon }}
    />
  );
}
