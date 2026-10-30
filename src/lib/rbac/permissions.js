/**
 * SACS Payroll — single source of truth for role-based access control.
 *
 * Mirrors "Section 2 — Full Ordered Permission Matrix" in
 * SACS-Payroll-Permission-Matrix.md. Nothing in this system should hardcode a
 * role name to decide access; ask this table instead, via can() / scopeFor().
 *
 * Two independent dimensions, exactly as the matrix describes them:
 *
 *   SCOPE  — how much data a role may reach:
 *            'all'    every branch (super_admin everywhere; HR on every
 *                     module it can reach -- HR accounts carry no branch)
 *            'branch' rows whose branch_id equals the caller's own branch
 *            'self'   rows belonging to the caller personally
 *            'none'   no access to the module at all
 *
 *   ACTIONS — what the role may do inside that scope: create / read /
 *             update / delete.
 *
 * NOTE ON 'delete': across this system "delete" means ARCHIVE (set the record
 * inactive), never a physical row removal. Payroll and attendance history must
 * stay referentially intact, so no role — super_admin included — is granted a
 * hard delete. See assertNoHardDelete() below.
 */

export const ROLES = ["super_admin", "admin", "hr", "accountant", "employee"];

export const SCOPE_ALL = "all";
export const SCOPE_BRANCH = "branch";
export const SCOPE_SELF = "self";
export const SCOPE_NONE = "none";

/**
 * Roles whose every query must be filtered down to their own branch_id.
 * HR is not one of them: it serves every branch and its accounts are stored
 * with no branch, like Super Admin (see
 * supabase/migrations/20260924020000_hr_all_branches.sql).
 */
export const BRANCH_SCOPED_ROLES = ["admin", "accountant", "employee"];

const CRUD = ["create", "read", "update", "delete"];
const READ = ["read"];
const READ_WRITE = ["read", "update"];

/** Shorthand: full CRUD within the given scope. */
const full = (scope) => ({ scope, actions: CRUD });
/** Shorthand: view-only within the given scope. */
const view = (scope) => ({ scope, actions: READ });
/** Shorthand: no access at all. */
const none = () => ({ scope: SCOPE_NONE, actions: [] });

/**
 * Module registry. `label`, `section` and `page` drive the dynamically
 * rendered sidebar (see src/lib/rbac/menu.js); `order` follows the matrix's
 * own numbering so the sidebar keeps the documented ordering.
 *
 * `page` maps a module to the existing legacy page id per role, so the
 * generated sidebar keeps calling the same adminNav()/saNav()/hrNav()/
 * acctNav() handlers the portals already define — no page markup changes.
 */
