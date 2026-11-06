# ERD updates (2026-11-06)

What to add to or change in the ERD so it matches the database. Every
definition here was read from the live database on 2026-11-06 (not from
memory or the old migrations).

## Add: `role_permissions` (in use)

The database's copy of the access rules: one row per role and module, read by
`private.has_permission()`, which 40 row-level security policies on 15 tables
call (attendance logs, audit logs, branch requests, branches, branch
assignments, leave requests, payroll approval history, payroll entries,
payroll records, payroll run items, payroll runs, profiles, role permissions,
system config, transfer requests). 181 rows on live.

| Column | Type | Null | Default | Key / rule |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | PK |
| role | text | no | | UNIQUE (role, module) |
| module | text | no | | UNIQUE (role, module) |
| scope | text | no | 'none' | CHECK in ('all','branch','self','none') |
| can_create | boolean | no | false | |
| can_read | boolean | no | false | |
| can_update | boolean | no | false | |
| can_delete | boolean | no | false | |
| updated_at | timestamptz | no | now() | |

Relationship: no foreign key. `role_permissions.role` matches
`profiles.role` by value (draw it as a dashed "governs" line from
PROFILES to ROLE_PERMISSIONS, many-to-one on role, if your ERD notation
allows non-FK links; otherwise place the table on its own with a note).

## Add: `rfid_terminals` (retired, kept)

The registered-terminal feature was removed on 2026-10-27 (the kiosk is now
unlocked with an account password). The table stays because it holds data
(1 row on live) and because guard triggers keep anyone from creating or
editing terminals again. No new rows are made. Mark it "retired" in the ERD.

| Column | Type | Null | Default | Key / rule |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | PK |
| name | text | no | | CHECK 2-50 letters, digits, space . ' - |
| branch_id | uuid | yes | | FK → branches.id |
| status | text | no | 'active' | CHECK in ('active','inactive') |
| key_version | integer | no | 1 | |
| last_tap_at | timestamptz | yes | | |
| last_tap_result | text | yes | | |
| status_reason | text | yes | | |
| created_by | uuid | yes | | FK → profiles.id |
| created_by_name | text | no | | |
| created_by_role | text | no | | |
| updated_by_name | text | yes | | |
| created_at | timestamptz | no | now() | |
| updated_at | timestamptz | no | now() | |

Relationships:
- BRANCHES 1 ── 0..* RFID_TERMINALS (`rfid_terminals.branch_id`)
- PROFILES 1 ── 0..* RFID_TERMINALS (`rfid_terminals.created_by`)
- RFID_TERMINALS 1 ── 0..* ATTENDANCE_TAPS (`attendance_taps.terminal_id`,
  nullable; 0 taps use it on live)

## Change: `leave_requests` (migration 20261106060000)

- New column `decision_reason` text, nullable, CHECK length ≤ 500: why HR
  rejected the request (required on every rejection from now on).

## Change: `profiles` (migration 20261106050000)

- New rule `profiles_admin_has_branch`: CHECK (role <> 'admin' OR branch_id
  IS NOT NULL). An Admin always belongs to one branch. The
  PROFILES ── BRANCHES line stays optional (0..1) for the other roles.

## Not an ERD item

- Removed function `payroll_pending_run_count()` (migration 20261106070000):
  functions are not drawn in the ERD.
- Table count stays 67.
