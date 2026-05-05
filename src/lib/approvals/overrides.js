import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeDir = path.join(os.tmpdir(), "bncs-payroll-runtime");
const overridesPath = path.join(runtimeDir, "approval-overrides.json");

function normalizeStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "approved" || value === "rejected" || value === "pending") {
    return value;
  }
  return "pending";
}

export async function readApprovalOverrides() {
  try {
    const raw = await fs.readFile(overridesPath, "utf8");
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed.overrides) ? parsed.overrides : [];

    return new Map(
      rows
        .filter((row) => row && row.id)
        .map((row) => [String(row.id), {
          status: normalizeStatus(row.status),
          decided_at: row.decided_at || null,
          updated_at: row.updated_at || new Date().toISOString(),
        }]),
    );
  } catch {
    return new Map();
  }
}

async function writeApprovalOverridesMap(map) {
  await fs.mkdir(path.dirname(overridesPath), { recursive: true });
  const overrides = Array.from(map.entries()).map(([id, value]) => ({
    id,
    status: normalizeStatus(value.status),
    decided_at: value.decided_at || null,
    updated_at: value.updated_at || new Date().toISOString(),
  }));

  await fs.writeFile(overridesPath, JSON.stringify({ overrides }, null, 2), "utf8");
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

  await writeApprovalOverridesMap(map);
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
