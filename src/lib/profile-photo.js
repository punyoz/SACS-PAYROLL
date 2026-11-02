/**
 * Profile pictures (20261102020000): file rules and who may see whose.
 *
 * Every user uploads, replaces and removes their OWN picture only; the API
 * (/api/profile-photo) takes the user from the signed session, never from the
 * request. Files live in the private "profile-photos" bucket as
 * "<user id>/<random uuid>.webp" (512x512) and "...-thumb.webp" (96x96), and
 * are only ever served as signed URLs that expire.
 *
 * File rules, checked in the browser and again here:
 *   - JPG, PNG or WebP only, judged by the file's first bytes (magic bytes),
 *     not its name or the type the browser claims; SVG, GIF, PDF and anything
 *     else are refused
 *   - at most 2 MB
 *   - 64 to 8,000 pixels a side, 40 megapixels at most; a file the decoder
 *     cannot read is refused as corrupt
 *   - re-encoded to WebP (cropped square, 512 and 96 pixels): the output has
 *     no EXIF, so a phone photo's GPS location is gone
 */

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_MIN_SIDE = 64;
export const PHOTO_MAX_SIDE = 8000;
export const PHOTO_MAX_PIXELS = 40_000_000;
export const PHOTO_SIZE = 512;
export const THUMB_SIZE = 96;
/** Signed URLs live this long (seconds); the browser re-asks before then. */
export const PHOTO_URL_TTL = 3600;
export const PHOTO_BUCKET = "profile-photos";
export const ALLOWED_TYPES_TEXT = "JPG, PNG or WebP";

/** "jpeg" | "png" | "webp" from the first bytes of a file, or null. */
export function detectImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/** The error message for a file before decoding it, or null. */
export function checkPhotoFile({ size, bytes }) {
  if (!size) return "Choose a picture.";
  if (size > PHOTO_MAX_BYTES) return `The picture is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`;
  if (bytes && !detectImageType(bytes)) return `Only ${ALLOWED_TYPES_TEXT} pictures can be used.`;
  return null;
}

/** A crop square inside an image of width x height, or an error message. */
export function validateCrop(crop, width, height) {
  if (!crop) return { crop: null };
  const n = (v) => Math.round(Number(v));
  const x = n(crop.x);
  const y = n(crop.y);
  const size = n(crop.size);
  if (![x, y, size].every(Number.isFinite)) return { error: "The crop is not valid." };
  if (size < 32 || x < 0 || y < 0 || x + size > width || y + size > height) return { error: "The crop is outside the picture." };
  return { crop: { left: x, top: y, width: size, height: size } };
}

/**
 * Decode, check and re-encode an upload: { full, thumb } WebP buffers, or
 * { error }. `crop` is { x, y, size } in the picture's own (upright) pixels.
 */
export async function processPhoto(buffer, crop = null) {
  const type = detectImageType(buffer);
  if (!type) return { error: `Only ${ALLOWED_TYPES_TEXT} pictures can be used.` };
  const { default: sharp } = await import("sharp");
  const open = () => sharp(buffer, { limitInputPixels: PHOTO_MAX_PIXELS, failOn: "error", animated: false });
  let meta;
  try {
    meta = await open().metadata();
  } catch (error) {
    return { error: /pixel limit/i.test(String(error?.message)) ? "The picture is too large (over 40 megapixels)." : "The picture could not be read (it may be damaged)." };
  }
  if (meta.format !== type) return { error: "The picture's contents do not match its type." };
  // Upright size: orientations 5-8 swap the sides.
  const upright = Number(meta.orientation) >= 5;
  const width = upright ? meta.height : meta.width;
  const height = upright ? meta.width : meta.height;
  if (!width || !height || width < PHOTO_MIN_SIDE || height < PHOTO_MIN_SIDE) return { error: `The picture is too small (at least ${PHOTO_MIN_SIDE} pixels a side).` };
  if (width > PHOTO_MAX_SIDE || height > PHOTO_MAX_SIDE || width * height > PHOTO_MAX_PIXELS) return { error: `The picture is too large (at most ${PHOTO_MAX_SIDE} pixels a side).` };
  const checked = validateCrop(crop, width, height);
  if (checked.error) return { error: checked.error };
  try {
    // rotate() first: crops are in upright pixels, and EXIF orientation is applied, then dropped.
    let pipeline = open().rotate();
    if (checked.crop) pipeline = pipeline.extract(checked.crop);
    const full = await pipeline
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
    const thumb = await sharp(full).resize(THUMB_SIZE, THUMB_SIZE).webp({ quality: 80 }).toBuffer();
    return { full, thumb };
  } catch {
    return { error: "The picture could not be read (it may be damaged)." };
  }
}

const roleOf = (p) => String(p?.role || "").toLowerCase();

/**
 * May `viewer` see `target`'s picture? Their own always; otherwise as their
 * role sees that person: HR and Super Admin everyone; a branch Admin or an
 * Accountant their own branch; an Employee the HR / Super Admin accounts and
 * their own branch's Admin and Accountant (announcement authors, payroll).
 */
export function canSeePhoto(viewer, target) {
  if (!viewer || !target) return false;
  if (String(viewer.id) === String(target.id)) return true;
  const role = roleOf(viewer);
  if (role === "hr" || role === "super_admin") return true;
  const sameBranch = Boolean(viewer.branch_id) && viewer.branch_id === target.branch_id;
  if (role === "admin" || role === "accountant") return sameBranch;
  if (role === "employee") {
    const targetRole = roleOf(target);
    return targetRole === "hr" || targetRole === "super_admin" || (sameBranch && (targetRole === "admin" || targetRole === "accountant"));
  }
  return false;
}
