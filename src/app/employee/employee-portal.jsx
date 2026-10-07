"use client";

import * as React from "react";
import { CalendarCheckIcon, CalendarDaysIcon, ClockIcon, LayoutDashboardIcon, ReceiptTextIcon, UserRoundIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { useEmployeeStats, useLeaveRequests, usePayslips } from "./use-employee-data";
import { DashboardPage } from "./dashboard-page";
import { AttendancePage } from "./attendance-page";
import { TimesheetPage } from "./timesheet-page";
import { PayslipsPage } from "./payslips-page";
import { LeavePage } from "./leave-page";
import { ProfilePage } from "./profile-page";

/*
 * Page ids are the legacy portal's (public/legacy/js/employee.js EMP_PAGES),
 * so the saved page carries over between the two and sign-out clears it.
 * `module` is the permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "emp-dash", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  {
    section: "Attendance",
    items: [
      { id: "emp-attendance", label: "Attendance", icon: CalendarCheckIcon, module: "attendance" },
      { id: "emp-timesheet", label: "Timesheet", icon: ClockIcon, module: "timesheet" },
    ],
  },
  { section: "Payroll", items: [{ id: "emp-payslips", label: "Payslips", icon: ReceiptTextIcon, module: "payslips" }] },
  { section: "Leave", items: [{ id: "emp-leave", label: "Leave", icon: CalendarDaysIcon, module: "leave_approval" }] },
  { section: "Account", items: [{ id: "emp-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const PAGES = NAV.flatMap((group) => group.items);
const PAGE_IDS = PAGES.map((item) => item.id);

const DESCRIPTIONS = {
  "emp-dash": null,
  "emp-attendance": "Your attendance this month, recorded by RFID tap.",
  "emp-timesheet": "Daily work hours, tardiness and undertime for any date range.",
  "emp-payslips": "Your latest payslip and earlier ones, with the full breakdown.",
  "emp-leave": "Request leave and follow its approval.",
  "emp-profile": "Your personal, contact, government and bank details on file.",
};

function EmployeeScreens() {
  const session = usePortalSession();
  const { ctx, notify, can } = session;
  const [page, setPage] = usePersistedPage("employee", PAGE_IDS, "emp-dash");
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
    const pending = leave.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending").length;
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
