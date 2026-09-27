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
