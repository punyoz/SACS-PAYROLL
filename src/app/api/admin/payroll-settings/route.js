import { requirePermission } from "@/lib/rbac/guard";
import { addSettingsVersion, settingsView } from "@/lib/payroll/settings-versions-server";

/**
 * Semi-monthly payroll settings (Super Admin, System Configuration). The rules
 * live in src/lib/payroll/settings-versions-server.js, shared with HR's
 * /api/payroll/settings. The withholding tax table is read-only (fixed by law).
 */

export async function GET(request) {
  const guard = await requirePermission(request, "system_configuration", "read");
  if (guard.denied) return guard.denied;
  return settingsView(guard);
}

export async function POST(request) {
  const guard = await requirePermission(request, "system_configuration", "create");
  if (guard.denied) return guard.denied;
  return addSettingsVersion(request, guard);
}