export const MODULES = {
  // Branch oversight (20261020020000): the branch Admin recommends, HR
  // decides. Attendance flags, leave and transfer endorsements, incident /
  // AWOL reports, schedule requests, RFID issues, overtime / substitute
  // teaching confirmations and incentive recommendations, all for the
  // Admin's own branch (public.branch_admin_requests).
  branch_oversight: {
    order: 1.5, label: "Branch Oversight", section: "Branch",
    page: {},
  },
  // Branch announcements: the Admin posts them for its branch's employees.
  announcements: {
    order: 1.6, label: "Announcements", section: "Branch",
    page: {},
  },
  dashboard: {
    order: 1, label: "Dashboard", section: "Overview",
    page: { super_admin: "sa-dashboard", admin: "adm-dashboard", hr: "hr-dashboard", accountant: "ac-dashboard" },
    labelOverride: { super_admin: "SA Dashboard", hr: "HR Dashboard" },
  },
  attendance: {
    order: 2, label: "Attendance", section: "Overview",
    page: { hr: "hr-attendance", accountant: "ac-attendance" },
    labelOverride: { hr: "Attendance Monitoring", accountant: "View Attendance" },
  },
  user_management: {
    // HR owns every Employee and Accountant account, across all branches.
    // Super Admin keeps only the Admin/HR login accounts — HR cannot create an
    // account that outranks HR, and somebody has to create the first HR login.
    order: 3, label: "User Management", section: "Management",
    page: { super_admin: "sa-accounts", hr: "hr-employees" },
    labelOverride: { super_admin: "Admin & HR Accounts" },
  },
  employee_information: {
    order: 4, label: "Employee Information", section: "Management",
    // Merged with user_management's page — HR's full-CRUD staff table
    // (hr-employees) now carries the extra columns (contact number, branch
    // name, date hired) that used to live on a separate read-only page.
    page: { hr: "hr-employees" },
  },
  // Backs public.employee_info_view (id, full_name, cp_number, branch_id,
  // branch_name, position, status, date_hired). No dedicated screen for any
  // role — the same data now lives as extra columns on each role's existing
  // full-CRUD employee table. Grants are kept so /api/admin/employee-info
  // and the view stay reachable as read-only infrastructure.
  employee_info_readonly: {
    order: 4.5, label: "Employee Info", section: "Management",
    page: {},
  },
  branch_management: {
    order: 5, label: "Branch Management", section: "Management",
    page: { super_admin: "sa-branches" },
  },
  branch_assignment: {
    order: 6.5, label: "Branch Assignment", section: "Management",
    // The branch roster and the transfer flow are one page, owned by HR.
    // Sharing transfer_requests' page id lets buildMenu()'s dedup collapse
    // them into a single sidebar row (transfer_requests' lower order wins).
    page: { hr: "hr-transfers" },
  },
  roles_permissions: {
    order: 7, label: "Roles & Permissions", section: "Management",
    page: { super_admin: "sa-roles" },
  },
  // HR moves employees between branches. HR is the approver as well as the
  // requester, so a move is recorded in public.transfer_requests and applied
  // at once (its trigger moves profiles.branch_id on approval).
  transfer_requests: {
    order: 6, label: "Transfer Requests", section: "Management",
    page: { hr: "hr-transfers" },
  },
  leave_approval: {
    order: 8, label: "Leave Approval", section: "Leave",
    page: { hr: "hr-leaves" },
  },
  rfid_devices: {
    order: 9, label: "RFID Devices", section: "Attendance",
    page: { hr: "hr-rfid-cards" },
  },
  process_payroll: {
    order: 10, label: "Process Payroll", section: "Payroll",
    page: { accountant: "ac-process" },
  },
  // The emergency override of an approved Final payslip (20261029040000):
  // PATCH /api/accountant/payroll { action: "override_final" } and its log.
  // Backend only, no page.
  payroll_override: {
    order: 10.1, label: "Final Payslip Override", section: "Payroll",
    page: {},
  },
  payroll_records: {
    order: 11, label: "Payroll Records", section: "Payroll",
    page: { accountant: "ac-records", hr: "hr-payroll-records" },
  },
  payslips: {
    order: 12, label: "Payslips", section: "Payroll",
    // HR opens payslips from its Payroll Records page (read-only).
    page: { accountant: "ac-payslips", hr: "hr-payroll-records" },
  },
  payroll_monitoring: {
    order: 13, label: "Payroll Monitoring", section: "Monitoring",
    page: { accountant: "ac-monitoring" },
  },
  system_maintenance: {
    // RFID card registration (assign / update / void) and the RFID scan
    // input. Admin runs the same screen as Super Admin, limited to its branch.
    order: 14, label: "System Maintenance", section: "System",
    page: { super_admin: "sa-maintenance", admin: "adm-maintenance" },
  },
  system_configuration: {
    order: 15, label: "System Configuration", section: "System",
    page: { super_admin: "sa-config" },
  },
  // SSS / PhilHealth / Pag-IBIG rates, the SSS salary credit table and the
  // withholding tax table (2026-10-26). The Super Admin edits them in System
  // Configuration; the Accountant and HR see them read-only, with the history
  // of every change; an Employee only sees its own deductions on its payslip.
  government_rates: {
    order: 15.5, label: "Government Rates", section: "Reference",
    page: { accountant: "ac-gov-rates", hr: "hr-gov-rates" },
  },
  audit_logs: {
    // Super Admin's is system-wide (logins, config changes, backups);
    // Admin's is their own branch's activity only.
    order: 16, label: "Audit Logs", section: "System",
    page: { super_admin: "sa-audit", admin: "adm-audit-logs" },
    labelOverride: { super_admin: "Audit & Monitoring" },
  },
  backup_recovery: {
    order: 17, label: "Backup & Recovery", section: "System",
    page: { super_admin: "sa-backup" },
  },
  hr_reports: {
    order: 18, label: "HR Reports", section: "Reports",
    page: { hr: "hr-reports" },
  },
  payroll_reports: {
    order: 19, label: "Payroll Reports", section: "Reports",
    page: { accountant: "ac-reports" },
  },
  branch_reports: {
    // NEW — the branch-level summary the matrix flags as missing for Admin.
    // View-only: attendance, headcount and payroll status for the Admin's own
    // branch. Payroll figures stay editable by the Accountant alone.
    order: 20, label: "Branch Reports", section: "Reports",
    page: { admin: "adm-branch-reports" },
  },
  profile: {
    order: 21, label: "Profile", section: "Account",
    page: { super_admin: "sa-profile", admin: "adm-profile", hr: "hr-profile", accountant: "ac-profile" },
  },
  timesheet: {
    order: 22, label: "Timesheet", section: "Account",
    page: {},
  },
  // Payslip schedule, loans, AWOL and the licensed-teacher subsidy
  // (docs/payroll-schedule-loans-awol.md; 20261009010000 / 20261009020000).
  // Loans replace cash advances: deducted on the 2nd half, partial when pay is short.
  loans: {
    order: 12.5, label: "Loans", section: "Payroll",
    page: { accountant: "ac-loans" },
  },
  // AWOL cases: HR confirms and sends the notices; the branch Admin decides
  // separation (on the Approvals page); the Accountant sees who is held.
  awol_cases: {
    order: 8.5, label: "AWOL Cases", section: "Leave",
    page: { hr: "hr-awol" },
  },
  // Subsidy approvals (2026-10-20: HR only): missed-month subsidy
  // adjustments the Accountant requests, and refused-consent excess subsidy
  // advances. HR decides both; the Accountant requests adjustments.
  payroll_approvals: {
    order: 13.5, label: "Subsidy Approvals", section: "Payroll",
    page: { hr: "hr-subsidy-approvals", accountant: "ac-approvals" },
  },
  // Licensed-teacher fields (row 4a): HR edits and verifies inside the
  // employee form; Admin and Super Admin view; Accountant / Employee none.
  teacher_license: {
    order: 4.6, label: "Licensed Teachers", section: "Management",
    page: {},
  },
  // Missed tap-out corrections: an employee asks for a corrected time out,
  // HR approves or rejects it (2026-10-20). No sidebar row of its own -- it lives
  // on each role's Attendance page (and the employee's My Attendance tab).
  attendance_corrections: {
    order: 2.5, label: "Attendance Corrections", section: "Overview",
    page: {},
  },
  // Per-employee work schedule profiles and who follows them
  // (20261013010000). Super Admin (System Configuration → Attendance) and HR
  // (Work Schedules) have the same full power; Admin views its own branch.
  work_schedules: {
    order: 2.6, label: "Work Schedules", section: "Attendance",
    page: { hr: "hr-schedules" },
  },
  // Early Bird incentive: one winner per pay period. Super Admin or HR sets
  // the threshold, the eligibility rule and the amount.
  early_bird_incentive: {
    order: 2.7, label: "Early Bird Incentive", section: "Attendance",
    page: {},
  },
  // Payroll Approval (20261014010000): the Accountant submits each branch's
  // run for a cutoff; HR reviews every branch and approves or rejects; Super
  // Admin views. HR also views processed payslips (payroll_records /
  // payslips, read-only) but never changes a figure.
  payroll_run_approval: {
    order: 10.5, label: "Payroll Approval", section: "Payroll",
    page: { hr: "hr-payroll-approval" },
  },
  // Tenure Pay Protection (20261015010000): the policy (tenure threshold,
  // covered categories, per branch or system-wide), the summer / Christmas
  // break dates, and which employees HR has granted it to. Super Admin and HR
  // everywhere; Admin its own branch (grants and the branch's own policy).
  // Accountant and Employee: none.
  tenure_protection: {
    order: 4.7, label: "Tenure Pay Protection", section: "Employees",
    page: { hr: "hr-tenure" },
  },
};

