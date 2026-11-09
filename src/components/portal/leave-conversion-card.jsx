"use client";

import * as React from "react";
import { Loader2Icon, PalmtreeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";

/**
 * Unused leave conversion in final pay (decision 2026-11-09 #1): off until
 * the school confirms its rule. HR and the Super Admin switch it, with a
 * reason; the change is audited and the Super Admin is told.
 */
export function LeaveConversionCard() {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, setting: null, canEdit: false });
  const [form, setForm] = React.useState({ enabled: false, max_days: "", reason: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/payroll/leave-conversion");
      setState({ loading: false, setting: data.setting, canEdit: data.can_edit });
      setForm({ enabled: data.setting.enabled, max_days: data.setting.max_days ? String(data.setting.max_days) : "", reason: "" });
    } catch (e) {
      setState((c) => ({ ...c, loading: false }));
      setError(e.message || "Unable to load the setting.");
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.reason.trim()) { setError("Give a reason for the change."); return; }
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/payroll/leave-conversion", jsonBody("PATCH", { enabled: form.enabled, max_days: form.max_days === "" ? null : Number(form.max_days), reason: form.reason.trim() }));
      notify("Setting saved", `Unused leave conversion is ${form.enabled ? "on" : "off"}.`, "success");
      await load();
    } catch (e) {
      setError(e.message || "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="min-w-0 shadow-xs" data-testid="leave-conversion-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PalmtreeIcon className="size-4 text-gold-text" aria-hidden="true" />Final pay: unused leave conversion</CardTitle>
        <CardDescription>
          Off until the school confirms its rule. When on, a separated employee&apos;s unused leave with pay this year is paid in final pay at the daily rate,
          as its own line, up to the maximum days set. Withholding tax on it is not computed yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[auto_10rem_minmax(0,1fr)_auto] sm:items-end">
        <div className="flex items-center gap-2">
          <Switch id="lc-enabled" checked={form.enabled} onCheckedChange={(v) => setForm((c) => ({ ...c, enabled: v }))} disabled={!state.canEdit || state.loading} />
          <Label htmlFor="lc-enabled">{form.enabled ? "On" : "Off"}</Label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lc-max">Maximum days</Label>
          <Input id="lc-max" type="number" inputMode="numeric" min={1} max={365} placeholder="No limit" value={form.max_days}
            onChange={(e) => setForm((c) => ({ ...c, max_days: e.target.value }))} disabled={!state.canEdit || !form.enabled} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lc-reason">Reason <span className="text-destructive" aria-hidden="true">*</span></Label>
          <Input id="lc-reason" maxLength={300} placeholder="e.g. Board resolution 2027-03" value={form.reason}
            onChange={(e) => { setForm((c) => ({ ...c, reason: e.target.value })); setError(""); }} disabled={!state.canEdit} />
        </div>
        <Button onClick={save} disabled={!state.canEdit || busy || state.loading}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
        {error ? <p role="alert" className="text-sm text-destructive sm:col-span-4">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
