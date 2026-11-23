"use client";

import { SubstitutionsPanel } from "@/components/portal/substitutions";
import { DecisionReasonsCard } from "@/components/portal/remark-presets-manager";
import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import {
  ArrowLeftRightIcon,
  BanknoteIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  ClockIcon,
  CoinsIcon,
  CreditCardIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
  RadioTowerIcon,
  SirenIcon,
  StarIcon,
  TrendingUpIcon,
  UserRoundIcon,
} from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { logAuditMovement } from "@/lib/portal/audit";
import { MaintenancePage } from "./maintenance-page";
import { AttendancePage } from "./attendance-page";
import { LeaveRecommendationsPage, TransferEndorsementsPage } from "./endorsement-pages";
import { IncentiveEndorsementsPage, IncidentReportsPage, OvertimeConfirmationsPage, RfidIssuesPage, ScheduleRequestsPage } from "./requests-pages";
import { AnnouncementsPage, PayrollSummaryPage } from "./branch-pages";
import { DashboardPage } from "./dashboard-page";
import { PayRatesPanel } from "@/components/portal/pay-rates";
import { navPages } from "@/lib/portal/nav-tabs";

const BranchReportsPage = dynamic(() => import("./branch-reports-page").then((m) => m.BranchReportsPage), { loading: PageSkeleton });

/*
 * The branch Admin (2026-10-20): the branch head's oversight role. It
 * recommends, HR decides, the Accountant processes, the Super Admin maintains
 * the system. Every page is its own branch only (/api/admin/branch-oversight,
 * /api/announcements); it never manages employees, payroll, subsidy
 * decisions or system settings. `module` is the permission each page needs
 * (src/lib/rbac/permissions.js).
 */
// Part I (2026-11-23): five items, a tab per page; same page ids and routes. The branch's payroll summary, reports and pay rates are Dashboard tabs.
const BO = "branch_oversight";
const NAV = [
  { section: "Overview", items: [{ id: "adm-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, tabs: [
    { id: "adm-dashboard", label: "Overview", module: BO },
    { id: "adm-announcements", label: "Announcements", module: "announcements" },
    { id: "adm-payroll", label: "Payroll summary", module: "branch_reports" },
    { id: "adm-branch-reports", label: "Branch reports", module: "branch_reports" },
    { id: "adm-pay-rates", label: "Pay rates", module: "pay_rates" },
  ] }] },
  {
    section: "Branch",
    items: [
      { id: "adm-attendance", label: "Branch Attendance", icon: CalendarCheckIcon, module: BO },
      // One check list: everything the Admin endorses or confirms before HR decides.
      { id: "adm-leaves", label: "Branch Review", icon: CalendarDaysIcon, tabs: [
        { id: "adm-leaves", label: "Leave", module: BO },
        { id: "adm-overtime", label: "Overtime & Substitute", module: BO },
        { id: "adm-transfers", label: "Transfers", module: BO },
        { id: "adm-incentives", label: "Incentives", module: BO },
        { id: "adm-schedules", label: "Schedules", module: BO },
      ] },
      { id: "adm-incidents", label: "Incidents & RFID", icon: SirenIcon, tabs: [
        { id: "adm-incidents", label: "Incident & AWOL reports", module: BO },
        { id: "adm-rfid-issues", label: "RFID issues", module: BO },
        { id: "adm-maintenance", label: "RFID terminal & cards", module: "system_maintenance" },
      ] },
    ],
  },
  { section: "My Account", items: [{ id: "adm-profile", label: "My Account", icon: UserRoundIcon, module: "profile" }] },
];

const NAV_ITEMS = navPages(NAV);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
// Page titles stay as before (the tab labels are shorter).
const TITLES = {
  "adm-dashboard": "Dashboard", "adm-announcements": "Announcements", "adm-attendance": "Branch Attendance", "adm-overtime": "Overtime & Substitute",
  "adm-leaves": "Leave Recommendations", "adm-transfers": "Transfer Endorsements", "adm-incentives": "Incentive Recommendations", "adm-schedules": "Schedule Requests",
  "adm-incidents": "Incident & AWOL Reports", "adm-rfid-issues": "RFID Issues", "adm-maintenance": "RFID Terminal & Cards", "adm-payroll": "Payroll Summary",
  "adm-branch-reports": "Branch Reports", "adm-pay-rates": "Pay Rates", "adm-profile": "Profile",
};

