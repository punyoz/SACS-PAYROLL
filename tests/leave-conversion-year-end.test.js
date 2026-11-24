// Leave conversion (2026-11-26): year end on the Dec 16–31 payslip, final pay, tax under 10 days, preview = December.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  conversionDailyRate, conversionPreviewText, isYearEndPeriod, leaveConversionFor, leaveConversionFrom, LEAVE_CONVERSION_KEYS,
} from "@/lib/payroll/leave-conversion";

const on = { enabled: true, max_days: null, tax_free_days: 10, statuses: [] };
const read = (p) => readFileSync(p, "utf8");

describe("the year-end amount and its payslip line", () => {
  it("unused days × monthly × 12 ÷ 261, to the centavo, as its own line", () => {
    expect(conversionDailyRate(32000)).toBe(1471.26);
    const c = leaveConversionFor({ setting: on, remaining: 3, monthlySalary: 32000 });
    expect(c).toMatchObject({ eligible: true, days: 3, daily_rate: 1471.26, amount: 4413.78 });
    expect(c.note).toBe("Leave conversion: 3 unused days × ₱1,471.26 = ₱4,413.78");
  });
  it("only on the Dec 16–31 half", () => {
    expect(isYearEndPeriod("2026-12-16")).toBe(true);
    expect(isYearEndPeriod("2026-12-01")).toBe(false);
    expect(isYearEndPeriod("2026-11-16")).toBe(false);
  });
  it("the payroll engine adds it on that half as an earning line with its own total", () => {
    const route = read("src/app/api/accountant/payroll/route.js");
    expect(route).toMatch(/if \(!isYearEndPeriod\(period\?\.start_key\)/);
    expect(route).toMatch(/type: "leave_conversion", quantity: leaveConversion\.days, unit: "day", rate: leaveConversion\.daily_rate/);
    expect(route).toMatch(/leave_conversion_pay: leaveConversionPay,/);
    expect(route).toMatch(/specialDayPay \+ leaveConversionPay\);/);
    expect(read("src/lib/payroll/line-tags.js")).toMatch(/line\("leave_conversion", "Leave conversion"/);
  });
});

describe("half days, pending requests, statuses and the cap", () => {
  it("half days count 0.5; nothing below 0", () => {
    expect(leaveConversionFor({ setting: on, remaining: 2.5, monthlySalary: 32000 }).days).toBe(2.5);
    expect(leaveConversionFor({ setting: on, remaining: 2.7, monthlySalary: 32000 }).days).toBe(2.5);
    expect(leaveConversionFor({ setting: on, remaining: -1, monthlySalary: 32000 })).toMatchObject({ days: 0, amount: 0 });
  });
  it("a request still pending at year end is not used: the pool counts approved leave only", () => {
    const src = read("src/lib/employees/classification-server.js");
    expect(src).toMatch(/status === "approved"|\.eq\("status", "approved"\)|isApproved/);
  });
  it("statuses converted (empty = all on payroll) and the maximum days", () => {
    expect(leaveConversionFor({ setting: { ...on, statuses: ["Regular"] }, remaining: 3, monthlySalary: 32000, status: "Probationary" })).toMatchObject({ eligible: false, amount: 0 });
    expect(leaveConversionFor({ setting: { ...on, statuses: ["Regular"] }, remaining: 3, monthlySalary: 32000, status: "Regular" }).amount).toBe(4413.78);
    expect(leaveConversionFor({ setting: { ...on, max_days: 2 }, remaining: 3, monthlySalary: 32000 }).days).toBe(2);
  });
  it("off pays nothing", () => {
    expect(leaveConversionFor({ setting: { ...on, enabled: false }, remaining: 3, monthlySalary: 32000 })).toMatchObject({ eligible: false, amount: 0 });
  });
});

describe("tax: de minimis up to 10 days a year, any excess taxable", () => {
  it("under 10 days: all tax-free", () => {
    expect(leaveConversionFor({ setting: on, remaining: 5, monthlySalary: 26100 })).toMatchObject({ exempt_days: 5, taxable: 0 });
  });
  it("over 10 days: the excess days are taxable", () => {
    const c = leaveConversionFor({ setting: on, remaining: 12, monthlySalary: 26100 });
    expect(c.daily_rate).toBe(1200);
    expect(c).toMatchObject({ days: 12, amount: 14400, exempt_days: 10, exempt: 12000, taxable: 2400 });
  });
  it("the engine leaves the exempt part out of taxable income", () => {
    expect(read("src/app/api/accountant/payroll/route.js")).toMatch(/adjustmentNonTaxable \+ customNonTaxable \+ \(leaveConversion \? toAmount\(leaveConversion\.exempt\) : 0\)/); // 2026-11-26: + the non-taxable own pay types
  });
  it("settings: tax-free days and statuses are stored; the note says to verify with the school's accountant", () => {
    const s = leaveConversionFrom([{ section: "payroll", key: LEAVE_CONVERSION_KEYS.enabled, value: "true" }, { section: "payroll", key: LEAVE_CONVERSION_KEYS.taxFreeDays, value: "8" },
      { section: "payroll", key: LEAVE_CONVERSION_KEYS.statuses, value: "[\"Regular\"]" }]);
    expect(s).toMatchObject({ enabled: true, tax_free_days: 8, statuses: ["Regular"] });
    expect(read("src/components/portal/leave-conversion-card.jsx")).toMatch(/LEAVE_CONVERSION_NOTE/);
    expect(read("src/lib/payroll/leave-conversion.js")).toMatch(/verify with the school's accountant/);
  });
});

describe("separation and the preview", () => {
  it("final pay converts the current year's unused days, worded like the year-end line", () => {
    const fp = read("src/app/api/accountant/final-pay/route.js");
    expect(fp).toMatch(/leaveConversionAmount\(setting, balance\.with_pay_remaining, daily\)/);
    expect(fp).toMatch(/label: "Leave conversion"/);
  });
  it("the preview is December's own calculation", () => {
    const c = leaveConversionFor({ setting: on, remaining: 3, monthlySalary: 32000 });
    expect(conversionPreviewText(c)).toBe("If the year ended today: 3 unused days → ₱4,413.78 (paid on the Dec 16–31 payslip)");
    expect(read("src/lib/payroll/leave-conversion-server.js")).toMatch(/leaveConversionFor\(\{ setting, remaining: balance\.pool \? balance\.pool\.remaining/);
    expect(read("src/app/api/accountant/payroll/route.js")).toMatch(/leaveConversionFor\(\{ setting, remaining, monthlySalary: e\.basic_salary/);
  });
  it("statutory leaves are never converted: the pool holds Vacation, Sick and Emergency only", () => {
    expect(read("src/lib/employees/classification.js")).toMatch(/CREDIT_LEAVE_TYPES/);
  });
});
