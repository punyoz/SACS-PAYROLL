import { requirePermission } from "@/lib/rbac/guard";
import { addSettingsVersion, settingsView } from "@/lib/payroll/settings-versions-server";

/**
 * HR's SSS salary credit table and per-employee contribution amounts
 * (decision 2026-11-09 #4). Both reading and writing need government_rates
 * "create" (HR, Super Admin): the screen lists every employee's amounts.
 * The withholding tax table is read-only here too.
 */

export async function GET(request) {
  const guard = await requirePermission(request, "government_rates", "create");
  if (guard.denied) return guard.denied;
  return settingsView(guard);
}

export async function POST(request) {
  const guard = await requirePermission(request, "government_rates", "create");
  if (guard.denied) return guard.denied;
  return addSettingsVersion(request, guard);
}
