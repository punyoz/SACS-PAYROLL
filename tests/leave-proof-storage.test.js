import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LEAVE_PROOF_BUCKET,
  PROOF_MAX_BYTES,
  decodeProofDataUrl,
  proofMimeOfPath,
  proofPathFor,
  sniffProofType,
} from "@/lib/leave-requests/proof";

/**
 * Leave proofs in the private leave-proofs bucket (20261105030000): the file
 * must really be the type it claims, stays within 2 MB, lives in the filer's
 * own folder, and is only handed out by the HR proof route.
 */

const PDF = Buffer.from("%PDF-1.7\n%test\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;

describe("leave proof files", () => {
  it("knows PDF, PNG and JPEG by their first bytes", () => {
    expect(sniffProofType(PDF)).toBe("application/pdf");
    expect(sniffProofType(PNG)).toBe("image/png");
    expect(sniffProofType(JPG)).toBe("image/jpeg");
    expect(sniffProofType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });

  it("decodes a matching data URL to a file with its extension", () => {
    const pdf = decodeProofDataUrl(dataUrl("application/pdf", PDF));
    expect(pdf).toMatchObject({ ok: true, mime: "application/pdf", ext: "pdf" });
    expect(Buffer.compare(pdf.bytes, PDF)).toBe(0);
    expect(decodeProofDataUrl(dataUrl("image/jpeg", JPG))).toMatchObject({ ok: true, ext: "jpg" });
    expect(decodeProofDataUrl(dataUrl("image/png", PNG))).toMatchObject({ ok: true, ext: "png" });
  });

  it("refuses a file whose contents are not what it claims", () => {
    expect(decodeProofDataUrl(dataUrl("application/pdf", Buffer.from("<html><script>x</script>"))).ok).toBe(false);
    expect(decodeProofDataUrl(dataUrl("image/png", JPG)).ok).toBe(false);
  });

  it("refuses a file over 2 MB", () => {
    const big = Buffer.concat([PDF, Buffer.alloc(PROOF_MAX_BYTES)]);
    expect(decodeProofDataUrl(dataUrl("application/pdf", big)).ok).toBe(false);
  });

  it("keeps the file in the filer's own folder, as the CHECK constraint requires", () => {
    const employee = "11111111-2222-3333-4444-555555555555";
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const path = proofPathFor(employee, "pdf", uuid);
    expect(path).toBe(`${employee}/${uuid}.pdf`);
    expect(new RegExp(`^${employee}/[0-9a-f-]{36}\\.(pdf|png|jpg)$`).test(path)).toBe(true);
    expect(proofMimeOfPath(path)).toBe("application/pdf");
    expect(proofMimeOfPath(`${employee}/${uuid}.svg`)).toBeNull();
  });
});

describe("leave proof bucket and routes", () => {
  const migration = readFileSync("supabase/migrations/20261105030000_leave_proofs_bucket.sql", "utf8");

  it("the bucket is private, 2 MB, PDF / PNG / JPEG only, closed to browsers", () => {
    expect(LEAVE_PROOF_BUCKET).toBe("leave-proofs");
    expect(migration).toContain("VALUES ('leave-proofs', 'leave-proofs', FALSE, 2097152, ARRAY['application/pdf', 'image/png', 'image/jpeg'])");
    expect(migration).toMatch(/AS RESTRICTIVE FOR ALL TO anon, authenticated/);
  });

  it("new requests store the file, not the base64, and remove it if the row is not saved", () => {
    const route = readFileSync("src/app/api/employee/leave-requests/route.js", "utf8");
    expect(route).toContain("decodeProofDataUrl(proof.value)");
    expect(route).toContain('proof_url: "",');
    expect(route).toContain("proof_path: proofPath,");
    expect(route).toContain(".remove([proofPath])");
  });

  it("HR's list says a stored proof exists without sending it or its path", () => {
    const route = readFileSync("src/app/api/hr/leave-requests/route.js", "utf8");
    expect(route).toContain("has_stored_proof: Boolean(proofPath)");
  });

  it("the proof route checks the permission, refuses self scope, and checks the branch", () => {
    const route = readFileSync("src/app/api/hr/leave-requests/proof/route.js", "utf8");
    expect(route).toContain('requirePermission(request, "leave_approval", "read")');
    expect(route).toContain("denySelfScopeList(guard)");
    expect(route).toContain("denyForeignBranch(guard, row.branch_id)");
    expect(route).toContain('"Cache-Control": "no-store"');
  });
});
