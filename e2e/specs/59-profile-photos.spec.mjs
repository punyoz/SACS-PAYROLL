// Profile pictures (20261102020000), against the real local stack and its
// Storage. Every role uploads, replaces and removes their OWN picture; nobody
// reaches another user's picture; the bucket is private, links are signed and
// expire; bad files are refused by the server (not only by the screen).
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail } from "../support/db.mjs";
import { localSupabase } from "../local-env.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const BUCKET = "profile-photos";
const PROFILE_PAGE = { super_admin: "sa-profile", admin: "adm-profile", hr: "hr-profile", accountant: "ac-profile", employee: "emp-profile" };
const picture = (format, width = 640, height = 480, color = { r: 27, g: 94, b: 60 }) =>
  sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer();
const upload = (page, buffer, name, mimeType, crop) => page.request.post("/api/profile-photo", {
  multipart: { file: { name, mimeType, buffer }, ...(crop ? { crop: JSON.stringify(crop) } : {}) },
});
const filesOf = async (userId) => ((await db().storage.from(BUCKET).list(userId)).data || []).map((f) => f.name).sort();

test("profile pictures: own only, private, signed, every bad file refused", async ({ page }) => {
  const { url: supabaseUrl, anonKey } = localSupabase();
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);

  await step(page, "Storage > the bucket is private, WebP only, 2 MB", async () => {
    const bucket = await db().storage.getBucket(BUCKET);
    expect(bucket.data).toMatchObject({ public: false, file_size_limit: 2097152, allowed_mime_types: ["image/webp"] });
  });

  // Every role: JPG, PNG, WebP; the last one stays (the old files are deleted on each replace).
  for (const role of ["super_admin", "admin", "hr", "accountant", "employee"]) {
    await as(page, role, PROFILE_PAGE[role]);
    await step(page, `${role} > uploads a JPG, a PNG and a WebP; only the last picture's two files remain`, async () => {
      const me = await profileByEmail(ACCOUNTS[role].email);
      for (const [format, mime] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]]) {
        const res = await upload(page, await picture(format), `me.${format === "jpeg" ? "jpg" : format}`, mime, { x: 80, y: 0, size: 480 });
        expect(res.status(), `${role} ${format}`).toBe(200);
      }
      const files = await filesOf(me.id);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("-thumb.webp"))).toBe(true);
      const got = await api(page, "GET", "/api/profile-photo?ids=me&size=full");
      expect(got.data.photos.me.url).toContain("/storage/v1/object/sign/");
      await page.reload();
      await settle(page);
      await expect(main(page).getByRole("img", { name: /profile picture/ }).first()).toBeVisible();
    });
  }

  await as(page, "employee2", "emp-profile");
  await step(page, "Employee (Bea) > has a picture of her own (the target of the next checks)", async () => {
    expect((await upload(page, await picture("jpeg"), "bea.jpg", "image/jpeg")).status()).toBe(200);
    expect(await filesOf(bea.id)).toHaveLength(2);
  });

  await as(page, "employee", "emp-profile");
  await step(page, "Employee > bad files are refused by a direct API call", async () => {
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00", "latin1"), Buffer.alloc(4096, 1)]);
    expect((await upload(page, exe, "setup.jpg", "image/jpeg")).status()).toBe(415);
    expect((await upload(page, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg", "image/svg+xml")).status()).toBe(415);
    expect((await upload(page, await picture("gif"), "x.gif", "image/gif")).status()).toBe(415);
    expect((await upload(page, Buffer.from("%PDF-1.4\n%...", "latin1"), "x.pdf", "application/pdf")).status()).toBe(415);
    const big = Buffer.concat([await picture("jpeg"), Buffer.alloc(5 * 1024 * 1024, 0)]);
    expect((await upload(page, big, "big.jpg", "image/jpeg")).status()).toBe(413);
    const jpg = await picture("jpeg");
    const corrupt = Buffer.concat([jpg.subarray(0, 40), Buffer.alloc(300, 9)]);
    const bad = await upload(page, corrupt, "broken.jpg", "image/jpeg");
    expect(bad.status()).toBe(422);
    expect((await bad.json()).error).toMatch(/could not be read/);
    expect((await upload(page, await picture("png", 9000, 60), "huge.png", "image/png")).status()).toBe(422);
  });

  await step(page, "Employee (Ana) > cannot read, overwrite or delete another user's picture", async () => {
    // Bea has a picture: read it, as Ana, through the API.
    const beaFiles = await filesOf(bea.id);
    const read = await api(page, "GET", `/api/profile-photo?ids=${bea.id}`);
    expect(read.data.photos[bea.id]).toBeNull();
    // The API has no "whose" field: a forged user id is ignored, the upload is Ana's own.
    const forged = await page.request.post(`/api/profile-photo?user_id=${bea.id}`, {
      multipart: { file: { name: "x.png", mimeType: "image/png", buffer: await picture("png") }, user_id: bea.id, id: bea.id },
    });
    expect(forged.status()).toBe(200);
    expect(await filesOf(bea.id)).toEqual(beaFiles);
    // Straight to Storage with the browser's key: nothing is listed, read, written or deleted.
    const listed = await anon.storage.from(BUCKET).list(bea.id);
    expect(listed.data || []).toHaveLength(0);
    const downloaded = await anon.storage.from(BUCKET).download(`${bea.id}/${beaFiles[0]}`);
    expect(downloaded.data).toBeNull();
    const written = await anon.storage.from(BUCKET).upload(`${bea.id}/${crypto.randomUUID()}.webp`, await picture("webp"), { contentType: "image/webp" });
    expect(written.error).toBeTruthy();
    await anon.storage.from(BUCKET).remove(beaFiles.map((f) => `${bea.id}/${f}`));
    expect(await filesOf(bea.id)).toEqual(beaFiles);
    // A profile can never point at someone else's folder (database CHECK).
    const pointed = await db().from("profiles").update({ photo_path: `${bea.id}/${crypto.randomUUID()}.webp` }).eq("id", ana.id);
    expect(pointed.error?.message || "").toMatch(/profiles_photo_own_folder/);
  });

  await step(page, "Storage > no public link works, and signed links expire", async () => {
    const path = `${bea.id}/${(await filesOf(bea.id))[0]}`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
    expect((await page.request.get(publicUrl)).status()).toBeGreaterThanOrEqual(400);
    const signed = await api(page, "GET", "/api/profile-photo?ids=me");
    const token = new URL(signed.data.photos.me.url).searchParams.get("token");
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBe(3600);
    // A link that has run out is refused.
    const short = await db().storage.from(BUCKET).createSignedUrl(path, 1);
    expect((await page.request.get(short.data.signedUrl)).status()).toBe(200);
    await page.waitForTimeout(2500);
    expect((await page.request.get(short.data.signedUrl)).status()).toBeGreaterThanOrEqual(400);
  });

  await step(page, "Employee > the dialog: choose, crop, save; then remove, and the initials come back", async () => {
    await page.reload();
    await settle(page);
    await main(page).getByRole("button", { name: "Change your profile picture" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').first().setInputFiles({ name: "face.png", mimeType: "image/png", buffer: await picture("png", 900, 600, { r: 201, g: 162, b: 39 }) });
    await expect(dialog.getByRole("img", { name: /Crop preview/ })).toBeVisible();
    await dialog.locator("#photo-zoom").fill("1.5");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await expect(main(page).getByRole("img", { name: /profile picture/ }).first()).toBeVisible();
    // A file the browser can tell is wrong never leaves the page.
    await main(page).getByRole("button", { name: "Change your profile picture" }).click();
    await page.getByRole("dialog").locator('input[type="file"]').first().setInputFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(/JPG, PNG or WebP/);
    await page.getByRole("dialog").getByRole("button", { name: "Remove photo" }).click();
    const removed = page.waitForResponse((r) => r.url().includes("/api/profile-photo") && r.request().method() === "DELETE");
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30000 });
    expect(await filesOf(ana.id)).toHaveLength(0);
    await expect(main(page).getByRole("img", { name: /profile picture/ })).toHaveCount(0);
  });
});
