import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { recordStatusMeta } from '@/lib/portal/payroll-preview';

describe('recordStatusMeta (Accountant Payroll Records / Monitoring)', () => {
  const rec = (run_status, pay_period = 'October 1-15, 2026', status = 'paid') => ({ status, pay_period, run_status });

  it('is Paid only once HR approves the branch run', () => {
    expect(recordStatusMeta(rec('approved')).label).toBe('Paid');
    expect(recordStatusMeta(rec('pending')).label).toBe('Pending HR Approval');
    expect(recordStatusMeta(rec('rejected')).label).toBe('Rejected by HR');
    expect(recordStatusMeta(rec(null)).label).toBe('Not submitted to HR');
    expect(recordStatusMeta(rec('draft')).label).toBe('Not submitted to HR');
  });

  it('keeps the old labels before approval existed, and for drafts', () => {
    expect(recordStatusMeta(rec(null, 'September 16-30, 2026')).label).toBe('Paid');
    expect(recordStatusMeta(rec(null, 'October 1-15, 2026', 'draft')).label).toBe('Not submitted to HR');
  });
});

describe('Payroll Records keeps every period (vanishing-records regression)', () => {
  const route = readFileSync('src/app/api/accountant/payroll/route.js', 'utf8');
  const page = readFileSync('src/app/accountant/records-page.jsx', 'utf8');

  it('the API always returns the all-period history, whatever ?period= asks for', () => {
    expect(route).toMatch(/history_records: historyRecords/);
    expect(route).toMatch(/history_panels: buildPayrollPanels\(historyRecords\)/);
    // Scale (2026-10-22): the history is a window (last 12 months or a year,
    // ?history=), never narrowed by ?period=; the Pay Record picker lists the
    // period's payslips (and the one opened) out of that history.
    expect(route).toMatch(/historyEntries = sortedEntries\.filter\(\(entry\) => entry\.status !== "draft" && windowLabels\.includes\(entry\.pay_period\)\)/);
    expect(route).toMatch(/payslip_options: buildPayslipOptions\(\s*historyRecords\.filter/);
  });

  it('the page lists the history, not the period-scoped records', () => {
    expect(page).toMatch(/data\?\.history_records/);
    expect(page).toMatch(/data\?\.history_panels/);
  });
});

describe('incentive cutoff (the day before the 2nd-half payslip day)', () => {
  it('pays an item filed up to the cutoff this month, and one filed after it next month', async () => {
    const { deferredPayrollMonth } = await import('@/app/accountant/incentives-page.jsx');
    const cutoffs = { '2026-10': { cutoff_date: '2026-10-29' }, '2026-12': { cutoff_date: '2026-12-30' } };
    expect(deferredPayrollMonth('2026-10-20', '2026-10-20', cutoffs)).toBe('2026-10');
    expect(deferredPayrollMonth('2026-10-10', '2026-10-29', cutoffs)).toBe('2026-10');
    expect(deferredPayrollMonth('2026-10-10', '2026-10-30', cutoffs)).toBe('2026-11');
    expect(deferredPayrollMonth('2026-12-10', '2026-12-31', cutoffs)).toBe('2027-01');
  }, 30000); // imports a whole client page: slow under a busy full run
});
