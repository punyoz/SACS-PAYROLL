import { listUsersCached } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { readAllLeaveRequests, updateLeaveRequestStatus } from "@/lib/leave-requests/store";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) return null;
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getArchivedEmployeeIds(supabase) {
  if (!supabase) return new Set();
  try {
    const { data: { users } = {} } = await listUsersCached(supabase);
    const archived = new Set();
    (users || []).forEach((u) => {
      if (u.user_metadata?.archived === true) archived.add(u.id);
    });
    return archived;
  } catch {
    return new Set();
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending_accountant").trim().toLowerCase();

    const supabase = getAdminClient();
    const [allRequests, archivedIds] = await Promise.all([
      readAllLeaveRequests(),
      getArchivedEmployeeIds(supabase),
    ]);

    const annotated = allRequests.map((r) => ({
      ...r,
      employee_archived: r.employee_id ? archivedIds.has(r.employee_id) : false,
    }));

    const pendingRequests = annotated.filter((row) => row.status === "pending_accountant");
    const historyRequests = annotated.filter((row) => row.status !== "pending_accountant");

    let requests;
    if (status === "all") {
      requests = annotated;
    } else if (status === "history") {
      requests = historyRequests;
    } else {
      requests = annotated.filter((row) => row.status === status);
    }

    return NextResponse.json({
      requests,
      pending_requests: pendingRequests,
      history_requests: historyRequests,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be approve or reject." }, { status: 400 });
    }

    // Verify current status before acting
    const allRequests = await readAllLeaveRequests();
    const current = allRequests.find((row) => row.id === id);

    if (!current) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    if (current.status !== "pending_accountant") {
      return NextResponse.json(
        { error: `Cannot ${action} a leave request with status: ${current.status}.` },
        { status: 400 },
      );
    }

    // Block action if the employee has been archived.
    // Only attempt the lookup when employee_id is a valid UUID — Supabase
    // throws if the value is empty, a SACS code, or any other non-UUID string.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (current.employee_id && UUID_RE.test(current.employee_id)) {
      const supabase = getAdminClient();
      if (supabase) {
        const { data: { user } = {} } = await supabase.auth.admin.getUserById(current.employee_id);
        if (user?.user_metadata?.archived === true) {
          return NextResponse.json(
            { error: "Cannot process leave request for an archived employee." },
            { status: 403 },
          );
        }
      }
    }

    // Accountant approve → forwards to admin; reject → final rejection
    const nextStatus = action === "approve" ? "pending_admin" : "rejected";
    const result = await updateLeaveRequestStatus(id, nextStatus);

    if (!result.found) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, request: result.request });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
