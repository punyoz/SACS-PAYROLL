import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAllSalaryApprovals } from "@/lib/salary-approvals/store";
import { PATCH as patchDashboardData } from "@/app/api/admin/dashboard/route";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same /tmp path the accountant route writes payroll entries to.
const payrollEntriesTmpPath = path.join(
  os.tmpdir(),
  "bncs-payroll-runtime",
  "accountant-payroll-entries.json",
);

// Same Storage bucket/key the accountant route uses for draft persistence.
const DRAFT_BUCKET = "bncs-payroll-runtime";
const DRAFT_STORAGE_KEY = "accountant-draft-entries.json";

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) return null;
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parsePayroll(raw) {
  if (!raw) return null;
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  return p?.totals ? p : null;
}

// Build a Map<approval_id, payroll> from a flat array of payroll entries.
function buildLookupFromEntries(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.approval_id && !map.has(e.approval_id)) {
      const payroll = parsePayroll(e.payroll);
      if (payroll) map.set(e.approval_id, payroll);
    }
  }
  return map;
}

// Approvals stored before the payroll_breakdown column was added have a null
// breakdown.  Enrich them from every available payroll-entries source so that
// the admin approval card can always show the full deduction summary.
async function enrichBreakdowns(approvals) {
  const missing = approvals.filter((a) => !a.payroll_breakdown && a.id);
  if (!missing.length) return;

  const ids = missing.map((a) => a.id);
  const lookup = new Map();

  const supabase = getAdminClient();

  // 1. payroll_entries DB table (most reliable when DB sync succeeded).
  if (supabase) {
    try {
      const { data } = await supabase
        .from("payroll_entries")
        .select("approval_id,payroll")
        .in("approval_id", ids);

      if (data?.length) {
        for (const row of data) {
          const payroll = parsePayroll(row.payroll);
          if (row.approval_id && payroll && !lookup.has(row.approval_id)) {
            lookup.set(row.approval_id, payroll);
          }
        }
      }
    } catch {
      // payroll_entries may not exist — fall through
    }
  }

  // 2. /tmp accountant payroll-entries file (survives within the same instance).
  if (ids.some((id) => !lookup.has(id))) {
    try {
      const raw = await fs.readFile(payrollEntriesTmpPath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const extra = buildLookupFromEntries(entries);
      for (const [id, payroll] of extra) {
        if (!lookup.has(id)) lookup.set(id, payroll);
      }
    } catch {
      // /tmp may be empty on cold starts — fall through
    }
  }

  // 3. Supabase Storage draft file (persists across cold starts).
  if (supabase && ids.some((id) => !lookup.has(id))) {
    try {
      const { data, error } = await supabase.storage
        .from(DRAFT_BUCKET)
        .download(DRAFT_STORAGE_KEY);
      if (!error && data) {
        const text = await data.text();
        const entries = JSON.parse(text);
        if (Array.isArray(entries)) {
          const extra = buildLookupFromEntries(entries);
          for (const [id, payroll] of extra) {
            if (!lookup.has(id)) lookup.set(id, payroll);
          }
        }
      }
    } catch {
      // Storage may be unavailable — fall through
    }
  }

  // Apply whatever we found.
  if (lookup.size > 0) {
    for (const approval of approvals) {
      if (!approval.payroll_breakdown && lookup.has(approval.id)) {
        approval.payroll_breakdown = lookup.get(approval.id);
      }
    }
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending").toLowerCase();

    const allApprovals = await readAllSalaryApprovals();

    // Fill missing payroll_breakdown from payroll_entries sources (no-op when all present).
    await enrichBreakdowns(allApprovals);

    const pendingRequests = allApprovals.filter((row) => row.status === "pending");
    const historyRequests = allApprovals.filter((row) => row.status !== "pending");

    let requests;
    if (status === "all") {
      requests = allApprovals;
    } else if (status === "history") {
      requests = historyRequests;
    } else {
      requests = allApprovals.filter((row) => row.status === status);
    }

    return NextResponse.json({
      requests,
      pending_requests: pendingRequests,
      history_requests: historyRequests,
      can_persist: true,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  return patchDashboardData(request);
}
