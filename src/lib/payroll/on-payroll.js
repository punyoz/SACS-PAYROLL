/**
 * "Not on payroll" system accounts (20261120020000): they sign in and work in
 * the app but get no attendance, no payslip and are left out of employee lists.
 * The account metadata carries the flag (set with profiles.on_payroll).
 */
export const isOnPayroll = (user) => user?.user_metadata?.on_payroll !== false;
