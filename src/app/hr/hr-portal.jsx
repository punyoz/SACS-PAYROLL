"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import { ArrowLeftRightIcon, BadgeCheckIcon, LandmarkIcon, CreditCardIcon, RadioTowerIcon, InboxIcon, SirenIcon, ReceiptTextIcon, CalendarCheckIcon, CalendarClockIcon, ClipboardCheckIcon, CalendarDaysIcon, FileBarChartIcon, LayoutDashboardIcon, ShieldCheckIcon, UserRoundIcon, UserXIcon, UsersIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { GovernmentRatesPanel } from "@/components/portal/government-rates";
import { AdjustmentApprovalsPanel } from "@/components/portal/adjustment-approvals";
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
import { BranchRequestsReview } from "@/components/portal/branch-requests-review";
import { RfidCardsPanel } from "@/components/portal/rfid/rfid-cards-panel";
import { RfidTerminalsPanel } from "@/components/portal/rfid/rfid-terminals-panel";

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
    // RFID registration and terminals for every branch (2026-10-21), the same
    // records the Super Admin and each branch's Admin manage.
    section: "RFID",
    items: [
      { id: "hr-rfid-cards", label: "RFID Cards", icon: CreditCardIcon, module: "rfid_devices" },
      { id: "hr-rfid-terminals", label: "RFID Terminals", icon: RadioTowerIcon, module: "rfid_devices" },
    ],
  },
  {
    section: "Leave",
    items: [
      { id: "hr-leaves", label: "Leave Approval", icon: CalendarDaysIcon, module: "leave_approval" },
      { id: "hr-awol", label: "AWOL Cases", icon: UserXIcon, module: "awol_cases" },
    ],
  },
  {
    // What the branch Admins send (2026-10-20): HR decides.
    section: "Branch Admins",
    items: [{ id: "hr-branch-requests", label: "Branch Requests", icon: InboxIcon, module: "branch_oversight" }],
  },
  {
    section: "Payroll",
    items: [
      { id: "hr-payroll-approval", label: "Payroll Approval", icon: BadgeCheckIcon, module: "payroll_run_approval" },
      { id: "hr-payroll-records", label: "Payroll Records", icon: ReceiptTextIcon, module: "payroll_records" },
      // Moved from Leave (2026-10-20): subsidy decisions are payroll, not leave.
      { id: "hr-subsidy-approvals", label: "Subsidy Approvals", icon: ClipboardCheckIcon, module: "payroll_approvals" },
      // Incentives, overload and loans the Accountant filed (20261027020000).
      { id: "hr-adjustment-approvals", label: "Incentive & Loan Approvals", icon: ClipboardCheckIcon, module: "payroll_approvals" },
      // Read-only (2026-10-26): to answer employees' questions about deductions.
      { id: "hr-gov-rates", label: "Government Rates", icon: LandmarkIcon, module: "government_rates" },
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
  "hr-rfid-cards": "RFID Cards",
  "hr-rfid-terminals": "RFID Terminals",
  "hr-payroll-approval": "Payroll Approval",
  "hr-payroll-records": "Payroll Records",
  [EMPLOYEE_PAGE]: "Employee Attendance Record",
  "hr-leaves": "Leave Approval",
  "hr-awol": "AWOL Cases",
  "hr-branch-requests": "Branch Requests",
  "hr-subsidy-approvals": "Subsidy Approvals",
  "hr-adjustment-approvals": "Incentive & Loan Approvals",
  "hr-gov-rates": "Government Rates",
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
  "hr-rfid-cards": "Register, replace, deactivate and reactivate employees' RFID cards for every branch. Only an Active card records attendance; every action is kept in the card history.",
  "hr-rfid-terminals": "The RFID readers of every branch: add and name them, switch them on or off, and open the RFID Terminal on one.",
  [EMPLOYEE_PAGE]: "One employee's attendance, corrections and leave.",
  "hr-leaves": "Review, approve, or reject employee leave applications and monitor leave history.",
  "hr-subsidy-approvals": "Approve or reject the subsidies the Accountant processed: missed-month adjustments, subsidy advances and excess-advance settlements. HR is the only approver; every decision stays in the history.",
  "hr-awol": "Unexcused absences flagged by the nightly check or reported by a branch Admin: confirm, send the notices, and separate or close each case.",
  "hr-branch-requests": "Attendance flags, schedule requests, incentive recommendations, RFID issues and overtime confirmations sent by the branch Admins. HR decides; the Admin is notified.",
  "hr-reports": "Generate attendance reports and employee record summaries for documentation.",
  "hr-adjustment-approvals": "Approve or reject the incentives, overload, loans and cash advances the Accountant filed. Payroll pays or deducts only approved ones; a rejection needs a reason and the Accountant is notified.",
  "hr-gov-rates": "View-only — the SSS, PhilHealth, Pag-IBIG and withholding tax tables payroll uses, and every change to them.",
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
        {current === "hr-rfid-cards" ? <RfidCardsPanel refreshKey={refreshKey} /> : null}
        {current === "hr-rfid-terminals" ? <RfidTerminalsPanel refreshKey={refreshKey} canAdd={false} /> : null}
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
        {current === "hr-awol" ? (
          <div className="flex flex-col gap-4">
            <AwolCasesPage refreshKey={refreshKey} />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["incident_report"]} icon={SirenIcon} title="Incident reports from branch Admins"
              description="A reported no-show is already in the AWOL cases above (flagged). Handle the case there, then mark the report resolved with a remark for the Admin." />
          </div>
        ) : null}
        {current === "hr-branch-requests" ? (
          <div className="flex flex-col gap-4">
            <BranchRequestsReview refreshKey={refreshKey} kinds={["attendance_flag"]} title="Attendance flags" description="Records a branch Admin asked HR to check. Correct the record in Attendance if needed, then mark it resolved." />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["schedule_request"]} title="Work schedule & class-load requests" description="Approve or reject. Apply an approved change in Work Schedules." />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["incentive_endorsement"]} title="Incentive recommendations" description="Approving adds the incentive or overload to payroll, counted by today's date (after the month's cutoff it moves to next month's payroll)." />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["rfid_issue"]} title="RFID issues" description="Lost or broken cards and faulty readers. HR or the Super Admin marks them resolved." />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["overtime_confirmation"]} readOnly title="Overtime & substitute-teaching confirmations" description="The branch Admin's confirmation; the Accountant reads it before paying. Nothing to decide here." />
          </div>
        ) : null}
        {current === "hr-subsidy-approvals" ? <ApprovalsPage refreshKey={refreshKey} /> : null}
        {current === "hr-reports" ? <ReportsPage /> : null}
        {current === "hr-gov-rates" ? <GovernmentRatesPanel refreshKey={refreshKey} /> : null}
        {current === "hr-adjustment-approvals" ? <AdjustmentApprovalsPanel refreshKey={refreshKey} /> : null}
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