/**
 * THE MATRIX. Rows = modules, columns = roles.
 * Any module a role is missing from is implicitly no-access.
 */
export const ROLE_PERMISSIONS = {
  super_admin: {
    // System functions only (2026-10-20): system settings, branches, roles &
    // permissions, staff (Admin / HR) login accounts, RFID maintenance, audit
    // logs, backups. Managing employees (attendance, schedules, leave, AWOL,
    // transfers, Tenure Pay Protection) is HR's; processing payroll is the
    // Accountant's; approving it is HR's. The Super Admin does none of them.
    dashboard: view(SCOPE_ALL),
    // Read-only, no page: the backup export and the per-employee payroll rate
    // picker (System Configuration) read the employee list and attendance.
    attendance: view(SCOPE_ALL),
    // Only the Admin / HR / Super Admin login accounts (MANAGEABLE_ROLES).
    user_management: full(SCOPE_ALL),
    employee_information: view(SCOPE_ALL),
    employee_info_readonly: view(SCOPE_ALL),
    branch_management: full(SCOPE_ALL),
    // Moving an Admin account to another branch (the route refuses anyone else).
    branch_assignment: { scope: SCOPE_ALL, actions: READ_WRITE },
    roles_permissions: full(SCOPE_ALL),
    transfer_requests: none(),
    leave_approval: none(),
    rfid_devices: full(SCOPE_ALL),
    process_payroll: none(),
    // Override of an approved Final payslip only (2026-10-29); still no process_payroll.
    payroll_override: { scope: SCOPE_ALL, actions: ["read", "update"] },
    payroll_records: none(),
    payslips: none(),
    payroll_monitoring: none(),
    system_maintenance: full(SCOPE_ALL),
    system_configuration: full(SCOPE_ALL),
    // Government deduction tables (2026-10-26): the only role that changes them.
    government_rates: { scope: SCOPE_ALL, actions: ["create", "read", "update"] },
    audit_logs: full(SCOPE_ALL),
    backup_recovery: full(SCOPE_ALL),
    hr_reports: none(),
    payroll_reports: none(),
    branch_reports: view(SCOPE_ALL),
    profile: full(SCOPE_SELF),
    timesheet: none(),
    attendance_corrections: none(),
    loans: none(),
    awol_cases: none(),
    payroll_approvals: none(),
    teacher_license: none(),
    work_schedules: none(),
    // The Early Bird threshold and amount are system configuration.
    early_bird_incentive: { scope: SCOPE_ALL, actions: READ_WRITE },
    payroll_run_approval: none(),
    tenure_protection: none(),
    // RFID issue reports only (the route refuses every other kind): it marks them Resolved.
    branch_oversight: { scope: SCOPE_ALL, actions: READ_WRITE },
    // Moderation only: reads every announcement and deletes any. Whether it
    // posts routine announcements is an open decision (2026-10-30).
    announcements: { scope: SCOPE_ALL, actions: ["read", "delete"] },
  },

  admin: {
    // The branch head's oversight role (2026-10-20): it recommends, HR
    // decides, the Accountant processes, the Super Admin maintains the
    // system. Everything is its own branch only: the branch dashboard,
    // read-only attendance, endorsements / reports / requests to HR
    // (branch_oversight), announcements, the branch payroll totals and
    // reports, and the RFID terminal and cards. It never manages employees,
    // payroll, subsidy decisions or system settings.
    // dashboard: only the holiday calendar read; /api/admin/dashboard
    // (salaries) refuses the Admin.
    dashboard: view(SCOPE_BRANCH),
    attendance: none(),
    user_management: none(),
    employee_information: none(),
    employee_info_readonly: view(SCOPE_BRANCH),
    branch_management: none(),
    branch_assignment: none(),
    roles_permissions: none(),
    transfer_requests: none(),
    leave_approval: none(),
    // RFID cards and terminals of the Admin's own branch: register, replace,
    // deactivate; add and manage terminals (2026-10-21).
    rfid_devices: { scope: SCOPE_BRANCH, actions: ["create", "read", "update"] },
    process_payroll: none(),
    payroll_override: none(),
    payroll_records: none(),
    payslips: none(),
    payroll_monitoring: none(),
    system_maintenance: { scope: SCOPE_BRANCH, actions: READ_WRITE },
    system_configuration: none(),
    government_rates: none(),
    audit_logs: none(),
    backup_recovery: none(),
    hr_reports: none(),
    payroll_reports: none(),
    // Attendance rate, lateness and leave usage; the payroll summary is run totals only.
    branch_reports: view(SCOPE_BRANCH),
    profile: full(SCOPE_SELF),
    timesheet: none(),
    attendance_corrections: none(),
    loans: none(),
    awol_cases: none(),
    payroll_approvals: none(),
    teacher_license: none(),
    work_schedules: none(),
    early_bird_incentive: none(),
    payroll_run_approval: none(),
    tenure_protection: none(),
    branch_oversight: { scope: SCOPE_BRANCH, actions: ["create", "read", "update"] },
    // "delete" removes (archives) an announcement.
    announcements: full(SCOPE_BRANCH),
  },

  hr: {
    // HR serves EVERY branch, so every module it can reach is SCOPE_ALL and
    // HR accounts are stored with no branch ("All Branches"). The account
    // ceiling that keeps this safe is MANAGEABLE_ROLES (Employee and
    // Accountant only); payroll and system modules stay none().
    dashboard: view(SCOPE_ALL),
    attendance: { scope: SCOPE_ALL, actions: READ_WRITE },
    user_management: full(SCOPE_ALL),
    employee_information: full(SCOPE_ALL),
    employee_info_readonly: view(SCOPE_ALL),
    branch_management: none(),
    branch_assignment: { scope: SCOPE_ALL, actions: READ_WRITE },
    roles_permissions: none(),
    transfer_requests: full(SCOPE_ALL),
    leave_approval: full(SCOPE_ALL),
    // RFID cards and terminals for every branch (2026-10-21), alongside the
    // Super Admin and each branch's Admin. Nothing is ever deleted.
    rfid_devices: { scope: SCOPE_ALL, actions: ["create", "read", "update"] },
    process_payroll: none(),
    // Reads the override log (decision 2026-10-29); never runs an override.
    payroll_override: view(SCOPE_ALL),
    // Matrix rows 11-12: HR views every branch's processed payslips, read-only
    // (/api/hr/payroll-records). Restored in the database by
    // supabase/migrations/20261018010000_hr_view_payroll_records_payslips.sql;
    // kept in step here because src/lib/rbac/guard.js answers from this table.
    payroll_records: view(SCOPE_ALL),
    payslips: view(SCOPE_ALL),
    payroll_monitoring: none(),
    system_maintenance: none(),
    system_configuration: none(),
    // Read-only: answers employees' questions about their deductions.
    government_rates: view(SCOPE_ALL),
    audit_logs: none(),
    backup_recovery: none(),
    hr_reports: full(SCOPE_ALL),
    payroll_reports: none(),
    branch_reports: none(),
    profile: full(SCOPE_SELF),
    timesheet: view(SCOPE_ALL),
    attendance_corrections: { scope: SCOPE_ALL, actions: READ_WRITE },
    loans: none(),
    awol_cases: { scope: SCOPE_ALL, actions: ["create", "read", "update"] },
    // The only approver of subsidy decisions: missed-month adjustments the
    // Accountant requests, and refused-consent excess subsidy advances.
    payroll_approvals: { scope: SCOPE_ALL, actions: READ_WRITE },
    // The only role that edits and verifies licensed-teacher fields.
    teacher_license: { scope: SCOPE_ALL, actions: ["create", "read", "update"] },
    // Same full power over schedules as the Super Admin ("delete" archives).
    work_schedules: full(SCOPE_ALL),
    // Threshold, eligibility rule and amount.
    early_bird_incentive: { scope: SCOPE_ALL, actions: READ_WRITE },
    // Reviews every branch's run; approves or rejects ("update"). No create
    // or delete: HR never changes a computation.
    payroll_run_approval: { scope: SCOPE_ALL, actions: READ_WRITE },
    // Sets the policy and break dates, grants and revokes (never deletes:
    // a grant is revoked, history kept).
    tenure_protection: { scope: SCOPE_ALL, actions: ["create", "read", "update"] },
    // Sees every branch Admin's endorsements, reports and requests and decides them.
    branch_oversight: { scope: SCOPE_ALL, actions: READ_WRITE },
    // Posts, edits and deletes for the whole school or any branch (2026-10-30).
    announcements: full(SCOPE_ALL),
  },

  accountant: {
    dashboard: view(SCOPE_BRANCH),
    attendance: view(SCOPE_BRANCH),
    user_management: none(),
    employee_information: view(SCOPE_BRANCH),
    branch_management: none(),
    branch_assignment: none(),
    roles_permissions: none(),
    // No access: SACS-Payroll-Permission-Matrix.md row 8 gives Accountant "—".
    // This was a first-stage review (status pending_accountant) from before
    // Leave Approval moved to HR. New requests are now filed as pending_admin
    // (src/app/api/employee/leave-requests/route.js) and src/app/api/hr/
    // leave-requests/route.js absorbs any leftover pending_accountant rows, so
    // nothing depends on the Accountant acting here any more.
    leave_approval: none(),
    rfid_devices: none(),
    process_payroll: full(SCOPE_BRANCH),
    payroll_override: none(),
    payroll_records: full(SCOPE_BRANCH),
    payslips: full(SCOPE_BRANCH),
    payroll_monitoring: full(SCOPE_BRANCH),
    system_maintenance: none(),
    system_configuration: none(),
    // Read-only: checks and explains the deductions it processes.
    government_rates: view(SCOPE_BRANCH),
    audit_logs: none(),
    backup_recovery: none(),
    hr_reports: none(),
    payroll_reports: full(SCOPE_BRANCH),
    branch_reports: none(),
    profile: full(SCOPE_SELF),
    timesheet: view(SCOPE_BRANCH),
    // Accountants tap in too: they may ask to correct their own records.
    attendance_corrections: { scope: SCOPE_SELF, actions: ["create", "read"] },
    loans: full(SCOPE_BRANCH),
    // Sees who is AWOL / separated (payroll hold, final pay).
    awol_cases: view(SCOPE_BRANCH),
    // Requests subsidy adjustments and records refused consent.
    payroll_approvals: { scope: SCOPE_BRANCH, actions: ["create", "read"] },
    teacher_license: none(),
    work_schedules: none(),
    // Sees the period's winner on the payroll page.
    early_bird_incentive: view(SCOPE_BRANCH),
    // Its own branch's runs and HR's decisions (it submits through
    // process_payroll, and never approves).
    payroll_run_approval: view(SCOPE_BRANCH),
    // Payroll applies protection; the Accountant cannot see or grant it.
    tenure_protection: none(),
    // Reads the branch Admin's overtime / substitute-teaching confirmations before paying them.
    branch_oversight: view(SCOPE_BRANCH),
    announcements: view(SCOPE_BRANCH),
  },

  employee: {
    dashboard: view(SCOPE_SELF),
    attendance: view(SCOPE_SELF),
    user_management: none(),
    employee_information: view(SCOPE_SELF),
    branch_management: none(),
    branch_assignment: none(),
    roles_permissions: none(),
    // Submit own requests only.
    leave_approval: { scope: SCOPE_SELF, actions: ["create", "read"] },
    rfid_devices: none(),
    process_payroll: none(),
    payroll_override: none(),
    payroll_records: none(),
    payslips: view(SCOPE_SELF),
    payroll_monitoring: none(),
    system_maintenance: none(),
    system_configuration: none(),
    government_rates: none(),
    audit_logs: none(),
    backup_recovery: none(),
    hr_reports: none(),
    payroll_reports: none(),
    branch_reports: none(),
    profile: full(SCOPE_SELF),
    timesheet: view(SCOPE_SELF),
    // View own statuses; ask to correct an Incomplete / disputed record.
    attendance_corrections: { scope: SCOPE_SELF, actions: ["create", "read"] },
    loans: view(SCOPE_SELF),
    awol_cases: none(),
    payroll_approvals: none(),
    teacher_license: none(),
    work_schedules: none(),
    // A winner sees the incentive on their own payslip, not this module.
    early_bird_incentive: none(),
    payroll_run_approval: none(),
    tenure_protection: none(),
    branch_oversight: none(),
    // Its own branch's announcements (dashboard and notification bell).
    announcements: view(SCOPE_SELF),
  },
};

