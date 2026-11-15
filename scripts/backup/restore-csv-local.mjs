#!/usr/bin/env node
/**
 * Restore a CSV backup (Backup & Recovery, "Download everything") into the
 * LOCAL Supabase stack only -- the worked example of the restore guide in
 * every backup README (docs/restore-from-csv-backup.md). 2026-11-15.
 *
 *   node scripts/backup/restore-csv-local.mjs <sacs-payroll_everything_*.zip> --yes
 *
 * It EMPTIES the local database's backup tables and auth.users, then loads:
 *   1. sign-in accounts from users_and_accounts.csv (same UUID and email, no
 *      password: people reset it), 2. every table file in the README's LOAD
 *      ORDER, reading the README's column guide ([loads into: column (type)]),
 *      in one session per table with triggers and foreign-key checks off
 *      (session_replication_role = replica) so stored values stay as they are.
 * Then it compares every table's row count with the README and prints the time.
 *
 * Local only: it talks to the docker container supabase_db_SACS-PAYROLL and
 * nothing else. Never point it at production.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const CONTAINER = "supabase_db_SACS-PAYROLL";
const [zipPath, ...flags] = process.argv.slice(2);
if (!zipPath || !flags.includes("--yes")) {
  console.error("Usage: node scripts/backup/restore-csv-local.mjs <backup.zip> --yes\nEMPTIES the LOCAL database, then loads the backup. Local stack only.");
  process.exit(2);
}

const psql = (sql) => execSync(`docker exec -i ${CONTAINER} psql -qtA -v ON_ERROR_STOP=1 -U postgres -d postgres`, { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

/** ZIP (central directory) -> { name: text }. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < entries; i += 1) {
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files[name] = inflateRawSync(buffer.subarray(start, start + packed)).toString("utf8").replace(/^﻿/, "");
    at += 46 + nameLength + skip;
  }
  return files;
}

/** CSV text -> rows of cells (quotes, doubled quotes, CRLF and line breaks inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 1; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** README -> { order, files: { name: { rows, columns: { header: { column, type } } } } }. */
function readReadme(text) {
  const order = (/^LOAD ORDER: (.+)$/m.exec(text)?.[1] || "").split(", ").filter(Boolean);
  const files = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const file = /^([a-z0-9_]+\.csv)$/.exec(line);
    if (file) { current = { rows: null, columns: {} }; files[file[1]] = current; continue; }
    if (!current) continue;
    const rows = /^ {2}Rows: (\d+)$/.exec(line);
    if (rows) current.rows = Number(rows[1]);
    const col = /^ {4}(.+?) - .*\[loads into: ([a-z0-9_]+) \(([a-z]+)\)\]$/.exec(line);
    if (col) current.columns[col[1]] = { column: col[2], type: col[3] };
  }
  return { order, files };
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** One CSV cell -> an SQL literal for its column. */
function literal(value, type, meta) {
  if (value === "") {
    if (meta && meta.nullable === "NO") return meta.hasDefault ? "DEFAULT" : ["text", "character varying"].includes(meta.dataType) ? "''" : "DEFAULT";
    return "NULL";
  }
  switch (type) {
    case "tstz": return quote(`${value}+08`); // exported in Asia/Manila
    case "bool": return value === "Yes" ? "TRUE" : value === "No" ? "FALSE" : quote(value);
    case "array": {
      const list = JSON.parse(value);
      return quote(`{${list.map((v) => (v === null ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}`);
    }
    case "num": case "int": case "date": case "time": case "json": return quote(value);
    default: return quote(/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value); // the formula guard taken off
  }
}

const started = Date.now();
const files = unzip(readFileSync(zipPath));
const readme = readReadme(files["README.txt"] || "");
if (!readme.order.length) throw new Error("README.txt has no LOAD ORDER: not a full CSV backup.");
const tables = readme.order.filter((t) => files[`${t}.csv`]);
console.log(`Restoring ${tables.length} tables from ${zipPath} into the LOCAL database (${CONTAINER}).`);

