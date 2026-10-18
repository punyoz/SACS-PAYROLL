"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import { ArrowLeftRightIcon, BadgeCheckIcon, ReceiptTextIcon, CalendarCheckIcon, CalendarClockIcon, ClipboardCheckIcon, CalendarDaysIcon, FileBarChartIcon, LayoutDashboardIcon, ShieldCheckIcon, UserRoundIcon, UserXIcon, UsersIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { useEmployeeRecordPage } from "@/components/portal/use-employee-page";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { EmployeeAttendanceRecord } from "@/components/portal/attendance/employee-record";
import { EmployeesPage } from "./employees-page";
import { TransfersPage } from "./transfers-page";
import { AttendancePage } from "./attendance-page";
import { LeavesPage } from "./leaves-page";
import { AwolCasesPage } from "./awol-cases-page";
import { ApprovalsPage } from "@/components/portal/approvals-page";
import { WorkSchedulesPanel } from "@/components/portal/work-schedules";
import { EarlyBirdCard } from "@/components/portal/early-bird-card";
import { usePendingRunCount } from "@/components/portal/use-live-payroll-runs";
import { PayrollApprovalPage } from "./payroll-approval-page";
import { PayrollRecordsPage } from "./payroll-records-page";
import { TenureProtectionPanel } from "@/components/portal/tenure-protection";

