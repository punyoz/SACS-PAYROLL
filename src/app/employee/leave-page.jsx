"use client";

import { dateLabel } from "@/lib/portal/payroll-preview";

import { AttendanceCorrectionByDate, MyCorrectionRequests, useMyCorrections } from "@/components/portal/attendance-correction-form";
import { describeSplit, splitForBalance } from "@/lib/leave-requests/split";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CalendarOffIcon, Loader2Icon, PlusIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/portal/data-table";
import { DatePicker } from "@/components/portal/date-picker";
import { MyOvertimeList, OvertimeRequestForm, SEPARATED_NOTE, useMyOvertime } from "@/components/portal/overtime-requests";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { useUrlParam } from "@/components/portal/use-url-param";
import { isPendingRequest } from "@/components/portal/status-badge";
import { RequestStatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { LEAVE_ADVANCE_DAYS, LEAVE_ADVANCE_MESSAGE, earliestLeaveStart } from "@/lib/leave-requests/advance-rule";
import { REASON_MAX } from "@/lib/input-limits";

/*
 * Leave request (submitLeaveRequest, public/legacy/js/employee.js): the same
 * fields, rules and POST /api/me/leave-requests body. The proof file is
 * sent as a data URL, under 2 MB, PDF / PNG / JPEG.
 */

// Yearly credits; statutory leaves (maternity, paternity, …) are added when the person may file them.
const LEAVE_TYPES = ["Sick Leave", "Vacation Leave", "Emergency Leave"];
const MAX_PROOF_BYTES = 2 * 1024 * 1024;

const schema = z.object({
  leave_type: z.string().min(1, "Leave type is required."),
  pay_status: z.enum(["with_pay", "without_pay"]),
  // Part B (2026-11-22): a whole day (or days), or the morning / afternoon of one day.
  day_length: z.enum(["full", "AM", "PM"]),
  start_date: z.string().min(1, "Start date is required."),
  end_date: z.string(),
  reason: z.string().trim().min(1, "Reason is required."),
  proof: z.any().optional(),
}).refine((v) => v.day_length !== "full" || v.end_date, {
  path: ["end_date"],
  message: "End date is required.",
}).refine((v) => v.day_length !== "full" || !v.start_date || !v.end_date || v.start_date <= v.end_date, {
  path: ["end_date"],
  message: "End date must be on or after the start date.",
}).refine((v) => v.day_length !== "full" || !v.start_date || v.start_date >= earliestLeaveStart(), {
  // Checked again by the server against its own clock (a half day: the requests' window, on the server).
  path: ["start_date"],
  message: LEAVE_ADVANCE_MESSAGE,
}).refine((v) => !v.proof || v.proof.size <= MAX_PROOF_BYTES, {
  path: ["proof"],
  message: "Proof file must be less than 2MB.",
});

const DEFAULTS = { leave_type: "", pay_status: "with_pay", day_length: "full", start_date: "", end_date: "", reason: "", proof: undefined };
const HALF_LABEL = { AM: "Half day: morning (AM)", PM: "Half day: afternoon (PM)" };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

// mode "full": whole day(s); "half": the morning or afternoon of one day (Leave & Overtime, 2026-11-22).
function LeaveRequestForm({ onSubmitted, balance = null, filing = null, mode = "full" }) {
  const { ctx, notify } = usePortalSession();
  const [serverError, setServerError] = React.useState("");
  const [fileKey, setFileKey] = React.useState(0);
  const defaults = React.useMemo(() => ({ ...DEFAULTS, day_length: mode === "half" ? "AM" : "full" }), [mode]);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: defaults });
  // Days before today + 7 (Manila) cannot be picked.
  const earliest = earliestLeaveStart();
  const startDate = form.watch("start_date");
  const endDate = form.watch("end_date");
  const payStatus = form.watch("pay_status");
  const leaveType = form.watch("leave_type");
  const dayLength = form.watch("day_length");
  const half = dayLength !== "full";
  // The credits of the chosen leave type (20261121010000).
  const remaining = balance?.by_type?.[leaveType]?.remaining ?? balance?.with_pay_remaining ?? 0;
  // Over the paid balance (2026-11-12): not blocked; the extra days are without pay.
  const split = !half && balance && leaveType && payStatus === "with_pay" && startDate && endDate
    ? splitForBalance({ start_date: startDate, end_date: endDate, pay_status: payStatus }, remaining) : null;

  async function onSubmit(values) {
    setServerError("");
    const employeeName = String(ctx?.full_name || "").trim();
    if (!employeeName) {
      setServerError("Unable to resolve employee profile. Please sign in again.");
      return;
    }
    try {
      const proofUrl = values.proof ? await readAsDataUrl(values.proof) : "";
      const response = await apiFetch("/api/me/leave-requests", jsonBody("POST", {
        employee_id: String(ctx?.employee_id || "").trim(),
        employee_name: employeeName,
        position: String(ctx?.position || "").trim(),
        leave_type: values.leave_type,
        pay_status: values.pay_status,
        start_date: values.start_date,
        end_date: values.day_length === "full" ? values.end_date : values.start_date,
        ...(values.day_length === "full" ? {} : { half_day: values.day_length }),
        reason: values.reason.trim(),
        proof_url: proofUrl,
      }));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to submit leave request.");

      form.reset(defaults);
      setFileKey((k) => k + 1);
      const when = values.day_length === "full" ? `${values.start_date} to ${values.end_date}` : `${values.start_date}, ${HALF_LABEL[values.day_length].toLowerCase()}`;
      notify("Leave Request Submitted", `${values.leave_type} · ${when} · Awaiting admin approval.`, "success");
      await onSubmitted(values.day_length === "full" ? "leave" : "half");
    } catch (error) {
      setServerError(error.message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid items-start gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="leave_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Leave type</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger className="w-full"><SelectValue placeholder="Select leave type" /></SelectTrigger></FormControl>
                <SelectContent>{[...LEAVE_TYPES, ...(balance?.statutory || []).filter((t) => !t.refusal).map((t) => t.leave_type)].map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="pay_status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pay status</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger className="w-full"><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="with_pay">With pay</SelectItem>
                  <SelectItem value="without_pay">Without pay</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {mode === "half" ? (
        <FormField
          control={form.control}
          name="day_length"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Length</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl><SelectTrigger className="w-full" aria-label="Length"><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="AM">{HALF_LABEL.AM}</SelectItem>
                  <SelectItem value="PM">{HALF_LABEL.PM}</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                {half
                  ? `Counts as half a day${payStatus === "with_pay" ? " of leave credit" : ", deducted at half your daily rate"}. Tap in or out as usual for the half you work.`
                  : "A half day covers the morning or the afternoon of one day."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        ) : null}
        <FormField
          control={form.control}
          name="start_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{half ? "Date" : "Start date"}</FormLabel>
              <FormControl><DatePicker value={field.value} onChange={field.onChange} min={half ? undefined : earliest} /></FormControl>
              <FormDescription>
                {half
                  ? `At least ${filing?.file_days_before ?? 1} day${(filing?.file_days_before ?? 1) === 1 ? "" : "s"} before, or up to ${filing?.late_filing_days_after ?? 2} days after as a late filing.`
                  : `At least ${LEAVE_ADVANCE_DAYS} days from today: ${new Date(`${earliest}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })} or later.`}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {half ? null : (
          <FormField
            control={form.control}
            name="end_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End date</FormLabel>
                <FormControl><DatePicker value={field.value} onChange={field.onChange} min={startDate && startDate > earliest ? startDate : earliest} /></FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {split?.without_pay_days ? (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm text-warning sm:col-span-2" data-testid="leave-split-preview">
            This is more than your {remaining} paid {leaveType.toLowerCase()} day{remaining === 1 ? "" : "s"} left: if approved, {describeSplit(split)} (deducted at your daily rate).
          </p>
        ) : null}
        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Reason</FormLabel>
              <FormControl><Textarea rows={3} maxLength={REASON_MAX} placeholder="State the reason for your leave request" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="proof"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Proof document <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
              <FormControl>
                <Input
                  key={fileKey}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.files?.[0])}
                  className="file:mr-3 file:text-primary"
                />
              </FormControl>
              <FormDescription>PDF, PNG or JPEG, under 2 MB.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError ? <p role="alert" className="text-sm text-destructive sm:col-span-2">{serverError}</p> : null}
        <Button type="submit" className="sm:col-span-2" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting
            ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Submitting…</>
            : <><SendIcon aria-hidden="true" />Submit leave request</>}
        </Button>
      </form>
    </Form>
  );
}

const days = (n) => `${n} ${Number(n) === 1 ? "day" : "days"}`;

function LeaveBalance({ balance, loading }) {
  const bal = balance || { with_pay_allotment: 0, with_pay_used: 0, with_pay_remaining: 0, without_pay_used: 0 };
  // ONE pool a year shared by Vacation, Sick and Emergency leave (2026-11-24); per type: what was used.
  const pool = bal.pool || { allotment: bal.with_pay_allotment, used: bal.with_pay_used, remaining: bal.with_pay_remaining, used_by_type: {} };
  const usedByType = Object.entries(pool.used_by_type || {}).filter(([, n]) => Number(n) > 0);
  const statutory = (bal.statutory || []).filter((t) => !t.refusal);
  const percent = pool.allotment > 0 ? Math.min(100, Math.round((pool.used / pool.allotment) * 100)) : 0;
  const short = (t) => t.replace(/ Leave$/, "");

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>Leave credits</CardTitle>
        <CardDescription>This year&apos;s leave with pay: one total for vacation, sick and emergency leave</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Skeleton className="h-24 w-full" /> : (
          <>
            <div data-testid="leave-credits">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">Leave credits</span>
                <span className="tabular-nums font-medium">{pool.used} of {days(pool.allotment)} used · {days(pool.remaining)} left</span>
              </div>
              <Progress value={percent} aria-label={`Leave credits: ${pool.used} of ${pool.allotment} days used`} />
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="leave-credits-by-type">
                {usedByType.length ? `Used: ${usedByType.map(([t, n]) => `${short(t)} ${n}`).join(", ")}` : "None used yet"}
                {bal.without_pay_used ? ` · without pay: ${days(bal.without_pay_used)}` : ""}
              </p>
              {bal.conversion?.eligible && bal.conversion.text ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="leave-conversion-preview">{bal.conversion.text}</p>
              ) : null}
            </div>
            {statutory.length ? (
              <div className="space-y-1.5 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Statutory leave, filed per event (not from your yearly credits)</p>
                {statutory.map((t) => (
                  <p key={t.leave_type} className="text-sm">
                    <span className="font-medium">{t.leave_type}</span>: up to {days(t.days)}{t.basis === "year" ? " a year" : " each time"}
                    {t.max_events ? ` (first ${t.max_events}; ${t.used} used)` : ""}. <span className="text-xs text-muted-foreground">{t.note}</span>
                  </p>
                ))}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const REQUEST_COLUMNS = [
  {
    key: "leave_type",
    header: "Leave",
    sortable: true,
    className: "font-medium",
    cell: (r) => (
      <div>
        <p>{r.leave_type}</p>
        <p className="text-xs font-normal text-muted-foreground">{r.pay_status === "without_pay" ? "Without pay" : "With pay"}</p>
      </div>
    ),
    searchValue: (r) => r.leave_type,
  },
  { key: "start_date", header: "Dates", sortable: true, cell: (r) => (r.half_day ? `${dateLabel(r.start_date)}, ${HALF_LABEL[r.half_day] || "half day"}` : `${dateLabel(r.start_date)} to ${dateLabel(r.end_date)}`), searchValue: (r) => `${r.start_date} ${r.end_date}` },
  { key: "reason", header: "Reason", className: "max-w-xs whitespace-normal text-muted-foreground", cell: (r) => r.reason, searchValue: (r) => r.reason },
  {
    key: "submitted_at",
    header: "Submitted",
    sortable: true,
    className: "text-muted-foreground",
    cell: (r) => (r.submitted_at
      ? new Date(r.submitted_at).toLocaleString("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "Unknown date"),
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    // HR's reason under a rejection (2026-11-06).
    cell: (r) => (
      <div className="space-y-1">
        <RequestStatusBadge status={r.status} />
        {String(r.status || "").toLowerCase() === "rejected" && r.decision_reason ? <p className="max-w-56 text-xs text-muted-foreground [overflow-wrap:anywhere]">Reason: {r.decision_reason}</p> : null}
      </div>
    ),
    searchValue: (r) => `${r.status} ${r.decision_reason || ""}`,
  },
];

const TABS = [
  { value: "leave", label: "Leave" },
  { value: "half", label: "Half day" },
  { value: "overtime", label: "Overtime" },
  { value: "correction", label: "Attendance correction" },
];
const TYPE_TITLES = { leave: "Leave (whole days)", half: "Half day", overtime: "Overtime", correction: "Attendance correction" };

/**
 * Leave & Overtime (2026-11-22; was "My Leave"): balances at the top, one
 * "New request" button (the type chosen in the dialog), and the person's
 * requests in three tabs with a pending count each. The tab is kept in the
 * address (?lo_tab=); the old page address opens the Leave tab.
 */
export function LeavePage({ leave, overtimeApi = "/api/me/overtime-requests" }) {
  const { me } = usePortalSession();
  const separated = Boolean(me?.user?.separated);
  const overtime = useMyOvertime(overtimeApi);
  // A separated person cannot file (and the server refuses them the list).
  const corrections = useMyCorrections(0, { enabled: Boolean(me?.user) && !separated });
  // An HR person's own requests: who decides them (another HR who covers their branch, or the Super Admin).
  const [approver, setApprover] = React.useState(null);
  const isHr = me?.user?.role === "hr";
  React.useEffect(() => {
    if (!isHr) return undefined;
    let alive = true;
    fetchJson("/api/me/approver").then((a) => { if (alive) setApprover(a); }).catch(() => {});
    return () => { alive = false; };
  }, [isHr]);
  const [tab, setTab] = useUrlParam("lo_tab", "leave");
  const current = TABS.some((t) => t.value === tab) ? tab : "leave";
  const [filing, setFiling] = React.useState(null); // the type chosen in the dialog, or null when closed
  const whole = (leave.requests || []).filter((r) => !r.half_day);
  const halves = (leave.requests || []).filter((r) => r.half_day);
  const pending = {
    leave: whole.filter((r) => isPendingRequest(r.status)).length,
    half: halves.filter((r) => isPendingRequest(r.status)).length,
    overtime: (overtime.rows || []).filter((r) => r.status === "pending").length,
    correction: (corrections.rows || []).filter((r) => r.status === "pending").length,
  };
  const filed = async (kind) => {
    setFiling(null);
    setTab(kind);
    if (kind === "overtime") await overtime.reload();
    else if (kind === "correction") await corrections.reload();
    else await leave.reload();
  };
  const leaveTable = (rows, title) => (
    <DataTable
      columns={REQUEST_COLUMNS}
      rows={rows}
      loading={leave.loading}
      error={leave.error}
      onRetry={leave.reload}
      searchPlaceholder="Search requests…"
      empty={{ title, icon: CalendarOffIcon }}
      caption={title}
      minWidth={680}
    />
  );

  return (
    <>
      <LeaveBalance balance={leave.balance} loading={leave.loading} />

      <Card className="min-w-0 shadow-xs">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>My requests</CardTitle>
            <CardDescription>Leave, half days, overtime and attendance corrections. Each goes to HR / your Administrator for approval.</CardDescription>
            {approver ? <p className="text-xs text-muted-foreground" data-testid="waiting-for">Your requests wait for: {approver.label}</p> : null}
          </div>
          {separated
            ? <p className="text-sm text-muted-foreground" data-testid="separated-note">{SEPARATED_NOTE}</p>
            : <Button onClick={() => setFiling(current)} data-testid="new-request"><PlusIcon aria-hidden="true" />New request</Button>}
        </CardHeader>
        <CardContent className="space-y-3">
          <FilterTabs value={current} onValueChange={setTab} label="Request type"
            options={TABS.map((t) => ({ ...t, count: pending[t.value] || undefined }))} />
          {current === "leave" ? leaveTable(whole, "No leave requests submitted yet") : null}
          {current === "half" ? leaveTable(halves, "No half-day requests yet") : null}
          {current === "overtime" ? <MyOvertimeList list={overtime} apiBase={overtimeApi} /> : null}
          {current === "correction" ? <MyCorrectionRequests list={corrections} /> : null}
        </CardContent>
      </Card>

      <Dialog open={Boolean(filing)} onOpenChange={(open) => { if (!open) setFiling(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New request</DialogTitle>
            <DialogDescription>Choose the type, then fill in the request.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-request-type">Type</Label>
            <Select value={filing || "leave"} onValueChange={setFiling}>
              <SelectTrigger id="new-request-type" className="w-full" aria-label="Request type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TABS.map((t) => <SelectItem key={t.value} value={t.value}>{TYPE_TITLES[t.value]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {filing === "correction"
            ? <AttendanceCorrectionByDate onDone={() => filed("correction")} onCancel={() => setFiling(null)} />
            : filing === "overtime"
            ? <OvertimeRequestForm apiBase={overtimeApi} settings={overtime.settings} onFiled={() => filed("overtime")} />
            : filing
              ? <LeaveRequestForm key={filing} mode={filing === "half" ? "half" : "full"} onSubmitted={filed} balance={leave.balance} filing={leave.filing} />
              : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
