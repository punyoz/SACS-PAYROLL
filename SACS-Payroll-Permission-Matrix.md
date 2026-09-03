# SACS Payroll — Role Permission Matrix & Claude Code Prompt

## 1. Issues Found in Current Sidebar Design

| Issue | Current State | Recommendation |
|---|---|---|
| Admin has **System Maintenance** | Same label/access as Super Admin | Should be scoped/limited for Admin (e.g., view-only, or restricted to branch-level settings) — full System Maintenance should stay Super Admin only |
| Admin has no **Reports** section | Only HR and Accountant have reports | Admin (branch manager) should get a branch-level summary report view |
| "Audit Logs" (Admin) vs "Audit & Monitoring" (Super Admin) | No defined scope difference | Admin's Audit Logs = branch-scoped only; Super Admin's Audit & Monitoring = all branches + system-level events (login attempts, config changes, backups) |
| Admin has **User Management** with no defined ceiling | Unclear if Admin can create other Admins | Admin should only manage HR / Accountant / Employee accounts in their own branch — never Super Admin or other Admin accounts |
| **Roles & Permissions** only in Super Admin | Correct | Keep exclusive to Super Admin — this is where role-permission mapping itself is edited |
| **Backup & Recovery** only in Super Admin | Correct | Keep exclusive — high-risk, system-wide action |

---

## 2. Full Ordered Permission Matrix

Legend: **F** = Full (CRUD), **P** = Partial/Branch-scoped, **V** = View only, **—** = No access

| # | Module | Super Admin | Admin | HR | Accountant | Employee |
|---|---|---|---|---|---|---|
| **OVERVIEW** |
| 1 | Dashboard (role-specific view) | F (all branches) | P (own branch) | P (own branch) | P (own branch) | P (own record) |
| 2 | Attendance | F (all branches, edit/override) | P (own branch, edit/correct) | P (own branch, monitor + correct) | V (reference only, no edit) | V (own record only) |
| **MANAGEMENT** |
| 3 | User/Account Management | F — can create/archive Admin, HR, Accountant, Employee accounts, any branch (no permanent delete) | P — can create/edit/archive HR, Accountant, Employee accounts, own branch only. Cannot create Admin/Super Admin | P — can view/edit Employee accounts in own branch | — | — |
| 4 | Employee Information (records, 201 files) | F (all branches) | P (own branch) | F (own branch — primary owner of this module) | V (for payroll reference) | V (own profile only) |
| 5 | Branch Management (create/edit/close branches) | F | — | — | — | — |
| 6 | Branch Assignment (assign staff to a branch) | F (any staff, any branch) | P (within own branch only) | P (within own branch only) | — | — |
| 7 | Roles & Permissions (define what each role can do) | F — exclusive | — | — | — | — |
| 8 | Leave Approval | F (override any decision) | V | F (own branch) | — | Submit only (own requests) |
| **ATTENDANCE / RFID** |
| 9 | RFID Device Registration/Config | F | V | — | — | — |
| **PAYROLL** |
| 10 | Process Payroll | V (oversight/approval only) | — | — | F (own branch) | — |
| 11 | Payroll Records | F (all branches) | V (own branch) | V (own branch) | F (own branch) | — |
| 12 | Payslips | F (view/reissue, all branches) | V (own branch) | V (own branch) | F (generate, own branch) | V (own payslip only) |
| 13 | Payroll Monitoring | F (all branches) | V (own branch) | — | F (own branch) | — |
| **SYSTEM** |
| 14 | System Maintenance (feature toggles, general settings) | F — exclusive | — | — | — | — |
| 15 | System Configuration (tax tables, formulas, holiday calendar, integrations) | F — exclusive | — | — | — | — |
| 16 | Audit Logs / Audit & Monitoring | F (all branches + system events) | V (own branch activity only) | — | — | — |
| 17 | Backup & Recovery | F — exclusive | — | — | — | — |
| **REPORTS** |
| 18 | HR Reports | F (all branches) | V (own branch) | F (own branch) | — | — |
| 19 | Payroll Reports | F (all branches) | V (own branch) | — | F (own branch) | — |
| **ACCOUNT** |
| 20 | Profile | F (own) | F (own) | F (own) | F (own) | F (own) |
| 21 | Timesheet | F (all, view/adjust) | V (own branch) | V (own branch) | V (reference) | F (own — view/print) |

---

