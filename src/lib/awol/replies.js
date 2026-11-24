// AWOL replies (2026-11-24): the preset reasons and the private attachments
// (bucket awol-replies, path <case>/<reply>/<n>-<name>; PDF / JPG / PNG, 5 MB each, at most 3).

export const REPLY_REASONS = Object.freeze({
  illness: "Illness / medical",
  family_emergency: "Family emergency",
  accident: "Accident",
  off_site: "Was working off-site",
  other: "Other",
});
export const RECEIVED_HOW = Object.freeze({ letter: "Letter", phone: "Phone", in_person: "In person", email: "E-mail", other: "Other" });

const TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

/** Store the attachments; returns { files: [{ path, name, type, size }] } or { error }. Nothing stored on an error. */
export async function saveReplyFiles(supabase, { caseId, replyId, files }) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_FILES) return { error: `At most ${MAX_FILES} attachments.` };
  const ready = [];
  for (const [i, f] of list.entries()) {
    const type = String(f?.type || "");
    if (!TYPES[type]) return { error: "Attachments are PDF, JPG or PNG files." };
    const data = Buffer.from(String(f?.data || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!data.length) return { error: "An attachment is empty." };
    if (data.length > MAX_BYTES) return { error: "Each attachment is at most 5 MB." };
    const safe = String(f?.name || `attachment.${TYPES[type]}`).replace(/[^\w.-]+/g, "-").slice(0, 80) || `attachment.${TYPES[type]}`;
    ready.push({ path: `${caseId}/${replyId}/${i + 1}-${safe}`, name: String(f?.name || safe).slice(0, 120), type, size: data.length, data });
  }
  const stored = [];
  for (const r of ready) {
    const up = await supabase.storage.from("awol-replies").upload(r.path, r.data, { contentType: r.type, upsert: false });
    if (up.error) {
      if (stored.length) await supabase.storage.from("awol-replies").remove(stored.map((s) => s.path)).catch(() => {});
      return { error: "The attachment could not be saved. Try again." };
    }
    stored.push({ path: r.path, name: r.name, type: r.type, size: r.size });
  }
  return { files: stored };
}
