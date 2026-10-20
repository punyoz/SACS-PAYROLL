"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/portal/lazy-page";
import * as React from "react";
import { LayoutDashboardIcon, ScrollTextIcon, TrendingUpIcon, UserRoundIcon, WrenchIcon } from "lucide-react";
import { AppShell } from "@/components/portal/app-shell";
import { PasswordGate } from "@/components/portal/password-gate";
import { PortalSessionProvider, usePersistedPage, usePortalSession } from "@/components/portal/session";
import { StaffProfilePage } from "@/components/portal/staff-profile";
import { logAuditMovement } from "@/lib/portal/audit";
import { AuditLogsPage } from "./audit-logs-page";
import { MaintenancePage } from "./maintenance-page";

// Charts (recharts) load with these pages, not with the portal.
const DashboardPage = dynamic(() => import("./dashboard-page").then((m) => m.DashboardPage), { loading: PageSkeleton });
const BranchReportsPage = dynamic(() => import("./branch-reports-page").then((m) => m.BranchReportsPage), { loading: PageSkeleton });

/*
 * Page ids are the legacy portal's (public/legacy/js/admin.js ADMIN_PAGES),
 * so the saved page carries over and sign-out clears it. `module` is the
 * permission each page needs (src/lib/rbac/permissions.js).
 *
 * Since 2026-10-20 the Admin oversees its branch only: attendance, work
 * schedules, Tenure Pay Protection and subsidy approvals are HR's.
 */
const NAV = [
  { section: "Overview", items: [{ id: "adm-dashboard", label: "Dashboard", icon: LayoutDashboardIcon, module: "dashboard" }] },
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

const NAV_ITEMS = NAV.flatMap((group) => group.items);
const PAGE_IDS = NAV_ITEMS.map((item) => item.id);
const TITLES = Object.fromEntries(NAV_ITEMS.map((item) => [item.id, item.label]));

const DESCRIPTIONS = {
  "adm-dashboard": "School-wide payroll and attendance overview.",
  "adm-audit-logs": "Track admin and system movements across payroll operations.",
  "adm-maintenance": "Register, replace and void RFID cards for your branch.",
  "adm-branch-reports": "Attendance, headcount and payroll status for your branch.",
  "adm-profile": null,
};

function AdminScreens() {
  const { can, me } = usePortalSession();
  const [page, setPage] = usePersistedPage("admin", PAGE_IDS, "adm-dashboard");
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [summary, setSummary] = React.useState([]);

  const allowed = (id) => {
    const item = NAV_ITEMS.find((i) => i.id === id);
    return item ? can(item.module) : false;
  };
  const current = allowed(page) ? page : "adm-dashboard";

  const navigate = setPage;

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
    <AppShell
      nav={NAV}
      page={current}
      onNavigate={navigate}
      title={TITLES[current]}
      description={DESCRIPTIONS[current]}
      onRefresh={refresh}
      refreshing={refreshing}
      notificationSummary={summary}
      profilePage="adm-profile"
      accountOptions={{ payrollReadOnly: false, titleCaseName: true }}
    >
      {current === "adm-dashboard" ? <DashboardPage refreshKey={refreshKey} onSummary={setSummary} /> : null}
      {current === "adm-audit-logs" ? <AuditLogsPage refreshKey={refreshKey} /> : null}
      {current === "adm-maintenance" ? <MaintenancePage refreshKey={refreshKey} /> : null}
      {current === "adm-branch-reports" ? <BranchReportsPage refreshKey={refreshKey} /> : null}
      {current === "adm-profile" ? <StaffProfilePage roleLabel="Administrator" /> : null}
    </AppShell>
  );
}

export function AdminPortal() {
  return (
    <PortalSessionProvider role="admin" gate={PasswordGate}>
      <AdminScreens />
    </PortalSessionProvider>
  );
}
