/**
 * A small in-memory stand-in for the parts of supabase-js the API routes use:
 * from().select/insert/upsert/update/delete with eq/in/gte/lte/lt/like/order/
 * limit, maybeSingle/single, rpc(), and auth.admin.listUsers().
 *
 * Usage (vi.mock is hoisted, so the module is imported inside the factory):
 *
 *   vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);
 */

// Kept on globalThis: vi.resetModules() hands the mocked supabase-js a fresh
// copy of this module, and both copies must see the same data.
const state = (globalThis.__fakeSupabaseState ??= { db: {}, users: [], rpc: { calls: [], results: {} } });
export const db = state.db;
export const users = state.users;
export const rpc = state.rpc;

export function resetDb() {
  for (const key of Object.keys(db)) delete db[key];
  users.length = 0;
  rpc.calls = [];
  rpc.results = {};
}

export function table(name) {
  if (!db[name]) db[name] = [];
  return db[name];
}

function query(name) {
  const filters = [];
  let op = "select";
  let payload = null;
  let limitN = null;
  let single = false;
  const orders = [];

  const matches = (row) => filters.every((f) => f(row));
  const run = () => {
    const rows = table(name);
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
        id: row.id || `${name}-${rows.length}-${Math.random().toString(16).slice(2, 8)}`,
        created_at: new Date().toISOString(),
        ...row,
      }));
      rows.push(...list);
      return { data: single ? list[0] : list, error: null };
    }
    if (op === "upsert") {
      const list = Array.isArray(payload) ? payload : [payload];
      list.forEach((row) => {
        const i = rows.findIndex((r) => r.id === row.id || (r.employee_id === row.employee_id && r.pay_period === row.pay_period));
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push({ ...row });
      });
      return { data: list, error: null };
    }
    if (op === "update") {
      const hit = rows.filter(matches);
      hit.forEach((row) => Object.assign(row, payload));
      return { data: single ? hit[0] || null : hit, error: null };
    }
    if (op === "delete") {
      db[name] = rows.filter((row) => !matches(row));
      return { data: null, error: null };
    }
    let out = rows.filter(matches);
    orders.forEach(({ column, ascending }) => {
      out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    });
    if (limitN !== null) out = out.slice(0, limitN);
    return { data: single ? out[0] || null : out, error: null };
  };

  const builder = {
    select() { return builder; },
    insert(rows) { op = "insert"; payload = rows; return builder; },
    upsert(rows) { op = "upsert"; payload = rows; return builder; },
    update(values) { op = "update"; payload = values; return builder; },
    delete() { op = "delete"; return builder; },
    eq(column, value) { filters.push((row) => row[column] === value); return builder; },
    neq(column, value) { filters.push((row) => row[column] !== value); return builder; },
    in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
    gte(column, value) { filters.push((row) => String(row[column]) >= String(value)); return builder; },
    lte(column, value) { filters.push((row) => String(row[column]) <= String(value)); return builder; },
    lt(column, value) { filters.push((row) => String(row[column]) < String(value)); return builder; },
    like(column, pattern) {
      const prefix = pattern.replace(/%$/, "");
      filters.push((row) => String(row[column] || "").startsWith(prefix));
      return builder;
    },
    order(column, options = {}) { orders.push({ column, ascending: options.ascending !== false }); return builder; },
    limit(n) { limitN = n; return builder; },
    maybeSingle() { single = true; return Promise.resolve(run()); },
    single() { single = true; return Promise.resolve(run()); },
    then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
  };
  return builder;
}

/**
 * In-memory stand-in for public.payroll_commit_entries
 * (20260926090000_payroll_legal_rules_and_atomic_commit.sql): per employee,
 * a payroll_records row with the next PS-YYYYMM-NNNN number, the
 * payroll_entries row (upserted on employee + period) and the line rows --
 * all or nothing, with "23505" when the employee's period is already paid.
 */
function commitPayrollEntries({ p_items: items = [] } = {}) {
  return items.map((item) => {
    const { record, entry } = item;
    const records = table("payroll_records");
    if (records.some((r) => r.employee_id === record.employee_id && r.period_label === record.period_label && !r.archived)) {
      return { employee_id: entry.employee_id, ok: false, code: "23505", error: "duplicate key value violates unique constraint" };
    }
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" })
      .format(new Date(record.processed_at || Date.now())).replace("-", "");
    const prefix = `PS-${month}-`;
    const seq = records
      .filter((r) => String(r.payslip_no || "").startsWith(prefix))
      .reduce((max, r) => Math.max(max, Number(String(r.payslip_no).slice(prefix.length)) || 0), 0) + 1;
    const payslipNo = `${prefix}${String(seq).padStart(4, "0")}`;

    const recordId = `payroll_records-${records.length}-${Math.random().toString(16).slice(2, 8)}`;
    records.push({ id: recordId, archived: false, ...record, payslip_no: payslipNo });

    const entries = table("payroll_entries");
    const at = entries.findIndex((e) => e.employee_id === entry.employee_id && e.pay_period === entry.pay_period);
    const entryRow = { ...entry, payslip_no: payslipNo };
    if (at >= 0) entries[at] = { ...entries[at], ...entryRow, id: entries[at].id };
    else entries.push(entryRow);
    const entryId = at >= 0 ? entries[at].id : entry.id;

    const base = { payroll_record_id: recordId, payroll_entry_id: entryId, employee_id: entry.employee_id, pay_period: entry.pay_period };
    (item.deductions || []).forEach((line) => table("payroll_deductions").push({ ...base, ...line }));
    (item.incentives || []).forEach((line) => table("payroll_incentives").push({ ...base, ...line }));

    return { employee_id: entry.employee_id, ok: true, record_id: recordId, entry_id: entryId, payslip_no: payslipNo };
  });
}

export const supabaseModule = {
  createClient: () => ({
    from: (name) => query(name),
    rpc: async (fn, args) => {
      rpc.calls.push({ fn, args });
      const result = rpc.results[fn];
      if (!result && fn === "payroll_commit_entries") return { data: commitPayrollEntries(args), error: null };
      return typeof result === "function" ? result(args) : (result || { data: {}, error: null });
    },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users }, error: null }),
        getUserById: async (id) => {
          const user = users.find((u) => u.id === id) || null;
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "User not found" } };
        },
        // Merges app_metadata like Supabase does, so session revocation is observable.
        updateUserById: async (id, attrs = {}) => {
          const user = users.find((u) => u.id === id);
          if (user && attrs.app_metadata) user.app_metadata = { ...(user.app_metadata || {}), ...attrs.app_metadata };
          if (user && attrs.user_metadata) user.user_metadata = attrs.user_metadata;
          return { data: { user: user || {} }, error: null };
        },
      },
    },
  }),
};
