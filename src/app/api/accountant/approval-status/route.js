import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET() {
  try {
    const supabase = getAdminClient();

    const [salaryResult, leaveResult] = await Promise.all([
      supabase
        .from("salary_approvals")
        .select("id,employee_name,employee_code,employee_type,current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at")
        .order("submitted_at", { ascending: false }),
      supabase
        .from("leave_requests")
        .select("id,employee_name,leave_type,start_date,end_date,status,submitted_at,decided_at,updated_at")
        .not("status", "eq", "pending_accountant")
        .order("submitted_at", { ascending: false }),
    ]);

    const salaryApprovals = salaryResult.error ? [] : (salaryResult.data || []);
    const leaveForwards = leaveResult.error ? [] : (leaveResult.data || []);

    return NextResponse.json({
      salary_approvals: salaryApprovals,
      leave_forwards: leaveForwards,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