/**
 * Which roles each role may create / edit / archive through User Management.
 * Admin's ceiling is the whole point of this table: an Admin may never mint,
 * edit, or elevate anyone into admin or super_admin.
 */
export const MANAGEABLE_ROLES = {
  // Staff login accounts only; HR owns every Employee and Accountant account.
  super_admin: ["super_admin", "admin", "hr"],
  admin: [],
  hr: ["accountant", "employee"],
  accountant: [],
  employee: [],
};

/** Modules that are Super Admin exclusive, and the routes that expose them. */
export const SUPER_ADMIN_ONLY_MODULES = [
  "roles_permissions",
  "branch_management",
  "system_configuration",
  "backup_recovery",
];

export function isKnownRole(role) {
  return ROLES.includes(String(role || "").toLowerCase());
}

/** The permission entry for a role/module pair, or a closed one. */
export function permissionFor(role, module) {
  const entry = ROLE_PERMISSIONS[String(role || "").toLowerCase()]?.[module];
  if (!entry) return { scope: SCOPE_NONE, actions: [] };
  return entry;
}

/** True when `role` may perform `action` on `module`. */
export function can(role, module, action = "read") {
  return permissionFor(role, module).actions.includes(String(action).toLowerCase());
}

/** 'all' | 'branch' | 'self' | 'none' for a role/module pair. */
export function scopeFor(role, module) {
  return permissionFor(role, module).scope;
}

