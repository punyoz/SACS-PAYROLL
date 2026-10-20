"use client";

import * as React from "react";
import { BellRingIcon, CheckIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel } from "@/lib/portal/payroll-preview";

/*
 * Expiring licenses (HR dashboard; docs/payroll-schedule-loans-awol.md §6.6).
 * The daily job (teacher_license_daily, 00:30 Manila) opens one alert when a
 * license enters the warning window (Super Admin setting, default 60 days)
 * and one the day after it expires. HR acknowledges each. Hidden when there
 * is nothing to show or before 20261009010000.
 */
export function LicenseAlertsCard({ refreshKey, onNavigate }) {
  const { notify } = usePortalSession();
  const [data, setData] = React.useState(null);
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      setData(await fetchJson("/api/hr/teacher-license"));
    } catch {
      // A failed refresh keeps the alerts already shown (it used to hide them).
      setData((current) => current);
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function acknowledge(alert) {
    if (busy) return;
    setBusy(alert.id);
    try {
      await fetchJson("/api/hr/teacher-license", jsonBody("POST", { action: "acknowledge_alert", alert_id: alert.id }));
      await load();
      notify("Alert Acknowledged", `${alert.employee_name}'s license alert is cleared.`, "success");
    } catch (error) {
      notify("Not Updated", error.message, "error");
    } finally {
      setBusy("");
    }
  }

  const alerts = data?.alerts || [];
  if (!alerts.length) return null;

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BellRingIcon className="size-4" aria-hidden="true" />Expiring licenses</CardTitle>
        <CardDescription>Licensed teachers whose PRC license expires within {data.warning_days} days, or has expired. Update the expiry and verify again in User Management.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{alert.employee_name}</p>
                <p className="text-xs text-muted-foreground">License {alert.kind === "expired" ? "expired" : "expires"} {dateLabel(alert.license_expires_on)}</p>
              </div>
              <StatusBadge tone={alert.kind === "expired" ? "danger" : "gold"}>{alert.kind === "expired" ? "Expired" : "Expiring"}</StatusBadge>
              <Button size="sm" variant="ghost" onClick={() => onNavigate?.("hr-employees")}>Open</Button>
              <Button size="sm" variant="outline" onClick={() => acknowledge(alert)} disabled={Boolean(busy)}>{busy === alert.id ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}Acknowledge</Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
