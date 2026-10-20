"use client";

import * as React from "react";
import { CalendarRangeIcon, Loader2Icon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { StatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { dateLabel, money } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Tenure Pay Protection (/api/hr/tenure-protection; src/lib/payroll/tenure-protection.js).
 * Employees with the minimum tenure whose contract says so are not deducted
 * for the categories the policy covers -- but only once HR GRANTS it to them.
 * HR and the Super Admin set the system-wide policy and the break dates and
 * grant for every branch; an Admin grants for, and sets the policy of, its
 * own branch. The server refuses everything else whatever this screen shows.
 */

const ALL = "__all__";
const API = "/api/hr/tenure-protection";

const years = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n} ${n === 1 ? "yr" : "yrs"}`;
};

function coveredLabel(policy, categories) {
  const list = (categories || []).filter((c) => policy?.categories?.[c.key]).map((c) => c.label);
  return list.length ? list.join(", ") : "Nothing covered";
}

function PolicyFields({ idPrefix, value, onChange, categories, disabled }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-years`}>Minimum tenure (years)</Label>
          <Input id={`${idPrefix}-years`} type="number" min="0" max="50" step="0.5" inputMode="decimal" className="tabular-nums"
            value={value.min_tenure_years} disabled={disabled} onChange={(e) => onChange({ ...value, min_tenure_years: e.target.value })} />
          <p className="text-xs text-muted-foreground">Counted from the hire date. Meeting it does not grant the benefit by itself.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-active`}>Policy active</Label>
          <div className="flex h-9 items-center gap-2">
            <Switch id={`${idPrefix}-active`} checked={value.is_active} disabled={disabled} onCheckedChange={(v) => onChange({ ...value, is_active: v === true })} />
            <span className="text-sm text-muted-foreground">{value.is_active ? "Yes: payroll applies granted protection" : "No: nobody is protected"}</span>
          </div>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Not deducted for</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {categories.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={Boolean(value.categories[c.key])} disabled={disabled}
                onCheckedChange={(v) => onChange({ ...value, categories: { ...value.categories, [c.key]: v === true } })} />
              {c.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">A day inside a break, on a holiday or under a suspension is judged only by that day&apos;s box: with Summer break unchecked, summer days stay unpaid even when Absence is checked.</p>
      </fieldset>
    </div>
  );
}

const policyForm = (policy) => ({
  min_tenure_years: String(policy?.min_tenure_years ?? 2),
  is_active: policy?.is_active !== false,
  categories: { ...(policy?.categories || {}) },
});

export function TenureProtectionPanel({ refreshKey }) {
  const { notify } = usePortalSession();
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [systemForm, setSystemForm] = React.useState(policyForm(null));
  const [schoolYear, setSchoolYear] = React.useState("");
  const [breakForms, setBreakForms] = React.useState({});
  const [tab, setTab] = React.useState("meets");
  const [branchFilter, setBranchFilter] = React.useState(ALL);
  const [dialog, setDialog] = React.useState(null);
  const [input, setInput] = React.useState({});
  const [dialogError, setDialogError] = React.useState("");
  const [feedback, setFeedback] = React.useState({ text: "", ok: false, where: "" });
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(API);
      if (!data.available) throw new Error(data.error || "Tenure Pay Protection is not set up yet.");
      setState({ loading: false, error: null, data });
      setSystemForm(policyForm(data.policy?.system));
      setSchoolYear((current) => current || data.school_year);
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message, data: c.data }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const categories = data?.categories || [];
  const canEdit = Boolean(data?.can_edit);
  const canEditSystem = Boolean(data?.can_edit_system);
  const today = data?.today || "";

  // The break forms follow the chosen school year.
  React.useEffect(() => {
    if (!data || !schoolYear) return;
    const forms = {};
    (data.break_kinds || []).forEach((k) => {
      const row = (data.breaks || []).find((b) => b.school_year === schoolYear && b.kind === k.key && !b.archived);
      forms[k.key] = { start_date: row?.start_date || "", end_date: row?.end_date || "", note: row?.note || "", saved: row || null };
    });
    setBreakForms(forms);
  }, [data, schoolYear]);

  async function post(body, done, where) {
    setBusy(where);
    setFeedback({ text: "", ok: false, where });
    try {
      const result = await fetchJson(API, jsonBody("POST", body));
      notify("Tenure Pay Protection", result.warning || done, result.warning ? "info" : "success");
      setFeedback({ text: result.warning || done, ok: true, where });
      setDialog(null);
      await load();
      return true;
    } catch (error) {
      if (where === "dialog") setDialogError(error.message);
      else setFeedback({ text: error.message, ok: false, where });
      return false;
    } finally {
      setBusy("");
    }
  }

  const policyBody = (form) => ({
    min_tenure_years: form.min_tenure_years === "" ? "" : Number(form.min_tenure_years),
    is_active: form.is_active,
    categories: form.categories,
  });

  const open = (kind, values = {}) => {
    setDialogError("");
    setInput({ notes: "", ...values });
    setDialog({ kind });
  };

  function submitDialog() {
    if (dialog?.kind === "grant") {
      post({ action: "grant", employee_id: input.employee.id, effective_from: input.date, notes: input.notes },
        `Granted to ${input.employee.full_name} from ${dateLabel(input.date)}.`, "dialog");
    } else if (dialog?.kind === "revoke") {
      post({ action: "revoke", grant_id: input.employee.grant.id, revoked_on: input.date, notes: input.notes },
        `${input.employee.full_name}: protection ends ${dateLabel(input.date)}. Earlier payroll keeps it.`, "dialog");
    } else if (dialog?.kind === "branch") {
      post({ action: "save_policy", branch_id: input.branch.branch_id, ...policyBody(input.form) },
        `${input.branch.branch_name} policy saved.`, "dialog");
    }
  }

  const employees = React.useMemo(() => {
    const rows = data?.employees || [];
    const byBranch = branchFilter === ALL ? rows : rows.filter((r) => String(r.branch_id) === branchFilter);
    if (tab === "meets") return byBranch.filter((r) => r.meets_tenure);
    if (tab === "granted") return byBranch.filter((r) => r.grant);
    return byBranch;
  }, [data, tab, branchFilter]);
  const counts = React.useMemo(() => {
    const rows = (data?.employees || []).filter((r) => branchFilter === ALL || String(r.branch_id) === branchFilter);
    return { meets: rows.filter((r) => r.meets_tenure).length, granted: rows.filter((r) => r.grant).length, all: rows.length };
  }, [data, branchFilter]);

  function statusOf(r) {
    if (r.protected_today) return <StatusBadge tone="success">Protected</StatusBadge>;
    if (r.grant && r.grant.effective_from > today) return <StatusBadge tone="info">Granted from {dateLabel(r.grant.effective_from)}</StatusBadge>;
    if (r.grant && !r.policy_active) return <StatusBadge tone="warning">Granted · policy off</StatusBadge>;
    if (r.grant && !r.meets_tenure) return <StatusBadge tone="warning">Granted · below tenure</StatusBadge>;
    if (r.meets_tenure) return <StatusBadge tone="gold">Eligible · not granted</StatusBadge>;
    return <StatusBadge tone="muted">Not eligible</StatusBadge>;
  }

  const columns = [
    { key: "full_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.full_name} ${r.employee_code || ""}`,
      cell: (r) => <span>{r.full_name}<span className="block text-xs text-muted-foreground">{r.employee_code || ""}{r.position ? ` · ${r.position}` : ""}</span></span> },
    { key: "branch_name", header: "Branch", sortable: true, cell: (r) => r.branch_name || "—" },
    { key: "date_hired", header: "Hired", sortable: true, cell: (r) => (r.date_hired ? dateLabel(r.date_hired) : <span className="text-muted-foreground">No hire date</span>) },
    { key: "tenure_years", header: "Tenure", sortable: true, className: "tabular-nums", cell: (r) => (r.tenure_years === null ? "—" : years(r.tenure_years)) },
    { key: "eligible_from", header: "Meets tenure", sortable: true,
      cell: (r) => (r.meets_tenure
        ? <span className="text-success">Yes</span>
        : <span className="text-muted-foreground">{r.eligible_from ? `From ${dateLabel(r.eligible_from)}` : "—"}</span>) },
    { key: "status", header: "Benefit", sortValue: (r) => (r.protected_today ? 0 : r.grant ? 1 : r.meets_tenure ? 2 : 3),
      cell: (r) => (
        <div className="space-y-0.5">
          {statusOf(r)}
          {r.grant ? <p className="text-xs text-muted-foreground">By {r.grant.granted_by_name || "—"}{r.grant.notes ? ` · ${r.grant.notes}` : ""}</p> : null}
        </div>
      ) },
    ...(canEdit ? [{
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (r) => (r.grant
        ? <Button variant="outline" size="sm" onClick={() => open("revoke", { employee: r, date: today })}>Revoke</Button>
        : <Button size="sm" disabled={!r.meets_tenure && !r.eligible_from} onClick={() => open("grant", { employee: r, date: r.meets_tenure || !r.eligible_from || r.eligible_from < today ? today : r.eligible_from })}>Grant</Button>),
    }] : []),
  ];

  const grantColumns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium" },
    { key: "effective_from", header: "Protected", sortable: true,
      cell: (g) => <span className="whitespace-nowrap">{dateLabel(g.effective_from)} – {g.revoked_on ? dateLabel(g.revoked_on) : "ongoing"}</span> },
    { key: "granted_by_name", header: "Granted by", sortable: true,
      cell: (g) => <span>{g.granted_by_name || "—"}<span className="block text-xs text-muted-foreground">{g.notes || ""}</span></span> },
    { key: "revoked_by_name", header: "Revoked by", cell: (g) => (g.revoked_on ? <span>{g.revoked_by_name || "—"}<span className="block text-xs text-muted-foreground">{g.revoke_notes || ""}</span></span> : "—") },
    { key: "applied", header: "Applied to payroll", sortValue: (g) => g.applied.total,
      cell: (g) => (g.applied.count
        ? <span className="tabular-nums">{money(g.applied.total)} not deducted<span className="block text-xs text-muted-foreground">{g.applied.count} item{g.applied.count === 1 ? "" : "s"} · {g.applied.pay_periods.join(", ")}</span></span>
        : <span className="text-muted-foreground">Not yet</span>) },
  ];

  const feedbackFor = (where) => (feedback.where === where && feedback.text
    ? <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
    : null);

  return (
    <div className="flex flex-col gap-4">
      {state.error ? <Alert className="border-warning/40 bg-warning/5"><AlertDescription>{state.error}</AlertDescription></Alert> : null}

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Tenure Pay Protection policy</CardTitle>
          <CardDescription>
            For employees whose contract says their pay is not deducted. Payroll applies it only to employees granted it below, while they meet the tenure,
            for the boxes checked here. {canEditSystem ? "" : "The system-wide policy is set by HR or the Super Admin."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium">System-wide (all branches)</p>
            <PolicyFields idPrefix="tp-system" value={systemForm} onChange={setSystemForm} categories={categories} disabled={!canEditSystem || state.loading} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">By branch</p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>Branch</TableHead><TableHead>Policy</TableHead><TableHead>Minimum tenure</TableHead><TableHead>Not deducted for</TableHead>{canEdit ? <TableHead className="text-right">Actions</TableHead> : null}</TableRow></TableHeader>
                <TableBody>
                  {(data?.policy?.branches || []).length ? data.policy.branches.map((b) => (
                    <TableRow key={b.branch_id}>
                      <TableCell className="font-medium">{b.branch_name}</TableCell>
                      <TableCell>
                        {b.has_own ? <StatusBadge tone="gold">Own policy</StatusBadge> : <StatusBadge tone="muted">System-wide</StatusBadge>}
                        {!b.effective.is_active ? <StatusBadge tone="warning" className="ml-1.5">Off</StatusBadge> : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{years(b.effective.min_tenure_years)}</TableCell>
                      <TableCell className="max-w-72 text-sm text-muted-foreground">{coveredLabel(b.effective, categories)}</TableCell>
                      {canEdit ? (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => open("branch", { branch: b, form: policyForm(b.has_own ? b.own : b.effective) })}>{b.has_own ? "Edit" : "Customize"}</Button>
                            {b.has_own ? (
                              <Button variant="ghost" size="sm" disabled={busy === "branch-reset"}
                                onClick={() => post({ action: "save_policy", branch_id: b.branch_id, use_global: true }, `${b.branch_name} follows the system-wide policy again.`, "branch-reset")}>
                                Use system-wide
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )) : (
                    <TableRow><TableCell colSpan={canEdit ? 5 : 4} className="text-muted-foreground">{state.loading ? "Loading…" : "No branches."}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {feedbackFor("branch-reset")}
          </div>
        </CardContent>
        {canEditSystem ? (
          <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button disabled={busy === "system" || state.loading}
              onClick={() => post({ action: "save_policy", branch_id: null, ...policyBody(systemForm) }, "System-wide policy saved.", "system")}>
              {busy === "system" ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save system-wide policy"}
            </Button>
            {feedbackFor("system")}
          </CardFooter>
        ) : null}
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarRangeIcon className="size-4 text-gold-text" aria-hidden="true" />Summer and Christmas break</CardTitle>
          <CardDescription>
            The dates of each break for a school year. Days inside a break are paid only for protected employees whose policy covers that break;
            everyone else is not paid for them, as before. Payslips not yet final pick up changed dates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="tp-school-year">School year</Label>
            <Select value={schoolYear} onValueChange={setSchoolYear}>
              <SelectTrigger id="tp-school-year" className="w-full"><SelectValue placeholder="School year" /></SelectTrigger>
              <SelectContent>{(data?.school_years || []).map((y) => <SelectItem key={y} value={y}>SY {y}{y === data?.school_year ? " (current)" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(data?.break_kinds || []).map((k) => {
              const form = breakForms[k.key] || { start_date: "", end_date: "", note: "", saved: null };
              const set = (patch) => setBreakForms((c) => ({ ...c, [k.key]: { ...form, ...patch } }));
              const where = `break-${k.key}`;
              return (
                <div key={k.key} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{k.label}</p>
                    {form.saved ? <StatusBadge tone="success">Set</StatusBadge> : <StatusBadge tone="muted">Not set</StatusBadge>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${where}-start`}>First day</Label>
                      <DatePicker id={`${where}-start`} value={form.start_date} disabled={!canEditSystem} onChange={(v) => set({ start_date: v })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${where}-end`}>Last day</Label>
                      <DatePicker id={`${where}-end`} value={form.end_date} disabled={!canEditSystem} min={form.start_date || undefined} onChange={(v) => set({ end_date: v })} />
                    </div>
                  </div>
                  {form.saved?.updated_by_name ? <p className="text-xs text-muted-foreground">Last set by {form.saved.updated_by_name}</p> : null}
                  {canEditSystem ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={busy === where || !form.start_date || !form.end_date}
                        onClick={() => post({ action: "save_break", school_year: schoolYear, kind: k.key, start_date: form.start_date, end_date: form.end_date, note: form.note },
                          `${k.label} SY ${schoolYear} saved.`, where)}>
                        {busy === where ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}Save
                      </Button>
                      {form.saved ? (
                        <Button size="sm" variant="ghost" disabled={busy === where}
                          onClick={() => post({ action: "archive_break", school_year: schoolYear, kind: k.key }, `${k.label} SY ${schoolYear} removed.`, where)}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {feedbackFor(where)}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UsersIcon className="size-4 text-gold-text" aria-hidden="true" />Employees</CardTitle>
          <CardDescription>
            Who meets the tenure requirement, and who has the benefit granted. Meeting the tenure does not protect anyone by itself:
            grant it only where the signed contract says so. Revoking ends protection from a date; payroll before it keeps it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Tabs value={tab} onValueChange={setTab} className="min-w-0 max-w-full">
              <div className="-mx-1 overflow-x-auto px-1 pb-1">
                <TabsList className="w-max">
                  <TabsTrigger value="meets">Meets tenure ({counts.meets})</TabsTrigger>
                  <TabsTrigger value="granted">Benefit granted ({counts.granted})</TabsTrigger>
                  <TabsTrigger value="all">All employees ({counts.all})</TabsTrigger>
                </TabsList>
              </div>
            </Tabs>
            {(data?.branches || []).length > 1 ? (
              <div className="w-full space-y-1.5 sm:w-56">
                <Label htmlFor="tp-branch">Branch</Label>
                <Select value={branchFilter} onValueChange={setBranchFilter}>
                  <SelectTrigger id="tp-branch" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All branches</SelectItem>
                    {data.branches.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DataTable columns={columns} rows={employees} loading={state.loading && !data} pageSize={15}
            searchPlaceholder="Search employee or ID…" caption="Employees and Tenure Pay Protection" minWidth={canEdit ? 900 : 800}
            empty={{ title: tab === "granted" ? "Nobody has the benefit granted" : tab === "meets" ? "Nobody meets the tenure requirement yet" : "No employees" }} />
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Grant history</CardTitle>
          <CardDescription>Every grant and revocation, and what each grant kept from being deducted on payslips.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={grantColumns} rows={data?.grants || []} loading={state.loading && !data} pageSize={10}
            searchPlaceholder="Search employee…" caption="Tenure Pay Protection grants" minWidth={760} empty={{ title: "No grants yet" }} />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onOpenChange={(value) => { if (!value) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "grant" ? `Grant protection — ${input.employee?.full_name}`
                : dialog?.kind === "revoke" ? `Revoke protection — ${input.employee?.full_name}`
                  : `${input.branch?.branch_name} policy`}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "branch"
                ? "This branch's own policy replaces the system-wide one for its employees."
                : "Recorded in Audit & Monitoring with your name. Payroll already worked out is not recalculated."}
            </DialogDescription>
          </DialogHeader>

          {dialog?.kind === "branch" ? (
            <PolicyFields idPrefix="tp-branch-policy" value={input.form} categories={categories}
              onChange={(form) => setInput((c) => ({ ...c, form }))} />
          ) : dialog ? (
            <div className="space-y-3">
              {dialog.kind === "grant" ? (
                <p className="text-sm text-muted-foreground">
                  Hired {input.employee?.date_hired ? dateLabel(input.employee.date_hired) : "—"} · {years(input.employee?.tenure_years)} of service ·
                  needs {years(input.employee?.min_tenure_years)}.
                </p>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="tp-date">{dialog.kind === "grant" ? "Protected from" : "Protection ends on"}</Label>
                <DatePicker id="tp-date" value={input.date} min={today} onChange={(v) => setInput((c) => ({ ...c, date: v }))} />
                {dialog.kind === "revoke" ? <p className="text-xs text-muted-foreground">Days before this date stay protected.</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tp-notes">{dialog.kind === "grant" ? "Contract reference / notes" : "Reason"}</Label>
                <Textarea id="tp-notes" maxLength={500} rows={3} placeholder={dialog.kind === "grant" ? "e.g. Contract No. 2026-014, clause 7" : "Optional"}
                  value={input.notes || ""} onChange={(e) => setInput((c) => ({ ...c, notes: e.target.value }))} />
              </div>
            </div>
          ) : null}

          {dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setDialog(null)} disabled={busy === "dialog"}>Cancel</Button>
            <Button variant={dialog?.kind === "revoke" ? "destructive" : "default"} onClick={submitDialog} disabled={busy === "dialog"}>
              {busy === "dialog" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              {dialog?.kind === "grant" ? "Grant" : dialog?.kind === "revoke" ? "Revoke" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
