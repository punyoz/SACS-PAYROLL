import { conversionPreviewText, leaveConversionFor, loadLeaveConversion } from "@/lib/payroll/leave-conversion";

/**
 * "If the year ended today: …" for one employee (2026-11-26): the pool's unused days × the daily rate of
 * today's salary, by the same function the Dec 16–31 payslip uses. null when it cannot be read.
 */
export async function conversionPreviewFor(supabase, employeeId, balance) {
  if (!balance) return null;
  try {
    const [setting, { data: person }] = await Promise.all([loadLeaveConversion(supabase),
      supabase.from("profiles").select("basic_salary,employment_status").eq("id", employeeId).maybeSingle()]);
    const c = leaveConversionFor({ setting, remaining: balance.pool ? balance.pool.remaining : balance.with_pay_remaining, monthlySalary: person?.basic_salary, status: person?.employment_status });
    return { ...c, text: conversionPreviewText(c) };
  } catch {
    return null;
  }
}
