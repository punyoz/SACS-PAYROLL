import { leaveApprovedAfterFinal } from "@/lib/payroll/final-payslips";
import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { branchCounts } from "@/lib/branch-counts";
import { sanitizeError } from "@/lib/api-error";
import { readLeaveRequestsWithoutProof } from "@/lib/leave-requests/store";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { attendanceBucket, isPresentRow } from "@/lib/attendance/status";
import { countAbsentToday } from "@/lib/attendance/not-tapped";
import { requirePermission } from "@/lib/rbac/guard";
import { SCOPE_SELF } from "@/lib/rbac/permissions";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey as getDateKey } from "@/lib/payroll/periods";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { isOnPayroll } from "@/lib/payroll/on-payroll";

// Statuses attendance_missing_days leaves out (20261110020000 private.is_active_staff).
const GONE = ["Inactive", "Archived", "Separated"];

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "dashboard", "read");
    if (guard.denied) return guard.denied;

    // This endpoint returns branch/company-wide aggregates, not one person's
    // own records — a SCOPE_SELF caller (Employee) has "dashboard read" for
    // their own portal's stats endpoint, but that grant does not extend here.
    if (guard.scope === SCOPE_SELF) {
      return NextResponse.json({ error: "You do not have permission to perform this action." }, { status: 403 });
    }

    const supabase = getAdminClient();

    // Fetch all users
    const usersResult = await listUsersCached(supabase);
    if (usersResult.error) throw new Error(usersResult.error.message);

    const allUsers = usersResult.data.users || [];
    const candidateEmployees = allUsers.filter((u) => {
      const role = String(u.user_metadata?.role || "employee").toLowerCase();
      // The people who work: the same set "Absent today" counts from
      // (public.attendance_missing_days): Employee, Accountant and HR -- the
      // viewer too, HR is on payroll -- not archived, Inactive or Separated.
      // So Present + Absent (+ on leave / day off) adds up to this total.
      const status = String(u.user_metadata?.employee_status || "Active");
      return ["employee", "accountant", "hr"].includes(role) && !u.user_metadata?.archived && !GONE.includes(status) && isOnPayroll(u);
    });

    let employees = candidateEmployees;
    if (!guard.branchExempt) {
      const userIds = candidateEmployees.map((u) => u.id);
      const branchMap = new Map();
      if (userIds.length) {
        const { data: profileRows } = await fetchAllIn(() => supabase
          .from("profiles")
          .select("id,branch_id")
          .order("id", { ascending: true }), "id", userIds);
        (profileRows || []).forEach((row) => branchMap.set(row.id, row.branch_id));
      }
      employees = candidateEmployees.filter(
        (u) => String(branchMap.get(u.id) || u.user_metadata?.branch_id || "") === String(guard.branchId || ""),
      );
    }

    const totalEmployees = employees.length;

    // Attendance today
    const today = getDateKey();
    let presentToday = 0;
    let lateToday = 0;
    let absentToday = 0;
    // Part J (2026-11-22): today's attendance chart, each status on its own.
    let absentMarkedToday = 0;
    let onLeaveToday = 0;

    try {
      let attQuery = supabase
        .from("attendance_logs")
        .select("employee_id, status, time_in, time_out, log_date")
        .eq("log_date", today)
        .eq("archived_duplicate", false);
      if (!guard.branchExempt) attQuery = attQuery.eq("branch_id", guard.branchId);
      const { data: attRows } = await attQuery;

      if (Array.isArray(attRows)) {
        // One record per employee: status comes from the day's first tap.
        // Present = the shared group (Late included, decision 2026-11-14).
        collapseDailyTaps(attRows, { dateKey: () => today }).forEach((row) => {
          if (isPresentRow(row, today)) presentToday++;
          if (attendanceBucket(row.status) === "late") lateToday++;
          if (attendanceBucket(row.status) === "absent") absentMarkedToday++;
          if (attendanceBucket(row.status) === "leave") onLeaveToday++;
        });
      }
      // Absent = scheduled today with no record (the board's "Not tapped yet").
      absentToday = await countAbsentToday(supabase, { dateKey: today, employeeIds: guard.branchExempt ? null : employees.map((u) => u.id) });
    } catch {
      absentToday = 0;
    }

    // Pending leave requests
    let pendingLeaves = 0;
    try {
      const pendingRows = await readLeaveRequestsWithoutProof({
        statuses: ["pending_admin", "pending_accountant"],
        ...(guard.branchExempt ? {} : { branchId: guard.branchId || "00000000-0000-0000-0000-000000000000" }),
      });
      pendingLeaves = pendingRows.length;
    } catch { /* ignore */ }

    // Recent attendance activity (last 10 employee-days). Fetches more raw
    // rows than needed because multiple taps a day share one employee-day
    // slot once collapsed — without this, a single employee's repeat taps
    // could fill the whole "recent" list with duplicates of themselves.
    let recentActivity = [];
    try {
      let recentQuery = supabase
        .from("attendance_logs")
        .select("employee_id, employee_name, log_date, time_in, time_out, status, created_at")
        .eq("archived_duplicate", false)
        .order("created_at", { ascending: false })
        .limit(40);
      if (!guard.branchExempt) recentQuery = recentQuery.eq("branch_id", guard.branchId);
      const { data: recent } = await recentQuery;
      const collapsed = collapseDailyTaps(recent || []).sort((a, b) => {
        const aTime = new Date(a.time_out || a.time_in || 0).getTime();
        const bTime = new Date(b.time_out || b.time_in || 0).getTime();
        return bTime - aTime;
      });
      recentActivity = collapsed.slice(0, 10).map((row) => ({
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        date: row.log_date,
        time_in: row.time_in,
        time_out: row.time_out,
        total_hours: row.total_hours,
        status: row.status,
      }));
    } catch { /* ignore */ }

    // Employee type breakdown. No type on record reads as Teaching, the same
    // default as User Management, so the two add up to the total.
    const teaching = employees.filter((u) =>
      String(u.user_metadata?.employee_type || "Teaching").toLowerCase() === "teaching"
    ).length;
    const nonTeaching = employees.filter((u) =>
      String(u.user_metadata?.employee_type || "").toLowerCase() === "non-teaching"
    ).length;

    // Action needed (Part A, 20261121010000): records to confirm, probations and
    // contracts ending within the reminder windows. Never fails the dashboard.
    let actionNeeded = { unconfirmed: [], probation_ending: [], contract_ending: [], salary_not_set: [], date_hired_not_set: [], branch_not_set: [], leave_after_payslip: [] };
    try {
      // Not the viewer's own record: another HR confirms it.
      const ids = employees.map((u) => u.id).filter((id) => id !== guard.userId);
      const [rows, cfg] = await Promise.all([
        fetchAllIn(() => supabase.from("profiles").select("id,full_name,employment_status,contract_end_date,classification_unconfirmed").order("id", { ascending: true }), "id", ids),
        supabase.from("system_config").select("key,value").eq("section", "hr").in("key", ["probation_reminder_days", "contract_reminder_days"]),
      ]);
      const days = (key) => Number((cfg.data || []).find((r) => r.key === key)?.value) || 30;
      const plus = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
      const people = rows.data || [];
      const probation = await Promise.all(people.filter((p) => ["Probationary", "Provisional"].includes(p.employment_status)).map(async (p) => {
        const end = await supabase.rpc("employee_probation_end", { p_employee: p.id });
        return { id: p.id, full_name: p.full_name, due_on: end.data || null };
      }));
      actionNeeded = {
        unconfirmed: people.filter((p) => p.classification_unconfirmed).map((p) => ({ id: p.id, full_name: p.full_name })),
        probation_ending: probation.filter((p) => p.due_on && p.due_on >= today && p.due_on <= plus(days("probation_reminder_days"))),
        contract_ending: people.filter((p) => p.contract_end_date && p.contract_end_date >= today && p.contract_end_date <= plus(days("contract_reminder_days")))
          .map((p) => ({ id: p.id, full_name: p.full_name, due_on: p.contract_end_date })),
        salary_not_set: [],
        date_hired_not_set: [],
        branch_not_set: [],
        leave_after_payslip: [],
      };
    } catch { /* ignore */ }
    // Salary not set (2026-11-22): every on-payroll account with a ₱0 salary;
    // payroll refuses to process them until the salary is set.
    try {
      let zero = supabase.from("profiles").select("id,full_name,role,branch_id")
        .or("basic_salary.is.null,basic_salary.eq.0")
        .not("archived", "is", true)
        .not("on_payroll", "is", false)
        .in("role", ["employee", "accountant", "hr"])
        .order("full_name", { ascending: true });
      if (!guard.branchExempt) zero = zero.eq("branch_id", guard.branchId);
      const { data } = await zero;
      actionNeeded.salary_not_set = (data || []).map((p) => ({ id: p.id, full_name: p.full_name, role: p.role }));
    } catch { /* ignore */ }
    // Date hired not set (2026-11-22): tenure, proration and leave accrual count from it
    // (Part G cannot count anyone without one). Every on-payroll account, any role.
    try {
      let undated = supabase.from("profiles").select("id,full_name,role,branch_id")
        .is("date_hired", null)
        .not("archived", "is", true)
        .not("on_payroll", "is", false)
        .in("role", ["employee", "accountant", "hr"])
        .order("full_name", { ascending: true });
      if (!guard.branchExempt) undated = undated.eq("branch_id", guard.branchId);
      const { data } = await undated;
      actionNeeded.date_hired_not_set = (data || []).map((p) => ({ id: p.id, full_name: p.full_name, role: p.role }));
    } catch { /* ignore */ }
    // Branch not set (2026-11-23): AWOL detection skips anyone without a branch until one is set
    // (for HR: the home branch whose Accountant processes their payslip). HR sees every branch.
    if (guard.branchExempt) {
      try {
        const { data } = await supabase.from("profiles").select("id,full_name,role")
          .is("branch_id", null)
          .not("archived", "is", true)
          .not("on_payroll", "is", false)
          .in("role", ["employee", "accountant", "hr"])
          .order("full_name", { ascending: true });
        actionNeeded.branch_not_set = (data || []).map((p) => ({ id: p.id, full_name: p.full_name, role: p.role }));
      } catch { /* ignore */ }
    }
    // Leave approved after its day's Final payslip (Part B, 2026-11-22): a
    // correction on the next payslip. Approvals of the last 60 days, branch-scoped.
    try {
      const since = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 864e5).toISOString();
      let recent = supabase.from("leave_requests").select("id,employee_id,employee_name,leave_type,start_date,end_date,status,decided_at,half_day,branch_id")
        .eq("status", "approved").gte("decided_at", since).order("decided_at", { ascending: false }).limit(500);
      if (!guard.branchExempt) recent = recent.eq("branch_id", guard.branchId);
      const { data: leaves } = await recent;
      const ids = [...new Set((leaves || []).map((l) => String(l.employee_id)))];
      if (ids.length) {
        const finals = await fetchAllIn(() => supabase.from("payroll_entries").select("id,employee_id,pay_period,status,payslip_no,payroll,submitted_at,updated_at").eq("status", "paid"), "employee_id", ids);
        actionNeeded.leave_after_payslip = leaveApprovedAfterFinal(leaves, finals.data || []);
      }
    } catch { /* ignore */ }

    // 2026-11-24: on payroll with no ACTIVE RFID card: AWOL never runs for them (no taps prove nothing).
    actionNeeded.no_card = [];
    try {
      const { data: staff } = await supabase.from("profiles").select("id,full_name,role").eq("archived", false).eq("on_payroll", true).in("role", ["employee", "accountant", "hr"]);
      const { data: cards } = await supabase.from("rfid_cards").select("employee_id").eq("status", "active");
      const has = new Set((cards || []).map((k) => String(k.employee_id)));
      actionNeeded.no_card = (staff || []).filter((p) => !has.has(String(p.id))).map((p) => ({ id: p.id, full_name: p.full_name }));
    } catch { /* ignore */ }
    // 2026-11-24 (no Automation card): what the system could not decide, and what waits too long, with the reason.
    actionNeeded.automation = [];
    try {
      const { data: stuck } = await supabase.from("automation_actions").select("id,summary,reason,status,escalated_at,created_at,module")
        .or("status.eq.couldnt_decide,and(status.in.(with_hr,open),escalated_at.not.is.null)").order("created_at", { ascending: false }).limit(50);
      actionNeeded.automation = (stuck || []).map((a) => ({ id: a.id, full_name: a.summary,
        detail: a.status === "couldnt_decide" ? `Couldn't decide: ${a.reason || "no reason given"}` : "Waiting too long" }));
    } catch { /* ignore */ }

    // Per branch, the same numbers each branch's Admin sees (src/lib/branch-counts.js, 2026-11-24).
    let byBranch = [];
    try {
      let bq = supabase.from("branches").select("id,name,status").order("name", { ascending: true });
      if (!guard.branchExempt && guard.branchId) bq = bq.eq("id", guard.branchId);
      const { data: brs } = await bq;
      const open = (brs || []).filter((b) => String(b.status || "active").toLowerCase() !== "closed");
      byBranch = await Promise.all(open.map(async (b) => ({ branch_id: b.id, branch_name: b.name, ...(await branchCounts(supabase, b.id, today)) })));
    } catch { /* ignore */ }

    return NextResponse.json({
      branch_counts: byBranch,
      action_needed: actionNeeded,
      total_employees: totalEmployees,
      teaching_staff: teaching,
      non_teaching_staff: nonTeaching,
      present_today: presentToday,
      late_today: lateToday,
      absent_today: absentToday,
      // Part J: Absent / On Leave records today (the "Not tapped yet" count is absent_today).
      absent_marked_today: absentMarkedToday,
      on_leave_today: onLeaveToday,
      pending_leaves: pendingLeaves,
      recent_activity: recentActivity,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
