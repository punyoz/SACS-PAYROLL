# 2026-11-08 — Narrower sidebar (UI only)

Branch `feat/sidebar-narrow-2026-11-08` (from `feat/sa-backup-ui-rates-2026-11-08`, 926a03f). No database, migration, payroll or data change; no menu item renamed, removed or re-permissioned.

| | Before | After |
| --- | --- | --- |
| Expanded (desktop) | 16rem (256 px) | **13rem (208 px)** |
| Collapsed (icons) | 3rem (48 px), 32 px buttons | 3.25rem (52 px), 36 px buttons |
| Phone drawer (< 768 px) | 18rem (288 px) | 18rem (unchanged: no label cut) |
| Menu row height | 32 px | 36 px desktop, 40 px touch |
| Group headings | 11 px | 10 px |
| Menu labels | 14 px | 14 px |

Width: one place for every role, `SIDEBAR_WIDTH` in `src/components/ui/sidebar.jsx` (the `--sidebar-width` CSS variable comes from it). Spacing, heights and tooltips: `src/components/portal/app-shell.jsx`.

Also fixed: the collapse state was written to the `sidebar_state` cookie but never read, so a reload always reopened the sidebar; it is now read back.

Labels cut at 13rem (full text shown on hover / focus): Admin "Leave Recommendations", "Incentive Recommendations", "Incident & AWOL Reports"; HR "Incentive & Loan Approvals". At 14rem only "Incentive Recommendations" and "Incentive & Loan Approvals" are cut.
