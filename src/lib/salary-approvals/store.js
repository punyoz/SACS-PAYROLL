/**
 * Persistent salary-approval storage — mirrors leave-requests/store.js.
 *
 * Priority order (most reliable first):
 *   1. Supabase database table `salary_approvals`
 *   2. Supabase Storage JSON file (sacs-payroll-store bucket)
 *   3. /tmp filesystem (development only — ephemeral on Vercel)
 */

import { createClient } from "@supabase/supabase-js";
import { storageReadJson, storageWriteJson } from "@/lib/storage/supabase-store";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORAGE_FILE = "salary-approvals.json";
const tmpPath = path.join(os.tmpdir(), "sacs-payroll-runtime", "salary-approvals.json");

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

export function normalizeSalaryApproval(row) {
  let payrollBreakdown = row.payroll_breakdown || null;
  if (typeof payrollBreakdown === "string") {
    try { payrollBreakdown = JSON.parse(payrollBreakdown); } catch { payrollBreakdown = null; }
  }

  return {
    id: String(row.id || ""),
    employee_id: String(row.employee_id || ""),
    employee_name: String(row.employee_name || "Unknown Employee"),
    employee_code: String(row.employee_code || ""),
    employee_type: String(row.employee_type || "Teaching"),
    position: String(row.position || "Employee"),
    current_salary: Number(row.current_salary || 0),
    proposed_salary: Number(row.proposed_salary || 0),
    reason: String(row.reason || "No reason provided."),
    submitted_by: String(row.submitted_by || "Accountant"),
    submitted_at: row.submitted_at || new Date().toISOString(),
    status: String(row.status || "pending").toLowerCase(),
    decided_at: row.decided_at || null,
    payroll_breakdown: payrollBreakdown,
  };
}

// ─── Backend Detection ────────────────────────────────────────────────────────

async function detectBackend(supabase) {
  if (_backend) return _backend;

  if (!supabase) {
    _backend = "tmp";
    return _backend;
  }

  const { error } = await supabase.from("salary_approvals").select("id").limit(0);
  _backend = error ? "storage" : "table";
  return _backend;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

const FULL_SELECT =
  "id,employee_id,employee_name,employee_code,employee_type,position," +
  "current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at,payroll_breakdown";

const BASE_SELECT =
  "id,employee_id,employee_name,employee_code,employee_type,position," +
  "current_salary,proposed_salary,reason,submitted_by,submitted_at,status,decided_at";

function isNewColumnMissing(error) {
  return String(error?.message || "").toLowerCase().includes("payroll_breakdown");
}

export async function readAllSalaryApprovals() {
  const supabase = getAdminClient();
  const backend = await detectBackend(supabase);

  if (backend === "table") {
    try {
      let { data, error } = await supabase
        .from("salary_approvals")
        .select(FULL_SELECT)
        .order("submitted_at", { ascending: false });

      // Migration may not have run yet — retry without payroll_breakdown
      // instead of falling back to storage (which would lose all DB records).
      if (error && isNewColumnMissing(error)) {
        const r2 = await supabase
          .from("salary_approvals")
          .select(BASE_SELECT)
          .order("submitted_at", { ascending: false });
        data = r2.data;
        error = r2.error;
      }

      if (!error) {
        return (data || []).map(normalizeSalaryApproval);
      }

      if (!isMissingTableError(error)) throw new Error(error.message);
      _backend = "storage";
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      _backend = "storage";
    }
  }

  if (_backend === "storage" || backend === "storage") {
    try {
      const parsed = await storageReadJson(STORAGE_FILE, { approvals: [] });
      const rows = Array.isArray(parsed.approvals) ? parsed.approvals : [];
      return rows
        .map(normalizeSalaryApproval)
        .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
    } catch {
      // Fall through to /tmp
    }
  }

  // /tmp — last resort
  try {
    const raw = await fs.readFile(tmpPath, "utf8");
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed.approvals) ? parsed.approvals : [];
    return rows
      .map(normalizeSalaryApproval)
      .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  } catch {
    return [];
  }
}

// ─── Write Helpers ────────────────────────────────────────────────────────────

