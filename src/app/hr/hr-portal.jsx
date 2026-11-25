"use client";

import { MaintenancePage } from "../admin/maintenance-page";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import { ArrowLeftRightIcon, BadgeCheckIcon, LandmarkIcon, CreditCardIcon, RadioTowerIcon, InboxIcon, SirenIcon, ReceiptTextIcon, CalendarCheckIcon, CalendarClockIcon, CalendarHeartIcon, ClipboardCheckIcon, CalendarDaysIcon, FileBarChartIcon, LayoutDashboardIcon, MegaphoneIcon, ShieldCheckIcon, SlidersHorizontalIcon, UserXIcon, UsersIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { MY_DESCRIPTIONS, MY_PAGE_IDS, MyAccountScreen, myAccountGroup, myAccountItem, myPageKind } from "@/components/portal/my-account";
import { navPages } from "@/lib/portal/nav-tabs";
import { NOT_FOUND_PAGE, PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { AnnouncementsManager } from "@/components/portal/announcements";
import { GovernmentRatesPanel } from "@/components/portal/government-rates";
import { AdjustmentApprovalsPanel } from "@/components/portal/adjustment-approvals";
import { useEmployeeRecordPage } from "@/components/portal/use-employee-page";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { EmployeeAttendanceRecord } from "@/components/portal/attendance/employee-record";
import { EmployeesPage } from "./employees-page";
import { SubstitutionsReportCard } from "@/components/portal/substitutions";
import { SubstitutionsPanel } from "@/components/portal/substitutions";
import { GovernmentLoansPage } from "./government-loans-page";
import { AutomationSettings } from "@/components/portal/automation-settings";
import { DecisionReasonsCard, RemarkPresetsCard } from "@/components/portal/remark-presets-manager";
import { ClassificationRulesPage } from "./classification-rules-page";
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
import { fetchJson } from "@/lib/portal/api";
import { TenureProtectionPanel } from "@/components/portal/tenure-protection";
import { BranchRequestsReview } from "@/components/portal/branch-requests-review";
import { RfidCardsPanel } from "@/components/portal/rfid/rfid-cards-panel";
import { HolidayDutyPage } from "@/components/portal/holiday-duty";
import { RatesSection } from "@/app/super-admin/rates-section";
import { PayrollSettingsSection } from "@/app/super-admin/tax-section";
import { LeaveConversionCard } from "@/components/portal/leave-conversion-card";
import { SpecialDaysPanel } from "@/components/portal/special-days";

// Charts (recharts) load with these pages, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });
const ReportsPage = dynamic(() => import("./reports-page").then((m) => m.ReportsPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (public/legacy/js/hr.js HR_PAGES), so the
 * saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 */
const NAV = [
  // Part I (2026-11-23): one item per module, a tab per page (each tab keeps its page id, permission and filters).
  { section: "Overview", items: [{ id: "hr-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, tabs: [
    { id: "hr-dashboard", label: "Overview", module: "dashboard" },
    // School-wide and branch announcements (2026-10-30).
    { id: "hr-announcements", label: "Announcements", module: "announcements" },
  ] }] },
  {
    section: "Work",
    items: [
      { id: "hr-employees", label: "Employees", icon: UsersIcon, tabs: [
        { id: "hr-employees", label: "Management", module: "user_management" },
        { id: "hr-tenure", label: "Tenure pay", module: "tenure_protection" },
        { id: "hr-awol", label: "AWOL cases", module: "awol_cases" },
        // SSS / Pag-IBIG loans HR encodes from the agency's notice (2026-11-25).
        { id: "hr-gov-loans", label: "Government loans", module: "government_loans" },
      ] },
      // ONE inbox: every page where HR decides something.
      { id: "hr-leaves", label: "Approvals", icon: InboxIcon, tabs: [
        { id: "hr-leaves", label: "Leave, overtime & corrections", module: "leave_approval" },
        { id: "hr-transfers", label: "Transfers", module: "transfer_requests" },
        // What the branch Admins file (2026-11-24: incidents and incentive proposals; the Admin no longer endorses).
        { id: "hr-branch-requests", label: "From branch admins", module: "branch_oversight" },
        // Incentives, overload and cash advances the Accountant filed, and the system's rule-based incentives.
        { id: "hr-adjustment-approvals", label: "Incentives & cash advances", module: "payroll_approvals" },
        { id: "hr-subsidy-approvals", label: "Subsidies", module: "payroll_approvals" },
        { id: "hr-payroll-approval", label: "Payroll runs & final pay", module: "payroll_run_approval" },
      ] },
      { id: "hr-attendance", label: "Attendance", icon: CalendarCheckIcon, tabs: [
        { id: "hr-attendance", label: "Monitoring", module: "attendance" },
        { id: "hr-schedules", label: "Work schedules", module: "work_schedules" },
        { id: "hr-holidays", label: "Holidays & Duty", module: "attendance" },
        // RFID in one tab (2026-11-24): cards, the terminal, card history and RFID issues.
        { id: "hr-rfid-cards", label: "RFID", module: "rfid_devices" },
      ] },
      { id: "hr-payroll-records", label: "Payroll Records", icon: ReceiptTextIcon, module: "payroll_records" },
      { id: "hr-reports", label: "Reports", icon: FileBarChartIcon, module: "hr_reports" },
      { id: "hr-gov-rates", label: "Settings", icon: SlidersHorizontalIcon, tabs: [
        { id: "hr-gov-rates", label: "Government rates", module: "government_rates" },
        // Leave credits and pay rules per category / status / type (Part A, 20261121010000).
        { id: "hr-classification-rules", label: "Status & leave rules", module: "user_management" },
        // Part H (2026-11-22): the remarks offered on every decision.
        { id: "hr-remark-presets", label: "Preset remarks", module: "user_management" },
        // 2026-11-24: the module switches, Pause all, the digests and the activity log (no dashboard card).
        { id: "hr-automation", label: "Automation", module: "user_management" },
      ] },
    ],
  },
  // HR is an employee too (2026-11-09): its own pages in one item.
  myAccountItem("hr"),
];

const EMPLOYEE_PAGE = "hr-att-employee";
const NAV_ITEMS = navPages(NAV);
const PAGE_IDS = [...NAV_ITEMS.map((item) => item.id), EMPLOYEE_PAGE];
const TITLES = {
  "hr-dashboard": "HR Dashboard",
  "hr-employees": "User Management",
  "hr-gov-loans": "Government loans",
  "hr-transfers": "Transfer Requests",
  "hr-tenure": "Tenure Pay Protection",
  "hr-attendance": "Attendance Monitoring",
  "hr-schedules": "Work Schedules",
  "hr-holidays": "Holidays & Duty",
  "hr-rfid-cards": "RFID",
  "hr-payroll-approval": "Payroll Approval",
  "hr-payroll-records": "Payroll Records",
  [EMPLOYEE_PAGE]: "Employee Attendance Record",
  "hr-leaves": "Leave Approval",
  "hr-awol": "AWOL Cases",
  "hr-branch-requests": "From Branch Admins",
  "hr-automation": "Automation",
  "hr-subsidy-approvals": "Subsidy Approvals",
  "hr-adjustment-approvals": "Incentive & Cash Advance Approvals",
  "hr-gov-rates": "Government Rates",
  "hr-reports": "HR Reports",
  "hr-announcements": "Announcements",
  "hr-classification-rules": "Status & Leave Rules",
  "hr-remark-presets": "Preset Remarks",
  "hr-profile": "My Profile",
  ...Object.fromEntries(Object.entries(MY_PAGE_IDS.hr).filter(([kind]) => kind !== "profile").map(([kind, id]) => [id, myAccountGroup("hr").items.find((i) => i.id === id).label])),
};
const DESCRIPTIONS = {
  "hr-dashboard": "Attendance summaries, leave notifications, and quick HR access.",
  "hr-announcements": "Announcements for the whole school or for one branch.",
  "hr-gov-loans": "SSS and Pag-IBIG loans from the agencies' deduction notices, deducted on 16–end payslips.",
  "hr-employees": "Create and maintain HR, Accountant and Employee accounts and their 201 records for every branch.",
  "hr-transfers": "See where every employee is assigned and move employees between branches. Each transfer applies immediately and is kept in Transfer History.",
  "hr-attendance": "Review employee attendance records, track absences and tardiness.",
  "hr-tenure": "Set who is not deducted for absence, lateness, holidays, suspensions and school breaks under a tenure contract clause, and grant or revoke it per employee. Every change is logged.",
  "hr-schedules": "Create, change and assign employee work schedules, and set the Early Bird incentive. Every change takes effect from a date and is logged.",
  "hr-holidays": "The school is closed on holidays. Choose who must still report, and approve holiday work done without an assignment.",
  "hr-rfid-cards": "Register, replace, deactivate and reactivate RFID cards for every branch, open the RFID Terminal, and follow the card history and the RFID issues. Only an Active card records attendance.",
  [EMPLOYEE_PAGE]: "One employee's attendance, corrections and leave.",
  "hr-leaves": "Review, approve, or reject employee leave applications and monitor leave history.",
  "hr-subsidy-approvals": "Approve or reject the subsidies the Accountant processed: missed-month adjustments, subsidy advances and excess-advance settlements. HR is the only approver; every decision stays in the history.",
  "hr-awol": "Unexcused absences flagged by the nightly check or reported by a branch Admin: confirm, send the notices, and separate or close each case.",
  "hr-branch-requests": "What the branch Admins filed: incident reports and incentive proposals, with the Admin's name and remark. HR decides; the Admin sees the decision and is notified. Message the Admin on an item if you need to.",
  "hr-automation": "The automatic checks: switch modules on or off, pause everything, set the daily digests, and see what the system did (with Undo).",
  "hr-reports": "Generate attendance reports and employee record summaries for documentation.",
  "hr-adjustment-approvals": "Approve or reject the incentives, overload and cash advances the Accountant filed. Payroll pays or deducts only approved ones; a rejection needs a reason and the Accountant is notified.",
  "hr-gov-rates": "Change the daily rate and the SSS, PhilHealth and Pag-IBIG rates for future pay periods (with a reason; the Super Admin is notified). The hourly rate is the daily rate ÷ 8, automatic; the withholding tax table is fixed by law.",
  "hr-payroll-approval": "Approve each branch's payroll and each final pay, or send it back to the Accountant with a reason.",
  "hr-payroll-records": "Every employee's processed payslips across all branches, read-only. Open any payslip to print or download it.",
  "hr-remark-presets": "The remarks offered when you approve, reject, resolve, override or revoke. Deactivated ones stay on old records.",
  "hr-classification-rules": "Leave credits and pay rules per category, employment status and type, and the reminders before a probation or contract ends. Each change applies from a date you choose.",
  "hr-profile": null,
  ...Object.fromEntries(Object.entries(MY_PAGE_IDS.hr).filter(([kind]) => kind !== "profile").map(([kind, id]) => [id, MY_DESCRIPTIONS[kind]])),
};

/** Retired page ids and where they open now (2026-11-20: Final Pay Approvals moved into Payroll Approval). */
const MOVED_PAGES = {
  "hr-final-pay-approvals": { page: "hr-payroll-approval", params: { pa_section: "final-pay" } },
  // A leave notification names the Employee page; HR's own Leave & Overtime is hr-my-leave (2026-11-22).
  "emp-leave": { page: "hr-my-leave", params: {} },
  // 2026-11-24: one RFID tab.
  "hr-rfid-terminals": { page: "hr-rfid-cards", params: {} },
};


function HrScreens() {
  const { can } = usePortalSession();
  const [page, setPage] = usePersistedPage("hr", PAGE_IDS, "hr-dashboard", MOVED_PAGES);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);
  // Pending payroll runs, live (the sidebar badge).
  const [pendingRuns, reloadPending] = usePendingRunCount(can("payroll_run_approval"));
  // Final pay waiting for HR (the sidebar badge).
  const [pendingFinalPay, setPendingFinalPay] = React.useState(0);
  const reloadFinalPay = React.useCallback(() => {
    if (!can("payroll_run_approval")) return;
    fetchJson("/api/hr/final-pay-approvals?count=1").then((d) => setPendingFinalPay(Number(d?.pending) || 0)).catch(() => null);
  }, [can]);
  React.useEffect(() => { reloadFinalPay(); }, [reloadFinalPay, refreshKey]);

  const allowed = (id) => {
    if (id === EMPLOYEE_PAGE) return can("attendance");
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  // An old link to a retired page (My BIR Form 2316) shows "Page not found".
  const current = page === NOT_FOUND_PAGE ? NOT_FOUND_PAGE : allowed(page) ? page : "hr-dashboard";
  const myKind = myPageKind("hr", current);
  const { employeeId, openEmployee, navigate: navigatePage } = useEmployeeRecordPage(current, setPage, EMPLOYEE_PAGE, "hr-attendance");
  // A moved page (a notification or dashboard link): its new page, with its tab set (remounts the page).
  const [sectionKey, setSectionKey] = React.useState(0);
  const navigate = React.useCallback((id) => {
    const moved = MOVED_PAGES[id];
    if (!moved) return navigatePage(id);
    const params = new URLSearchParams(window.location.search);
    Object.entries(moved.params).forEach(([k, v]) => params.set(k, v));
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    setSectionKey((n) => n + 1);
    return navigatePage(moved.page);
  }, [navigatePage]);

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
        badges={{ "hr-payroll-approval": (Number(pendingRuns) || 0) + pendingFinalPay }}
        profilePage="hr-profile"
        accountOptions={{ payrollReadOnly: false }}
      >
        {current === "hr-dashboard" ? <DashboardPage refreshKey={refreshKey} onNavigate={navigate} onSummary={setSummary} /> : null}
        {current === "hr-employees" ? <EmployeesPage refreshKey={refreshKey} /> : null}
        {current === "hr-gov-loans" ? <GovernmentLoansPage refreshKey={refreshKey} /> : null}
        {current === "hr-transfers" ? <TransfersPage refreshKey={refreshKey} /> : null}
        {current === "hr-tenure" ? <TenureProtectionPanel refreshKey={refreshKey} /> : null}
        {current === "hr-attendance" ? <AttendancePage refreshKey={refreshKey} /> : null}
        {current === "hr-rfid-cards" ? (
          <MaintenancePage refreshKey={refreshKey} description="Every branch's RFID cards, the RFID Terminal, the RFID issues the branch Admins report, and the card history."
            issues={<BranchRequestsReview refreshKey={refreshKey} kinds={["rfid_issue"]} title="RFID issues" description="Lost or broken cards and faulty readers reported by the branch Admins. HR or the Super Admin marks them resolved." />} />
        ) : null}
        {current === "hr-automation" ? <AutomationSettings refreshKey={refreshKey} /> : null}
        {current === "hr-payroll-approval" ? <PayrollApprovalPage key={sectionKey} refreshKey={refreshKey} onChanged={() => { reloadPending(); reloadFinalPay(); }} counts={{ runs: pendingRuns, finalPay: pendingFinalPay }} /> : null}
        {current === "hr-payroll-records" ? <PayrollRecordsPage refreshKey={refreshKey} /> : null}
        {current === "hr-holidays" ? <><HolidayDutyPage refreshKey={refreshKey} /><SpecialDaysPanel refreshKey={refreshKey} /></> : null}
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
        {current === "hr-leaves" ? <SubstitutionsPanel role="hr" refreshKey={refreshKey} /> : null}
        {current === "hr-awol" ? (
          <div className="flex flex-col gap-4">
            <AwolCasesPage refreshKey={refreshKey} />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["incident_report"]} icon={SirenIcon} title="Incident reports from branch Admins"
              description="A reported no-show is already in the AWOL cases above (flagged). Handle the case there, then mark the report resolved with a remark for the Admin." />
          </div>
        ) : null}
        {current === "hr-branch-requests" ? (
          <div className="flex flex-col gap-4">
            <BranchRequestsReview refreshKey={refreshKey} kinds={["incentive_endorsement"]} title="Incentive proposals" description="Discretionary incentives and overload the branch Admin proposed. Approving adds it to payroll, counted by today's date (after the month's cutoff it moves to next month's payroll)." />
            <BranchRequestsReview refreshKey={refreshKey} kinds={["incident_report"]} title="Incident reports" description="A reported no-show is already in AWOL Cases (flagged). Handle the case there, then mark the report resolved with a remark for the Admin." />
            {/* Earlier items from before the Admin became view-only (2026-11-24): kept, still closable. */}
            <BranchRequestsReview refreshKey={refreshKey} kinds={["attendance_flag", "schedule_request", "overtime_confirmation"]} title="Earlier items from the branch Admins" description="Sent before the branch Admins became view-only. Close what is still pending; nothing new arrives here." />
          </div>
        ) : null}
        {current === "hr-subsidy-approvals" ? <ApprovalsPage refreshKey={refreshKey} /> : null}
        {current === "hr-reports" ? <ReportsPage /> : null}
        {current === "hr-reports" ? <DecisionReasonsCard allBranches refreshKey={refreshKey} /> : null}
        {current === "hr-reports" ? <SubstitutionsReportCard /> : null}
        {current === "hr-remark-presets" ? <RemarkPresetsCard refreshKey={refreshKey} /> : null}
        {current === "hr-gov-rates" ? <><RatesSection refreshKey={refreshKey} endpoint="/api/payroll/rates" onlyEditable /><PayrollSettingsSection refreshKey={refreshKey} endpoint="/api/payroll/settings" showTax={false} /><LeaveConversionCard /><GovernmentRatesPanel refreshKey={refreshKey} /></> : null}
        {current === "hr-adjustment-approvals" ? <AdjustmentApprovalsPanel refreshKey={refreshKey} /> : null}
        {current === "hr-announcements" ? <AnnouncementsManager refreshKey={refreshKey} /> : null}
        {current === "hr-classification-rules" ? <ClassificationRulesPage refreshKey={refreshKey} /> : null}
        {current === "hr-profile" ? <StaffProfilePage roleLabel="HR" showPosition /> : null}
        {myKind && myKind !== "profile" ? <MyAccountScreen kind={myKind} refreshKey={refreshKey} /> : null}
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
