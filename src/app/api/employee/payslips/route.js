import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same paths the accountant route uses.
const payrollEntriesTmpPath = path.join(
  os.tmpdir(),
  "bncs-payroll-runtime",
  "accountant-payroll-entries.json",
);
const DRAFT_BUCKET = "bncs-payroll-runtime";
const DRAFT_STORAGE_KEY = "accountant-draft-entries.json";

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function toAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function payPeriodToLabel(payPeriod) {
  if (!payPeriod) return null;
  const pp = String(payPeriod).trim();
  if (/^\d{4}-\d{2}$/.test(pp)) {
    return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(
      new Date(pp + "-01T00:00:00"),
    );
  }
  return pp;
}

// Map a payroll_entries row (or /tmp entry) — has full JSONB payroll.
function mapPayrollEntryToPayslip(row) {
  const payroll =
    (typeof row.payroll === "string" ? JSON.parse(row.payroll) : row.payroll) || {};
  const totals = payroll.totals || {};
  const allowances = payroll.allowances || {};
  const deductions = payroll.deductions || {};

  const grossPay = toAmount(totals.gross_pay ?? payroll.basic_salary ?? 0);
  const totalDeductions = toAmount(totals.total_deductions ?? 0);
  const netPay = toAmount(totals.net_pay ?? grossPay - totalDeductions);

  const periodLabel =
    payPeriodToLabel(row.pay_period) ||
    new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(
      new Date(row.submitted_at || row.created_at || Date.now()),
    );

  return {
    id: row.id,
    payslip_no: row.payslip_no || null,
    period_label: periodLabel,
    processed_at: row.submitted_at || row.created_at,
    gross_pay: grossPay,
    total_deductions: totalDeductions,
    net_pay: netPay,
    has_breakdown: true,
    basic_salary: toAmount(payroll.basic_salary),
    transportation: toAmount(allowances.transportation),
    rice: toAmount(allowances.rice),
    overtime: toAmount(allowances.overtime),
    bonus: toAmount(allowances.bonus),
    sss: toAmount(deductions.sss),
    philhealth: toAmount(deductions.philhealth),
    pagibig: toAmount(deductions.pagibig),
    withholding_tax: toAmount(deductions.withholding_tax),
    absences_days: toAmount(deductions.absences_days),
    absence_deduction: toAmount(totals.absence_deduction),
    cash_advance: toAmount(deductions.cash_advance),
  };
}

// Map a salary_approvals row — uses payroll_breakdown JSONB when present.
function mapApprovalToPayslip(row) {
  const bd =
    (typeof row.payroll_breakdown === "string"
      ? JSON.parse(row.payroll_breakdown)
      : row.payroll_breakdown) || {};
  const totals = bd.totals || {};
  const allowances = bd.allowances || {};
  const deductions = bd.deductions || {};
  const hasBreakdown = Object.keys(bd).length > 0;

  const grossPay = hasBreakdown
    ? toAmount(totals.gross_pay ?? bd.basic_salary ?? 0)
    : toAmount(row.proposed_salary || row.current_salary || 0);
  const totalDeductions = hasBreakdown ? toAmount(totals.total_deductions ?? 0) : 0;
  const netPay = hasBreakdown
    ? toAmount(totals.net_pay ?? grossPay - totalDeductions)
    : grossPay;

  const periodLabel = new Intl.DateTimeFormat("en-PH", {
    month: "long",
    year: "numeric",
  }).format(new Date(row.submitted_at || Date.now()));

  return {
    id: row.id,
    payslip_no: null,
    period_label: periodLabel,
    processed_at: row.submitted_at,
    gross_pay: grossPay,
    total_deductions: totalDeductions,
    net_pay: netPay,
    has_breakdown: hasBreakdown,
    basic_salary: toAmount(bd.basic_salary),
    transportation: toAmount(allowances.transportation),
    rice: toAmount(allowances.rice),
    overtime: toAmount(allowances.overtime),
    bonus: toAmount(allowances.bonus),
    sss: toAmount(deductions.sss),
    philhealth: toAmount(deductions.philhealth),
    pagibig: toAmount(deductions.pagibig),
    withholding_tax: toAmount(deductions.withholding_tax),
    absences_days: toAmount(deductions.absences_days),
    absence_deduction: toAmount(totals.absence_deduction),
    cash_advance: toAmount(deductions.cash_advance),
  };
}

// Map a payroll_records row — totals only, no per-deduction breakdown.
function mapRecordToPayslip(rec) {
  return {
    id: rec.id,
    payslip_no: rec.payslip_no || null,
    period_label: payPeriodToLabel(rec.period_label) || rec.period_label,
    processed_at: rec.processed_at,
    gross_pay: toAmount(rec.gross_pay),
    total_deductions: toAmount(rec.total_deductions),
    net_pay: toAmount(rec.net_pay),
    has_breakdown: false,
  };
}

