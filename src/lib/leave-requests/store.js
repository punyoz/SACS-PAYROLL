/**
 * Persistent leave-request storage.
 *
 * Priority order (most reliable first):
 *   1. Supabase database table `leave_requests` (if the migration has been applied)
 *   2. Supabase Storage JSON file          (always available via service role key)
 *   3. /tmp filesystem                     (development only — ephemeral on Vercel)
 */

import { createClient } from "@supabase/supabase-js";
import { storageReadJson, storageWriteJson } from "@/lib/storage/supabase-store";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORAGE_FILE = "leave-requests.json";
const tmpPath = path.join(os.tmpdir(), "bncs-payroll-runtime", "leave-requests.json");

// Cached per warm serverless instance to avoid repeated probes.
let _backend = null; // 'table' | 'storage' | 'tmp'

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) return null;
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isMissingTableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("relation") ||
    msg.includes("undefined table")
  );
}

export function normalizeLeaveRequest(row) {
  return {
    id: String(row.id || crypto.randomUUID()),
    employee_id: String(row.employee_id || ""),
    employee_name: String(row.employee_name || "Unknown Employee"),
    position: String(row.position || "Employee"),
    leave_type: String(row.leave_type || "Leave"),
    start_date: String(row.start_date || ""),
    end_date: String(row.end_date || ""),
    reason: String(row.reason || "No reason provided."),
    // Preserve proof_url exactly — it may be a large base64 data URL.
    proof_url: String(row.proof_url || ""),
    status: String(row.status || "pending_accountant").toLowerCase(),
    submitted_at: row.submitted_at || new Date().toISOString(),
    decided_at: row.decided_at || null,
    updated_at: row.updated_at || row.submitted_at || new Date().toISOString(),
  };
}

// ─── Backend Detection ────────────────────────────────────────────────────────

async function detectBackend(supabase) {
  if (_backend) return _backend;

  if (!supabase) {
    _backend = "tmp";
    return _backend;
  }

  const { error } = await supabase.from("leave_requests").select("id").limit(0);
  if (!error) {
    _backend = "table";
  } else {
    // Whether or not the table exists, Supabase Storage is available with the
    // service role key, so prefer it over /tmp.
    _backend = "storage";
  }

  return _backend;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readAllLeaveRequests() {
  const supabase = getAdminClient();
  const backend = await detectBackend(supabase);

  if (backend === "table") {
    try {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("*")
        .order("submitted_at", { ascending: false });

      if (!error) {
        return (data || []).map(normalizeLeaveRequest);
      }

      if (!isMissingTableError(error)) throw new Error(error.message);

      // Table was dropped/missing after detection — fall back.
      _backend = "storage";
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      _backend = "storage";
    }
  }

  if (backend === "storage" || _backend === "storage") {
    try {
      const parsed = await storageReadJson(STORAGE_FILE, { requests: [] });
      const rows = Array.isArray(parsed.requests) ? parsed.requests : [];
      return rows
        .map(normalizeLeaveRequest)
        .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
    } catch {
      // Fall through to /tmp
    }
  }

  // /tmp — last resort
  try {
    const raw = await fs.readFile(tmpPath, "utf8");
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed.requests) ? parsed.requests : [];
    return rows
      .map(normalizeLeaveRequest)
      .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  } catch {
    return [];
  }
}

// ─── Write Helpers ────────────────────────────────────────────────────────────

async function writeAllToStorage(requests) {
  await storageWriteJson(STORAGE_FILE, { requests: requests.map(normalizeLeaveRequest) });
}

async function writeAllToTmp(requests) {
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(
    tmpPath,
    JSON.stringify({ requests: requests.map(normalizeLeaveRequest) }, null, 2),
    "utf8",
  );
}

// ─── Insert ───────────────────────────────────────────────────────────────────

export async function insertLeaveRequest(newRequest) {
  const normalized = normalizeLeaveRequest(newRequest);
  const supabase = getAdminClient();
  const backend = await detectBackend(supabase);

  if (backend === "table") {
    try {
      const { error } = await supabase.from("leave_requests").insert(normalized);
      if (!error) return normalized;
      if (!isMissingTableError(error)) throw new Error(error.message);
      _backend = "storage";
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      _backend = "storage";
    }
  }

  if (_backend === "storage" || backend === "storage") {
    try {
      const existing = await readAllLeaveRequests();
      await writeAllToStorage([normalized, ...existing]);
      return normalized;
    } catch {
      // Fall through to /tmp
    }
  }

  // /tmp fallback
  const existing = await readAllLeaveRequests();
  await writeAllToTmp([normalized, ...existing]);
  return normalized;
}

// ─── Update Status ────────────────────────────────────────────────────────────

export async function updateLeaveRequestStatus(id, nextStatus) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();
  const backend = await detectBackend(supabase);

  if (backend === "table") {
    try {
      const lookupResult = await supabase
        .from("leave_requests")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (lookupResult.error) {
        if (!isMissingTableError(lookupResult.error)) throw new Error(lookupResult.error.message);
        _backend = "storage";
      } else {
        if (!lookupResult.data) return { found: false, request: null };

        const { error } = await supabase
          .from("leave_requests")
          .update({ status: nextStatus, decided_at: nowIso, updated_at: nowIso })
          .eq("id", id);

        if (error) throw new Error(error.message);

        const updated = normalizeLeaveRequest({
          ...lookupResult.data,
          status: nextStatus,
          decided_at: nowIso,
          updated_at: nowIso,
        });
        return { found: true, request: updated };
      }
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      _backend = "storage";
    }
  }

  if (_backend === "storage" || backend === "storage") {
    try {
      const allRequests = await readAllLeaveRequests();
      const index = allRequests.findIndex((r) => r.id === id);
      if (index < 0) return { found: false, request: null };

      const updated = normalizeLeaveRequest({
        ...allRequests[index],
        status: nextStatus,
        decided_at: nowIso,
        updated_at: nowIso,
      });
      allRequests[index] = updated;
      await writeAllToStorage(allRequests);
      return { found: true, request: updated };
    } catch {
      // Fall through to /tmp
    }
  }

  // /tmp fallback
  const allRequests = await readAllLeaveRequests();
  const index = allRequests.findIndex((r) => r.id === id);
  if (index < 0) return { found: false, request: null };

  const updated = normalizeLeaveRequest({
    ...allRequests[index],
    status: nextStatus,
    decided_at: nowIso,
    updated_at: nowIso,
  });
  allRequests[index] = updated;
  await writeAllToTmp(allRequests);
  return { found: true, request: updated };
}
