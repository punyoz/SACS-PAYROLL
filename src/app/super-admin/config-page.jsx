"use client";

import * as React from "react";
import { CalendarClockIcon, InfoIcon, Loader2Icon, LockIcon, SettingsIcon, WalletIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { ErrorState } from "@/components/portal/empty-state";
import { usePortalSession } from "@/components/portal/session";
import { fetchJson, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";
import { RatesSection } from "./rates-section";
import { PayrollSettingsSection } from "./tax-section";
import { HolidaysSection } from "./holidays-section";
import { OverrideSection } from "./override-section";

/*
 * System Configuration (loadSAConfig / saveSAConfig and the per-branch
 * attendance policy, public/legacy/js/super-admin.js): GET and PATCH
 * /api/admin/config { section, fields }. A branch's own schedule is the
 * "attendance:<branch id>" section; keys it has not set fall back to the
 * default "attendance" section (src/lib/attendance/policy.js).
 */

const TABS = [
  { id: "general", label: "General" },
  { id: "attendance", label: "Attendance" },
  { id: "payroll", label: "Payroll" },
  { id: "rates", label: "Rates" },
  { id: "tax", label: "Tax & contributions" },
  { id: "holidays", label: "Holidays" },
  { id: "security", label: "Security" },
  { id: "override", label: "Payslip override" },
];

const ATT_DEFAULTS = { work_start: "08:00", work_end: "17:00", grace: "15", work_hours: "8" };
const SECTION_LABELS = { general: "General Settings", attendance: "Attendance Policy", payroll: "Payroll Configuration", security: "Security & Access" };

const FIELDS = {
  general: [
    { key: "org_name", label: "Organization name", type: "text", placeholder: "e.g. SACS School", fallback: "SACS" },
    { key: "timezone", label: "Timezone", options: [["Asia/Manila", "Asia/Manila (PHT, UTC+8)"], ["UTC", "UTC"]], fallback: "Asia/Manila" },
    { key: "date_format", label: "Date format", options: [["MM/DD/YYYY", "MM/DD/YYYY"], ["DD/MM/YYYY", "DD/MM/YYYY"], ["YYYY-MM-DD", "YYYY-MM-DD"]], fallback: "MM/DD/YYYY" },
    { key: "currency", label: "Currency", options: [["PHP", "PHP — Philippine Peso"], ["USD", "USD — US Dollar"]], fallback: "PHP" },
  ],
  attendance: [
    { key: "work_start", label: "Work start time", type: "time" },
    { key: "work_end", label: "Work end time", type: "time" },
    { key: "grace", label: "Late grace period (minutes)", type: "number", min: 0, max: 60 },
    { key: "work_hours", label: "Required work hours / day", type: "number", min: 1, max: 24, step: 0.5 },
  ],
  payroll: [
    { key: "pay_freq", label: "Pay frequency", options: [["semi-monthly", "Semi-Monthly (1st & 15th)"], ["monthly", "Monthly"], ["weekly", "Weekly"]], fallback: "semi-monthly" },
  ],
  security: [
    { key: "session", label: "Session timeout (minutes)", type: "number", min: 5, max: 480, fallback: "60" },
    { key: "login_attempts", label: "Max login attempts", type: "number", min: 3, max: 20, fallback: "5" },
    { key: "pw_min", label: "Password minimum length", type: "number", min: 6, max: 32, fallback: "8" },
    { key: "pw_expiry", label: "Force password expiry (days, 0 = never)", type: "number", min: 0, max: 365, fallback: "0" },
  ],
};

// The payroll sheet's title line and "Approved for payment" signatory (optional).
const SHEET_FIELDS = [
  { key: "sheet_school_name", label: "Payroll sheet — school name", maxLength: 200, placeholder: "e.g. Shepherd Angels Christian School of Antipolo, Inc." },
  { key: "sheet_approver_name", label: "Payroll sheet — approved by", maxLength: 120, placeholder: "Name of the approver" },
  { key: "sheet_approver_title", label: "Approver's title", maxLength: 120, placeholder: "e.g. Owner / Manager" },
];

const attendanceSection = (branchId) => (branchId ? `attendance:${branchId}` : "attendance");

function initialValues(fields, saved) {
  return Object.fromEntries(fields.map((f) => [f.key, saved?.[f.key] !== undefined && saved?.[f.key] !== null ? String(saved[f.key]) : (f.fallback ?? "")]));
}

function keyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Every setting needs a value (requireFields); returns { key: message }. */
function blankErrors(fields, values) {
  return Object.fromEntries(fields.filter((f) => !String(values[f.key] ?? "").trim()).map((f) => [f.key, `${f.label} is required.`]));
}

function SettingInputs({ fields, values, errors, onChange, idPrefix }) {
  return fields.map((f) => {
    const id = `${idPrefix}-${f.key}`;
    const invalid = errors[f.key] ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
    return (
      <div key={f.key} className="space-y-2">
        <Label htmlFor={id}>{f.label}</Label>
        {f.options ? (
          <Select value={values[f.key] || undefined} onValueChange={(v) => onChange(f.key, v)}>
            <SelectTrigger id={id} className="w-full" {...invalid}><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{f.options.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
        ) : (
          <Input
            id={id}
            type={f.type}
            min={f.min}
            max={f.max}
            step={f.step}
            inputMode={f.type === "number" ? "decimal" : undefined}
            placeholder={f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => onChange(f.key, e.target.value)}
            className={cn(f.type === "number" && "tabular-nums")}
            {...invalid}
          />
        )}
        {errors[f.key] ? <p id={`${id}-error`} className="text-sm text-destructive">{errors[f.key]}</p> : null}
      </div>
    );
  });
}

/** Save one section after a confirmation (saveSAConfig). Returns the new config, or null. */
function useSaveConfig() {
  const { notify } = usePortalSession();
  const [confirmDialog, confirm] = useConfirm();
  const save = React.useCallback(async (section, label, fields) => {
    const ok = await confirm({ title: "Confirm save", description: `Save the ${label} changes? This will apply system-wide immediately.`, confirmLabel: "Save" });
    if (!ok) return null;
    const data = await fetchJson("/api/admin/config", jsonBody("PATCH", { section, fields }));
    const name = section.split(":")[0];
    notify("Configuration Saved", `${name} settings updated.`, "success");
    return data.config || null;
  }, [confirm, notify]);
  return [confirmDialog, save];
}

function SectionCard({ icon: Icon, title, description, note, applies, footer, children }) {
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Icon className="size-4 text-gold-text" aria-hidden="true" />{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {note ? (
          <Alert className="border-warning/40 bg-warning/5">
            <InfoIcon className="text-warning" aria-hidden="true" />
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        ) : null}
        {applies ? <p className="text-sm text-muted-foreground">{applies}</p> : null}
        {children}
      </CardContent>
      {footer ? <CardFooter className="flex flex-wrap items-center gap-3 border-t pt-4">{footer}</CardFooter> : null}
    </Card>
  );
}

function SaveRow({ busy, onSave, feedback }) {
  return (
    <>
      <Button onClick={onSave} disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save"}</Button>
      <p role="status" aria-live="polite" className={cn("text-sm", feedback.ok ? "text-success" : "text-destructive")}>{feedback.text}</p>
    </>
  );
}

/** General and Security: plain fields saved as one section. */
function SimpleSection({ section, config, onConfig, icon, title, description, note }) {
  const fields = FIELDS[section];
  const [values, setValues] = React.useState(() => initialValues(fields, config?.[section]));
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [confirmDialog, saveConfig] = useSaveConfig();

  const change = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function save() {
    const nextErrors = blankErrors(fields, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFeedback({ text: "Fill in the highlighted settings.", ok: false });
      return;
    }
    setBusy(true);
    try {
      const next = await saveConfig(section, SECTION_LABELS[section], values);
      if (next) {
        onConfig(next);
        setFeedback({ text: `${section.charAt(0).toUpperCase() + section.slice(1)} settings saved.`, ok: true });
      }
    } catch (error) {
      setFeedback({ text: error.message || "Failed to save configuration.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard icon={icon} title={title} description={description} note={note} footer={<SaveRow busy={busy} onSave={save} feedback={feedback} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingInputs fields={fields} values={values} errors={errors} onChange={change} idPrefix={`cfg-${section}`} />
      </div>
      {confirmDialog}
    </SectionCard>
  );
}

function AttendanceSection({ config, onConfig, branches }) {
  const fields = FIELDS.attendance;
  const [branchId, setBranchId] = React.useState("");
  const base = React.useMemo(() => ({ ...ATT_DEFAULTS, ...(config?.attendance || {}) }), [config]);
  const own = branchId ? config?.[attendanceSection(branchId)] || null : null;
  const resolve = React.useCallback(() => Object.fromEntries(fields.map((f) => {
    const v = own && own[f.key] !== undefined && own[f.key] !== null && own[f.key] !== "" ? own[f.key] : base[f.key];
    return [f.key, v === undefined || v === null ? "" : String(v)];
  })), [fields, own, base]);
  const [values, setValues] = React.useState(resolve);
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [confirmDialog, saveConfig] = useSaveConfig();

  // A different branch (or a fresh save) shows that branch's schedule.
  React.useEffect(() => { setValues(resolve()); setErrors({}); }, [resolve]);

  const branch = branches.find((b) => String(b.id) === branchId);
  const hint = !branchId
    ? "Editing the default schedule. Branches without their own schedule use these values."
    : own ? `Editing ${branch?.name || "this branch"}'s own schedule.`
      : `${branch?.name || "This branch"} has no schedule of its own yet — showing the default. Saving creates one for this branch.`;

  const change = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function save() {
    const nextErrors = blankErrors(fields, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFeedback({ text: "Fill in the highlighted settings.", ok: false });
      return;
    }
    setBusy(true);
    try {
      const label = branch ? `${SECTION_LABELS.attendance} for ${branch.name}` : SECTION_LABELS.attendance;
      const next = await saveConfig(attendanceSection(branchId), label, values);
      if (next) {
        onConfig(next);
        setFeedback({ text: "Attendance settings saved.", ok: true });
      }
    } catch (error) {
      setFeedback({ text: error.message || "Failed to save configuration.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      icon={CalendarClockIcon}
      title="Attendance policy"
      description="Work hours and grace periods, set per branch. An RFID Time In is marked Late after the employee's branch start time plus the grace period; timesheets show that branch's shift, tardiness and undertime."
      footer={<SaveRow busy={busy} onSave={save} feedback={feedback} />}
    >
      <div className="space-y-2">
        <Label htmlFor="cfg-att-branch">Branch schedule</Label>
        <Select value={branchId || "__default__"} onValueChange={(v) => { setBranchId(v === "__default__" ? "" : v); setFeedback({ text: "", ok: false }); }}>
          <SelectTrigger id="cfg-att-branch" className="w-full sm:max-w-md" aria-describedby="cfg-att-branch-hint"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">Default (all branches without their own schedule)</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={String(b.id)}>{b.name}{config?.[attendanceSection(b.id)] ? " — custom schedule" : ""}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="cfg-att-branch-hint" className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SettingInputs fields={fields} values={values} errors={errors} onChange={change} idPrefix="cfg-att" />
      </div>
      {confirmDialog}
    </SectionCard>
  );
}

function PayrollSection({ config, onConfig }) {
  const saved = config?.payroll;
  const [values, setValues] = React.useState(() => ({ ...initialValues(FIELDS.payroll, saved), ...initialValues(SHEET_FIELDS, saved) }));
  const [dates, setDates] = React.useState(() => {
    try {
      const parsed = saved?.pay_calendar ? JSON.parse(saved.pay_calendar) : [];
      return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : [];
    } catch {
      return [];
    }
  });
  const [errors, setErrors] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [busy, setBusy] = React.useState(false);
  const [confirmDialog, saveConfig] = useSaveConfig();

  const change = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };
  const sorted = [...dates].sort();

  async function save() {
    const nextErrors = blankErrors(FIELDS.payroll, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFeedback({ text: "Fill in the highlighted settings.", ok: false });
      return;
    }
    setBusy(true);
    try {
      const fields = {
        pay_freq: values.pay_freq,
        pay_calendar: JSON.stringify(sorted),
        ...Object.fromEntries(SHEET_FIELDS.map((f) => [f.key, String(values[f.key] || "").trim()])),
      };
      const next = await saveConfig("payroll", SECTION_LABELS.payroll, fields);
      if (next) {
        onConfig(next);
        setFeedback({ text: "Payroll settings saved.", ok: true });
      }
    } catch (error) {
      setFeedback({ text: error.message || "Failed to save configuration.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      icon={WalletIcon}
      title="Payroll configuration"
      description="Pay frequency, the payroll sheet's header and signatory, and the pay calendar."
      applies="Rates, the tax table and contribution amounts are on their own tabs; each change there applies from the effective date you set — past payslips are not affected."
      footer={<SaveRow busy={busy} onSave={save} feedback={feedback} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingInputs fields={FIELDS.payroll} values={values} errors={errors} onChange={change} idPrefix="cfg-pay" />
        <SettingInputs fields={SHEET_FIELDS.map((f) => ({ ...f, type: "text" }))} values={values} errors={{}} onChange={change} idPrefix="cfg-sheet" />
      </div>
      <div className="space-y-2">
        <p id="cfg-paycal-label" className="text-sm font-medium">Pay calendar</p>
        <p className="text-xs text-muted-foreground">Mark exact pay-out dates for the year — use this when management needs a specific schedule beyond the frequency above. Select a day to add or remove it.</p>
        <div className="flex flex-col gap-4 md:flex-row md:items-start" role="group" aria-labelledby="cfg-paycal-label">
          <Calendar
            mode="multiple"
            selected={sorted.map(dateFromKey)}
            onSelect={(list) => setDates((list || []).map(keyFromDate))}
            className="w-fit rounded-md border"
          />
          <div className="flex flex-1 flex-wrap content-start gap-2">
            {sorted.length ? sorted.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs tabular-nums">
                {d}
                <Button type="button" variant="ghost" size="icon" className="size-5 rounded-full" onClick={() => setDates((current) => current.filter((x) => x !== d))} aria-label={`Remove ${d}`}>
                  <XIcon className="size-3" aria-hidden="true" />
                </Button>
              </span>
            )) : <p className="text-sm text-muted-foreground">No pay dates selected — select a day on the calendar to add one.</p>}
          </div>
        </div>
      </div>
      {confirmDialog}
    </SectionCard>
  );
}

export function ConfigPage({ refreshKey }) {
  const [tab, setTab] = React.useState("general");
  const [state, setState] = React.useState({ loading: true, error: null, config: null, branches: [], version: 0 });

  const load = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    const [config, branches] = await Promise.allSettled([fetchJson("/api/admin/config"), fetchJson("/api/admin/branches")]);
    setState((current) => ({
      loading: false,
      // The legacy page kept its built-in values when the config could not load.
      error: config.status === "rejected" && !current.config ? config.reason?.message || "Unable to load the configuration." : null,
      config: config.status === "fulfilled" ? config.value.config || {} : current.config,
      branches: branches.status === "fulfilled" ? branches.value.branches || [] : current.branches,
      version: current.version + 1,
    }));
  }, []);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const onConfig = React.useCallback((config) => setState((current) => ({ ...current, config })), []);
  const ready = Boolean(state.config) || Boolean(state.error);
  const config = state.config || {};

  return (
    <>
      <Alert className="border-info/30 bg-info/5">
        <InfoIcon className="text-info" aria-hidden="true" />
        <AlertDescription>Configuration changes apply system-wide. Review all settings carefully before saving.</AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList className="w-max">
            {TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
          </TabsList>
        </div>

        {["general", "attendance", "payroll", "security"].includes(tab) && !ready ? (
          <Card className="shadow-xs"><CardContent className="space-y-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-28 w-full" /></CardContent></Card>
        ) : null}
        {state.error && ["general", "attendance", "payroll", "security"].includes(tab) ? (
          <Card className="shadow-xs"><CardContent><ErrorState message={state.error} onRetry={load} /></CardContent></Card>
        ) : null}

        {/* key: a reload (or the header refresh) puts each form back to the saved values. */}
        <TabsContent value="general" className="flex flex-col gap-4">
          {state.config ? (
            <SimpleSection
              key={`general-${state.version}`}
              section="general"
              config={config}
              onConfig={onConfig}
              icon={SettingsIcon}
              title="General settings"
              description="Organization name, timezone, and display preferences."
              note="Saved for reference only — not yet applied by the system. Dates and times are currently shown in Asia/Manila throughout."
            />
          ) : null}
        </TabsContent>
        <TabsContent value="attendance" className="flex flex-col gap-4">
          {state.config ? <AttendanceSection key={`att-${state.version}`} config={config} onConfig={onConfig} branches={state.branches} /> : null}
        </TabsContent>
        <TabsContent value="payroll" className="flex flex-col gap-4">
          {state.config ? <PayrollSection key={`pay-${state.version}`} config={config} onConfig={onConfig} /> : null}
        </TabsContent>
        <TabsContent value="rates" className="flex flex-col gap-4"><RatesSection refreshKey={refreshKey} /></TabsContent>
        <TabsContent value="tax" className="flex flex-col gap-4"><PayrollSettingsSection refreshKey={refreshKey} /></TabsContent>
        <TabsContent value="holidays" className="flex flex-col gap-4"><HolidaysSection refreshKey={refreshKey} /></TabsContent>
        <TabsContent value="security" className="flex flex-col gap-4">
          {state.config ? (
            <SimpleSection
              key={`sec-${state.version}`}
              section="security"
              config={config}
              onConfig={onConfig}
              icon={LockIcon}
              title="Security & access"
              description="Session policies and access control rules."
              note="Saved for reference only — not yet applied by the system. Sessions last 8 hours and sign-in is limited to 5 attempts per account; both are fixed in code."
            />
          ) : null}
        </TabsContent>
        <TabsContent value="override" className="flex flex-col gap-4"><OverrideSection refreshKey={refreshKey} /></TabsContent>
      </Tabs>
    </>
  );
}
