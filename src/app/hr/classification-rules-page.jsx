"use client";

import * as React from "react";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { PAY_BASIS_LABELS } from "@/lib/employees/classification";

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
// Category × Status (no part-time employees, 2026-11-23).
const comboLabel = (r) => `${r.employee_type} · ${r.employment_status}`;
const pending = (note) => /pending policy manual/i.test(String(note || ""));
const SHORT = { "Vacation Leave": "Vacation", "Sick Leave": "Sick", "Emergency Leave": "Emergency", "Leave Credits": "Leave credits (days per year)" };
const WHO = { female: "Female employees", married_male: "Married male employees", any: "Any employee" };
const FLAGS = [["overtime_allowed", "Overtime"], ["subsidy_eligible", "Subsidies"], ["incentive_eligible", "Incentives"], ["loan_eligible", "Cash advances"]];

/**
 * HR → Settings → Status & leave rules (Part A, 20261121010000): leave
 * credits and pay rules per category × employment status × type, and the
 * reminder settings. Each save is a new version from a date; old versions
 * stay for the dates they covered.
 */
export function ClassificationRulesPage({ refreshKey }) {
  const { role, notify } = usePortalSession();
  const canEdit = ["hr", "super_admin"].includes(role);
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [leave, setLeave] = React.useState([]);
  const [pay, setPay] = React.useState([]);
  const [settings, setSettings] = React.useState({});
  const [loanMultiplier, setLoanMultiplier] = React.useState("");
  const [statutory, setStatutory] = React.useState([]);
  const [from, setFrom] = React.useState({ leave: today(), pay: today() });
  const [note, setNote] = React.useState({ leave: "", pay: "" });
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    setError("");
    try {
      const d = await fetchJson("/api/hr/classification-rules");
      setData(d);
      setLeave(d.leave.map((r) => ({ ...r, values: Object.fromEntries(d.leave_types.map((t) => [t, String(r.days[t]?.days ?? 0)])) })));
      setPay(d.pay.map((r) => ({ ...r, ...(r.rule || { pay_basis: "monthly", overtime_allowed: true, subsidy_eligible: true, incentive_eligible: true, loan_eligible: true }) })));
      setSettings(Object.fromEntries(Object.entries(d.settings).map(([k, v]) => [k, String(v.value)])));
      setLoanMultiplier(d.loan_limit ? String(d.loan_limit.multiplier) : "");
      setStatutory((d.statutory || []).map((t) => ({ ...t, days: String(Number(t.days)), max_events: t.max_events ? String(t.max_events) : "" })));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  async function save(kind, body) {
    setBusy(kind);
    setError("");
    try {
      const result = await fetchJson("/api/hr/classification-rules", jsonBody("POST", { kind, ...body }));
      notify?.(result.warnings?.length ? `Saved. ${result.warnings.length} combination${Number(result.warnings.length) === 1 ? "" : "s"} are below the 5-day service incentive leave.` : "Saved.");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const saveLeave = () => save("leave", {
    effective_from: from.leave, note: note.leave,
    rows: leave.flatMap((r) => data.leave_types.map((t) => ({ leave_type: t, employee_type: r.employee_type, employment_status: r.employment_status, employment_type: r.employment_type, days_per_year: Number(r.values[t]) }))),
  });
  const savePay = () => save("pay", {
    effective_from: from.pay, note: note.pay,
    rows: pay.map(({ employee_type, employment_status, employment_type, pay_basis, overtime_allowed, subsidy_eligible, incentive_eligible, loan_eligible }) =>
      ({ employee_type, employment_status, employment_type, pay_basis, overtime_allowed, subsidy_eligible, incentive_eligible, loan_eligible })),
  });

  if (!data) {
    return error
      ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" aria-hidden="true" />Loading…</p>;
  }

  const anyPending = data.leave.some((r) => Object.values(r.days).some((d) => pending(d?.note)));
  return (
    <div className="space-y-6">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {data.warnings.length ? (
        <Alert>
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Below the legal minimum</AlertTitle>
          <AlertDescription>
            The Labor Code (Art. 95) gives 5 days of service incentive leave a year after one year of service. These combinations give fewer paid days
            (vacation + sick + emergency): {data.warnings.map((w) => `${comboLabel(w)} (${w.total})`).join("; ")}.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Leave credits</CardTitle>
          <CardDescription>
            One total a year per category and status, shared by vacation, sick and emergency leave (half a day uses 0.5).
            From the 1-year service anniversary the Regular total applies, pro-rated for the rest of the year. New hires get a share from their hire date.
            Granted automatically every January 1. Statutory leaves (below) never use it.{anyPending ? " Defaults are pending the policy manual." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">Leave credits per category, employment status and type</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Category · status · type</th>
                  {data.leave_types.map((t) => <th key={t} scope="col" className="px-2 py-2 font-medium">{SHORT[t]}</th>)}
                </tr>
              </thead>
              <tbody>
                {leave.map((r, i) => (
                  <tr key={comboLabel(r)} className="border-b last:border-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap">
                      {comboLabel(r)}
                      {data.leave_types.some((t) => pending(r.days[t]?.note)) ? <StatusBadge tone="gold" className="ml-2" dot={false}>Pending policy manual</StatusBadge> : null}
                    </th>
                    {data.leave_types.map((t) => (
                      <td key={t} className="px-2 py-1.5">
                        <Input aria-label={`${comboLabel(r)}: ${t} days per year`} inputMode="decimal" className="h-8 w-20 tabular-nums" disabled={!canEdit}
                          value={r.values[t]} onChange={(e) => setLeave((rows) => rows.map((x, j) => (j === i ? { ...x, values: { ...x.values, [t]: e.target.value } } : x)))} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5"><Label htmlFor="leave-from">Applies from</Label><DatePicker id="leave-from" value={from.leave} onChange={(v) => setFrom((f) => ({ ...f, leave: v }))} /></div>
              <div className="min-w-60 flex-1 space-y-1.5"><Label htmlFor="leave-note">Note</Label><Input id="leave-note" maxLength={500} placeholder="e.g. Policy manual 2027, section 4" value={note.leave} onChange={(e) => setNote((n) => ({ ...n, leave: e.target.value }))} /></div>
              <Button onClick={saveLeave} disabled={Boolean(busy)}>{busy === "leave" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save leave credits</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Statutory leave</CardTitle>
          <CardDescription>Filed per event (or per year) when the employee is eligible, not granted every January 1. HR approves them like other leave.</CardDescription>
          {canEdit ? (
            <CardAction>
              <Button onClick={() => save("statutory", { rows: statutory.map(({ leave_type, enabled, days, max_events }) => ({ leave_type, enabled, days: Number(days), max_events })) })} disabled={Boolean(busy)}>
                {busy === "statutory" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border text-sm">
            {statutory.map((t, i) => {
              const setRow = (patch) => setStatutory((rows) => rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <li key={t.leave_type} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                  <div>
                    <p className="font-medium">{t.leave_type}</p>
                    <p className="text-xs text-muted-foreground">{WHO[t.eligibility]} · {t.basis === "year" ? "per year" : "per event"}. {t.note}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`stat-days-${i}`} className="text-xs">Days</Label>
                    <Input id={`stat-days-${i}`} inputMode="decimal" className="h-8 w-20 tabular-nums" disabled={!canEdit} value={t.days} onChange={(e) => setRow({ days: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`stat-max-${i}`} className="text-xs">Times</Label>
                    <Input id={`stat-max-${i}`} inputMode="numeric" placeholder="any" className="h-8 w-16 tabular-nums" disabled={!canEdit} value={t.max_events} onChange={(e) => setRow({ max_events: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id={`stat-on-${i}`} checked={t.enabled} disabled={!canEdit} onCheckedChange={(v) => setRow({ enabled: v === true })} />
                    <Label htmlFor={`stat-on-${i}`} className="text-xs">Offered</Label>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Pay rules</CardTitle>
          <CardDescription>How each combination is paid and what it may receive. Government contributions, withholding tax and the 13th month apply to everyone by law.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Pay rules per category, employment status and type</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Category · status · type</th>
                  <th scope="col" className="px-2 py-2 font-medium">Pay basis</th>
                  {FLAGS.map(([k, l]) => <th key={k} scope="col" className="px-2 py-2 font-medium">{l}</th>)}
                </tr>
              </thead>
              <tbody>
                {pay.map((r, i) => {
                  const setRow = (patch) => setPay((rows) => rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <tr key={comboLabel(r)} className="border-b last:border-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap">{comboLabel(r)}</th>
                      <td className="px-2 py-1.5">
                        <span className="text-muted-foreground">{PAY_BASIS_LABELS.monthly}</span>
                      </td>
                      {FLAGS.map(([k, l]) => (
                        <td key={k} className="px-2 py-1.5">
                          <Checkbox aria-label={`${comboLabel(r)}: ${l}`} checked={r[k] !== false} disabled={!canEdit} onCheckedChange={(v) => setRow({ [k]: v === true })} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5"><Label htmlFor="pay-from">Applies from</Label><DatePicker id="pay-from" value={from.pay} onChange={(v) => setFrom((f) => ({ ...f, pay: v }))} /></div>
              <div className="min-w-60 flex-1 space-y-1.5"><Label htmlFor="pay-note">Note</Label><Input id="pay-note" maxLength={500} value={note.pay} onChange={(e) => setNote((n) => ({ ...n, pay: e.target.value }))} /></div>
              <Button onClick={savePay} disabled={Boolean(busy)}>{busy === "pay" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save pay rules</Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">Payroll pays a monthly salary only for now: an employee on an hourly or per-scheduled-hour basis is held back from processing with a message.</p>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>Reminders and hours</CardTitle>
          <CardDescription>HR is reminded before a probation ends and before a contract ends. Pending the policy manual.</CardDescription>
          {canEdit ? (
            <CardAction>
              <Button onClick={() => save("settings", { values: settings })} disabled={Boolean(busy)}>{busy === "settings" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {Object.entries(data.settings).map(([key, def]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`hr-set-${key}`}>{def.label}</Label>
              <Input id={`hr-set-${key}`} inputMode="numeric" className="w-28 tabular-nums" disabled={!canEdit} value={settings[key] ?? ""}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))} />
            </div>
          ))}
        </CardContent>
      </Card>

      {data.loan_limit ? (
        <Card className="min-w-0 shadow-xs" data-testid="loan-limit-settings">
          <CardHeader>
            <CardTitle>Cash advance limit <StatusBadge tone="gold" className="ml-2" dot={false}>Pending policy manual</StatusBadge></CardTitle>
            <CardDescription>
              An employee cannot owe more on cash advances than this. Counted: the amount still owed on every unpaid cash advance (pending, approved or suspended; interest not counted) plus the new one.
              The ₱50,000 cash advance cap stays. SSS and Pag-IBIG loans are never limited. Checked when a cash advance is filed, increased and approved; those already given are not changed.
            </CardDescription>
            {canEdit ? (
              <CardAction>
                <Button onClick={() => save("loan_limit", { multiplier: loanMultiplier })} disabled={Boolean(busy)}>{busy === "loan_limit" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save</Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Based on</Label>
              <p className="text-sm">{data.loan_limit.basis_label}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hr-set-loan-limit">Limit (months of that salary)</Label>
              <Input id="hr-set-loan-limit" inputMode="decimal" className="w-28 tabular-nums" disabled={!canEdit} value={loanMultiplier}
                onChange={(e) => setLoanMultiplier(e.target.value)} />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
