/**
 * A table's search and sort, applied on the server to an export (2026-11-19),
 * so the Excel / PDF lists exactly what the screen's DataTable shows. Each
 * page shares its fields with its route: `fields(row)` gives the texts the
 * search box matches (a row matches when one of them contains the text, as
 * DataTable does), `sorts` the sortable columns { key: { label, value(row) } }.
 *
 *   const { rows, filters } = tableQuery(url, rows, { fields, sorts, defaultSort: "Given (newest first)" });
 */

const compare = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
};

/** "key:asc" | "key:desc" → { key, dir } when the key is one of `sorts`; else null. */
export function parseSort(text, sorts) {
  const [key, dir] = String(text || "").split(":");
  return sorts?.[key] && ["asc", "desc"].includes(dir) ? { key, dir } : null;
}

export function searchRows(rows, query, fields) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => fields(row).some((text) => text !== null && text !== undefined && String(text).toLowerCase().includes(q)));
}

/** DataTable's own order: the column's value, ascending or descending; no sort keeps the list as it is. */
export function sortRows(rows, sort, sorts) {
  if (!sort || !sorts?.[sort.key]) return rows;
  const value = sorts[sort.key].value;
  const factor = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => factor * compare(value(a), value(b)));
}

export function sortLabel(sort, sorts, fallback = "As listed") {
  if (!sort || !sorts?.[sort.key]) return fallback;
  return `${sorts[sort.key].label} (${sort.dir === "desc" ? "descending" : "ascending"})`;
}

/**
 * The search (?q=) and sort (?sort=key:dir) of a table, applied to `rows`,
 * with the two filter-line entries that say so in words.
 */
export function tableQuery(url, rows, { fields, sorts = {}, defaultSort = "As listed" }) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const sort = parseSort(url.searchParams.get("sort"), sorts);
  return {
    q,
    rows: sortRows(searchRows(rows, q, fields), sort, sorts),
    filters: [["Search", q || "none"], ["Sorted by", sortLabel(sort, sorts, defaultSort)]],
  };
}

/** The params an ExportButtons sends for a DataTable toolbar's { query, sort }. */
export function tableParams({ query, sort } = {}) {
  return { q: query || "", sort: sort ? `${sort.key}:${sort.dir}` : "" };
}