/** True when the role sees every branch (super_admin bypasses branch checks). */
export function isBranchExempt(role) {
  return String(role || "").toLowerCase() === "super_admin";
}

/**
 * True when the role may reach every branch on this particular module — either
 * because it is branch-exempt outright, or because the matrix grants it
 * SCOPE_ALL there (HR on employee records, user accounts and transfers).
 */
export function isBranchExemptFor(role, module) {
  return isBranchExempt(role) || scopeFor(role, module) === SCOPE_ALL;
}

/** True when the role's queries must carry a branch_id filter. */
export function isBranchScoped(role) {
  return BRANCH_SCOPED_ROLES.includes(String(role || "").toLowerCase());
}

/** True when `actorRole` may create/edit/archive an account of `targetRole`. */
export function canManageRole(actorRole, targetRole) {
  const allowed = MANAGEABLE_ROLES[String(actorRole || "").toLowerCase()] || [];
  return allowed.includes(String(targetRole || "").toLowerCase());
}

/** Every module a role can at least read — drives the sidebar. */
export function allowedModules(role) {
  const table = ROLE_PERMISSIONS[String(role || "").toLowerCase()] || {};
  return Object.keys(table)
    .filter((m) => table[m].actions.includes("read"))
    .sort((a, b) => (MODULES[a]?.order || 99) - (MODULES[b]?.order || 99));
}

/**
 * Hard-delete kill switch. Accounts and any record payroll/attendance history
 * depends on are archived, never destroyed. Call this on any code path that
 * would physically remove such a row; it always throws.
 */
export function assertNoHardDelete(entity = "record") {
  throw new Error(
    "Hard delete is disabled system-wide: a " + entity + " can only be archived " +
    "(status set to inactive), so payroll and attendance history stays intact.",
  );
}
