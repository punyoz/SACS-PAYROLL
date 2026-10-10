"use client";

import * as React from "react";
import { GraduationCapIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/portal/data-table";
import { StatusBadge } from "@/components/portal/status-badge";
import { fetchJson } from "@/lib/portal/api";
import { dateLabel } from "@/lib/portal/payroll-preview";

/*
 * Licensed teachers, read-only (Admin: own branch; Super Admin: all —
 * SACS-Payroll-Permission-Matrix.md row 4a). Status, last 4 digits, expiry
 * and verifier only: never the full PRC number or the ID file, and no edit
 * controls (HR edits in User Management). Hidden before 20261009010000.
 */
export function LicensedTeachersCard({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, teachers: null });

  React.useEffect(() => {
    let alive = true;
    fetchJson("/api/hr/teacher-license")
      .then((data) => { if (alive) setState({ loading: false, error: null, teachers: data.available === false ? null : data.teachers || [] }); })
      .catch((error) => { if (alive) setState({ loading: false, error: error.message, teachers: null }); });
    return () => { alive = false; };
  }, [refreshKey]);

  if (!state.loading && state.teachers === null) return null;
  const rows = (state.teachers || []).filter((t) => t.is_licensed_teacher);

  const columns = [
    { key: "full_name", header: "Teacher", sortable: true, className: "font-medium", searchValue: (t) => t.full_name },
    { key: "license", header: "PRC license", className: "tabular-nums", cell: (t) => t.prc_license_masked || "—" },
    { key: "expires", header: "Expires", cell: (t) => dateLabel(t.license_expires_on) },
    { key: "verified", header: "Verified", cell: (t) => (t.verified_at ? `${t.verified_by_name || "HR"} · ${dateLabel(String(t.verified_at).slice(0, 10))}` : "—") },
    { key: "status", header: "Status", cell: (t) => <StatusBadge tone={t.status.tone}>{t.status.label}</StatusBadge> },
  ];

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GraduationCapIcon className="size-4" aria-hidden="true" />Licensed teachers</CardTitle>
        <CardDescription>Read-only. HR turns licenses on, edits and verifies them in User Management.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={rows} loading={state.loading} error={state.error} pageSize={10}
          searchPlaceholder="Search teacher…" empty={{ title: "No licensed teachers", icon: GraduationCapIcon }} caption="Licensed teachers" minWidth={720} />
      </CardContent>
    </Card>
  );
}
