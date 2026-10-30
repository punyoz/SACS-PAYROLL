"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import {
  BuildingIcon,
  DatabaseBackupIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
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
import { AnnouncementsManager } from "@/components/portal/announcements";
import { manilaDateKey } from "@/lib/portal/format";
import { AuditLogsPage } from "../admin/audit-logs-page";
import { MaintenancePage } from "../admin/maintenance-page";
import { BranchRequestsReview } from "@/components/portal/branch-requests-review";
import { BranchesPage } from "./branches-page";
import { AccountsPage } from "./accounts-page";
import { RolesPage } from "./roles-page";
import { ConfigPage } from "./config-page";
import { BackupPage } from "./backup-page";
import { BirExportsCard, YearEndTaxCard } from "@/components/portal/bir-forms";

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
const NAV = [
  {
    section: "Overview",
    items: [
      { id: "sa-dashboard", label: "SA Dashboard", icon: LayoutDashboardIcon, module: "dashboard" },
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
      // Moderation: delete any announcement (posting is an open decision, 2026-10-30).
      { id: "sa-announcements", label: "Announcements", icon: MegaphoneIcon, module: "announcements" },
      { id: "sa-backup", label: "Backup & Recovery", icon: DatabaseBackupIcon, module: "backup_recovery" },
    ],
  },
  { section: "Account", items: [{ id: "sa-profile", label: "Profile", icon: UserRoundIcon, module: "profile" }] },
];

const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
const TITLES = Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label]));

const DESCRIPTIONS = {
  "sa-dashboard": "Centralized monitoring of all branches, system health, and overall activity.",
  "sa-accounts": "Create and maintain the login accounts of Super Admin, Admin and HR staff. Employee and Accountant accounts are managed by HR.",
  "sa-branches": "Manage branch information and status across all branches.",
  "sa-roles": "What each role can reach across the system.",
  "sa-maintenance": "Run the RFID Terminal and manage RFID card registration.",
  "sa-config": "System-wide settings, payroll rules, attendance policies and holidays.",
  "sa-audit": "System-wide audit trails, login activity and transaction history across all branches.",
  "sa-announcements": "Every announcement in the school, for moderation.",
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
      profilePage="sa-profile"
      accountOptions={{ payrollReadOnly: false, titleCaseName: true }}
    >
      {current === "sa-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} onNavigate={navigate} /> : null}
      {current === "sa-accounts" ? <AccountsPage refreshKey={refreshKey} /> : null}
      {current === "sa-branches" ? <BranchesPage refreshKey={refreshKey} /> : null}
      {current === "sa-roles" ? <RolesPage /> : null}
      {current === "sa-maintenance" ? (
        <MaintenancePage
          refreshKey={refreshKey}
          registrationText="Assign or update RFID UIDs for employees. The UID is used to match RFID card taps to attendance records. Void a card that is lost or no longer in use."
          auditActor={null}
          terminalText="Open the dedicated tap-in/tap-out screen for an RFID reader. It accepts cards from every branch, replaces this view and is locked behind your Super Admin password."
        />
      ) : null}
      {current === "sa-maintenance" ? (
        <BranchRequestsReview refreshKey={refreshKey} kinds={["rfid_issue"]} title="RFID issues reported by branch Admins"
          description="Lost or broken cards and faulty readers. Fix the card or reader, then mark the report resolved with a remark." />
      ) : null}
      {current === "sa-config" ? <ConfigPage refreshKey={refreshKey} /> : null}
      {current === "sa-audit" ? (
        <AuditLogsPage refreshKey={refreshKey} limit={200} csvName={() => `sacs-sa-audit-${manilaDateKey()}.csv`} auditActor={null} />
      ) : null}
      {/* Year-end tax records and generated BIR files: read-only oversight (decision 2026-10-29). */}
      {current === "sa-audit" ? <YearEndTaxCard /> : null}
      {current === "sa-audit" ? <BirExportsCard refreshKey={refreshKey} /> : null}
      {current === "sa-backup" ? <BackupPage refreshKey={refreshKey} /> : null}
      {current === "sa-announcements" ? <AnnouncementsManager refreshKey={refreshKey} /> : null}
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
