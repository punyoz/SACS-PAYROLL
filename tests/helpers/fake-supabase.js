/**
 * A small in-memory stand-in for the parts of supabase-js the API routes use:
 * from().select/insert/upsert/update/delete with eq/in/gte/lte/lt/like/order/
 * limit/range, maybeSingle/single, rpc(), and auth.admin.listUsers().
 *
 * Usage (vi.mock is hoisted, so the module is imported inside the factory):
 *
 *   vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);
 */

// Kept on globalThis: vi.resetModules() hands the mocked supabase-js a fresh
// copy of this module, and both copies must see the same data.
const state = (globalThis.__fakeSupabaseState ??= { db: {}, users: [], rpc: { calls: [], results: {} }, maxRows: null });
export const db = state.db;
export const users = state.users;
export const rpc = state.rpc;

// Tables added by a migration that the code must also work without: they
// answer like PostgreSQL does before the migration ("relation does not
// exist") until a test calls setMissingTables([]) — or seeds them.
// payroll_schedule_settings: 20261009010000 (src/lib/payroll/schedule.js
// falls back to the attendance_lock_day rate and the old window).
const DEFAULT_MISSING_TABLES = ["payroll_schedule_settings"];
state.missing ??= new Set(DEFAULT_MISSING_TABLES);

/** Tables that behave as not created yet. [] = every table exists. */
export function setMissingTables(names = []) {
  state.missing = new Set(names);
}

/** Cap every select at n rows, like PostgREST's max-rows (1000 by default). null = no cap. */
export function setMaxRows(n) {
  state.maxRows = n;
}

export function resetDb() {
  for (const key of Object.keys(db)) delete db[key];
  users.length = 0;
  rpc.calls = [];
  rpc.results = {};
  state.maxRows = null;
  state.missing = new Set(DEFAULT_MISSING_TABLES);
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
  let rangeFrom = null;
  let rangeTo = null;
  let single = false;
  const orders = [];

  const matches = (row) => filters.every((f) => f(row));
  const run = () => {
    if (state.missing.has(name) && !db[name]) {
      return { data: null, error: { code: "42P01", message: `relation "public.${name}" does not exist` } };
    }
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
    // Applied last-to-first so the first order() is the primary key, as in
    // SQL (Array#sort is stable).
    [...orders].reverse().forEach(({ column, ascending }) => {
      out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    });
    if (rangeFrom !== null) out = out.slice(rangeFrom, rangeTo + 1);
    if (limitN !== null) out = out.slice(0, limitN);
    if (state.maxRows !== null) out = out.slice(0, state.maxRows);
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
    // .is(column, null): a missing value counts as NULL, as in SQL.
    is(column, value) { filters.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value)); return builder; },
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
    range(from, to) { rangeFrom = from; rangeTo = to; return builder; },
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

    // 20261009020000: loan repayments, reversing this period's earlier ones
    // first; the loan's balance and status follow (payroll_loan_payments_apply).
    const loans = table("payroll_loans");
    const payments = table("payroll_loan_payments");
    const applyToLoan = (loanId, amount) => {
      const loan = loans.find((l) => l.id === loanId);
      if (!loan) return;
      loan.remaining_balance = Math.round((Number(loan.remaining_balance) - amount) * 100) / 100;
      if (loan.remaining_balance === 0) loan.status = "paid";
      else if (loan.status === "paid") loan.status = "active";
    };
    payments
      .filter((p) => p.employee_id === entry.employee_id && p.kind === "payroll" && p.period_start === record.period_start && !p.reversed)
      .forEach((p) => {
        p.reversed = true;
        payments.push({ id: `pay-${payments.length}`, loan_id: p.loan_id, employee_id: entry.employee_id, kind: "reversal", amount: -p.amount, reverses_payment_id: p.id });
        applyToLoan(p.loan_id, -p.amount);
      });
    (item.loan_payments || []).filter((line) => Number(line.amount) > 0).forEach((line) => {
      payments.push({
        id: `pay-${payments.length}`, loan_id: line.loan_id, employee_id: entry.employee_id, kind: line.kind || "payroll",
        period_start: (line.kind || "payroll") === "payroll" ? record.period_start : null,
        pay_period: entry.pay_period, payroll_entry_id: entryId, amount: Number(line.amount), amount_due: Number(line.amount_due ?? line.amount), reversed: false,
      });
      applyToLoan(line.loan_id, Number(line.amount));
    });
    if (item.subsidy?.balance_id) {
      const balance = table("payroll_subsidy_balances").find((b) => b.id === item.subsidy.balance_id);
      if (balance) Object.assign(balance, { paid_out: Number(item.subsidy.payout), paid_out_on: item.subsidy.paid_on, status: "paid_out", payout_entry_id: entryId });
    }
    (item.subsidy_adjustments || []).forEach((id) => {
      const adjustment = table("payroll_subsidy_adjustments").find((a) => a.id === id && a.status === "approved");
      if (adjustment) Object.assign(adjustment, { status: "applied", payroll_entry_id: entryId, applied_period_start: record.period_start });
    });

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
