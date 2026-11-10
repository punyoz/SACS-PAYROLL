// The demo bundle (G3): every row that belongs to the demo, found the same
// way on any database:
//   * the demo people: profiles.is_demo = true (and their login accounts);
//   * every row whose person columns all point at demo people (or are empty)
//     and at least one does, plus every row hanging off such a row by a
//     foreign key (payslip lines, card history, run items, ...), repeated
//     until nothing new is found;
//   * audit entries by a demo person or about one.
// A row mixing a demo person with a non-demo one (a real HR deciding a demo
// request, say) is NOT demo data: it is listed, never copied or deleted, and
// remove only clears its demo reference.
//
// Used by export (local -> bundle file), load (bundle -> a database),
// snapshot (a database -> file) and remove (delete the demo rows).
import { lit } from "./db.mjs";
import { SEED_ACTOR } from "./config.mjs";

/** Tables never copied: configuration that already exists everywhere, and transient state. */
const SKIP = new Set(["role_permissions", "system_config", "branches", "payroll_rate_configs", "payroll_tax_brackets", "payroll_sss_msc_brackets",
  "payroll_schedule_settings", "school_break_periods", "tenure_protection_policies", "attendance_holidays",
  "payroll_window_enforcement", "payroll_window_enforcement_changes", "auth_email_otps", "auth_throttle", "hr_queue_claims", "notification_channels"]);

/**
 * Rows made BY a demo item go with it, whoever received them (a notification
 * about a demo payroll run sent to a non-demo HR, the run's approval history).
 */
const DEMO_GENERATED = new Set(["notifications", "payroll_approval_history"]);

/** Person columns without a foreign key. */
const LOOSE_PERSON_COLUMNS = { audit_logs: ["actor_id"], work_schedules: ["created_by"] };

export async function schema(db) {
  const fks = await db.rows(`select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref, ra.attname as ref_col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1`);
  const cols = await db.rows(`select table_name as tbl, column_name as col, is_generated = 'ALWAYS' or (column_default like 'nextval%' and false) as generated, data_type
    from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`);
  const pks = await db.rows(`select c.conrelid::regclass::text as tbl, a.attname as col from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'p' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1`);
  const tables = [...new Set(cols.map((c) => c.tbl))].filter((t) => !SKIP.has(t));
  const byTable = Object.fromEntries(tables.map((t) => [t, {
    columns: cols.filter((c) => c.tbl === t).map((c) => c.col),
    generated: cols.filter((c) => c.tbl === t && c.generated).map((c) => c.col),
    person: [...new Set([...fks.filter((f) => f.tbl === t && (f.ref === "profiles" || f.ref === "auth.users")).map((f) => f.col), ...(LOOSE_PERSON_COLUMNS[t] || [])])],
    parents: fks.filter((f) => f.tbl === t && f.ref !== "profiles" && f.ref !== "auth.users" && f.ref !== t).map((f) => ({ col: f.col, ref: f.ref, refCol: f.ref_col })),
    key: pks.find((k) => k.tbl === t)?.col || null,
  }]));
  return byTable;
}

const inList = (ids) => (ids.length ? ids.map(lit).join(", ") : "null");

/**
 * Find the demo rows. Returns { demoIds, tables: { name: rows }, mixed: { name: count } }.
 * `withRows` false returns ids only (for remove / counts).
 */
export async function collect(db, { withRows = true } = {}) {
  const meta = await schema(db);
  const demoIds = (await db.rows("select id from profiles where is_demo")).map((r) => r.id);
  if (!demoIds.length) return { demoIds, tables: {}, mixed: {}, meta };
  const D = inList(demoIds);
  const found = {}; // table -> Map(id -> row)
  const mixed = {};
  const add = (t, rows) => { const k = meta[t]?.key || "id"; found[t] = found[t] || new Map(); let n = 0; for (const r of rows) if (!found[t].has(r[k])) { found[t].set(r[k], r); n += 1; } return n; };
  const personOk = (t) => {
    const p = meta[t].person;
    return p.length ? p.map((c) => `(${c} is null or ${c} in (${D}))`).join(" and ") : "true";
  };
  const pick = (t) => (withRows ? "*" : meta[t].key);

  // 1. Rows that name a demo person (and only demo people).
  for (const [t, m] of Object.entries(meta)) {
    if (!m.key || t === "profiles" || !m.person.length) continue;
    const any = m.person.map((c) => `${c} in (${D})`).join(" or ");
    const rows = await db.rows(`select ${pick(t)} from ${t} where (${any}) and ${personOk(t)}`);
    add(t, rows);
    const [mx] = await db.rows(`select count(*)::int n from ${t} where (${any}) and not (${personOk(t)})`);
    if (mx.n) mixed[t] = mx.n;
  }
  // Audit entries about a demo person without an actor (system events, duplicate taps).
  add("audit_logs", await db.rows(`select ${pick("audit_logs")} from audit_logs where actor_id is null and metadata->>'employee_id' in (${D})`));

  // 2. Rows hanging off demo rows, until nothing new is found.
  for (let pass = 0; pass < 6; pass += 1) {
    let added = 0;
    for (const [t, m] of Object.entries(meta)) {
      if (!m.key || t === "profiles") continue;
      for (const { col, ref } of m.parents) {
        const parentIds = [...(found[ref]?.keys() || [])];
        if (!parentIds.length) continue;
        for (let i = 0; i < parentIds.length; i += 2000) {
          const rows = await db.rows(`select ${pick(t)} from ${t} where ${col} in (${inList(parentIds.slice(i, i + 2000))}) and ${DEMO_GENERATED.has(t) ? "true" : personOk(t)}`);
          added += add(t, rows);
        }
      }
    }
    if (!added) break;
  }

  const tables = Object.fromEntries(Object.entries(found).map(([t, map]) => [t, [...map.values()]]));
  tables.profiles = withRows ? await db.rows(`select * from profiles where is_demo`) : demoIds.map((id) => ({ id }));
  return { demoIds, tables, mixed, meta };
}

/** Insert order: a table after every table it points at. */
export function insertOrder(meta, names) {
  const order = [];
  const seen = new Set();
  const visit = (t, depth = 0) => {
    if (seen.has(t) || !names.includes(t) || depth > 40) return;
    seen.add(t);
    for (const { ref } of meta[t]?.parents || []) visit(ref, depth + 1);
    order.push(t);
  };
  visit("profiles");
  for (const t of names) visit(t);
  return order;
}

export function counts(bundle) {
  return Object.fromEntries(Object.entries(bundle.tables).map(([t, rows]) => [t, rows.length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]));
}

/** For the bundle only: Branch 4's "Demo seed" processor is not an employee, so its run exclusions are not copied. */
export function withoutSeedExclusions(tables) {
  return { ...tables, payroll_run_exclusions: (tables.payroll_run_exclusions || []).filter((r) => r.employee_id !== SEED_ACTOR.id) };
}
