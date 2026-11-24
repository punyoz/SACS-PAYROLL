import { fetchAllIn } from "@/lib/supabase/fetch-all";

/**
 * The Accountant's own Additional Pay types (2026-11-26, 20261126040000). Shared by the route
 * (src/app/api/accountant/pay-types) and the item filing in the payroll route.
 */

/** Why a type's fields are refused, or null. */
export function payTypeProblem({ name, description }) {
  if (String(name || "").trim().length < 2) return "Name the pay type (at least 2 characters).";
  if (String(name).trim().length > 60) return "The name can be at most 60 characters.";
  if (String(description || "").length > 300) return "The description can be at most 300 characters.";
  return null;
}

/** The Additional Pay kinds offered for NEW items (2026-11-26: Adjustment is no longer offered; old ones stay). */
export const NEW_ITEM_KINDS = Object.freeze(["incentive", "overload", "honorarium", "bonus", "custom"]);

/**
 * Items (payroll_monthly_incentives rows) with their type's name as pay_type_name ("custom" kind only);
 * never fails (no table yet: the rows come back unchanged).
 */
export async function withPayTypeNames(supabase, rows) {
  const ids = [...new Set((rows || []).filter((r) => r?.kind === "custom" && r.pay_type_id).map((r) => r.pay_type_id))];
  if (!ids.length) return rows || [];
  const { data } = await fetchAllIn(() => supabase.from("additional_pay_types").select("id,name").order("id", { ascending: true }), "id", ids);
  const names = new Map((data || []).map((t) => [t.id, t.name]));
  return rows.map((r) => (r?.kind === "custom" ? { ...r, pay_type_name: names.get(r.pay_type_id) || "Additional pay" } : r));
}

/** An item's type in words: "Honorarium", "Bonus", a custom type's own name, … */
export function itemKindLabel(item) {
  if (item?.kind === "custom") return item.pay_type_name || "Additional pay";
  return { incentive: "Incentive", overload: "Overload", honorarium: "Honorarium", bonus: "Bonus", adjustment: "Adjustment" }[item?.kind] || "Incentive";
}
