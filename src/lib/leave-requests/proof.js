/**
 * Leave-request proof documents.
 *
 * The employee portal reads the chosen file (PDF, PNG or JPEG, under 2 MB)
 * with FileReader.readAsDataURL and sends the resulting data URL as
 * proof_url. HR and Admin later open it in the proof viewer
 * (public/legacy/js/app.js openProofDocument).
 *
 * proof_url used to be stored exactly as sent, so any string at all reached
 * the reviewer's browser -- including markup that broke out of the viewer's
 * HTML and ran as script in an HR session. Only the shape the portal itself
 * produces is accepted now: a base64 data URL of an allowed type, within the
 * size the portal already enforces.
 */

export const PROOF_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"];

/** The portal's own limit on the file, before base64 encoding. */
export const PROOF_MAX_BYTES = 2 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * @param {unknown} value the proof_url the browser sent
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 *   value is "" when no proof was attached.
 */
export function validateProofUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: "" };

  const match = DATA_URL_PATTERN.exec(raw);
  if (!match) {
    return { ok: false, error: "Attach the proof document as a PDF, PNG or JPEG file." };
  }

  const mime = match[1].toLowerCase();
  if (!PROOF_MIME_TYPES.includes(mime)) {
    return { ok: false, error: "Proof document must be a PDF, PNG or JPEG file." };
  }

  const payload = match[2];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes > PROOF_MAX_BYTES) {
    return { ok: false, error: "Proof file must be less than 2MB." };
  }

  return { ok: true, value: `data:${mime};base64,${payload}` };
}

// ─── Stored proofs (20261105030000) ──────────────────────────────────────────
//
// New proofs are kept as files in the private "leave-proofs" bucket and the
// row holds only their path; requests filed before keep the data URL in
// proof_url. Files are handed out only by GET /api/hr/leave-requests/proof
// (role and branch checked), never as a public or browser-held link.

export const LEAVE_PROOF_BUCKET = "leave-proofs";

const EXTENSIONS = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };
const MIME_OF_EXTENSION = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg" };

/** The type a file really is, from its first bytes, or null. */
export function sniffProofType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/**
 * A validated proof data URL (validateProofUrl's value) as a file to store.
 * The declared type must match the file's own first bytes.
 *
 * @param {string} dataUrl
 * @returns {{ ok: true, bytes: Buffer, mime: string, ext: string } | { ok: false, error: string }}
 */
export function decodeProofDataUrl(dataUrl) {
  const match = DATA_URL_PATTERN.exec(String(dataUrl || ""));
  if (!match) return { ok: false, error: "Attach the proof document as a PDF, PNG or JPEG file." };
  const declared = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > PROOF_MAX_BYTES) return { ok: false, error: "Proof file must be less than 2MB." };
  if (sniffProofType(bytes) !== declared) {
    return { ok: false, error: "The proof file's contents do not match a PDF, PNG or JPEG file." };
  }
  return { ok: true, bytes, mime: declared, ext: EXTENSIONS[declared] };
}

/** "<employee id>/<uuid>.<ext>": always the filer's own folder (CHECK in 20261105030000). */
export function proofPathFor(employeeId, ext, uuid) {
  return `${employeeId}/${uuid}.${ext}`;
}

/** The content type of a stored proof, from its path. */
export function proofMimeOfPath(path) {
  const ext = String(path || "").split(".").pop().toLowerCase();
  return MIME_OF_EXTENSION[ext] || null;
}
