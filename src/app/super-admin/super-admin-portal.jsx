"use client";

import { AutomationSettings } from "@/components/portal/automation-settings";

import { DecisionReasonsCard } from "@/components/portal/remark-presets-manager";
import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import {
  BuildingIcon,
  CalendarCheckIcon,
  CreditCardIcon,
  DatabaseBackupIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  InboxIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { FallbackPage } from "./fallback-page";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { AnnouncementsManager } from "@/components/portal/announcements";
import { manilaDateKey } from "@/lib/portal/format";
import { BACKGROUND, fetchJson } from "@/lib/portal/api";
import { AuditLogsPage } from "../admin/audit-logs-page";
import { MaintenancePage } from "../admin/maintenance-page";
import { BranchRequestsReview } from "@/components/portal/branch-requests-review";
import { AttendanceStatusBoard } from "@/components/portal/attendance/status-board";
import { BranchesPage } from "./branches-page";
import { AccountsPage } from "./accounts-page";
import { RolesPage } from "./roles-page";
import { ConfigPage } from "./config-page";
import { BackupPage } from "./backup-page";
import { BirExportsCard, YearEndTaxCard } from "@/components/portal/bir-forms";
import { AttendanceActionsProvider } from "@/components/portal/attendance/dialogs";
import { navPages } from "@/lib/portal/nav-tabs";

// Charts (recharts) load with this page, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (SA_PAGES, public/legacy/js/super-admin.js),
 * so the saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 *
 * Since 2026-10-20 the Super Admin runs system functions only: attendance and
 * Tenure Pay Protection are HR's, payroll the Accountant's (HR approves).
 */
// Part I (2026-11-23): eight items, a tab per page (same page ids, permissions and routes).
const NAV = [
  { section: "Overview", items: [{ id: "sa-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, tabs: [
    { id: "sa-dashboard", label: "Overview", module: "dashboard" },
    // Only what no active HR may decide (2026-11-09 Part D).
    { id: "sa-fallback", label: "Items waiting on fallback", module: "fallback_approvals" },
    { id: "sa-announcements", label: "Announcements", module: "announcements" },
  ] }] },
  {
    section: "Management",
    items: [
      { id: "sa-accounts", label: "Accounts", icon: UsersRoundIcon, tabs: [
        { id: "sa-accounts", label: "Admin & HR accounts", module: "user_management" },
        { id: "sa-roles", label: "Roles & permissions", module: "roles_permissions" },
      ] },
      { id: "sa-branches", label: "Branches", icon: BuildingIcon, module: "branch_management" },
      // Read-only, every branch, with dates, branch filter and export (alpha test B1).
      { id: "sa-attendance", label: "Attendance Records", icon: CalendarCheckIcon, module: "attendance" },
      { id: "sa-maintenance", label: "RFID", icon: CreditCardIcon, tabs: [
        // One RFID page (2026-11-24): cards, terminal, issues and card history.
        { id: "sa-maintenance", label: "RFID", module: "system_maintenance" },
      ] },
      { id: "sa-config", label: "System", icon: SettingsIcon, tabs: [
        { id: "sa-config", label: "Configuration", module: "system_configuration" },
        { id: "sa-backup", label: "Backup & Recovery", module: "backup_recovery" },
        // 2026-11-24: Settings > Automation (no dashboard card).
        { id: "sa-automation", label: "Automation", module: "system_configuration" },
      ] },
      { id: "sa-audit", label: "Audit & Monitoring", icon: ScrollTextIcon, module: "audit_logs" },
    ],
  },
  { section: "My Account", items: [{ id: "sa-profile", label: "My Account", icon: UserRoundIcon, module: "profile" }] },
];

const NAV_ITEMS = navPages(NAV);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
// Page titles stay as before (the tab labels are shorter).
const TITLES = {
  "sa-dashboard": "Dashboard", "sa-fallback": "Items Waiting on Fallback", "sa-announcements": "Announcements", "sa-accounts": "Admin & HR Accounts",
  "sa-roles": "Roles & Permissions", "sa-branches": "Branch Management", "sa-attendance": "Attendance Records", "sa-maintenance": "RFID",
  "sa-config": "System Configuration", "sa-backup": "Backup & Recovery", "sa-automation": "Automation",
  "sa-audit": "Audit & Monitoring", "sa-profile": "Profile",
};

