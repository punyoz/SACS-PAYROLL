"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import {
  BuildingIcon,
  CalendarCheckIcon,
  DatabaseBackupIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { useEmployeeRecordPage } from "@/components/portal/use-employee-page";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { EmployeeAttendanceRecord } from "@/components/portal/attendance/employee-record";
import { manilaDateKey } from "@/lib/portal/format";
import { AttendancePage } from "../admin/attendance-page";
import { AuditLogsPage } from "../admin/audit-logs-page";
import { MaintenancePage } from "../admin/maintenance-page";
import { BranchesPage } from "./branches-page";
import { AccountsPage } from "./accounts-page";
import { RolesPage } from "./roles-page";
import { ConfigPage } from "./config-page";
import { BackupPage } from "./backup-page";

// Charts (recharts) load with this page, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (SA_PAGES, public/legacy/js/super-admin.js),
 * so the saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  {
    section: "Overview",
    items: [
      { id: "sa-dashboard", label: "SA Dashboard", icon: LayoutDashboardIcon, module: "dashboard" },
      { id: "sa-attendance", label: "Attendance", icon: CalendarCheckIcon, module: "attendance" },
    ],
  },
  {
    section: "Management",
    items: [
      { id: "sa-accounts", label: "Admin & HR Accounts", icon: UsersRoundIcon, module: "user_management" },
      { id: "sa-branches", label: "Branch Management", icon: BuildingIcon, module: "branch_management" },
      { id: "sa-roles", label: "Roles & Permissions", icon: ShieldCheckIcon, module: "roles_permissions" },
    ],
  },
  {
    section: "System",
    items: [
      { id: "sa-maintenance", label: "System Maintenance", icon: WrenchIcon, module: "system_maintenance" },
      { id: "sa-config", label: "System Configuration", icon: SettingsIcon, module: "system_configuration" },
      { id: "sa-audit", label: "Audit & Monitoring", icon: ScrollTextIcon, module: "audit_logs" },
      { id: "sa-backup", label: "Backup & Recovery", icon: DatabaseBackupIcon, module: "backup_recovery" },
    ],
  },
  { section: "Account", items: [{ id: "sa-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const EMPLOYEE_PAGE = "sa-att-employee";
const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = [...NAV_ITEMS.map((item) => item.id), EMPLOYEE_PAGE];
const TITLES = { ...Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label])), [EMPLOYEE_PAGE]: "Employee Attendance Record" };

const DESCRIPTIONS = {
  "sa-dashboard": "Centralized monitoring of all branches, system health, and overall activity.",
  "sa-attendance": "System-wide RFID attendance — read, correct and export.",
  [EMPLOYEE_PAGE]: "One employee's attendance, taps, corrections and leave.",
  "sa-accounts": "Create and maintain the login accounts of Super Admin, Admin and HR staff. Employee and Accountant accounts are managed by HR.",
  "sa-branches": "Manage branch information and status across all branches.",
  "sa-roles": "What each role can reach across the system.",
  "sa-maintenance": "Manage RFID device registration and record RFID card scans.",
  "sa-config": "System-wide settings, payroll rules, attendance policies and holidays.",
  "sa-audit": "System-wide audit trails, login activity and transaction history across all branches.",
  "sa-backup": "Database status, manual exports and recovery procedures.",
  "sa-profile": null,
};

function SuperAdminScreens() {
  const { can } = usePortalSession();
  const [page, setPage] = usePersistedPage("super_admin", PAGE_IDS, "sa-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);

  const allowed = (id) => {
    if (id === EMPLOYEE_PAGE) return can("attendance");
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "sa-dashboard";

  const { employeeId, openEmployee, navigate } = useEmployeeRecordPage(current, setPage, EMPLOYEE_PAGE, "sa-attendance");

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    setRefreshKey((n) => n + 1);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  return (
    <AttendanceActionsProvider onOpenEmployee={openEmployee}>
      <AppShell
        nav={NAV}
        page={current === EMPLOYEE_PAGE ? "sa-attendance" : current}
        onNavigate={navigate}
        title={TITLES[current]}
        description={DESCRIPTIONS[current]}
        onRefresh={refresh}
        refreshing={refreshing}
        notificationSummary={summary}
        profilePage="sa-profile"
        accountOptions={{ payrollReadOnly: false, titleCaseName: true, showBank: false }}
      >
        {current === "sa-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} onNavigate={navigate} /> : null}
        {current === "sa-attendance" ? (
          <AttendancePage
            refreshKey={refreshKey}
            onNavigate={navigate}
            maintenancePage="sa-maintenance"
            terminalText="Open the dedicated tap-in/tap-out screen for an RFID reader. It accepts cards from every branch, replaces this view and is locked behind your Super Admin password."
            branchFilter
            auditActor={null}
          />
        ) : null}
        {current === EMPLOYEE_PAGE && employeeId ? (
          <EmployeeAttendanceRecord key={`${employeeId}-${refreshKey}`} employeeId={employeeId} onBack={() => navigate("sa-attendance")} />
        ) : null}
        {current === "sa-accounts" ? <AccountsPage refreshKey={refreshKey} /> : null}
        {current === "sa-branches" ? <BranchesPage refreshKey={refreshKey} /> : null}
        {current === "sa-roles" ? <RolesPage /> : null}
        {current === "sa-maintenance" ? (
          <MaintenancePage
            refreshKey={refreshKey}
            registrationText="Assign or update RFID UIDs for employees. The UID is used to match RFID card taps to attendance records. Void a card that is lost or no longer in use."
            auditActor={null}
          />
        ) : null}
        {current === "sa-config" ? <ConfigPage refreshKey={refreshKey} /> : null}
        {current === "sa-audit" ? (
          <AuditLogsPage refreshKey={refreshKey} limit={200} csvName={() => `sacs-sa-audit-${manilaDateKey()}.csv`} auditActor={null} />
        ) : null}
        {current === "sa-backup" ? <BackupPage refreshKey={refreshKey} /> : null}
        {current === "sa-profile" ? <StaffProfilePage roleLabel="Super Admin" accountOnly /> : null}
      </AppShell>
    </AttendanceActionsProvider>
  );
}

export function SuperAdminPortal() {
  return (
    <PortalSessionProvider role="super_admin" gate={PasswordGate}>
      <SuperAdminScreens />
    </PortalSessionProvider>
  );
}
