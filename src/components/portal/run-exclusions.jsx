"use client";

import * as React from "react";
import { RefreshCwIcon, UserMinusIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { cn } from "@/lib/utils";

/*
 * Employees left out of a payroll run (20261029080000): the Accountant may
 * submit a run without everyone, after confirming who and why. HR sees the
 * list on the run; both keep a follow-up list until each is paid in a later
 * (supplemental) run of that period.
 */

/** The run's left-out employees, shown on the run itself (HR review, Accountant's run card). */
export function ExclusionsAlert({ exclusions, title = "Left out of this run", className }) {
  if (!exclusions?.length) return null;
  return (
    <Alert className={cn("border-warning/40 bg-warning/5", className)} data-testid="run-exclusions">
      <UserMinusIcon className="text-warning" aria-hidden="true" />
      <AlertDescription className="space-y-1.5">
        <p className="font-medium text-foreground">{title}: {exclusions.length} employee{exclusions.length === 1 ? "" : "s"}</p>
        <ul className="space-y-1 text-sm">
          {exclusions.map((x) => (
            <li key={x.employee_id}>
              <span className="font-medium text-foreground">{x.employee_name}</span>
              {x.employee_code ? <span className="text-muted-foreground"> ({x.employee_code})</span> : null}
              {" — "}{x.reason || <span className="italic text-muted-foreground">no note given</span>}
            </li>
          ))}
        </ul>
        {exclusions[0]?.acknowledged_by_name ? <p className="text-xs text-muted-foreground">Confirmed as intentional by {exclusions[0].acknowledged_by_name}. They are paid in a supplemental run of this period.</p> : null}
      </AlertDescription>
    </Alert>
  );
}

const FOLLOW_UP = {
  not_processed: ["Not processed yet", "warning"],
  processed_not_submitted: ["Processed, not submitted", "info"],
};

/**
 * The follow-up list: employees left out of a submitted run who are not in
 * any run of that period yet. `endpoint` returns { excluded: [...] }.
 */
export function OpenExclusionsCard({ endpoint, refreshKey, showBranch = false, description }) {
  const [state, setState] = React.useState({ loading: true, error: null, rows: [] });
  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson(endpoint);
      setState({ loading: false, error: null, rows: data.excluded || [] });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message, rows: c.rows }));
    }
  }, [endpoint]);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const columns = [
    { key: "employee_name", header: "Employee", sortable: true, className: "font-medium", searchValue: (r) => `${r.employee_name} ${r.employee_code || ""}`,
      cell: (r) => <span>{r.employee_name}{r.employee_code ? <span className="block text-xs text-muted-foreground">{r.employee_code}</span> : null}</span> },
    ...(showBranch ? [{ key: "branch_name", header: "Branch", sortable: true }] : []),
    { key: "period_start", header: "Period", sortable: true, className: "whitespace-nowrap", cell: (r) => r.period_label, searchValue: (r) => r.period_label },
    { key: "reason", header: "Why left out", cell: (r) => (r.reason ? <p className="max-w-72 text-sm whitespace-normal">{r.reason}</p> : <span className="text-xs text-muted-foreground">No note given</span>) },
    { key: "follow_up", header: "Now", cell: (r) => { const [label, tone] = FOLLOW_UP[r.follow_up] || [r.follow_up, "muted"]; return <StatusBadge tone={tone}>{label}</StatusBadge>; } },
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Employees left out of a payroll run</CardTitle>
        <CardDescription>{description || "Left out of a submitted run and not paid for that period yet. Process them, then submit the supplemental run of that period."}</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent>
        {state.error && !state.rows.length ? <ErrorState message={state.error} onRetry={load} /> : (
          <DataTable
            columns={columns}
            rows={state.rows}
            loading={state.loading && !state.rows.length}
            pageSize={10}
            searchPlaceholder="Search employee or period…"
            empty={{ title: "Nobody is waiting: every employee left out has been paid", icon: UserMinusIcon }}
            caption="Employees left out of a payroll run"
            minWidth={640}
          />
        )}
      </CardContent>
    </Card>
  );
}