## 3. Core Rule to Remember

> **Super Admin = system-wide + configuration authority. Admin = operational authority, but boxed inside one branch, and never able to touch system config, role definitions, or other Admin/Super Admin accounts.**

Every permission difference in the table above traces back to two dimensions:
1. **Scope** — all branches vs. one branch
2. **Depth** — can configure the system vs. can only operate within it

---

## 4. Prompt to Send to Claude Code

```
I need you to update the role-based access control (RBAC) permissions in my
SACS Payroll Management System (web-based, Supabase/PostgreSQL backend,
RFID-based attendance, 4 school branches).

CONTEXT:
Roles in the system: Super Admin, Admin, HR, Accountant, Employee.
Currently, permissions are inconsistent — specifically, the Admin role has
access to modules that should be Super Admin-exclusive, and lacks a
branch-level Reports module.

GOAL: Enforce the following permission rules across the backend
(route guards / middleware / RLS policies in Supabase) AND the frontend
(sidebar rendering + route access):

1. SCOPE RULE
   - Super Admin: access to ALL branches' data, no branch restriction.
   - Admin: restricted to their assigned branch only (add a branch_id
     check on every query/action Admin performs).
   - HR, Accountant, Employee: same branch-level restriction as Admin.

2. MODULE-LEVEL PERMISSIONS TO IMPLEMENT

   Super Admin exclusive (Admin must NOT have access to these):
   - Roles & Permissions (editing what each role can do)
   - Branch Management (creating/editing/closing branch records)
   - System Configuration (tax tables, payroll formulas, holiday calendar)
   - System Maintenance (feature toggles, system-wide settings)
   - Backup & Recovery
   - Full Audit & Monitoring (all branches + system-level events:
     logins, config changes, backup actions)

   Admin (branch-scoped):
   - User Management: can create/edit/archive HR, Accountant, and
     Employee accounts WITHIN their own branch only. Accounts are
     archived (soft-deleted, status flag set to "inactive"), never
     permanently deleted from the database. Must NOT be able to
     create/edit/archive Admin or Super Admin accounts.
   - Employee Information: view/edit within own branch only.
   - Branch Assignment: can assign staff to roles/departments within
     their own branch only (not move staff across branches — that
     requires Super Admin).
   - Attendance: view/correct records for their own branch only.
   - Audit Logs: view-only, own branch's activity only (not
     system-level events).
   - Add a new "Branch Reports" module for Admin: view-only summary
     of attendance, headcount, and payroll status for their branch
     (no edit access to payroll figures — that stays with Accountant).
   - Leave Approval: view-only (final approval stays with HR, escalation
     goes to Super Admin).

3. IMPLEMENTATION DETAILS
   - Add/update a `role_permissions` table (or equivalent config) that
     maps each role to allowed modules and actions (create/read/update/
     delete), rather than hardcoding role checks throughout the codebase.
   - Add a `branch_id` scoping check as Row Level Security (RLS) policy
     in Supabase for every table that Admin, HR, Accountant, or Employee
     can touch, so users can only see/edit rows matching their own
     branch_id. Super Admin bypasses this check entirely.
   - Update the sidebar/menu rendering logic so menu items are generated
     dynamically based on the permissions table, not hardcoded per role
     component.
   - Add middleware/guard on each API route or server action that
     verifies both (a) role has permission for that action, and
     (b) branch_id matches if the role is branch-scoped.
   - Write or update automated tests confirming:
     - Admin cannot access /system-configuration, /backup-recovery,
       /roles-permissions, or /branch-management routes.
     - Admin cannot query or mutate data belonging to another branch_id.
     - Admin cannot create or elevate a user to Admin/Super Admin role.
     - Deleting a user account anywhere in the system only sets it to
       "archived"/"inactive" — no role can trigger a hard delete from
       the database (preserves payroll/attendance history integrity).

4. DELIVERABLES
   - Updated RBAC/permissions table or config file.
   - Updated Supabase RLS policies (SQL migration file).
   - Updated frontend route guards and sidebar rendering logic.
   - Short summary of every file changed and why.

Please review the current codebase structure first, tell me where role
checks currently live, and confirm the approach before making changes.
```

---

**Tip:** Before sending this to Claude Code, plug in your actual table/file names (e.g., your Supabase table for users, your route file structure) so it doesn't have to guess your architecture — that'll get you a much more accurate first pass.
