# Release 2026-11-24 (after 18:00): Admin view-only, HR ↔ Admin, automatic substitutions, AWOL, Settings > Automation, one RFID page, filter bars

Branch `release/2026-11-24-admin-hr` (from ehdd `49f2172`). Status: built and tested locally; not live yet.

## Database changes (5 migrations, all additive)

| # | Migration | What it changes |
|---|---|---|
| 1 | `20261124150000_admin_view_only_presets` | A system proposal goes straight to HR (no "waiting for the Admin's check"); items still waiting for the Admin move to HR (live: none). Preset remarks for the Admin's filings (new decision "file"): 4 incident, 3 incentive and 4 RFID presets ("Other" built in). Substitutions: a proposal may have no substitute yet; `source` (manual / leave / unplanned); an approved one must name the substitute; one proposal per leave and day. |
| 2 | `20261124160000_branch_item_messages` | New table: the HR ↔ branch Admin message thread per item. Written by the server only; never edited or deleted. |
| 3 | `20261124170000_rfid_lost_report_removed_event` | Card history action "Test lost-card report removed"; one entry per card cleaned this morning, taken from the audit log. |
| 4 | `20261124180000_daily_digests` | HR digest points to Action needed and Settings > Automation; new Admin digest: HR's decisions for their branch since yesterday. Both can be switched off (`automation.digest_hr` / `digest_admin`). |
| 5 | `20261124190000_awol_fully_automatic` | AWOL automatic until separation, with automatic stops. Settings: 5 days, reply 5, separation 3, a 2nd notice template. Case columns: automation state and reason, guards, separation date. New table `awol_notices`. New private bucket `awol-notices`. Guard, notice, status and send functions; `awol_flag_candidates` and `awol_daily_review` replaced. A system separation is allowed without an HR account (decided by "System"). **Every existing case is marked "Needs review" and is never processed automatically.** |

Live data changed by these:
- `hr.awol_flag_days` 3 → 5.
- The 4 open AWOL cases: automation "Needs review".
- 3 card history entries.
- 11 presets.
- 2 digest settings.

Nothing is deleted. No payroll or attendance rows change.

## Also live (not the database)
- **Vercel Cron:** `vercel.json` gets one daily job, `/api/cron/awol-notices` at 17:00 UTC (01:00 Manila). It needs a `CRON_SECRET` environment variable on Vercel (a new random value, never printed). Without it the route refuses every call, so the e-mails and stored PDFs wait; the in-app notices still go out.

## Checkbox audit (lists with row checkboxes)

| Page | Role | Bulk action | Result |
|---|---|---|---|
| Approvals › Leave, overtime & corrections | HR | Approve / Reject selected | kept |
| Approvals › Overtime requests | HR | Approve / Reject selected | kept |
| Approvals › Attendance corrections | HR | Approve / Reject selected | kept |
| Approvals › Substitutions | HR | Approve / Reject selected (a proposal needs its own pick: not selectable) | kept |
| Approvals › Transfers | HR | Approve / Reject selected | kept |
| Approvals › From branch admins | HR | Resolve / Approve / Reject selected | kept |
| Approvals › Incentives & loans | HR | Approve / Reject selected | kept |
| Approvals › Subsidies | HR | Approve / Reject selected | kept |
| Payroll corrections | HR | Approve / Reject selected | kept |
| Employees › Management | HR | Offboard selected | kept |
| Employees › Tenure pay | HR | Grant / Revoke selected | kept |
| RFID cards | HR / Super Admin / Admin | Replace selected | kept |
| Branch Review › Leave | Admin | none (the Admin no longer endorses) | **removed** |
| Branch Review › Transfers | Admin | none | **removed** |

Every remaining checkbox has a working bulk action; the e2e bulk tests click them. No checkbox without an action is left.

## What is in / out
(filled in at release)
