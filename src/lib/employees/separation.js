/**
 * Separating an employee who resigns, finishes a contract, retires, is
 * terminated or dies (scenarios EM-08 / HR-03, 2026-10-22). Before this only
 * an AWOL case could separate someone, so no one else ever reached Final Pay;
 * they could only be archived. The effect is the AWOL decision's
 * (src/lib/awol/cases.js setEmployeeStatus): status Separated with the date
 * and reason, pay held (profiles_payroll_hold_sync) and settled only through
 * Final Pay, taps refused. Their active RFID card is deactivated. The account
 * stays open so they can see their final payslip; HR archives it afterwards.
 */
import { normalizeText } from "@/lib/auth/normalize";
import { setEmployeeStatus } from "@/lib/awol/cases";
import { SEPARATION_REASONS, validateSeparation } from "@/lib/employees/separation-rules";

export { SEPARATION_REASONS, validateSeparation };

/**
 * Separate one employee. Returns null, or the error text. `guard` is the
 * route's (HR) guard, the actor of every change.
 */
export async function separateEmployee(supabase, { employee, effective, reason, note, guard }) {
  const text = [reason, normalizeText(note)].filter(Boolean).join(" — ");
  const error = await setEmployeeStatus(supabase, {
    employeeId: employee.id,
    status: "Separated",
    effectiveOn: effective,
    actor: guard,
    reason: `Separated (${text})`,
    extra: { separated_on: effective, separation_reason: reason },
  });
  if (error) return error;

  // The card stops recording attendance (it can be reactivated on a re-hire).
  const cards = await supabase.from("rfid_cards").select("id").eq("employee_id", employee.id).eq("status", "active");
  for (const card of cards.data || []) {
    await supabase.rpc("rfid_card_set_status", { p_actor: guard.userId, p_card: card.id, p_action: "deactivate", p_reason: `Separated: ${reason}` });
  }
  return null;
}