const DESCRIPTIONS = {
  "adm-dashboard": "Today's attendance, pending leave, headcount and recent activity for your branch.",
  "adm-attendance": "Your branch's attendance for any range of up to 62 days. View only: flag a record for HR to check.",
  "adm-overtime": "Confirm overtime and substitute teaching before the Accountant pays it.",
  "adm-leaves": "Endorse or do not endorse each leave request. HR decides.",
  "adm-transfers": "Endorse transfers into and out of your branch. HR decides.",
  "adm-incentives": "Recommend incentives and overload pay. HR approves them.",
  "adm-schedules": "Ask HR to change an employee's work schedule or class load.",
  "adm-incidents": "Report incidents and no-shows. They go to HR's AWOL Cases; HR handles them.",
  "adm-rfid-issues": "Report lost or broken cards and faulty readers. HR or the Super Admin resolves them.",
  "adm-announcements": "Announcements for your branch's employees.",
  "adm-payroll": "Total payroll cost of your branch per approved period. No individual pay.",
  "adm-branch-reports": "Attendance rate, lateness and leave usage for your branch.",
  "adm-pay-rates": "View-only: your branch's daily rate and its hourly rate (daily ÷ 8). HR and the Super Admin change the daily rate.",
  "adm-maintenance": "Run the RFID Terminal and register, replace or void your branch's RFID cards.",
  "adm-profile": null,
};

function AdminScreens() {
  const { can, me } = usePortalSession();
  const [page, setPage] = usePersistedPage("admin", PAGE_IDS, "adm-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);

  const allowed = (id) => {
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "adm-dashboard";
  const navigate = setPage;

  // Every page opened is recorded in the audit trail, as before.
  React.useEffect(() => {
    if (!me) return;
    logAuditMovement({
      module: "ui",
      action: "navigate",
      entity_type: "page",
      entity_id: current,
      description: `Admin opened ${TITLES[current] || "page"}.`,
      source: "ui",
      metadata: { page_id: current },
    });
  }, [current, me]);

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    setRefreshKey((n) => n + 1);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

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
      profilePage="adm-profile"
      accountOptions={{ payrollReadOnly: false, titleCaseName: true }}
    >
      {current === "adm-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} onNavigate={navigate} /> : null}
      {current === "adm-attendance" ? <AttendancePage refreshKey={refreshKey} /> : null}
      {current === "adm-overtime" ? <OvertimeConfirmationsPage refreshKey={refreshKey} /> : null}
      {/* Part C: arrange substitute teaching (HR approves; taps confirm; payroll pays). */}
      {current === "adm-overtime" ? <SubstitutionsPanel role="admin" refreshKey={refreshKey} /> : null}
      {current === "adm-leaves" ? <LeaveRecommendationsPage refreshKey={refreshKey} /> : null}
      {current === "adm-transfers" ? <TransferEndorsementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-incentives" ? <IncentiveEndorsementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-schedules" ? <ScheduleRequestsPage refreshKey={refreshKey} /> : null}
      {current === "adm-incidents" ? <IncidentReportsPage refreshKey={refreshKey} /> : null}
      {current === "adm-rfid-issues" ? <RfidIssuesPage refreshKey={refreshKey} /> : null}
      {current === "adm-announcements" ? <AnnouncementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-payroll" ? <PayrollSummaryPage refreshKey={refreshKey} /> : null}
      {current === "adm-branch-reports" ? <BranchReportsPage refreshKey={refreshKey} /> : null}
      {current === "adm-branch-reports" ? <DecisionReasonsCard refreshKey={refreshKey} /> : null}
      {current === "adm-pay-rates" ? <PayRatesPanel refreshKey={refreshKey} /> : null}
      {current === "adm-maintenance" ? <MaintenancePage refreshKey={refreshKey} /> : null}
      {current === "adm-profile" ? <StaffProfilePage roleLabel="Administrator" /> : null}
    </AppShell>
  );
}

export function AdminPortal() {
  return (
    <PortalSessionProvider role="admin" gate={PasswordGate}>
      <AdminScreens />
    </PortalSessionProvider>
  );
}
