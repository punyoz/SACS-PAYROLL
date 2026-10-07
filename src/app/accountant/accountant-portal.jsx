"use client";

import * as React from "react";
import {
  ActivityIcon,
  BanknoteIcon,
  CalculatorIcon,
  CalendarCheckIcon,
  CalendarIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  StarIcon,
  TableIcon,
  UserRoundIcon,
} from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { AccountantDataProvider, useAccountant } from "./accountant-data";
import { DashboardPage } from "./dashboard-page";
import { ProcessPage } from "./process-page";
import { RecordsPage } from "./records-page";
import { PayRecordPage } from "./pay-record-page";
import { IncentivesPage } from "./incentives-page";
import { CashAdvancesPage } from "./cash-advances-page";
import { ThirteenthMonthPage } from "./thirteenth-month-page";
import { AttendancePage } from "./attendance-page";
import { MonitoringPage } from "./monitoring-page";
import { ReportsPage } from "./reports-page";

/*
 * Page ids are the legacy portal's (public/legacy/js/accountant.js
 * ACCT_PAGES), so the saved page carries over and sign-out clears it.
 * `module` is the permission each page needs (src/lib/rbac/permissions.js);
 * Incentives, Cash Advances and 13th Month are part of Process Payroll.
 */
const NAV = [
  { section: "Overview", items: [{ id: "ac-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  {
    section: "Payroll",
    items: [
      { id: "ac-process", label: "Process Payroll", icon: CalculatorIcon, module: "process_payroll" },
      { id: "ac-records", label: "Payroll Records", icon: TableIcon, module: "payroll_records" },
      { id: "ac-payslips", label: "Payslips", icon: ReceiptTextIcon, module: "payslips" },
      { id: "ac-incentives", label: "Incentives & Overload", icon: StarIcon, module: "process_payroll" },
      { id: "ac-cash-advances", label: "Cash Advances", icon: BanknoteIcon, module: "process_payroll" },
      { id: "ac-13th", label: "13th Month Pay", icon: CalendarIcon, module: "process_payroll" },
    ],
  },
  { section: "Reference", items: [{ id: "ac-attendance", label: "View Attendance", icon: CalendarCheckIcon, module: "attendance" }] },
  { section: "Monitoring", items: [{ id: "ac-monitoring", label: "Payroll Monitoring", icon: ActivityIcon, module: "payroll_monitoring" }] },
  { section: "Reports", items: [{ id: "ac-reports", label: "Payroll Reports", icon: FileTextIcon, module: "payroll_reports" }] },
  { section: "Account", items: [{ id: "ac-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
const TITLES = { ...Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label])), "ac-payslips": "Pay Record", "ac-attendance": "Attendance Records" };
const DESCRIPTIONS = {
  "ac-dashboard": "Payroll overview and activity summary for the current period.",
  "ac-process": "Compute employee salaries including deductions. Processed payrolls generate payslips automatically.",
  "ac-records": "All processed payroll entries for reference.",
  "ac-payslips": "Generate and print pay records for employees.",
  "ac-incentives": "Added to the 2nd half payroll of the month they are counted in.",
  "ac-cash-advances": "Deducted from payslips in installments until repaid.",
  "ac-13th": "Total basic salary earned in the year ÷ 12 — a separate payout in December.",
  "ac-attendance": "View-only — for payroll deduction reference.",
  "ac-monitoring": "Monitor all payroll status and history across all periods.",
  "ac-reports": "Generate and export payroll reports for documentation and audit purposes.",
  "ac-profile": null,
};

function Screens({ current, navigate, refreshKey, refreshing, refresh }) {
  const { data, period } = useAccountant();
  const drafts = data?.draft_entries?.length || 0;
  const summary = [
    {
      title: drafts > 0 ? `${drafts} payroll draft${drafts > 1 ? "s" : ""} saved` : "No saved payroll drafts",
      description: drafts > 0 ? "Open Payroll Monitoring to edit or withdraw drafts." : "You can prepare and save payroll drafts before processing.",
    },
    { title: `Current pay period: ${period || "Current period"}`, description: "Use Process Payroll to compute and process payroll entries." },
  ];

  return (
    <AppShell
      nav={NAV}
      page={current}
      onNavigate={navigate}
      title={TITLES[current]}
      description={DESCRIPTIONS[current]}
      onRefresh={refresh}
      refreshing={refreshing}
      notificationSummary={summary}
      profilePage="ac-profile"
      accountOptions={{ payrollReadOnly: true }}
    >
      {current === "ac-dashboard" ? <DashboardPage refreshKey={refreshKey} onNavigate={navigate} /> : null}
      {current === "ac-process" ? <ProcessPage onNavigate={navigate} /> : null}
      {current === "ac-records" ? <RecordsPage /> : null}
      {current === "ac-payslips" ? <PayRecordPage /> : null}
      {current === "ac-incentives" ? <IncentivesPage refreshKey={refreshKey} /> : null}
      {current === "ac-cash-advances" ? <CashAdvancesPage refreshKey={refreshKey} /> : null}
      {current === "ac-13th" ? <ThirteenthMonthPage refreshKey={refreshKey} /> : null}
      {current === "ac-attendance" ? <AttendancePage refreshKey={refreshKey} /> : null}
      {current === "ac-monitoring" ? <MonitoringPage /> : null}
      {current === "ac-reports" ? <ReportsPage /> : null}
      {current === "ac-profile" ? <StaffProfilePage roleLabel="Accountant" showPosition showBank employeeIdLabel /> : null}
    </AppShell>
  );
}

function AccountantScreens() {
  const { can } = usePortalSession();
  const [page, setPage] = usePersistedPage("accountant", PAGE_IDS, "ac-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const item = NAV_ITEMS.find((i) => i.id === page);
  const current = item && can(item.module) ? page : "ac-dashboard";

  return (
    <AccountantDataProvider navigate={setPage}>
      <RefreshBridge refreshKey={refreshKey} />
      <AttendanceActionsProvider>
        <Screens
          current={current}
          navigate={setPage}
          refreshKey={refreshKey}
          refreshing={refreshing}
          refresh={() => {
            setRefreshing(true);
            setRefreshKey((n) => n + 1);
            setTimeout(() => setRefreshing(false), 800);
          }}
        />
      </AttendanceActionsProvider>
    </AccountantDataProvider>
  );
}

/** The top bar's refresh reloads the shared payroll data too. */
function RefreshBridge({ refreshKey }) {
  const { load } = useAccountant();
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    load();
  }, [refreshKey, load]);
  return null;
}

export function AccountantPortal() {
  return (
    <PortalSessionProvider role="accountant" gate={PasswordGate}>
      <AccountantScreens />
    </PortalSessionProvider>
  );
}
