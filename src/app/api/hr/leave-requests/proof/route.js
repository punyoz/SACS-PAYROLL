import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { readLeaveRequestsWithoutProof } from "@/lib/leave-requests/store";
import { LEAVE_PROOF_BUCKET, proofMimeOfPath } from "@/lib/leave-requests/proof";
import { requirePermission, denyForeignBranch, denySelfScopeList } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";

/**
 * GET /api/hr/leave-requests/proof?id=<leave request id>
 *   { proof_url: "data:<type>;base64,..." }
 *
 * One leave request's proof document from the private leave-proofs bucket
 * (20261105030000), fetched only when the reviewer clicks View, instead of
 * every proof travelling with the Leave Requests list. Same permission as
 * the list (leave_approval read, never self-scoped), and a branch-scoped
 * reviewer only inside their own branch. Returned as a data URL so the proof
 * viewer (src/components/portal/proof-viewer.jsx) shows it the way it showed
 * the older, inline proofs; the bucket is never exposed to the browser.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "read");
    if (guard.denied) return guard.denied;
    const selfDenied = denySelfScopeList(guard);
    if (selfDenied) return selfDenied;

    const id = String(new URL(request.url).searchParams.get("id") || "").trim();
    if (!UUID.test(id)) return json({ error: "A leave request id is required." }, 400);

    const [row] = await readLeaveRequestsWithoutProof({ id });
    if (!row) return json({ error: "Leave request not found." }, 404);
    const foreign = denyForeignBranch(guard, row.branch_id);
    if (foreign) return foreign;

    const mime = proofMimeOfPath(row.proof_path);
    if (!row.proof_path || !mime) return json({ error: "No proof document attached to this request." }, 404);

    const download = await getServiceClient().storage.from(LEAVE_PROOF_BUCKET).download(row.proof_path);
    if (download.error || !download.data) throw new Error(download.error?.message || "The proof document could not be read.");
    const bytes = Buffer.from(await download.data.arrayBuffer());
    return json({ proof_url: `data:${mime};base64,${bytes.toString("base64")}` });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}
