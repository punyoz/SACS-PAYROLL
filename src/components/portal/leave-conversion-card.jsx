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
import { Checkbox } from "@/components/ui/checkbox";
import { EMPLOYMENT_STATUS_OPTIONS } from "@/lib/employees/classification";
import { LEAVE_CONVERSION_NOTE } from "@/lib/payroll/leave-conversion";

/**
 * Unused leave conversion in final pay (decision 2026-11-09 #1): off until
 * the school confirms its rule. HR and the Super Admin switch it, with a
 * reason; the change is audited and the Super Admin is told.
 */
export function LeaveConversionCard() {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, setting: null, canEdit: false });
  const [form, setForm] = React.useState({ enabled: false, max_days: "", tax_free_days: "10", statuses: [], reason: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const data = await fetchJson("/api/payroll/leave-conversion");
      setState({ loading: false, setting: data.setting, canEdit: data.can_edit });
      setForm({ enabled: data.setting.enabled, max_days: data.setting.max_days ? String(data.setting.max_days) : "", tax_free_days: String(data.setting.tax_free_days ?? 10), statuses: data.setting.statuses || [], reason: "" });
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
      await fetchJson("/api/payroll/leave-conversion", jsonBody("PATCH", { enabled: form.enabled, max_days: form.max_days === "" ? null : Number(form.max_days), tax_free_days: form.tax_free_days === "" ? 10 : Number(form.tax_free_days), statuses: form.statuses, reason: form.reason.trim() }));
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
        <CardTitle className="flex items-center gap-2"><PalmtreeIcon className="size-4 text-gold-text" aria-hidden="true" />Leave conversion</CardTitle>
        <CardDescription>
          Unused days of the leave-credit pool are paid at the daily rate (monthly × 12 ÷ 261): on the Dec 16–31 payslip, and in final pay on separation.
          Statutory leaves are never converted. {LEAVE_CONVERSION_NOTE}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[auto_10rem_10rem_minmax(0,1fr)_auto] sm:items-end">
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
          <Label htmlFor="lc-free">Tax-free days a year</Label>
          <Input id="lc-free" type="number" inputMode="numeric" min={0} max={30} value={form.tax_free_days}
            onChange={(e) => setForm((c) => ({ ...c, tax_free_days: e.target.value }))} disabled={!state.canEdit || !form.enabled} />
        </div>
        <fieldset className="space-y-1.5 sm:col-span-5" disabled={!state.canEdit || !form.enabled}>
          <legend className="text-sm font-medium">Statuses converted <span className="font-normal text-muted-foreground">(none ticked = everyone on payroll)</span></legend>
          <div className="flex flex-wrap gap-4">
            {EMPLOYMENT_STATUS_OPTIONS.map((o) => (
              <Label key={o} className="flex items-center gap-2 font-normal">
                <Checkbox checked={form.statuses.includes(o)} onCheckedChange={(v) => setForm((c) => ({ ...c, statuses: v ? [...c.statuses, o] : c.statuses.filter((x) => x !== o) }))} />{o}
              </Label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="lc-reason">Reason <span className="text-destructive" aria-hidden="true">*</span></Label>
          <Input id="lc-reason" maxLength={300} placeholder="e.g. Board resolution 2027-03" value={form.reason}
            onChange={(e) => { setForm((c) => ({ ...c, reason: e.target.value })); setError(""); }} disabled={!state.canEdit} />
        </div>
        <Button onClick={save} disabled={!state.canEdit || busy || state.loading}>{busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
        {error ? <p role="alert" className="text-sm text-destructive sm:col-span-5">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
