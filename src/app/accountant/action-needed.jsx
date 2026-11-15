"use client";

import * as React from "react";
import { ArrowRightIcon, CheckCircle2Icon, InfoIcon, ListTodoIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/portal/empty-state";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { followPortalLink, portalHref } from "@/lib/portal/navigate";
import { cn } from "@/lib/utils";

/*
 * Action needed (decisions 2026-11-15, item 9): per branch, what the
 * Accountant still has to do, each with a count and a link to the screen
 * that does it (GET /api/accountant/payroll-runs?view=action_needed). The
 * list is read fresh, so an item is gone once it is done.
 */

const KIND_LABELS = {
  rejected: "Rejected by HR",
  recompute: "Needs recompute",
  drafts: "Drafts not finalized",
  left_out: "Left out of a run",
  unsubmitted: "Final, not in any run",
  not_processed: "Nothing processed",
  pending_long: "Pending HR Approval",
};
const KIND_TONES = { rejected: "danger", recompute: "warning", drafts: "gold", left_out: "warning", unsubmitted: "info", not_processed: "warning", pending_long: "muted" };

export function ActionNeededPanel({ refreshKey = 0, className }) {
  const [state, setState] = React.useState({ loading: true, error: null, items: [] });
  const load = React.useCallback(async () => {
    setState((c) => ({ ...c, loading: true, error: null }));
    try {
      const data = await fetchJson("/api/accountant/payroll-runs?view=action_needed");
      setState({ loading: false, error: null, items: data.items || [] });
    } catch (error) {
      setState((c) => ({ loading: false, error: error.message, items: c.items }));
    }
  }, []);
  React.useEffect(() => { load(); }, [load, refreshKey]);

  const branches = [...new Set(state.items.map((i) => i.branch_name || "Branch"))];
  const todo = state.items.filter((i) => !i.info).length;

  return (
    <Card className={cn("min-w-0 shadow-xs", todo && "border-warning/40")} data-testid="action-needed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ListTodoIcon className="size-4" aria-hidden="true" />Action needed{todo ? <StatusBadge tone="warning">{todo}</StatusBadge> : null}</CardTitle>
        <CardDescription>What is still open for payroll, per branch. Each item goes away once it is done.</CardDescription>
        <CardAction><Button variant="outline" size="sm" onClick={load} disabled={state.loading}><RefreshCwIcon className={cn(state.loading && "animate-spin")} aria-hidden="true" />Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.error && !state.items.length ? <ErrorState message={state.error} onRetry={load} /> : null}
        {state.loading && !state.items.length && !state.error ? <Skeleton className="h-12 w-full" /> : null}
        {!state.loading && !state.error && !state.items.length ? (
          <p className="flex items-center gap-2 text-sm text-success" data-testid="action-needed-empty"><CheckCircle2Icon className="size-4" aria-hidden="true" />Nothing to do: every period is processed, submitted and approved.</p>
        ) : null}
        {branches.map((branch) => (
          <section key={branch} className="space-y-1.5" aria-label={branch}>
            {branches.length > 1 || branch ? <h3 className="text-xs font-medium text-muted-foreground uppercase">{branch}</h3> : null}
            <ul className="divide-y rounded-md border">
              {state.items.filter((i) => (i.branch_name || "Branch") === branch).map((item) => {
                const href = portalHref(item.page, item.params || {});
                return (
                  <li key={`${item.kind}-${item.state || ""}-${item.branch_id}-${item.period_label}-${item.run_id || ""}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="action-item" data-kind={item.kind}>
                    <StatusBadge tone={KIND_TONES[item.kind] || "muted"}>{KIND_LABELS[item.kind] || item.kind}</StatusBadge>
                    <span className="font-semibold tabular-nums" data-testid="action-count">{item.count}</span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <span className="text-muted-foreground">{item.period_label} · </span>{item.text}
                      {item.names?.length ? <span className="block text-xs text-muted-foreground">{item.names.slice(0, 8).join(", ")}{item.names.length > 8 ? ` and ${item.names.length - 8} more` : ""}</span> : null}
                      {item.details?.length ? <span className="block text-xs text-muted-foreground">{item.details.map((d) => `${d.employee_name}: ${d.reason}`).join("; ")}</span> : null}
                    </span>
                    {item.info ? <InfoIcon className="size-4 text-muted-foreground" aria-label="Information only" /> : null}
                    <a href={href} onClick={followPortalLink} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" data-testid="action-link">
                      {item.action}<ArrowRightIcon className="size-3.5" aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
