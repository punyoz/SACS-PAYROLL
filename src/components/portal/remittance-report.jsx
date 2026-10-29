"use client";

import * as React from "react";
import { AlertTriangleIcon, DownloadIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { useDownloader } from "@/components/portal/bir-forms";
import { fetchJson } from "@/lib/portal/api";
import { moneyCompact } from "@/lib/portal/payroll-preview";
import { cn } from "@/lib/utils";

/*
 * Government remittance (GET /api/payroll/remittance, 2026-10-26): per
 * employee, the employee share deducted from pay, the employer share the
 * school adds (and SSS EC, employer only), the total remitted to SSS,
 * PhilHealth and Pag-IBIG, and the withholding tax remitted to the BIR.
 * Accountant (its branch) and HR (every branch). The employee never sees the
 * employer share.
 */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The last 12 payroll months, newest first ("YYYY-MM"), from October 2026. */
function monthOptions(today = new Date()) {
  const out = [];
  let year = today.getFullYear();
  let month = today.getMonth() + 1;
  for (let i = 0; i < 12; i += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key < "2026-10") break;
    out.push({ key, label: `${MONTH_NAMES[month - 1]} ${year}` });
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return out.length ? out : [{ key: "2026-10", label: "October 2026" }];
}

export function RemittanceCard({ refreshKey = 0 }) {
  const months = React.useMemo(() => monthOptions(), []);
  const [month, setMonth] = React.useState(months[0].key);
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const [busy, run] = useDownloader();

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetchJson(`/api/payroll/remittance?month=${month}`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message || "Unable to load the remittance report.", data: null });
    }
  }, [month]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  const data = state.data;
  const amount = (key, strong = false) => ({
    key, align: "right", className: cn("tabular-nums whitespace-nowrap", strong && "font-semibold"), sortValue: (r) => r[key], cell: (r) => moneyCompact(r[key]),
  });
  const columns = [
    {
      key: "employee_name", header: "Employee", sortable: true, searchValue: (r) => `${r.employee_name} ${r.employee_code} ${r.branch_name}`,
      cell: (r) => <div><p className="font-medium">{r.employee_name}</p><p className="text-xs text-muted-foreground">{r.employee_code} · {r.branch_name} · {r.status}</p></div>,
    },
    { ...amount("sss_ee"), header: "SSS EE" },
    { ...amount("sss_er"), header: "SSS ER" },
    { ...amount("sss_ec"), header: "SSS EC" },
    { ...amount("sss_total", true), header: "SSS remit" },
    { ...amount("philhealth_ee"), header: "PhilHealth EE" },
    { ...amount("philhealth_er"), header: "PhilHealth ER" },
    { ...amount("philhealth_total", true), header: "PhilHealth remit" },
    { ...amount("pagibig_ee"), header: "Pag-IBIG EE" },
    { ...amount("pagibig_er"), header: "Pag-IBIG ER" },
    { ...amount("pagibig_total", true), header: "Pag-IBIG remit" },
    { ...amount("withholding_tax", true), header: "Tax (BIR)" },
    // Year-end tax adjustment (+ collected / − refunded), 2026-10-29.
    { ...amount("year_end_tax", true), header: "Year-end tax adj." },
    { ...amount("total_remit", true), header: "Total remit" },
  ];
  const t = data?.totals || {};

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Government remittance</CardTitle>
        <CardDescription>
          What the school remits for the month: each contribution&apos;s employee share (EE, deducted from pay) plus the employer share (ER, the school&apos;s own cost) and SSS EC (employer only), and the withholding tax (employee only).
          Employees see only their own deductions.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger size="sm" className="w-40" aria-label="Payroll month"><SelectValue /></SelectTrigger>
            <SelectContent>{months.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button>
          <Button variant="outline" size="sm" disabled={busy === "csv" || !data?.rows?.length} onClick={() => run("csv", `/api/payroll/remittance?month=${month}&format=csv`, `remittance-${month}.csv`)}>
            {busy === "csv" ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}CSV
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error && !data ? <ErrorState message={state.error} onRetry={load} /> : null}
        {data?.missing_employer ? (
          <Alert>
            <AlertTriangleIcon aria-hidden="true" />
            <AlertDescription>{data.missing_employer} employee{data.missing_employer === 1 ? "" : "s"} had contributions deducted on a payslip processed before employer shares were recorded: the ER columns show ₱0 for them. Work out their employer share by hand before remitting.</AlertDescription>
          </Alert>
        ) : null}
        {data && data.rows.length ? (
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {[["SSS", t.sss_total], ["PhilHealth", t.philhealth_total], ["Pag-IBIG", t.pagibig_total], [t.year_end_tax ? "BIR (tax withheld + year-end adj.)" : "BIR (tax withheld)", (t.withholding_tax || 0) + (t.year_end_tax || 0)]].map(([label, value]) => (
              <div key={label} className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold tabular-nums">{moneyCompact(value)}</p></div>
            ))}
          </div>
        ) : null}
        <DataTable columns={columns} rows={data?.rows || []} rowKey={(r) => r.employee_id} loading={state.loading && !data} pageSize={15}
          searchPlaceholder="Search employee…" caption="Government remittance" minWidth={1400}
          empty={{ title: "No payslips this month", description: "Process the month's payroll first." }} />
      </CardContent>
    </Card>
  );
}
