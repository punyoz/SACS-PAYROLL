"use client";

import * as React from "react";
import { CalendarCheckIcon, ClipboardCheckIcon, LayoutDashboardIcon, ScrollTextIcon, TrendingUpIcon, UserRoundIcon, WrenchIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { useEmployeeRecordPage } from "@/components/portal/use-employee-page";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { EmployeeAttendanceRecord } from "@/components/portal/attendance/employee-record";
import { logAuditMovement } from "@/lib/portal/audit";
import { DashboardPage } from "./dashboard-page";
import { AttendancePage } from "./attendance-page";
import { AuditLogsPage } from "./audit-logs-page";
import { MaintenancePage } from "./maintenance-page";
import { BranchReportsPage } from "./branch-reports-page";
import { ApprovalsPage } from "@/components/portal/approvals-page";

/*
 * Page ids are the legacy portal's (public/legacy/js/admin.js ADMIN_PAGES),
 * so the saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "adm-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  { section: "Attendance", items: [{ id: "adm-attendance", label: "Attendance", icon: CalendarCheckIcon, module: "attendance" }] },
  { section: "Payroll", items: [{ id: "adm-approvals", label: "Approvals", icon: ClipboardCheckIcon, module: "payroll_approvals" }] },
  { section: "Reports", items: [{ id: "adm-branch-reports", label: "Branch Reports", icon: TrendingUpIcon, module: "branch_reports" }] },
  {
    section: "System",
    items: [
      { id: "adm-maintenance", label: "System Maintenance", icon: WrenchIcon, module: "system_maintenance" },
      { id: "adm-audit-logs", label: "Audit Logs", icon: ScrollTextIcon, module: "audit_logs" },
    ],
  },
  { section: "Account", items: [{ id: "adm-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const EMPLOYEE_PAGE = "adm-att-employee";
const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = [...NAV_ITEMS.map((item) => item.id), EMPLOYEE_PAGE];
const TITLES = { ...Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label])), [EMPLOYEE_PAGE]: "Employee Attendance Record" };

const DESCRIPTIONS = {
  "adm-dashboard": "School-wide payroll and attendance overview.",
  "adm-attendance": "School-wide RFID attendance — read, correct and export.",
  [EMPLOYEE_PAGE]: "One employee's attendance, corrections and leave.",
  "adm-audit-logs": "Track admin and system movements across payroll operations.",
  "adm-maintenance": "Register, replace and void RFID cards, and record RFID card scans for your branch.",
  "adm-branch-reports": "Attendance, headcount and payroll status for your branch.",
  "adm-approvals": "AWOL separations, excess subsidy advances and missed-month subsidy adjustments waiting for your decision.",
  "adm-profile": null,
};

function AdminScreens() {
  const { can, me } = usePortalSession();
  const [page, setPage] = usePersistedPage("admin", PAGE_IDS, "adm-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);

  const allowed = (id) => {
    if (id === EMPLOYEE_PAGE) return can("attendance");
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "adm-dashboard";

  const { employeeId, openEmployee, navigate } = useEmployeeRecordPage(current, setPage, EMPLOYEE_PAGE, "adm-attendance");

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
    <AttendanceActionsProvider onOpenEmployee={openEmployee}>
      <AppShell
        nav={NAV}
        page={current === EMPLOYEE_PAGE ? "adm-attendance" : current}
        onNavigate={navigate}
        title={TITLES[current]}
        description={DESCRIPTIONS[current]}
        onRefresh={refresh}
        refreshing={refreshing}
        notificationSummary={summary}
        profilePage="adm-profile"
        accountOptions={{ payrollReadOnly: false, titleCaseName: true, showBank: false }}
      >
        {current === "adm-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} /> : null}
        {current === "adm-attendance" ? <AttendancePage refreshKey={refreshKey} onNavigate={navigate} /> : null}
        {current === EMPLOYEE_PAGE && employeeId ? (
          <EmployeeAttendanceRecord key={`${employeeId}-${refreshKey}`} employeeId={employeeId} onBack={() => navigate("adm-attendance")} />
        ) : null}
        {current === "adm-audit-logs" ? <AuditLogsPage refreshKey={refreshKey} /> : null}
        {current === "adm-maintenance" ? <MaintenancePage refreshKey={refreshKey} /> : null}
        {current === "adm-branch-reports" ? <BranchReportsPage refreshKey={refreshKey} /> : null}
        {current === "adm-approvals" ? <ApprovalsPage refreshKey={refreshKey} /> : null}
        {current === "adm-profile" ? <StaffProfilePage roleLabel="Administrator" /> : null}
      </AppShell>
    </AttendanceActionsProvider>
  );
}

export function AdminPortal() {
  return (
    <PortalSessionProvider role="admin" gate={PasswordGate}>
      <AdminScreens />
    </PortalSessionProvider>
  );
}
