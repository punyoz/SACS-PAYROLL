"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CalendarOffIcon, Loader2Icon, SendIcon } from "lucide-react";
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
import { RequestStatusBadge } from "@/components/portal/status-badge";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, jsonBody } from "@/lib/portal/api";

/*
 * Leave request (submitLeaveRequest, public/legacy/js/employee.js): the same
 * fields, rules and POST /api/employee/leave-requests body. The proof file is
 * sent as a data URL, under 2 MB, PDF / PNG / JPEG.
 */

const LEAVE_TYPES = ["Sick Leave", "Vacation Leave", "Emergency Leave", "Maternity Leave", "Paternity Leave"];
const MAX_PROOF_BYTES = 2 * 1024 * 1024;

const schema = z.object({
  leave_type: z.string().min(1, "Leave type is required."),
  pay_status: z.enum(["with_pay", "without_pay"]),
  start_date: z.string().min(1, "Start date is required."),
  end_date: z.string().min(1, "End date is required."),
  reason: z.string().trim().min(1, "Reason is required."),
  proof: z.any().optional(),
}).refine((v) => !v.start_date || !v.end_date || v.start_date <= v.end_date, {
  path: ["end_date"],
  message: "End date must be on or after the start date.",
}).refine((v) => !v.proof || v.proof.size <= MAX_PROOF_BYTES, {
  path: ["proof"],
  message: "Proof file must be less than 2MB.",
});

const DEFAULTS = { leave_type: "", pay_status: "with_pay", start_date: "", end_date: "", reason: "", proof: undefined };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function LeaveRequestForm({ onSubmitted }) {
  const { ctx, notify } = usePortalSession();
  const [serverError, setServerError] = React.useState("");
  const [fileKey, setFileKey] = React.useState(0);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: DEFAULTS });

  async function onSubmit(values) {
    setServerError("");
    const employeeName = String(ctx?.full_name || "").trim();
    if (!employeeName) {
      setServerError("Unable to resolve employee profile. Please sign in again.");
      return;
    }
    try {
      const proofUrl = values.proof ? await readAsDataUrl(values.proof) : "";
      const response = await apiFetch("/api/employee/leave-requests", jsonBody("POST", {
        employee_id: String(ctx?.employee_id || "").trim(),
        employee_name: employeeName,
        position: String(ctx?.position || "").trim(),
        leave_type: values.leave_type,
        pay_status: values.pay_status,
        start_date: values.start_date,
        end_date: values.end_date,
        reason: values.reason.trim(),
        proof_url: proofUrl,
      }));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to submit leave request.");

      form.reset(DEFAULTS);
      setFileKey((k) => k + 1);
      notify("Leave Request Submitted", `${values.leave_type} · ${values.start_date} to ${values.end_date} · Awaiting admin approval.`, "success");
      await onSubmitted();
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
                <SelectContent>{LEAVE_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
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
        <FormField
          control={form.control}
          name="start_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start date</FormLabel>
              <FormControl><DatePicker value={field.value} onChange={field.onChange} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="end_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>End date</FormLabel>
              <FormControl><DatePicker value={field.value} onChange={field.onChange} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Reason</FormLabel>
              <FormControl><Textarea rows={3} placeholder="State the reason for your leave request" {...field} /></FormControl>
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
  const allotment = Number(bal.with_pay_allotment || 0);
  const used = Number(bal.with_pay_used || 0);
  const percent = allotment > 0 ? Math.min(100, Math.round((used / allotment) * 100)) : 0;

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>Leave balance</CardTitle>
        <CardDescription>This year&apos;s leave with pay</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Skeleton className="h-24 w-full" /> : (
          <>
            <div>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">With pay — used</span>
                <span className="tabular-nums font-medium">{bal.with_pay_used} of {bal.with_pay_allotment} days</span>
              </div>
              <Progress value={percent} aria-label={`Leave with pay used: ${bal.with_pay_used} of ${bal.with_pay_allotment} days`} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-success/8 p-3">
                <p className="text-xs text-muted-foreground">With pay remaining</p>
                <p className="mt-0.5 tabular-nums text-lg font-semibold text-success">{days(bal.with_pay_remaining)}</p>
              </div>
              <div className="rounded-lg border bg-warning/8 p-3">
                <p className="text-xs text-muted-foreground">Without pay used</p>
                <p className="mt-0.5 tabular-nums text-lg font-semibold text-warning">{days(bal.without_pay_used)}</p>
              </div>
            </div>
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
  { key: "start_date", header: "Dates", sortable: true, cell: (r) => `${r.start_date} to ${r.end_date}`, searchValue: (r) => `${r.start_date} ${r.end_date}` },
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
  { key: "status", header: "Status", sortable: true, cell: (r) => <RequestStatusBadge status={r.status} />, searchValue: (r) => r.status },
];

export function LeavePage({ leave }) {
  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle>Leave request</CardTitle>
            <CardDescription>Your request goes to HR / your Administrator for approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <LeaveRequestForm onSubmitted={leave.reload} />
          </CardContent>
        </Card>
        <LeaveBalance balance={leave.balance} loading={leave.loading} />
      </div>

      <Card className="min-w-0 shadow-xs">
        <CardHeader>
          <CardTitle>My leave requests</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={REQUEST_COLUMNS}
            rows={leave.requests}
            loading={leave.loading}
            error={leave.error}
            onRetry={leave.reload}
            searchPlaceholder="Search requests…"
            empty={{ title: "No leave requests submitted yet", icon: CalendarOffIcon }}
            caption="My leave requests"
            minWidth={680}
          />
        </CardContent>
      </Card>
    </>
  );
}
