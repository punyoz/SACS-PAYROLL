# SACS Payroll (Next.js)

This project has been migrated to Next.js and prepared for Supabase integration.

## Run

1. Copy `.env.example` to `.env.local`.
2. Set Supabase values:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (required for automated role user seeding)
   - `SESSION_SECRET` (required in production; signs the session cookie)
   - `GMAIL_USER`, `GMAIL_APP_PASSWORD` (sign-in and password codes by email)
3. Optional seed values for default login accounts (`SEED_SUPER_ADMIN_*`,
   `SEED_ADMIN_*`, `SEED_HR_*`, `SEED_ACCOUNTANT_*`, `SEED_EMPLOYEE_*`).
   `.env.example` lists every variable with a short note.
4. Install dependencies:
   - `npm install`
5. Start development server:
   - `npm run dev`

## Env Files

- `.env.local` is the runtime file used by Next.js and project scripts.
- `.env.example` is only a template for onboarding and should not contain real credentials.

## Project Structure

- `src/app` - Next.js App Router pages and API routes
- `src/lib/supabase` - Supabase client utilities
- `public/legacy` - Primary UI design (HTML/CSS/JS) used by login and role portals
- `.vscode/extensions.json` - Recommended VS Code extensions

## Notes

- The old static implementation is preserved in `public/legacy` and rendered through `src/app/_components/LegacyRoleFrame.js`.
- You can migrate each legacy role screen into React route pages incrementally.

## Supabase Migration

The active migrations live in `supabase/migrations/`. Apply any new SQL files there via the Supabase Dashboard SQL Editor, then restart `npm run dev`.

Tables used by the APIs (20 tables and 1 view):

- Accounts and branches: `profiles`, `branches`, `employee_branch_assignments`, `transfer_requests`, `role_permissions`, `system_config`
- Attendance: `attendance_logs`, `attendance_logs_history`, `attendance_corrections`, `attendance_overtime_approvals`, `attendance_holidays`, `attendance_blocked_taps`
- Leave: `leave_requests`
- Payroll: `payroll_entries`, `payroll_records`, `payroll_deductions`, `payroll_incentives`, `payroll_rate_configs`
- System: `audit_logs`, `auth_throttle`
- `employee_info_view` (read-only view)
