import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * scripts/clean-reset.mjs hard-deletes every auth user whose email is not in
 * its SEED_EMAILS list — profile row and auth account both. So that list has to
 * name every account scripts/seed-auth-users.mjs creates.
 *
 * It did not: Super Admin and HR were missing, so a reset destroyed the
 * highest-privilege account in the system along with HR, leaving no role able
 * to recreate them. These tests read the two scripts as text rather than
 * importing them, because importing clean-reset.mjs would run it.
 */

const seeder = readFileSync('scripts/seed-auth-users.mjs', 'utf8');
const reset = readFileSync('scripts/clean-reset.mjs', 'utf8');

/** Env var names of the form SEED_*_EMAIL referenced in a script. */
function seedEmailVars(source) {
  return [...source.matchAll(/process\.env\.(SEED_[A-Z_]*EMAIL)\b/g)]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();
}

describe('clean-reset seed list parity', () => {
  it('preserves every account the seeder creates', () => {
    const created = seedEmailVars(seeder);
    const preserved = seedEmailVars(reset);

    // Sanity: the seeder really does create the five role accounts.
    expect(created).toEqual([
      'SEED_ACCOUNTANT_EMAIL',
      'SEED_ADMIN_EMAIL',
      'SEED_EMPLOYEE_EMAIL',
      'SEED_HR_EMAIL',
      'SEED_SUPER_ADMIN_EMAIL',
    ]);

    const missing = created.filter((name) => !preserved.includes(name));
    expect(
      missing,
      `clean-reset.mjs would hard-delete these seeded accounts: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the privileged accounts specifically', () => {
    // Named explicitly: these are the two that were missing, and losing the
    // Super Admin is unrecoverable through the application itself.
    expect(reset).toContain('SEED_SUPER_ADMIN_EMAIL');
    expect(reset).toContain('SEED_HR_EMAIL');
  });

  it('defaults match the seeder, so an unset env var does not drop an account', () => {
    // Each script falls back to a literal default when the env var is unset.
    // If those disagree, a reset run without .env.local deletes the real one.
    for (const [varName, fallback] of [
      ['SEED_SUPER_ADMIN_EMAIL', 'superadmin@example.com'],
      ['SEED_ADMIN_EMAIL', 'admin@example.com'],
      ['SEED_HR_EMAIL', 'hr@example.com'],
      ['SEED_ACCOUNTANT_EMAIL', 'accountant@example.com'],
      ['SEED_EMPLOYEE_EMAIL', 'employee@example.com'],
    ]) {
      const pattern = new RegExp(
        `process\\.env\\.${varName}\\s*\\|\\|\\s*["']${fallback.replace('.', '\\.')}["']`,
      );
      expect(pattern.test(seeder), `${varName} default in seed-auth-users.mjs`).toBe(true);
      expect(pattern.test(reset), `${varName} default in clean-reset.mjs`).toBe(true);
    }
  });
});
