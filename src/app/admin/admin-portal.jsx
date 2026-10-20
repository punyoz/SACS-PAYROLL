"use client";

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

const BranchReportsPage = dynamic(() => import("./branch-reports-page").then((m) => m.BranchReportsPage), { loading: PageSkeleton });

/*
 * The branch Admin (2026-10-20): the branch head's oversight role. It
 * recommends, HR decides, the Accountant processes, the Super Admin maintains
 * the system. Every page is its own branch only (/api/admin/branch-oversight,
 * /api/announcements); it never manages employees, payroll, subsidy
 * decisions or system settings. `module` is the permission each page needs
 * (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "adm-dashboard", label: "Branch Dashboard", icon: LayoutDashboardIcon, module: "branch_oversight" }] },
  {
    section: "Attendance",
    items: [
      { id: "adm-attendance", label: "Branch Attendance", icon: CalendarCheckIcon, module: "branch_oversight" },
      { id: "adm-overtime", label: "Overtime & Substitute", icon: ClockIcon, module: "branch_oversight" },
    ],
  },
  {
    section: "Recommendations",
    items: [
      { id: "adm-leaves", label: "Leave Recommendations", icon: CalendarDaysIcon, module: "branch_oversight" },
      { id: "adm-transfers", label: "Transfer Endorsements", icon: ArrowLeftRightIcon, module: "branch_oversight" },
      { id: "adm-incentives", label: "Incentive Recommendations", icon: StarIcon, module: "branch_oversight" },
      { id: "adm-schedules", label: "Schedule Requests", icon: CalendarClockIcon, module: "branch_oversight" },
    ],
  },
  {
    section: "Reports to HR",
    items: [
      { id: "adm-incidents", label: "Incident & AWOL Reports", icon: SirenIcon, module: "branch_oversight" },
      { id: "adm-rfid-issues", label: "RFID Issues", icon: CreditCardIcon, module: "branch_oversight" },
    ],
  },
  {
    section: "Branch",
    items: [
      { id: "adm-announcements", label: "Announcements", icon: MegaphoneIcon, module: "announcements" },
      { id: "adm-payroll", label: "Payroll Summary", icon: BanknoteIcon, module: "branch_reports" },
      { id: "adm-branch-reports", label: "Branch Reports", icon: TrendingUpIcon, module: "branch_reports" },
    ],
  },
  { section: "RFID", items: [{ id: "adm-maintenance", label: "RFID Terminal & Cards", icon: RadioTowerIcon, module: "system_maintenance" }] },
  { section: "Account", items: [{ id: "adm-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
const TITLES = Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label]));

const DESCRIPTIONS = {
  "adm-dashboard": "Today's attendance, pending leave, headcount and recent activity for your branch.",
  "adm-attendance": "Daily and monthly attendance of your branch. View only: flag a record for HR to check.",
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
      {current === "adm-leaves" ? <LeaveRecommendationsPage refreshKey={refreshKey} /> : null}
      {current === "adm-transfers" ? <TransferEndorsementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-incentives" ? <IncentiveEndorsementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-schedules" ? <ScheduleRequestsPage refreshKey={refreshKey} /> : null}
      {current === "adm-incidents" ? <IncidentReportsPage refreshKey={refreshKey} /> : null}
      {current === "adm-rfid-issues" ? <RfidIssuesPage refreshKey={refreshKey} /> : null}
      {current === "adm-announcements" ? <AnnouncementsPage refreshKey={refreshKey} /> : null}
      {current === "adm-payroll" ? <PayrollSummaryPage refreshKey={refreshKey} /> : null}
      {current === "adm-branch-reports" ? <BranchReportsPage refreshKey={refreshKey} /> : null}
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
