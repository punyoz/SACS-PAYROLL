import { requirePermission } from "@/lib/rbac/guard";
import { addRateVersion, rateVersionsView } from "@/lib/payroll/rate-versions-server";

/**
 * Effective-dated payroll rates (Super Admin, System Configuration). The
 * rules live in src/lib/payroll/rate-versions-server.js, shared with HR's
 * /api/payroll/rates.
 */

export async function GET(request) {
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;
  return rateVersionsView(guard);
}

export async function POST(request) {
  const guard = await requirePermission(request, "system_configuration", "create");
  if (guard.denied) return guard.denied;
  return addRateVersion(request, guard);
}
