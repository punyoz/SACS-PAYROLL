import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const payrollStorePath = path.join(os.tmpdir(), "bncs-payroll-runtime", "accountant-payroll-entries.json");

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

async function readPayrollEntries() {
  try {
    const raw = await fs.readFile(payrollStorePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
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

    let dbRecords = [];
    try {
      const result = await supabase
        .from("payroll_records")
        .select("id, employee_id, employee_name, employee_type, gross_pay, total_deductions, net_pay, period_label, processed_at, payslip_no")
        .eq("employee_id", user.id)
        .order("processed_at", { ascending: false })
        .limit(50);

      if (!result.error && Array.isArray(result.data)) {
        dbRecords = result.data;
      }
    } catch {
      // payroll_records table may not exist
    }

    // Try to enrich with full breakdown from /tmp entries
    const tmpEntries = await readPayrollEntries();
    const entryByPeriod = new Map();
    for (const e of tmpEntries) {
      if (e.employee_id === user.id && !entryByPeriod.has(e.pay_period)) {
        entryByPeriod.set(e.pay_period, e);
      }
    }

    const payslips = dbRecords.map((rec) => {
      const entry = entryByPeriod.get(rec.period_label);
      const base = {
        id: rec.id,
        payslip_no: rec.payslip_no || null,
        period_label: rec.period_label,
        processed_at: rec.processed_at,
        gross_pay: toAmount(rec.gross_pay),
        total_deductions: toAmount(rec.total_deductions),
        net_pay: toAmount(rec.net_pay),
        has_breakdown: false,
      };

      if (entry?.payroll) {
        const p = entry.payroll;
        base.has_breakdown = true;
        base.basic_salary = toAmount(p.basic_salary);
        base.transportation = toAmount(p.allowances?.transportation);
        base.rice = toAmount(p.allowances?.rice);
        base.overtime = toAmount(p.allowances?.overtime);
        base.bonus = toAmount(p.allowances?.bonus);
        base.sss = toAmount(p.deductions?.sss);
        base.philhealth = toAmount(p.deductions?.philhealth);
        base.pagibig = toAmount(p.deductions?.pagibig);
        base.withholding_tax = toAmount(p.deductions?.withholding_tax);
        base.absences_days = toAmount(p.deductions?.absences_days);
        base.absence_deduction = toAmount(p.totals?.absence_deduction);
        base.cash_advance = toAmount(p.deductions?.cash_advance);
      }

      return base;
    });

    return NextResponse.json({ payslips });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
