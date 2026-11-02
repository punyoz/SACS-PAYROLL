/**
 * Profile pictures (20261102020000): the file rules and who may see whose
 * picture. Real images are generated with sharp, so the decoder is the one
 * the server uses.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PHOTO_MAX_BYTES, canSeePhoto, checkPhotoFile, detectImageType, processPhoto } from "@/lib/profile-photo";

const image = (format, width = 800, height = 600) => sharp({ create: { width, height, channels: 3, background: { r: 27, g: 94, b: 60 } } })[format]().toBuffer();

describe("file type by its first bytes", () => {
  it("accepts JPG, PNG and WebP", async () => {
    expect(detectImageType(await image("jpeg"))).toBe("jpeg");
    expect(detectImageType(await image("png"))).toBe("png");
    expect(detectImageType(await image("webp"))).toBe("webp");
  });

  it("refuses a renamed .exe, SVG, GIF and PDF whatever their name", async () => {
    expect(detectImageType(Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00", "latin1"))).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageType(await image("gif"))).toBeNull();
    expect(detectImageType(Buffer.from("%PDF-1.4\n"))).toBeNull();
    expect(checkPhotoFile({ size: 1000, bytes: Buffer.from("MZ\x90\x00", "latin1") })).toMatch(/JPG, PNG or WebP/);
  });

  it("refuses more than 2 MB with the size in the message", () => {
    expect(checkPhotoFile({ size: 5 * 1024 * 1024 })).toBe("The picture is 5.0 MB. The limit is 2 MB.");
    expect(checkPhotoFile({ size: PHOTO_MAX_BYTES })).toBeNull();
  });
});

describe("processing", () => {
  it("crops to a 512 square and a 96 thumbnail, both WebP", async () => {
    for (const format of ["jpeg", "png", "webp"]) {
      const out = await processPhoto(await image(format), { x: 100, y: 50, size: 400 });
      expect(out.error).toBeUndefined();
      const full = await sharp(out.full).metadata();
      const thumb = await sharp(out.thumb).metadata();
      expect([full.format, full.width, full.height]).toEqual(["webp", 512, 512]);
      expect([thumb.format, thumb.width, thumb.height]).toEqual(["webp", 96, 96]);
    }
  });

  it("removes EXIF, including a GPS location", async () => {
    const withGps = await sharp(await image("jpeg"))
      .withExif({ IFD0: { Make: "TestPhone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "14/1 35/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "121/1 10/1 0/1" } })
      .jpeg().toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeTruthy();
    const out = await processPhoto(withGps);
    const meta = await sharp(out.full).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.full.includes(Buffer.from("TestPhone"))).toBe(false);
  });

  it("refuses a corrupt file", async () => {
    const jpg = await image("jpeg");
    const broken = Buffer.concat([jpg.subarray(0, 40), Buffer.alloc(200, 7)]);
    expect((await processPhoto(broken)).error).toMatch(/could not be read/);
  });

  it("refuses absurd dimensions and tiny pictures", async () => {
    expect((await processPhoto(await image("png", 9000, 80))).error).toMatch(/too large/);
    expect((await processPhoto(await image("png", 40, 40))).error).toMatch(/too small/);
  });

  it("refuses a crop outside the picture", async () => {
    expect((await processPhoto(await image("jpeg"), { x: 700, y: 0, size: 400 })).error).toMatch(/outside/);
  });
});

describe("who sees whose picture", () => {
  const p = (id, role, branch_id) => ({ id, role, branch_id });
  const hr = p("hr", "hr", null);
  const sa = p("sa", "super_admin", null);
  const adminA = p("adA", "admin", "A");
  const acctA = p("acA", "accountant", "A");
  const empA = p("e1", "employee", "A");
  const empA2 = p("e2", "employee", "A");
  const empB = p("e3", "employee", "B");

  it("everyone sees their own", () => {
    [hr, sa, adminA, acctA, empA].forEach((who) => expect(canSeePhoto(who, who)).toBe(true));
  });

  it("HR and Super Admin see everyone", () => {
    [empA, empB, adminA, acctA].forEach((t) => {
      expect(canSeePhoto(hr, t)).toBe(true);
      expect(canSeePhoto(sa, t)).toBe(true);
    });
  });

  it("an Admin or Accountant sees their own branch only", () => {
    expect(canSeePhoto(adminA, empA)).toBe(true);
    expect(canSeePhoto(acctA, empA)).toBe(true);
    expect(canSeePhoto(adminA, empB)).toBe(false);
    expect(canSeePhoto(acctA, empB)).toBe(false);
  });

  it("an Employee sees HR, Super Admin and their branch's Admin and Accountant, not other employees", () => {
    expect(canSeePhoto(empA, hr)).toBe(true);
    expect(canSeePhoto(empA, sa)).toBe(true);
    expect(canSeePhoto(empA, adminA)).toBe(true);
    expect(canSeePhoto(empA, acctA)).toBe(true);
    expect(canSeePhoto(empA, empA2)).toBe(false);
    expect(canSeePhoto(empB, adminA)).toBe(false);
  });
});
