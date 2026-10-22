/**
 * POST /api/admin/employees/import — onboard employees from a CSV file
 * (src/lib/employees/csv-import.js; scenarios SC-10 / HR-02).
 *
 *   { rows: [{ line, values }], dry_run: true }   check every row, create nothing
 *   { rows: [{ line, values }] }                  create (at most IMPORT_BATCH_SIZE)
 *
 * Each row is checked by the Add employee form's own rules, plus: a known,
 * active branch; an email not already used (here or earlier in the file);
 * no one on file with the same name and birthday. Creating goes through
 * POST /api/admin/employees itself, so an imported employee is exactly like
 * one added by hand (ID, default password, metadata, audit). Every row gets
 * its own result; one bad row never stops the rest.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { listUsersCached } from "@/lib/auth/users-cache";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { normalizeEmployeeFields, validateEmployeeRecord } from "@/lib/employees/record";
import { normalizeEmergencyContact, validateEmergencyContact } from "@/lib/employees/emergency-contact";
import { findLikelyDuplicates } from "@/lib/employees/duplicates";
import { IMPORT_BATCH_SIZE, IMPORT_MAX_ROWS, rowToEmployeeBody } from "@/lib/employees/csv-import";
import { POST as createEmployee } from "../route";

export async function POST(request) {
  const guard = await requirePermission(request, "employee_information", "create");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const dryRun = body.dry_run === true;
    if (!rows.length) return NextResponse.json({ error: "The file has no employee rows." }, { status: 400 });
    if (rows.length > (dryRun ? IMPORT_MAX_ROWS : IMPORT_BATCH_SIZE)) {
      return NextResponse.json({ error: `At most ${dryRun ? IMPORT_MAX_ROWS : IMPORT_BATCH_SIZE} rows at a time.` }, { status: 400 });
    }

    const supabase = getAdminClient();
    const [branchResult, usersResult] = await Promise.all([
      supabase.from("branches").select("id,name,status").order("name", { ascending: true }),
      listUsersCached(supabase),
    ]);
    if (branchResult.error) throw new Error(branchResult.error.message);
    const branches = (branchResult.data || []).filter((b) => guard.branchExempt || b.id === guard.branchId);
    const users = usersResult.data?.users || [];
    const takenEmails = new Set(users.map((u) => String(u.email || "").toLowerCase()));
    const seenInFile = new Set();

    const results = [];
    for (const row of rows) {
      const line = Number(row?.line) || null;
      const values = row?.values && typeof row.values === "object" ? row.values : {};
      const { body: employeeBody, branch } = rowToEmployeeBody(values, branches);
      const record = normalizeEmployeeFields(employeeBody);
      const name = [record.first_name, record.last_name].filter(Boolean).join(" ") || "—";
      const fail = (error) => results.push({ line, ok: false, name, email: record.email, error });

      if (!branch) { fail(`Unknown branch "${values.branch || ""}".`); continue; }
      if (String(branch.status || "Active").toLowerCase() !== "active") { fail(`Branch ${branch.name} is not active.`); continue; }
      record.branch_id = branch.id;
      const invalid = validateEmployeeRecord(record, { creating: true });
      if (invalid) { fail(invalid); continue; }
      const emergency = validateEmergencyContact(normalizeEmergencyContact(employeeBody), record.cp_number);
      if (emergency) { fail(emergency); continue; }
      if (takenEmails.has(record.email)) { fail(`${record.email} is already used by another account.`); continue; }
      if (seenInFile.has(record.email)) { fail(`${record.email} appears more than once in the file.`); continue; }
      const duplicates = findLikelyDuplicates(record, users);
      if (duplicates.length) {
        fail(`Same name and date of birth as ${duplicates.map((d) => `${d.full_name}${d.employee_id ? ` (${d.employee_id})` : ""}${d.archived ? ", archived" : ""}`).join("; ")}. Add this one with the form if it is a different person.`);
        continue;
      }
      seenInFile.add(record.email);

      if (dryRun) { results.push({ line, ok: true, name, email: record.email }); continue; }

      // The Add employee route itself, with the caller's own session.
      const response = await createEmployee(new Request(new URL("/api/admin/employees", request.url), {
        method: "POST",
        headers: { cookie: request.headers.get("cookie") || "", "content-type": "application/json" },
        body: JSON.stringify({ ...employeeBody, branch_id: branch.id }),
      }));
      const created = await response.json().catch(() => ({}));
      if (!response.ok) { fail(created.error || "Not created."); continue; }
      takenEmails.add(record.email);
      results.push({ line, ok: true, name, email: record.email, employee_id: created.employee?.employee_id || null });
    }

    if (!dryRun) {
      const ok = results.filter((r) => r.ok).length;
      await appendAuditLog({
        actor: guard, module: "user_management", action: "employee_import", entity_type: "employee", entity_id: null,
        description: `CSV import: ${ok} employee${ok === 1 ? "" : "s"} created, ${results.length - ok} refused.`,
        status: ok === results.length ? "success" : "failed", source: "api",
        metadata: { created: results.filter((r) => r.ok).map((r) => r.employee_id), refused: results.filter((r) => !r.ok).map((r) => ({ line: r.line, error: r.error })) },
      });
    }
    return NextResponse.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
