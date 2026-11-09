"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import { LayoutDashboardIcon, MegaphoneIcon } from "lucide-react";
import { AnnouncementsFeed } from "@/components/portal/announcements";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { isPendingRequest } from "@/components/portal/status-badge";
import { useEmployeeStats, useLeaveRequests, usePayslips } from "./use-employee-data";
import { AttendancePage } from "./attendance-page";
import { TimesheetPage } from "./timesheet-page";
import { PayslipsPage } from "./payslips-page";
import { LeavePage } from "./leave-page";
import { ProfilePage } from "./profile-page";
import { MY_DESCRIPTIONS, MY_PAGE_IDS, MY_REQUEST_ALIASES, MyBirPage, MyRequestsPage, myAccountGroup } from "@/components/portal/my-account";

// Charts (recharts) load with this page, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (public/legacy/js/employee.js EMP_PAGES),
 * so the saved page carries over between the two and sign-out clears it.
 * `module` is the permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "emp-dash", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  // School-wide and branch announcements stay where they were.
  { section: "Communication", items: [{ id: "emp-announcements", label: "Announcements", icon: MegaphoneIcon, module: "announcements" }] },
  // Every personal page in ONE group (2026-11-09 Part E): the same group HR and
  // the Accountant get; expanded by default here (the Employee has no work pages).
  myAccountGroup("emp", { defaultOpen: true }),
];

const PAGES = NAV.flatMap((group) => group.items);
const PAGE_IDS = PAGES.map((item) => item.id);

const DESCRIPTIONS = {
  "emp-dash": null,
  "emp-announcements": "Announcements for the whole school and for your branch.",
  ...Object.fromEntries(Object.entries(MY_PAGE_IDS.emp).map(([kind, id]) => [id, MY_DESCRIPTIONS[kind]])),
};

function EmployeeScreens() {
  const session = usePortalSession();
  const { ctx, notify, can } = session;
  const [rawPage, setPage] = usePersistedPage("employee", [...PAGE_IDS, ...Object.keys(MY_REQUEST_ALIASES)], "emp-dash");
  // Old personal URLs (?page=emp-loans …) open the matching tab of My Requests.
  const aliasTab = MY_REQUEST_ALIASES[rawPage] || null;
  const page = aliasTab ? MY_PAGE_IDS.emp.requests : rawPage;
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);

  const email = String(ctx?.email || "").trim();
  const stats = useEmployeeStats(email, refreshKey);
  const payslips = usePayslips(email, refreshKey);
  const leave = useLeaveRequests(ctx, notify, refreshKey);

  // A page the role may not open (a stale saved id) falls back to the dashboard.
  const current = PAGES.find((item) => item.id === page && can(item.module)) ? page : "emp-dash";

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    setRefreshKey((n) => n + 1);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  // The bell's summary (getRoleNotifications, app.js, Employee screen).
  const summary = React.useMemo(() => {
    const data = stats.data;
    // Leave waits as "pending_admin" until HR decides (isPendingRequest).
    const pending = leave.requests.filter((r) => isPendingRequest(r.status)).length;
    return [
      {
        title: data ? `This month: ${data.present ?? 0} present · ${data.late ?? 0} late · ${data.absent ?? 0} absent` : "Attendance data loading…",
        description: data?.basic_salary ? `Basic salary: ${data.basic_salary}` : "Attendance is tracked via RFID tap.",
      },
      {
        title: pending > 0 ? `${pending} leave request${pending > 1 ? "s" : ""} pending approval` : "No pending leave requests",
        description: "Submit a leave request from the Leave page.",
      },
    ];
  }, [stats.data, leave.requests]);

  const title = PAGES.find((item) => item.id === current)?.label || "Dashboard";

  return (
    <AppShell
      nav={NAV}
      page={current}
      onNavigate={setPage}
      title={title}
      description={DESCRIPTIONS[current]}
      onRefresh={refresh}
      refreshing={refreshing}
      notificationSummary={summary}
      profilePage="emp-profile"
      accountOptions={{ payrollReadOnly: true }}
    >
      {current === "emp-dash" ? <DashboardPage stats={stats} payslips={payslips} leave={leave} onNavigate={setPage} /> : null}
      {current === "emp-attendance" ? <AttendancePage stats={stats} refreshKey={refreshKey} /> : null}
      {current === "emp-timesheet" ? <TimesheetPage /> : null}
      {current === "emp-payslips" ? <PayslipsPage payslips={payslips} /> : null}
      {current === "emp-leave" ? <LeavePage leave={leave} /> : null}
      {current === "emp-requests" ? <MyRequestsPage refreshKey={refreshKey} initialTab={aliasTab || undefined} /> : null}
      {current === "emp-bir" ? <MyBirPage /> : null}
      {current === "emp-announcements" ? <AnnouncementsFeed /> : null}
      {current === "emp-profile" ? <ProfilePage /> : null}
    </AppShell>
  );
}

export function EmployeePortal() {
  return (
    <PortalSessionProvider role="employee" gate={PasswordGate}>
      <EmployeeScreens />
    </PortalSessionProvider>
  );
}
