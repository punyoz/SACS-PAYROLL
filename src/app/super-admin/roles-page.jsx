"use client";

import { CheckIcon, ShieldCheckIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/portal/status-badge";

/*
 * Roles & Permissions: the Role Access Matrix of public/legacy/pages/
 * super-admin.html (static; the rules themselves live in
 * src/lib/rbac/permissions.js). "✅" cells become a check mark plus text.
 */

const COLUMNS = ["Dashboard", "Employees & Accounts", "Transfers", "Attendance", "Payroll", "Leave", "Reports", "System"];

const ROWS = [
  { role: "Super Admin", tone: "info", cells: [[true, "All branches"], "Admin & HR logins", null, [true, "All branches"], "View", [true], [true], [true, "Full"]] },
  { role: "Admin", tone: "gold", cells: [[true, "Own branch"], null, null, [true, "Own branch"], "View", "View", [true, "Branch reports"], "RFID & audit logs"] },
  { role: "HR", tone: "warning", cells: [[true, "Own branch"], [true, "All branches (Employee & Accountant)"], [true, "All branches"], [true, "Own branch"], null, [true, "Approve"], [true, "HR reports"], null] },
  { role: "Accountant", tone: "success", cells: [[true, "Own branch"], null, null, "View", [true, "Process"], null, [true, "Payroll reports"], null] },
  { role: "Employee", tone: "muted", cells: [[true, "Own"], "Own profile", null, "View own", "Own payslips", [true, "Request"], null, null] },
];

function Access({ value }) {
  if (value === null) return <span className="text-muted-foreground" aria-label="No access">—</span>;
  if (typeof value === "string") return <span>{value}</span>;
  const [, text] = value;
  return (
    <span className="inline-flex items-start gap-1.5">
      <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <span>{text || "Yes"}</span>
    </span>
  );
}

export function RolesPage() {
  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-4 text-gold-text" aria-hidden="true" />Role access matrix</CardTitle>
        <CardDescription>
          Employee and Accountant accounts are managed by HR; Super Admin, Admin and HR logins are created under Admin &amp; HR Accounts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-240">
            <TableCaption className="sr-only">What each role can reach</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                {COLUMNS.map((c) => <TableHead key={c}>{c}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((row) => (
                <TableRow key={row.role}>
                  <TableCell><StatusBadge tone={row.tone} dot={false} className="font-semibold">{row.role}</StatusBadge></TableCell>
                  {row.cells.map((cell, i) => <TableCell key={COLUMNS[i]} className="align-top whitespace-normal"><Access value={cell} /></TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