async function fetchPayslipsForUser(supabase, userId) {
  // ── 1. payroll_entries DB ─────────────────────────────────────────────────
  // Full JSONB payroll column; payslip_no present after migration is applied.
  try {
    // Try with payslip_no first (migration applied).
    let result = await supabase
      .from("payroll_entries")
      .select("id,employee_id,pay_period,status,payroll,payslip_no,submitted_at,created_at")
      .eq("employee_id", userId)
      .not("status", "eq", "draft")
      .order("created_at", { ascending: false })
      .limit(50);

    // Retry without payslip_no if the column doesn't exist yet.
    if (result.error && String(result.error.message || "").toLowerCase().includes("payslip_no")) {
      result = await supabase
        .from("payroll_entries")
        .select("id,employee_id,pay_period,status,payroll,submitted_at,created_at")
        .eq("employee_id", userId)
        .not("status", "eq", "draft")
        .order("created_at", { ascending: false })
        .limit(50);
    }

    if (!result.error && Array.isArray(result.data) && result.data.length > 0) {
      return result.data.map(mapPayrollEntryToPayslip);
    }
  } catch {
    // payroll_entries table may not exist — fall through
  }

  // ── 2. /tmp accountant payroll-entries file ───────────────────────────────
  // Same instance as the accountant route: always fresh, has full payroll JSONB.
  try {
    const raw = await fs.readFile(payrollEntriesTmpPath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const matched = entries
      .filter((e) => e.employee_id === userId && e.status !== "draft")
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 50);

    if (matched.length > 0) {
      return matched.map(mapPayrollEntryToPayslip);
    }
  } catch {
    // /tmp empty on cold start — fall through
  }

  // ── 3. Supabase Storage draft file ────────────────────────────────────────
  // Survives cold starts; written by the accountant route on every submit.
  try {
    const { data, error } = await supabase.storage
      .from(DRAFT_BUCKET)
      .download(DRAFT_STORAGE_KEY);
    if (!error && data) {
      const text = await data.text();
      const entries = JSON.parse(text);
      if (Array.isArray(entries)) {
        const matched = entries
          .filter((e) => e.employee_id === userId && e.status !== "draft")
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
          .slice(0, 50);
        if (matched.length > 0) {
          return matched.map(mapPayrollEntryToPayslip);
        }
      }
    }
  } catch {
    // Storage unavailable — fall through
  }

  // ── 4. salary_approvals (approved only, with payroll_breakdown) ───────────
  try {
    const { data, error } = await supabase
      .from("salary_approvals")
      .select(
        "id,employee_id,current_salary,proposed_salary,submitted_at,status,payroll_breakdown",
      )
      .eq("employee_id", userId)
      .eq("status", "approved")
      .order("submitted_at", { ascending: false })
      .limit(50);

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map(mapApprovalToPayslip);
    }
  } catch {
    // payroll_breakdown column may not exist — retry without it
    try {
      const { data, error } = await supabase
        .from("salary_approvals")
        .select("id,employee_id,current_salary,proposed_salary,submitted_at,status")
        .eq("employee_id", userId)
        .eq("status", "approved")
        .order("submitted_at", { ascending: false })
        .limit(50);

      if (!error && Array.isArray(data) && data.length > 0) {
        return data.map((row) => mapApprovalToPayslip({ ...row, payroll_breakdown: null }));
      }
    } catch {
      // fall through
    }
  }

  // ── 5. payroll_records — legacy totals table ──────────────────────────────
  try {
    const { data, error } = await supabase
      .from("payroll_records")
      .select(
        "id,employee_id,employee_name,employee_type,gross_pay,total_deductions,net_pay,period_label,processed_at,payslip_no",
      )
      .eq("employee_id", userId)
      .order("processed_at", { ascending: false })
      .limit(50);

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map(mapRecordToPayslip);
    }
  } catch {
    // payroll_records table may not exist
  }

  return [];
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();

    if (!email) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }

    const supabase = getAdminClient();

    const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersResult.error) {
      throw new Error(`Failed to list users: ${usersResult.error.message}`);
    }

    const user = (usersResult.data.users || []).find(
      (u) => String(u.email || "").trim().toLowerCase() === email,
    );

    if (!user) {
      return NextResponse.json({ payslips: [] });
    }

    const payslips = await fetchPayslipsForUser(supabase, user.id);

    return NextResponse.json({ payslips });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
