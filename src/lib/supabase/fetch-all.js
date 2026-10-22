/**
 * Read every row of a query, a page at a time.
 *
 * PostgREST answers at most its max-rows setting (1000 by default) per
 * request, and a plain .limit(N) silently drops everything past N. Reads that
 * must see every row -- the payroll entries a duplicate-payment check relies
 * on, the profiles the trusted-field overlay needs -- page through with
 * .range() instead, until a short page says there is nothing left.
 *
 * @param {() => any} buildQuery returns a fresh, fully filtered and ordered
 *        query builder each time (a builder cannot be reused across pages).
 * @param {number} pageSize
 * @returns {Promise<{ data: any[], error: any }>}
 */
export async function fetchAllRows(buildQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

/**
 * Values per `.in()` filter. The list travels in the request URL, and the
 * API gateway refuses a long one ("URI too long"): from ~300 employees in a
 * branch, every `.in("employee_id", ids)` failed (scale test 2026-10-22).
 * 100 UUIDs keep the URL near 4 KB.
 */
export const IN_CHUNK_SIZE = 100;

/** Split a list of filter values (duplicates and blanks dropped) into chunks. */
export function chunkValues(values, size = IN_CHUNK_SIZE) {
  const list = [...new Set((values || []).filter((v) => v !== null && v !== undefined && v !== ""))];
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

/**
 * Every row whose `column` is in `values`, however many values there are:
 * one paged query (fetchAllRows) per chunk of values. Rows come back chunk
 * by chunk, so a caller that needs one overall order sorts them itself.
 *
 * @param {() => any} buildQuery a fresh, filtered and ordered query builder
 * @param {string} column
 * @param {any[]} values
 * @returns {Promise<{ data: any[], error: any }>}
 */
export async function fetchAllIn(buildQuery, column, values, size = IN_CHUNK_SIZE) {
  const rows = [];
  for (const part of chunkValues(values, size)) {
    const { data, error } = await fetchAllRows(() => buildQuery().in(column, part));
    if (error) return { data: rows, error };
    rows.push(...data);
  }
  return { data: rows, error: null };
}

/** Run a write (update / delete) filtered by `.in(column, values)` in chunks. */
export async function forEachInChunk(values, run, size = IN_CHUNK_SIZE) {
  for (const part of chunkValues(values, size)) {
    const { error } = await run(part);
    if (error) return { error };
  }
  return { error: null };
}
