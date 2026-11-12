"use client";

/**
 * "My Account" (2026-11-09 Part E): ONE group of personal pages, the same for
 * every role on payroll (HR, Accountant, Employee). The pages are the
 * Employee portal's own components; their data comes from /api/me/*, which
 * the server pins to the signed-in person (src/lib/rbac/guard.js), so a
 * "My" page can never show anyone else's records. Admin and Super Admin
 * have no my_account permission: the group never shows for them and the
 * API answers 403.
 */
import * as React from "react";
import {
  HandCoinsIcon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  ClockIcon,
  InboxIcon,
  ReceiptTextIcon,
  UserRoundIcon,
} from "lucide-react";
import { DataTable } from "@/components/portal/data-table";
import { RequestStatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "@/lib/portal/api";
import { useEmployeeStats, useLeaveRequests, usePayslips } from "@/app/employee/use-employee-data";
import { AttendancePage } from "@/app/employee/attendance-page";
import { TimesheetPage } from "@/app/employee/timesheet-page";
import { PayslipsPage } from "@/app/employee/payslips-page";
import { LeavePage } from "@/app/employee/leave-page";
import { ProfilePage } from "@/app/employee/profile-page";

/** The page ids per portal. The Employee keeps its existing ids (saved pages and links still work). */
export const MY_PAGE_IDS = {
  emp: { attendance: "emp-attendance", timesheet: "emp-timesheet", leave: "emp-leave", payslips: "emp-payslips", requests: "emp-requests", profile: "emp-profile" },
  hr: { attendance: "hr-my-attendance", timesheet: "hr-my-timesheet", leave: "hr-my-leave", payslips: "hr-my-payslips", requests: "hr-my-requests", profile: "hr-profile" },
  ac: { attendance: "ac-my-attendance", timesheet: "ac-my-timesheet", leave: "ac-my-leave", payslips: "ac-my-payslips", requests: "ac-my-requests", profile: "ac-profile" },
};

export const MY_REQUEST_TABS = [
  { value: "loans", label: "Loans" },
  { value: "cash_advances", label: "Cash Advances" },
  { value: "incentives", label: "Incentives" },
  { value: "subsidy", label: "Subsidy" },
  { value: "thirteenth_month", label: "13th Month" },
];

/**
 * Old personal page ids that now live as a tab of My Requests (kept working:
 * ?page=emp-loans opens My Requests on the Loans tab).
 */
export const MY_REQUEST_ALIASES = {
  "emp-loans": "loans", "emp-cash-advances": "cash_advances", "emp-incentives": "incentives", "emp-subsidy": "subsidy", "emp-13th": "thirteenth_month",
};

/** The sidebar group. Expanded by default for the Employee, collapsed for HR and the Accountant. */
export function myAccountGroup(prefix, { defaultOpen = false } = {}) {
  const ids = MY_PAGE_IDS[prefix];
  return {
    section: "My Account",
    collapsible: true,
    defaultOpen,
    items: [
      { id: ids.attendance, label: "My Attendance", icon: CalendarCheckIcon, module: "my_account" },
      { id: ids.timesheet, label: "My Timesheet", icon: ClockIcon, module: "my_account" },
      { id: ids.leave, label: "My Leave", icon: CalendarDaysIcon, module: "my_account" },
      { id: ids.payslips, label: "My Payslips", icon: ReceiptTextIcon, module: "my_account" },
      { id: ids.requests, label: "My Requests", icon: InboxIcon, module: "my_account" },
      { id: ids.profile, label: "My Profile", icon: UserRoundIcon, module: "profile" },
    ],
  };
}

export const MY_DESCRIPTIONS = {
  attendance: "Your own attendance, recorded by RFID tap. Only your records.",
  timesheet: "Your own daily hours, tardiness and undertime for any date range.",
  leave: "File your own leave and follow its approval.",
  payslips: "Your own payslips and earlier ones: your deductions only.",
  requests: "Your own loans, cash advances, incentives, subsidy and 13th month pay.",
  profile: "Your personal, contact and government details on file.",
};

/** Which "My" page an id is in this portal, or null. */
export function myPageKind(prefix, page) {
  const entry = Object.entries(MY_PAGE_IDS[prefix] || {}).find(([, id]) => id === page);
  return entry ? entry[0] : null;
}

const peso = (value) => (value === null || value === undefined || value === "" ? "—"
  : `₱${Number(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (value) => (value ? String(value).slice(0, 10) : "—");

const REQUEST_COLUMNS = {
  loans: [
    { key: "loan_type", header: "Loan", cell: (r) => String(r.loan_type || "").replace(/_/g, " ") || "Loan", sortable: true },
    { key: "date_granted", header: "Granted", cell: (r) => day(r.date_granted), sortable: true },
    { key: "total_payable", header: "Total", cell: (r) => peso(r.total_payable ?? r.principal), align: "right" },
    { key: "remaining_balance", header: "Balance", cell: (r) => peso(r.remaining_balance), align: "right" },
    { key: "status", header: "Status", cell: (r) => <RequestStatusBadge status={r.approval_status === "pending" ? "pending" : r.status} />, mobileBadge: true },
  ],
  cash_advances: [
    { key: "date_granted", header: "Granted", cell: (r) => day(r.date_granted), sortable: true },
    { key: "principal", header: "Amount", cell: (r) => peso(r.principal), align: "right" },
    { key: "remaining_balance", header: "Balance", cell: (r) => peso(r.remaining_balance), align: "right" },
    { key: "status", header: "Status", cell: (r) => <RequestStatusBadge status={r.approval_status === "pending" ? "pending" : r.status} />, mobileBadge: true },
  ],
  incentives: [
    { key: "item_date", header: "Date", cell: (r) => day(r.item_date), sortable: true },
    { key: "kind", header: "Type", cell: (r) => String(r.kind || "").replace(/_/g, " ") },
    { key: "description", header: "Details", cell: (r) => r.description || "—" },
    { key: "amount", header: "Amount", cell: (r) => peso(r.amount), align: "right" },
    { key: "approval_status", header: "Status", cell: (r) => <RequestStatusBadge status={r.approval_status || "approved"} />, mobileBadge: true },
  ],
  subsidy: [
    { key: "requested_at", header: "Requested", cell: (r) => day(r.requested_at), sortable: true },
    { key: "kind", header: "Request", cell: (r) => String(r.kind || "").replace(/_/g, " ") },
    { key: "amount", header: "Amount", cell: (r) => peso(r.amount), align: "right" },
    { key: "status", header: "Status", cell: (r) => <RequestStatusBadge status={r.status} />, mobileBadge: true },
  ],
  thirteenth_month: [
    { key: "year", header: "Year", sortable: true, cell: (r) => (r.projected ? `${r.year} (so far)` : r.year) },
    { key: "label", header: "Status", cell: (r) => <RequestStatusBadge status={r.projected ? "pending" : "approved"} className="whitespace-nowrap" />, mobileBadge: true },
    { key: "note", header: "", cell: (r) => <span className="text-xs text-muted-foreground">{r.projected ? `Projected, not yet processed · opens ${day(r.opens)}` : r.label}{r.pay_date ? ` · paid ${day(r.pay_date)}` : ""}</span> },
    { key: "basic_earned", header: "Basic pay earned", cell: (r) => peso(r.basic_earned), align: "right" },
    { key: "amount", header: "13th month", cell: (r) => peso(r.amount), align: "right" },
    { key: "processed_at", header: "Processed", cell: (r) => day(r.processed_at) },
  ],
};

/** My Requests: one page, five tabs, read-only (the Accountant files, HR decides). */
export function MyRequestsPage({ refreshKey = 0, initialTab = "loans" }) {
  const [tab, setTab] = React.useState(MY_REQUEST_TABS.some((t) => t.value === initialTab) ? initialTab : "loans");
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fetchJson("/api/me/requests") });
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error: error?.message || "Could not load your requests." }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);
  // The 13th month tab: this year's projection on top, then processed years.
  const rowsOf = (value) => (value === "thirteenth_month" && state.data?.thirteenth_projected
    ? [{ id: "projected", projected: true, ...state.data.thirteenth_projected }, ...(state.data.thirteenth_month || [])]
    : state.data?.[value] || []);
  const counts = Object.fromEntries(MY_REQUEST_TABS.map((t) => [t.value, rowsOf(t.value).length]));
  return (
    <Card data-testid="my-requests">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HandCoinsIcon aria-hidden="true" className="size-4" />My Requests</CardTitle>
        <CardDescription>Only your own. The Accountant records these and HR approves them; amounts are deducted or paid on your payslips.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            {MY_REQUEST_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} data-testid={`my-requests-tab-${t.value}`}>
                {t.label}<span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{counts[t.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {MY_REQUEST_TABS.map((t) => (
            <TabsContent key={t.value} value={t.value} className="mt-3">
              <DataTable
                columns={REQUEST_COLUMNS[t.value]}
                rows={rowsOf(t.value)}
                loading={state.loading && !state.data}
                error={state.data ? null : state.error}
                onRetry={load}
                searchable={false}
                empty={{ title: `No ${t.label.toLowerCase()} yet`, description: null }}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

/**
 * Render the "My" page `kind` with the Employee portal's components. Mounted
 * only while a My page is open, so other pages do not load personal data.
 */
export function MyAccountScreen({ kind, refreshKey = 0, initialTab }) {
  const { ctx, notify } = usePortalSession();
  const email = String(ctx?.email || "").trim();
  const stats = useEmployeeStats(email, refreshKey);
  const payslips = usePayslips(email, refreshKey);
  const leave = useLeaveRequests(ctx, notify, refreshKey);
  if (kind === "attendance") return <AttendancePage stats={stats} refreshKey={refreshKey} />;
  if (kind === "timesheet") return <TimesheetPage />;
  if (kind === "leave") return <LeavePage leave={leave} />;
  if (kind === "payslips") return <PayslipsPage payslips={payslips} />;
  if (kind === "requests") return <MyRequestsPage refreshKey={refreshKey} initialTab={initialTab} />;
  if (kind === "profile") return <ProfilePage />;
  return null;
}