async function writeAllToStorage(approvals) {
  await storageWriteJson(STORAGE_FILE, {
    approvals: approvals.map(normalizeSalaryApproval),
  });
}

async function writeAllToTmp(approvals) {
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(
    tmpPath,
    JSON.stringify({ approvals: approvals.map(normalizeSalaryApproval) }, null, 2),
    "utf8",
  );
}

// ─── Update Status ────────────────────────────────────────────────────────────

export async function updateSalaryApprovalStatus(id, nextStatus) {
  const nowIso = new Date().toISOString();
  const supabase = getAdminClient();
  const backend = await detectBackend(supabase);

  if (backend === "table") {
    try {
      // Fetch the current record first.
      let lookupResult = await supabase
        .from("salary_approvals")
        .select(FULL_SELECT)
        .eq("id", id)
        .maybeSingle();

      if (lookupResult.error && isNewColumnMissing(lookupResult.error)) {
        lookupResult = await supabase
          .from("salary_approvals")
          .select(BASE_SELECT)
          .eq("id", id)
          .maybeSingle();
      }

      if (lookupResult.error) {
        if (!isMissingTableError(lookupResult.error)) throw new Error(lookupResult.error.message);
        _backend = "storage";
      } else {
        if (!lookupResult.data) return { found: false, approval: null };

        // Try the UPDATE. Attempt with decided_at first; if that column is missing
        // in the schema, retry with just status.
        let updateError = null;

        const { error: err1 } = await supabase
          .from("salary_approvals")
          .update({ status: nextStatus, decided_at: nowIso })
          .eq("id", id);

        if (err1) {
          const msg = String(err1.message || "").toLowerCase();
          if (msg.includes("decided_at")) {
            // Column missing — retry without it.
            const { error: err2 } = await supabase
              .from("salary_approvals")
              .update({ status: nextStatus })
              .eq("id", id);
            updateError = err2;
          } else {
            updateError = err1;
          }
        }

        if (!updateError) {
          // DB update succeeded.
          const updated = normalizeSalaryApproval({
            ...lookupResult.data,
            status: nextStatus,
            decided_at: nowIso,
          });
          return { found: true, approval: updated };
        }

        // DB update failed (trigger/permission error). Fall back: read all from DB,
        // apply the change in memory, and write the full list to Storage so that
        // subsequent reads return the correct state.
        let allRowsResult = await supabase
          .from("salary_approvals")
          .select(FULL_SELECT)
          .order("submitted_at", { ascending: false });
        if (allRowsResult.error && isNewColumnMissing(allRowsResult.error)) {
          allRowsResult = await supabase
            .from("salary_approvals")
            .select(BASE_SELECT)
            .order("submitted_at", { ascending: false });
        }
        const { data: allRows } = allRowsResult;

        const all = (allRows || []).map(normalizeSalaryApproval);
        const idx = all.findIndex((r) => r.id === id);
        const updated = normalizeSalaryApproval({
          ...(idx >= 0 ? all[idx] : lookupResult.data),
          status: nextStatus,
          decided_at: nowIso,
        });
        if (idx >= 0) all[idx] = updated;

        // Persist to Storage so the next request sees the correct state.
        _backend = "storage";
        try {
          await writeAllToStorage(all);
        } catch {
          await writeAllToTmp(all).catch(() => {});
        }

        return { found: true, approval: updated };
      }
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      _backend = "storage";
    }
  }

  // Storage path
  if (_backend === "storage" || backend === "storage") {
    try {
      const all = await readAllSalaryApprovals();
      const idx = all.findIndex((r) => r.id === id);
      if (idx < 0) return { found: false, approval: null };

      const updated = normalizeSalaryApproval({
        ...all[idx],
        status: nextStatus,
        decided_at: nowIso,
      });
      all[idx] = updated;
      await writeAllToStorage(all);
      return { found: true, approval: updated };
    } catch {
      // Fall through to /tmp
    }
  }

  // /tmp fallback
  const all = await readAllSalaryApprovals();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return { found: false, approval: null };

  const updated = normalizeSalaryApproval({
    ...all[idx],
    status: nextStatus,
    decided_at: nowIso,
  });
  all[idx] = updated;
  await writeAllToTmp(all);
  return { found: true, approval: updated };
}
