/**
 * Substitute teaching report (Part C, 2026-11-22): what processed payslips
 * paid for substitutions, by substitute, by absent teacher or by cutoff, with
 * totals. From the substitution lines on non-draft payslips (each tied to its
 * substitution). The file (Excel / PDF) lists the screen's rows.
 *
 *   GET ?from=&to=&by=substitute|absent|cutoff&q=[&format=pdf|xlsx]
 *
 * HR, the Accountant and the Super Admin; a branch-scoped role its own branch.
 * The proxy maps this route to "profile"; the roles are checked here.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";
import { isBranchExemptFor } from "@/lib/rbac/permissions";
import { getServiceClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { sanitizeError } from "@/lib/api-error";
import { reportResponse, wantsFile } from "@/lib/export/report-file";

const READERS = new Set(["hr", "accountant", "super_admin"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BY = { substitute: "Substitute", absent: "Absent teacher", cutoff: "Cutoff" };
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    if (!READERS.has(guard.role)) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    const url = new URL(request.url);
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    if (!DAY.test(from) || !DAY.test(to) || from > to) return NextResponse.json({ error: "Choose a valid date range." }, { status: 400 });
    const by = BY[url.searchParams.get("by")] ? url.searchParams.get("by") : "substitute";
    const allBranches = isBranchExemptFor(guard.role, "payroll_reports") || isBranchExemptFor(guard.role, "hr_reports");
    const supabase = getServiceClient();

    // Payslips that can hold these lines: created from the start of the range (a late approval pays later).
    const { data: entries, error } = await fetchAllRows(() => {
      let q = supabase.from("payroll_entries").select("id,employee_id,employee_name,branch_id,pay_period,status,payroll").neq("status", "draft")
        .gte("created_at", `${from}T00:00:00Z`).order("created_at", { ascending: true });
      if (!allBranches) q = q.eq("branch_id", guard.branchId);
      return q;
    });
    if (error) throw new Error(error.message);
    const lines = [];
    for (const e of entries || []) {
      for (const l of e.payroll?.audit?.lines?.incentives || []) {
        if (l.type !== "substitution" || !l.log_date || l.log_date < from || l.log_date > to) continue;
        lines.push({ ...l, substitute: e.employee_name || "—", cutoff: e.pay_period, entry_status: e.status });
      }
    }
    const subIds = [...new Set(lines.map((l) => l.substitution_id).filter(Boolean))];
    const subs = subIds.length ? (await fetchAllIn(() => supabase.from("substitutions").select("id,absent_employee_id,periods"), "id", subIds)).data || [] : [];
    const absentIds = [...new Set(subs.map((s) => s.absent_employee_id))];
    const names = absentIds.length ? (await fetchAllIn(() => supabase.from("profiles").select("id,full_name"), "id", absentIds)).data || [] : [];
    const nameOf = new Map(names.map((p) => [p.id, p.full_name]));
    const subOf = new Map(subs.map((s) => [s.id, s]));

    const groups = new Map();
    for (const l of lines) {
      const sub = subOf.get(l.substitution_id);
      const absent = nameOf.get(sub?.absent_employee_id) || "—";
      const key = by === "absent" ? absent : by === "cutoff" ? l.cutoff : l.substitute;
      const g = groups.get(key) || { key, substitutions: new Set(), hours: 0, amount: 0 };
      if (l.substitution_id) g.substitutions.add(l.substitution_id);
      g.hours += Number(l.quantity) || 0;
      g.amount += Number(l.amount) || 0;
      groups.set(key, g);
    }
    const search = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const rows = [...groups.values()].map((g) => ({ key: g.key, substitutions: g.substitutions.size, hours: Math.round(g.hours * 100) / 100, amount: peso(g.amount) }))
      .filter((r) => !search || String(r.key).toLowerCase().includes(search))
      .sort((a, b) => b.amount - a.amount || String(a.key).localeCompare(String(b.key)));
    const totals = rows.reduce((t, r) => ({ substitutions: t.substitutions + r.substitutions, hours: Math.round((t.hours + r.hours) * 100) / 100, amount: peso(t.amount + r.amount) }), { substitutions: 0, hours: 0, amount: 0 });

    const format = wantsFile(url);
    if (format) {
      return reportResponse({
        format, fileName: `substitutions_${from}_${to}_by-${by}`, title: `Substitute teaching by ${BY[by].toLowerCase()}`,
        period: `${from} to ${to}`, filters: [["Search", search]],
        columns: [{ header: BY[by] }, { header: "Substitutions", kind: "number", integer: true }, { header: "Hours", kind: "number" }, { header: "Paid", kind: "money" }],
        rows: rows.map((r) => [r.key, r.substitutions, r.hours, r.amount]), totals: true,
        empty: "No substitutions paid in this range.",
      });
    }
    return NextResponse.json({ by, rows, totals });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
