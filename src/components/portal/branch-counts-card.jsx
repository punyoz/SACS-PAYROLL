"use client";

import { Building2Icon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BRANCH_COUNT_LABELS } from "@/lib/branch-counts";

/*
 * A branch's numbers (2026-11-24): the same on the branch Admin's dashboard
 * (their branch) and on HR's (each branch), from one function on the server
 * (src/lib/branch-counts.js).
 */

const KEYS = Object.keys(BRANCH_COUNT_LABELS);

export function BranchCountsCard({ counts, rows = null }) {
  const list = rows || (counts ? [{ branch_id: "mine", branch_name: null, ...counts }] : []);
  if (!list.length) return null;
  return (
    <Card className="min-w-0 shadow-xs" data-testid="branch-counts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Building2Icon className="size-4 text-gold-text" aria-hidden="true" />{rows ? "By branch" : "Your branch"}</CardTitle>
        <CardDescription>{rows ? "Each branch's numbers, the same its branch Admin sees." : "The same numbers HR sees for your branch."}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {rows ? <th className="py-2 pr-3 font-medium">Branch</th> : null}
              {KEYS.map((k) => <th key={k} className="py-2 pr-3 text-right font-medium">{BRANCH_COUNT_LABELS[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.branch_id} className="border-b last:border-0" data-testid="branch-counts-row" data-branch={r.branch_id}>
                {rows ? <td className="py-2 pr-3 font-medium">{r.branch_name}</td> : null}
                {KEYS.map((k) => <td key={k} className="py-2 pr-3 text-right tabular-nums" data-count={k}>{Number(r[k]) || 0}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
