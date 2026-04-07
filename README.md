# BNCS Payroll (Next.js)

This project has been migrated to Next.js and prepared for Supabase integration.

## Run

1. Copy `.env.example` to `.env.local`.
2. Set Supabase values:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (required for automated role user seeding)
3. Optional seed values for default login accounts:
   - `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`
   - `SEED_ACCOUNTANT_EMAIL`, `SEED_ACCOUNTANT_PASSWORD`
   - `SEED_EMPLOYEE_EMAIL`, `SEED_EMPLOYEE_PASSWORD`
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
