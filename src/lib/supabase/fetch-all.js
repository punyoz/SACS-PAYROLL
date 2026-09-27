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
