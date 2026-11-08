import { requirePermission } from "@/lib/rbac/guard";
import { addRateVersion, rateVersionsView } from "@/lib/payroll/rate-versions-server";

/**
 * HR's government rates and daily rate (alpha test Part E). Reading needs
 * government_rates "read"; adding a version needs government_rates "create",
 * and addRateVersion checks each rate type again: the daily rate needs
 * pay_rates "create", other payroll rules stay the Super Admin's (System
 * Configuration), the hourly rate is never typed (daily / 8). It also refuses
 * a date before the next pay period, a missing reason and a change of one's
 * own rate. The withholding tax table (fixed by law) has no write route here.
 */

export async function GET(request) {
  const guard = await requirePermission(request, "government_rates", "read");
  if (guard.denied) return guard.denied;
  return rateVersionsView(guard);
}

export async function POST(request) {
  const guard = await requirePermission(request, "government_rates", "create");
  if (guard.denied) return guard.denied;
  return addRateVersion(request, guard);
}
