import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * scripts/purge-archived-employees.mjs used to hard-delete the profiles row
 * and the auth.users row of every archived employee account. Both are now
 * rejected by the block_hard_delete trigger in
 * supabase/migrations/20260903_rbac_branch_scoping.sql — deleting the auth
 * user cascades (profiles_id_fkey ON DELETE CASCADE) into the same blocked
 * delete on profiles, so the old script fails outright.
 *
 * These tests read the script as text rather than importing it, matching
 * tests/scripts-seed-parity.test.js: importing it would connect to Supabase
 * with the service role key and run its side effects for real.
 */

const script = readFileSync('scripts/purge-archived-employees.mjs', 'utf8');

describe('purge-archived-employees no longer hard-deletes', () => {
  it('never calls .delete() on any table', () => {
    // A hard delete anywhere in this script would hit block_hard_delete on
    // profiles, or on payroll_records/audit_logs/attendance_logs if the script
    // ever grew to touch those. There is no longer a legitimate reason for a
    // DELETE statement here at all.
    expect(script).not.toMatch(/\.delete\s*\(/);
  });

  it('never calls auth.admin.deleteUser', () => {
    // Deleting the auth user cascades into the same blocked profiles delete
    // (profiles_id_fkey ... ON DELETE CASCADE), so this call could only ever
    // fail now — and removing it entirely is the point of the fix, not just
    // catching the failure.
    expect(script).not.toMatch(/auth\.admin\.deleteUser/);
  });

  it('soft-deletes by updating profiles.archived instead', () => {
    expect(script).toMatch(/\.from\(["']profiles["']\)/);
    expect(script).toMatch(/\.update\s*\(/);
    expect(script).toContain('archived: true');
  });

  it('sets employee_status to Inactive, matching the existing archive endpoint', () => {
    // src/app/api/admin/employees/route.js writes the same two fields when it
    // archives an employee. Keeping this script's payload identical means a
    // profile this script fixes is indistinguishable from one archived
    // through the app.
    expect(script).toContain('employee_status: "Inactive"');
  });

  it('is idempotent: an already-archived profile is read before being written', () => {
    // The script must check current state before updating, or every run would
    // rewrite updated_at on rows that were already correct.
    expect(script).toMatch(/\.select\(/);
    expect(script).toMatch(/archived/);
  });

  it('still targets only employee-role accounts marked archived in auth metadata', () => {
    // The original filter is the one part of the script's purpose that must
    // not change: this is reconciliation for already-archived employees, not
    // a way to archive accounts that are not already flagged.
    expect(script).toContain('role === "employee"');
    expect(script).toContain('metadata.archived === true');
  });

  it('keeps auth.users untouched — user_metadata.archived stays authoritative', () => {
    // src/app/api/legacy-auth/login/route.js already refuses sign-in for
    // user_metadata.archived === true; this script brings profiles into
    // agreement with that, and must never write back to auth.users itself.
    expect(script).not.toMatch(/auth\.admin\.updateUserById/);
  });
});