// Charts (recharts) load with these pages, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });
const ReportsPage = dynamic(() => import("./reports-page").then((m) => m.ReportsPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (public/legacy/js/hr.js HR_PAGES), so the
 * saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  { section: "Overview", items: [{ id: "hr-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
  {
    section: "Employees",
    items: [
      { id: "hr-employees", label: "User Management", icon: UsersIcon, module: "user_management" },
      { id: "hr-transfers", label: "Transfer Requests", icon: ArrowLeftRightIcon, module: "transfer_requests" },
      { id: "hr-tenure", label: "Tenure Pay Protection", icon: ShieldCheckIcon, module: "tenure_protection" },
    ],
  },
  {
    section: "Attendance",
    items: [
      { id: "hr-attendance", label: "Attendance", icon: CalendarCheckIcon, module: "attendance" },
      { id: "hr-schedules", label: "Work Schedules", icon: CalendarClockIcon, module: "work_schedules" },
    ],
  },
  {
    section: "Leave",
    items: [
      { id: "hr-leaves", label: "Leave Approval", icon: CalendarDaysIcon, module: "leave_approval" },
      { id: "hr-awol", label: "AWOL Cases", icon: UserXIcon, module: "awol_cases" },
      { id: "hr-approvals", label: "Approvals", icon: ClipboardCheckIcon, module: "payroll_approvals" },
    ],
  },
  {
    section: "Payroll",
    items: [
      { id: "hr-payroll-approval", label: "Payroll Approval", icon: BadgeCheckIcon, module: "payroll_run_approval" },
      { id: "hr-payroll-records", label: "Payroll Records", icon: ReceiptTextIcon, module: "payroll_records" },
    ],
  },
  { section: "Reports", items: [{ id: "hr-reports", label: "HR Reports", icon: FileBarChartIcon, module: "hr_reports" }] },
  { section: "Account", items: [{ id: "hr-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const EMPLOYEE_PAGE = "hr-att-employee";
const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = [...NAV_ITEMS.map((item) => item.id), EMPLOYEE_PAGE];
const TITLES = {
  "hr-dashboard": "HR Dashboard",
  "hr-employees": "User Management",
  "hr-transfers": "Transfer Requests",
  "hr-tenure": "Tenure Pay Protection",
  "hr-attendance": "Attendance Monitoring",
  "hr-schedules": "Work Schedules",
  "hr-payroll-approval": "Payroll Approval",
  "hr-payroll-records": "Payroll Records",
  [EMPLOYEE_PAGE]: "Employee Attendance Record",
  "hr-leaves": "Leave Approval",
  "hr-awol": "AWOL Cases",
  "hr-approvals": "Approvals",
  "hr-reports": "HR Reports",
  "hr-profile": "Profile",
};
const DESCRIPTIONS = {
  "hr-dashboard": "Attendance summaries, leave notifications, and quick HR access.",
  "hr-employees": "Create and maintain Employee and Accountant accounts and their 201 records for every branch.",
  "hr-transfers": "See where every employee is assigned and move employees between branches. Each transfer applies immediately and is kept in Transfer History.",
  "hr-attendance": "Review employee attendance records, track absences and tardiness.",
  "hr-tenure": "Set who is not deducted for absence, lateness, holidays, suspensions and school breaks under a tenure contract clause, and grant or revoke it per employee. Every change is logged.",
  "hr-schedules": "Create, change and assign employee work schedules, and set the Early Bird incentive. Every change takes effect from a date and is logged.",
  [EMPLOYEE_PAGE]: "One employee's attendance, corrections and leave.",
  "hr-leaves": "Review, approve, or reject employee leave applications and monitor leave history.",
  "hr-approvals": "Recommend a decision for excess subsidy advances the teacher refused to sign for.",
  "hr-awol": "Unexcused absences flagged by the nightly check: confirm, send the notices, and separate or close each case.",
  "hr-reports": "Generate attendance reports and employee record summaries for documentation.",
  "hr-payroll-approval": "Review each branch's payroll for a cutoff, then approve it or send it back to the Accountant with a reason.",
  "hr-payroll-records": "Every employee's processed payslips across all branches, read-only. Open any payslip to print or download it.",
  "hr-profile": null,
};

function HrScreens() {
  const { can } = usePortalSession();
  const [page, setPage] = usePersistedPage("hr", PAGE_IDS, "hr-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);
  // Pending payroll runs, live (the sidebar badge).
  const [pendingRuns, reloadPending] = usePendingRunCount(can("payroll_run_approval"));

  const allowed = (id) => {
    if (id === EMPLOYEE_PAGE) return can("attendance");
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "hr-dashboard";
  const { employeeId, openEmployee, navigate } = useEmployeeRecordPage(current, setPage, EMPLOYEE_PAGE, "hr-attendance");

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    setRefreshKey((n) => n + 1);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  return (
    <AttendanceActionsProvider onOpenEmployee={openEmployee}>
      <AppShell
        nav={NAV}
        page={current === EMPLOYEE_PAGE ? "hr-attendance" : current}
        onNavigate={navigate}
        title={TITLES[current]}
        description={DESCRIPTIONS[current]}
        onRefresh={refresh}
        refreshing={refreshing}
        notificationSummary={summary}
        badges={{ "hr-payroll-approval": pendingRuns }}
        profilePage="hr-profile"
        accountOptions={{ payrollReadOnly: false }}
      >
        {current === "hr-dashboard" ? <DashboardPage refreshKey={refreshKey} onNavigate={navigate} onSummary={setSummary} /> : null}
        {current === "hr-employees" ? <EmployeesPage refreshKey={refreshKey} /> : null}
        {current === "hr-transfers" ? <TransfersPage refreshKey={refreshKey} /> : null}
        {current === "hr-tenure" ? <TenureProtectionPanel refreshKey={refreshKey} /> : null}
        {current === "hr-attendance" ? <AttendancePage refreshKey={refreshKey} /> : null}
        {current === "hr-payroll-approval" ? <PayrollApprovalPage refreshKey={refreshKey} onChanged={reloadPending} /> : null}
        {current === "hr-payroll-records" ? <PayrollRecordsPage refreshKey={refreshKey} /> : null}
        {current === "hr-schedules" ? (
          <div className="flex flex-col gap-4">
            <WorkSchedulesPanel refreshKey={refreshKey} />
            <EarlyBirdCard refreshKey={refreshKey} />
          </div>
        ) : null}
        {current === EMPLOYEE_PAGE && employeeId ? (
          <EmployeeAttendanceRecord key={`${employeeId}-${refreshKey}`} employeeId={employeeId} onBack={() => navigate("hr-attendance")} />
        ) : null}
        {current === "hr-leaves" ? <LeavesPage refreshKey={refreshKey} /> : null}
        {current === "hr-awol" ? <AwolCasesPage refreshKey={refreshKey} /> : null}
        {current === "hr-approvals" ? <ApprovalsPage refreshKey={refreshKey} /> : null}
        {current === "hr-reports" ? <ReportsPage /> : null}
        {current === "hr-profile" ? <StaffProfilePage roleLabel="HR" showPosition /> : null}
      </AppShell>
    </AttendanceActionsProvider>
  );
}

export function HrPortal() {
  return (
    <PortalSessionProvider role="hr" gate={PasswordGate}>
      <HrScreens />
    </PortalSessionProvider>
  );
}