const DESCRIPTIONS = {
  "sa-dashboard": "Centralized monitoring of all branches, system health, and overall activity.",
  "sa-fallback": "Items you decide only because no other HR is active (an HR's own leave or payslip run).",
  "sa-accounts": "Create and maintain the login accounts of Super Admin, Admin and HR staff. Employee and Accountant accounts are managed by HR.",
  "sa-branches": "Manage branch information and status across all branches.",
  "sa-roles": "What each role can reach across the system.",
  "sa-maintenance": "Every branch's RFID cards, the RFID Terminal, the RFID issues the branch Admins report, and the card history.",
  "sa-attendance": "View-only attendance records of every branch, by date range, with export. Corrections are HR's.",
  "sa-config": "System-wide settings, payroll rules, attendance policies and holidays.",
  "sa-automation": "The automatic checks: switch modules on or off, pause everything, set the daily digests, and see what the system did.",
  "sa-audit": "System-wide audit trails, login activity and transaction history across all branches.",
  "sa-announcements": "Post to the whole school or one branch, edit your own, and delete any announcement (moderation).",
  "sa-backup": "Database status, manual exports and recovery procedures.",
  "sa-profile": null,
};


/** Old addresses (2026-11-24: one RFID page): rewritten before the page is read. */
function redirectMovedPage(moved) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const to = moved[params.get("page")];
  if (!to) return;
  params.set("page", to);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
}

function SuperAdminScreens() {
  redirectMovedPage({ "sa-rfid-terminal": "sa-maintenance", "sa-rfid-issues": "sa-maintenance" });
  const { can } = usePortalSession();
  const [page, setPage] = usePersistedPage("super_admin", PAGE_IDS, "sa-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);
  // The sidebar badge: the same count as the dashboard's Pending actions card.
  const [fallbackCount, setFallbackCount] = React.useState(0);
  const canFallback = can("fallback_approvals");
  React.useEffect(() => {
    if (!canFallback) return undefined;
    let cancelled = false;
    fetchJson("/api/super-admin/fallback", BACKGROUND).then((data) => { if (!cancelled) setFallbackCount(Number(data?.counts?.total || 0)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [canFallback, refreshKey]);

  const allowed = (id) => {
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "sa-dashboard";

  const navigate = setPage;

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
      badges={{ "sa-fallback": fallbackCount }}
      profilePage="sa-profile"
      accountOptions={{ payrollReadOnly: false, titleCaseName: true }}
    >
      {current === "sa-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} onNavigate={navigate} /> : null}
      {current === "sa-fallback" ? <FallbackPage refreshKey={refreshKey} onCounts={setFallbackCount} /> : null}
      {current === "sa-accounts" ? <AccountsPage refreshKey={refreshKey} /> : null}
      {current === "sa-branches" ? <BranchesPage refreshKey={refreshKey} /> : null}
      {current === "sa-roles" ? <RolesPage /> : null}
      {/* The board needs the attendance actions context (read-only here: the
          server refuses any Super Admin change to attendance). */}
      {current === "sa-attendance" ? <AttendanceActionsProvider><AttendanceStatusBoard refreshKey={refreshKey} branchFilter readOnly defaultPreset="this_month" urlKey="sa_att" title="Attendance records" help="Every branch, view only. Corrections are HR's." /></AttendanceActionsProvider> : null}
      {current === "sa-maintenance" ? (
        <MaintenancePage refreshKey={refreshKey} description="Every branch's RFID cards, the RFID Terminal, the RFID issues the branch Admins report, and the card history."
          issues={<BranchRequestsReview refreshKey={refreshKey} kinds={["rfid_issue"]} title="RFID issues" description="Lost or broken cards and faulty readers. Fix the card or reader, then mark the report resolved with a remark." />} />
      ) : null}
      {current === "sa-config" ? <ConfigPage refreshKey={refreshKey} /> : null}
      {current === "sa-automation" ? <AutomationSettings refreshKey={refreshKey} /> : null}
      {current === "sa-audit" ? (
        <AuditLogsPage refreshKey={refreshKey} limit={200} csvName={() => `sacs-sa-audit-${manilaDateKey()}.csv`} auditActor={null} />
      ) : null}
      {/* Year-end tax records and generated BIR files, where they were (the
          BIR is the Super Admin's only since 2026-11-12). */}
      {current === "sa-audit" ? <YearEndTaxCard refreshKey={refreshKey} /> : null}
      {current === "sa-audit" ? <BirExportsCard refreshKey={refreshKey} /> : null}
      {/* Part H: how often each decision remark was used, every branch. */}
      {current === "sa-audit" ? <DecisionReasonsCard allBranches refreshKey={refreshKey} /> : null}
      {current === "sa-backup" ? <BackupPage refreshKey={refreshKey} /> : null}
      {current === "sa-announcements" ? <AnnouncementsManager refreshKey={refreshKey} description="Post to the whole school or to one branch. You can edit your own, and delete any announcement (moderation)." /> : null}
      {current === "sa-profile" ? <StaffProfilePage roleLabel="Super Admin" accountOnly /> : null}
    </AppShell>
  );
}

export function SuperAdminPortal() {
  return (
    <PortalSessionProvider role="super_admin" gate={PasswordGate}>
      <SuperAdminScreens />
    </PortalSessionProvider>
  );
}
