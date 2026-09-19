import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { floorNetPay, toPesoAmount } from '@/lib/payroll/net-pay';

describe('floorNetPay', () => {
  it('leaves a normal net pay untouched', () => {
    expect(floorNetPay(12500.5)).toBe(12500.5);
    expect(floorNetPay(0.01)).toBe(0.01);
  });

  it('floors a negative net pay at zero', () => {
    // 8,000 basic against 9,250 of deductions: the employee is owed nothing,
    // not asked to pay the school.
    expect(floorNetPay(8000 - 9250)).toBe(0);
    expect(floorNetPay(-0.01)).toBe(0);
    expect(floorNetPay(-100000)).toBe(0);
  });

  it('never returns negative zero', () => {
    // -0 would format as "-₱0.00" on a payslip and serialise as -0 in JSON.
    const result = floorNetPay(-0);
    expect(Object.is(result, -0)).toBe(false);
    expect(Object.is(result, 0)).toBe(true);
    expect(Object.is(floorNetPay(-0.001), 0)).toBe(true);
  });

  it('rounds to centavos', () => {
    expect(floorNetPay(1234.567)).toBe(1234.57);
    expect(floorNetPay(1234.564)).toBe(1234.56);
  });

  it('treats missing or non-numeric input as zero', () => {
    for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, {}]) {
      expect(floorNetPay(bad), String(bad)).toBe(0);
    }
  });

  it('accepts a numeric string, as a JSONB round-trip can produce', () => {
    expect(floorNetPay('4500.25')).toBe(4500.25);
    expect(floorNetPay('-4500.25')).toBe(0);
  });
});

describe('toPesoAmount', () => {
  it('rounds to centavos but keeps the sign', () => {
    // Deliberately unclamped: only net pay is floored. total_deductions and
    // the individual figures stay truthful.
    expect(toPesoAmount(-1250.005)).toBe(-1250.01);
    expect(toPesoAmount(9250)).toBe(9250);
    expect(toPesoAmount('nope')).toBe(0);
  });
});

describe('the floor is applied wherever net pay is produced or read back', () => {
  // Guards against a new net_pay site being added without the floor. Reading
  // the sources is crude, but these are route modules that cannot be imported
  // without a Supabase environment.
  const files = [
    'src/app/api/accountant/payroll/route.js',
    'src/app/api/employee/payslips/route.js',
  ];

  for (const file of files) {
    it(`${file} floors every net_pay it emits`, () => {
      const source = readFileSync(file, 'utf8');

      expect(source, 'imports the shared floor').toContain('floorNetPay');

      // Every line that assigns net_pay / netPay from a computation must run it
      // through floorNetPay - not the plain rounding helper.
      const offenders = source
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /(^|\s)(net_pay|const netPay)\s*[:=]/.test(line))
        .filter(([, line]) => !line.includes('floorNetPay'))
        // reading a column list or a plain passthrough of an already-floored
        // local is fine; only flag rounding helpers applied to net pay
        .filter(([, line]) => /toAmount|Number\(/.test(line));

      expect(
        offenders.map(([n, l]) => `${n}: ${l.trim()}`),
        'net_pay assigned without the floor',
      ).toEqual([]);
    });
  }
});
