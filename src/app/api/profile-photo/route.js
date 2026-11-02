import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import {
  PHOTO_BUCKET,
  PHOTO_MAX_BYTES,
  PHOTO_URL_TTL,
  canSeePhoto,
  checkPhotoFile,
  processPhoto,
} from "@/lib/profile-photo";

/**
 * Profile pictures (20261102020000).
 *
 *   GET    ?ids=me,<uuid>,…&size=thumb|full
 *          { photos: { <id>: { url, updated_at } | null }, expires_in }
 *          A person the viewer may not see (src/lib/profile-photo.js
 *          canSeePhoto) is simply null, like someone with no picture.
 *   POST   multipart: file (JPG / PNG / WebP, at most 2 MB), crop? ({ x, y, size })
 *          replaces the signed-in user's OWN picture.
 *   DELETE removes the signed-in user's own picture.
 *
 * Every user (all five roles) manages only their own picture: the user is
 * the signed session's, never an id from the request. The bucket is private
 * and closed to browsers (storage policy); pictures are only ever handed out
 * as signed URLs that expire after an hour. A replaced or removed picture's
 * files are deleted.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;

const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function viewerOf(supabase, guard) {
  const result = await supabase.from("profiles").select("id,role,branch_id,full_name,photo_path,photo_thumb_path").eq("id", guard.userId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function signedUrls(supabase, paths) {
  if (!paths.length) return new Map();
  const result = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, PHOTO_URL_TTL);
  if (result.error) throw new Error(result.error.message);
  return new Map((result.data || []).filter((r) => r.signedUrl && !r.error).map((r) => [r.path, r.signedUrl]));
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const size = url.searchParams.get("size") === "full" ? "full" : "thumb";
    const viewer = await viewerOf(supabase, guard);
    if (!viewer) return json({ error: "Your account was not found." }, 404);

    const asked = String(url.searchParams.get("ids") || "me").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS);
    const ids = [...new Set(asked.map((id) => (id === "me" ? viewer.id : id)).filter((id) => UUID.test(String(id))))];
    const people = ids.length
      ? await fetchAllIn(() => supabase.from("profiles").select("id,role,branch_id,photo_path,photo_thumb_path,photo_updated_at").order("id"), "id", ids)
      : { data: [] };
    if (people.error) throw new Error(people.error.message);

    const visible = (people.data || []).filter((p) => canSeePhoto(viewer, p) && p.photo_path);
    const pathOf = (p) => (size === "full" ? p.photo_path : p.photo_thumb_path || p.photo_path);
    const urls = await signedUrls(supabase, visible.map(pathOf));
    const photos = {};
    ids.forEach((id) => { photos[id] = null; });
    visible.forEach((p) => {
      const signed = urls.get(pathOf(p));
      photos[p.id] = signed ? { url: signed, updated_at: p.photo_updated_at } : null;
    });
    if (asked.includes("me")) photos.me = photos[viewer.id] ?? null;
    return json({ photos, expires_in: PHOTO_URL_TTL });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

async function removeFiles(supabase, paths) {
  const list = paths.filter(Boolean);
  if (list.length) await supabase.storage.from(PHOTO_BUCKET).remove(list);
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    // Refuse an oversized body before reading it.
    const declared = Number(request.headers.get("content-length")) || 0;
    if (declared > PHOTO_MAX_BYTES + 64 * 1024) return json({ error: "The picture is larger than 2 MB." }, 413);

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return json({ error: "Choose a picture." }, 400);
    if (file.size > PHOTO_MAX_BYTES) return json({ error: checkPhotoFile({ size: file.size }) }, 413);
    const buffer = Buffer.from(await file.arrayBuffer());
    const early = checkPhotoFile({ size: buffer.length, bytes: buffer.subarray(0, 16) });
    if (early) return json({ error: early }, buffer.length > PHOTO_MAX_BYTES ? 413 : 415);

    let crop = null;
    try {
      const raw = form.get("crop");
      crop = raw ? JSON.parse(String(raw)) : null;
    } catch {
      return json({ error: "The crop is not valid." }, 400);
    }
    const processed = await processPhoto(buffer, crop);
    if (processed.error) return json({ error: processed.error }, 422);

    const supabase = getAdminClient();
    const me = await viewerOf(supabase, guard);
    if (!me) return json({ error: "Your account was not found." }, 404);
    // The signed-in user's own folder, under a random name.
    const key = randomUUID();
    const fullPath = `${me.id}/${key}.webp`;
    const thumbPath = `${me.id}/${key}-thumb.webp`;
    const bucket = supabase.storage.from(PHOTO_BUCKET);
    const up1 = await bucket.upload(fullPath, processed.full, { contentType: "image/webp", upsert: false, cacheControl: "3600" });
    if (up1.error) throw new Error(up1.error.message);
    const up2 = await bucket.upload(thumbPath, processed.thumb, { contentType: "image/webp", upsert: false, cacheControl: "3600" });
    if (up2.error) {
      await removeFiles(supabase, [fullPath]);
      throw new Error(up2.error.message);
    }
    const saved = await supabase.from("profiles")
      .update({ photo_path: fullPath, photo_thumb_path: thumbPath, photo_updated_at: new Date().toISOString() })
      .eq("id", me.id);
    if (saved.error) {
      await removeFiles(supabase, [fullPath, thumbPath]);
      throw new Error(saved.error.message);
    }
    // The old picture is deleted once the new one is saved.
    await removeFiles(supabase, [me.photo_path, me.photo_thumb_path]);
    await appendAuditLog({
      actor: guard, module: "profile", action: me.photo_path ? "photo_replace" : "photo_upload",
      entity_type: "profile_photo", entity_id: me.id, description: `${me.full_name || "A user"} ${me.photo_path ? "replaced" : "added"} their profile picture.`,
    }).catch(() => {});
    const urls = await signedUrls(supabase, [fullPath, thumbPath]);
    return json({ ok: true, photo: { url: urls.get(fullPath) || null, thumb_url: urls.get(thumbPath) || null }, expires_in: PHOTO_URL_TTL });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

export async function DELETE(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const me = await viewerOf(supabase, guard);
    if (!me) return json({ error: "Your account was not found." }, 404);
    if (!me.photo_path && !me.photo_thumb_path) return json({ ok: true, removed: false });
    const saved = await supabase.from("profiles").update({ photo_path: null, photo_thumb_path: null, photo_updated_at: new Date().toISOString() }).eq("id", me.id);
    if (saved.error) throw new Error(saved.error.message);
    await removeFiles(supabase, [me.photo_path, me.photo_thumb_path]);
    await appendAuditLog({
      actor: guard, module: "profile", action: "photo_remove",
      entity_type: "profile_photo", entity_id: me.id, description: `${me.full_name || "A user"} removed their profile picture.`,
    }).catch(() => {});
    return json({ ok: true, removed: true });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}
