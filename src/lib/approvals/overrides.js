import { storageReadJson, storageWriteJson } from "@/lib/storage/supabase-store";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const STORAGE_FILE = "approval-overrides.json";
const tmpPath = path.join(os.tmpdir(), "sacs-payroll-runtime", "approval-overrides.json");

function normalizeStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "approved" || value === "rejected" || value === "pending") {
    return value;
  }
  return "pending";
}

function rowsToMap(rows) {
  return new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.id)
      .map((row) => [
        String(row.id),
        {
          status: normalizeStatus(row.status),
          decided_at: row.decided_at || null,
          updated_at: row.updated_at || new Date().toISOString(),
        },
      ]),
  );
}

export async function readApprovalOverrides() {
  // Primary: Supabase Storage (persists across serverless instances)
  try {
    const parsed = await storageReadJson(STORAGE_FILE, { overrides: [] });
    return rowsToMap(parsed.overrides);
  } catch {
    // Fall through to /tmp (development fallback)
  }

  try {
    const raw = await fs.readFile(tmpPath, "utf8");
    const parsed = JSON.parse(raw);
    return rowsToMap(parsed.overrides);
  } catch {
    return new Map();
  }
}

async function writeOverridesMap(map) {
  const overrides = Array.from(map.entries()).map(([id, value]) => ({
    id,
    status: normalizeStatus(value.status),
    decided_at: value.decided_at || null,
    updated_at: value.updated_at || new Date().toISOString(),
  }));

  // Primary: Supabase Storage
  try {
    await storageWriteJson(STORAGE_FILE, { overrides });
    return;
  } catch {
    // Fall through to /tmp
  }

  // /tmp fallback (development only — not reliable on Vercel)
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify({ overrides }, null, 2), "utf8");
}

export async function setApprovalOverride(id, status, decidedAt = new Date().toISOString()) {
  const key = String(id || "").trim();
  if (!key) return;

  const map = await readApprovalOverrides();
  map.set(key, {
    status: normalizeStatus(status),
    decided_at: decidedAt,
    updated_at: new Date().toISOString(),
  });

  await writeOverridesMap(map);
}

export function applyApprovalOverrides(rows, overridesMap) {
  if (!Array.isArray(rows) || !rows.length || !overridesMap?.size) {
    return Array.isArray(rows) ? rows : [];
  }

  return rows.map((row) => {
    const key = String(row.id || "");
    const override = overridesMap.get(key);
    if (!override) return row;

    return {
      ...row,
      status: normalizeStatus(override.status),
      decided_at: override.decided_at || row.decided_at || null,
    };
  });
}