// Column facts of the target tables (required, defaults, identity).
const meta = {};
psql(`select table_name || '|' || column_name || '|' || is_nullable || '|' || (column_default is not null or is_identity = 'YES')::text || '|' || data_type || '|' || coalesce(identity_generation, '') || '|' || is_generated
  from information_schema.columns where table_schema = 'public' and table_name in (${tables.map(quote).join(",")})`).split("\n").filter(Boolean).forEach((line) => {
  const [table, column, nullable, hasDefault, dataType, identity, generated] = line.split("|");
  (meta[table] ||= {})[column] = { nullable, hasDefault: hasDefault === "true", dataType, identity, generated: generated === "ALWAYS" };
});

// 1. Empty the local tables (and sign-in accounts).
psql(`truncate table ${tables.map((t) => `public.${t}`).join(", ")}, auth.users cascade;`);

// 2. Sign-in accounts, same UUID and email; no password (people reset it).
const users = parseCsv(files["users_and_accounts.csv"] || "");
const [uh, ...urows] = users;
const ui = (name) => uh.indexOf(name);
const accounts = urows.filter((r) => r[ui("Note")] !== "Profile without a sign-in account" && r[ui("User UUID")]);
if (accounts.length) {
  psql(`set session_replication_role = replica;
    insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
    values ${accounts.map((r) => {
      const created = r[ui("Account created (Asia/Manila)")] ? quote(`${r[ui("Account created (Asia/Manila)")]}+08`) : "now()";
      return `('00000000-0000-0000-0000-000000000000', ${quote(r[ui("User UUID")])}, 'authenticated', 'authenticated', ${quote(r[ui("Email")])}, ${r[ui("Email confirmed")] === "Yes" ? created : "NULL"}, ${created}, now(), '{"provider":"email","providers":["email"]}', '{}', false, false)`;
    }).join(",\n")};`);
}

// 3. Every table, parents first, triggers and foreign-key checks off.
const report = [];
for (const table of tables) {
  const file = readme.files[`${table}.csv`];
  const [header, ...rows] = parseCsv(files[`${table}.csv`]);
  const picks = header.map((h, i) => ({ i, ...(file.columns[h] || {}) })).filter((p) => p.column && meta[table]?.[p.column] && !meta[table][p.column].generated); // computed columns fill themselves
  const columns = picks.map((p) => p.column);
  const overriding = columns.some((c) => meta[table][c].identity === "ALWAYS") ? " overriding system value" : "";
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows.slice(i, i + 200).map((r) => `(${picks.map((p) => literal(r[p.i], p.type, meta[table][p.column])).join(", ")})`).join(",\n");
    psql(`set session_replication_role = replica;\ninsert into public.${table} (${columns.map((c) => `"${c}"`).join(", ")})${overriding} values\n${values};`);
  }
  const inDb = Number(psql(`select count(*) from public.${table}`));
  report.push({ table, csv: rows.length, readme: file.rows, database: inDb, ok: inDb === rows.length && rows.length === file.rows });
}

// Identity / serial columns continue after the loaded ids.
psql(`do $$ declare r record; begin
  for r in select c.table_name t, c.column_name col, pg_get_serial_sequence('public.' || c.table_name, c.column_name) s
    from information_schema.columns c where c.table_schema = 'public' and c.table_name in (${tables.map(quote).join(",")})
      and pg_get_serial_sequence('public.' || c.table_name, c.column_name) is not null loop
    execute format('select setval(%L, greatest(1, coalesce((select max(%I) from public.%I), 1)))', r.s, r.col, r.t);
  end loop; end $$;`);

const seconds = (Date.now() - started) / 1000;
const bad = report.filter((r) => !r.ok);
console.log(`Loaded ${accounts.length} sign-in accounts and ${report.reduce((n, r) => n + r.database, 0)} rows into ${report.length} tables in ${seconds.toFixed(1)} s.`);
bad.forEach((r) => console.log(`  MISMATCH ${r.table}: csv ${r.csv}, README ${r.readme}, database ${r.database}`));
console.log(JSON.stringify({ seconds, accounts: accounts.length, tables: report }));
process.exit(bad.length ? 1 : 0);
