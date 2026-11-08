/**
 * A branch's stored location ("Barangay, City, Province, Region") back to the
 * Branch dialog's selects (alpha test B, 2026-11-09).
 *
 * The region is matched exactly (by name, or by its label), else by the
 * LONGEST name the text contains as a whole word: "Region IV-A ..." used to
 * be read as "Region I", which emptied the province and city on Edit.
 * The barangay is the part before the city, so any barangay (including a
 * typed one) comes back.
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function longestWithin(text, list) {
  return [...(list || [])]
    .sort((a, b) => b.length - a.length)
    .find((value) => new RegExp(`(^|[\\s,(])${escapeRegExp(value)}($|[\\s,)])`).test(text)) || "";
}

export function parseBranchLocation(location, { PH_REGIONS = [], PH_PROVINCES = {}, PH_CITIES = {} } = {}, regionLabels = {}) {
  const text = String(location || "");
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  const exact = (list) => (list || []).find((v) => parts.includes(v));
  const region = exact(PH_REGIONS)
    || PH_REGIONS.find((r) => regionLabels[r] && parts.includes(regionLabels[r]))
    || longestWithin(text, PH_REGIONS);
  const province = region ? exact(PH_PROVINCES[region]) || longestWithin(text, PH_PROVINCES[region]) : "";
  const city = province ? exact(PH_CITIES[province]) || longestWithin(text, PH_CITIES[province]) : "";
  const cityAt = city ? parts.indexOf(city) : -1;
  const barangay = cityAt > 0 ? parts.slice(0, cityAt).join(", ") : "";
  return { region, province, city, barangay };
}

/** public/ph-barangays/<slug>.json for a region key ("Region IV-A (CALABARZON)" -> "region-iv-a-calabarzon"). */
export function regionSlug(region) {
  return String(region || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
