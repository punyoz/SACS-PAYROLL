"use client";

import * as React from "react";
import { CalendarCheckIcon, LayoutDashboardIcon, ScrollTextIcon, TrendingUpIcon, UserRoundIcon, WrenchIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { EmployeeAttendanceRecord } from "@/components/portal/attendance/employee-record";
import { logAuditMovement } from "@/lib/portal/audit";
import { DashboardPage } from "./dashboard-page";
import { AttendancePage } from "./attendance-page";
import { AuditLogsPage } from "./audit-logs-page";
import { MaintenancePage } from "./maintenance-page";
import { BranchReportsPage } from "./branch-reports-page";

/*
 * Page ids are the legacy portal's (public/legacy/js/admin.js ADMIN_PAGES),
 * so the saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "adm-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  { section: "Attendance", items: [{ id: "adm-attendance", label: "Attendance", icon: CalendarCheckIcon, module: "attendance" }] },
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
  "adm-profile": null,
};

// The employee whose record page is open: ?employee= in the URL, then this
// session (attEmployeeStoredId, app.js), so a refresh reopens it.
const EMPLOYEE_KEY = "sacs-att-employee";

function storedEmployeeId() {
  try {
    return new URLSearchParams(window.location.search).get("employee") || sessionStorage.getItem(EMPLOYEE_KEY) || "";
  } catch {
    return "";
  }
}

function AdminScreens() {
  const { can, me } = usePortalSession();
  const [page, setPage] = usePersistedPage("admin", PAGE_IDS, "adm-dashboard");
  const [employeeId, setEmployeeId] = React.useState("");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);

  const allowed = (id) => {
    if (id === EMPLOYEE_PAGE) return can("attendance");
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "adm-dashboard";

  React.useEffect(() => {
    if (current === EMPLOYEE_PAGE && !employeeId) {
      const stored = storedEmployeeId();
      if (stored) setEmployeeId(stored);
      else setPage("adm-attendance");
    }
  }, [current, employeeId, setPage]);

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

  const openEmployee = React.useCallback((id) => {
    const value = String(id || "");
    if (!value) return;
    setEmployeeId(value);
    try { sessionStorage.setItem(EMPLOYEE_KEY, value); } catch { /* private mode */ }
    setPage(EMPLOYEE_PAGE);
    const params = new URLSearchParams(window.location.search);
    params.set("employee", value);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [setPage]);

  const navigate = React.useCallback((id) => {
    if (id !== EMPLOYEE_PAGE) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("employee")) {
        params.delete("employee");
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      }
    }
    setPage(id);
  }, [setPage]);

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
