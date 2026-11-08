/**
 * Branch Management (alpha test B): the stored location comes back into the
 * selects correctly, and every city has its barangays (PSGC files).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parseBranchLocation, regionSlug } from "@/lib/portal/branch-location";
import { PH_REGIONS, PH_PROVINCES, PH_CITIES } from "@/lib/portal/ph-locations";

const LISTS = { PH_REGIONS, PH_PROVINCES, PH_CITIES };
const LABELS = { "Region IV-A (CALABARZON)": "Region IV-A – CALABARZON", "Region III": "Region III – Central Luzon" };

describe("parseBranchLocation", () => {
  it("a stored Region IV-A, II or III location is no longer read as Region I", () => {
    expect(parseBranchLocation("San Roque, Antipolo City, Rizal, Region IV-A (CALABARZON)", LISTS, LABELS))
      .toEqual({ region: "Region IV-A (CALABARZON)", province: "Rizal", city: "Antipolo City", barangay: "San Roque" });
    expect(parseBranchLocation("X, Y, Z, Region IV-A – CALABARZON", LISTS, LABELS).region).toBe("Region IV-A (CALABARZON)");
    expect(parseBranchLocation("Region III", LISTS, LABELS).region).toBe("Region III");
    expect(parseBranchLocation("Region II", LISTS, LABELS).region).toBe("Region II");
  });

  it("keeps a typed barangay, and an empty location stays empty", () => {
    expect(parseBranchLocation("Poblacion, Molundo, Lanao del Sur, BARMM", LISTS, LABELS)).toMatchObject({ city: "Molundo", barangay: "Poblacion" });
    expect(parseBranchLocation("", LISTS, LABELS)).toEqual({ region: "", province: "", city: "", barangay: "" });
  });
});

describe("barangay files (public/ph-barangays)", () => {
  const files = Object.fromEntries(readdirSync("public/ph-barangays").map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(`public/ph-barangays/${f}`, "utf8"))]));

  it("one file per region, named by regionSlug", () => {
    for (const region of PH_REGIONS) expect(files[regionSlug(region)], region).toBeTruthy();
  });

  it("all but 2 of the 1,634 cities have their barangays (Molundo, Sultan Gumander are newer than the PSGC edition)", () => {
    const missing = [];
    let barangays = 0;
    for (const region of PH_REGIONS) for (const province of PH_PROVINCES[region]) for (const city of PH_CITIES[province] || []) {
      const list = files[regionSlug(region)][`${province}|${city}`];
      if (!list?.length) missing.push(city); else barangays += list.length;
    }
    expect(missing.sort()).toEqual(["Molundo", "Sultan Gumander"]);
    expect(barangays).toBeGreaterThan(41000);
  });

  it("towns with the same name keep their own lists (San Juan, Batangas vs San Juan, Metro Manila)", () => {
    const batangas = files["region-iv-a-calabarzon"]["Batangas|San Juan"];
    const metro = files.ncr["Metro Manila|San Juan"];
    expect(batangas.length).toBeGreaterThan(30);
    expect(metro.length).toBe(21);
    expect(batangas).not.toEqual(metro);
    expect(files["region-iv-a-calabarzon"]["Rizal|Antipolo City"]).toHaveLength(16);
  });
});
