// One-time RFID reset before the defense (approved 2026-11-12, Part 2):
// DELETES every Active, Inactive and Replaced card record (and their card
// history rows) so every physical card can be registered again with Register
// many cards. LOST cards are kept: those numbers stay blocked for good.
//
//   node scripts/rfid-reset.mjs --target=local                 counts + list, then asks
//   node scripts/rfid-reset.mjs --target=production            URL typed back, counts, yes/no
//   node scripts/rfid-reset.mjs --target=local --dry-run       counts + list only
//   node scripts/rfid-reset.mjs --target=local --restore=<snapshot.json>   put the deleted rows back
//
// Before deleting: a snapshot (the cards, their history, the profiles' card
// numbers) is written OUTSIDE the repo, to %USERPROFILE%\sacs-snapshots.
// One transaction: attendance is never touched (attendance_logs.rfid_code is
// text, no foreign key); profiles.rfid_uid of the removed cards is cleared so
// the kiosk answers "Card not registered"; one audit entry per removed card
// (last 4 digits only). Nothing prints a full card number, key or token.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseTarget, confirm, lit } from "./demo/db.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const restoreFile = argv.find((a) => a.startsWith("--restore="))?.split("=").slice(1).join("=");
const db = await chooseTarget(argv);
const SNAP_DIR = join(homedir(), "sacs-snapshots");
const say = (...m) => console.log(...m);

// Triggers that refuse a hard delete / a direct change: off for this transaction only.
const triggersOff = `
  alter table public.rfid_cards disable trigger rfid_cards_block_hard_delete;
  alter table public.rfid_card_events disable trigger rfid_card_events_block_hard_delete;
  select set_config('sacs.rfid_flow', 'on', true);`;
const triggersOn = `
  alter table public.rfid_cards enable trigger rfid_cards_block_hard_delete;
  alter table public.rfid_card_events enable trigger rfid_card_events_block_hard_delete;`;

const counts = async () => db.rows(`select status, count(*)::int n from public.rfid_cards group by 1 order by 1`);
const attendanceCount = async () => (await db.rows(`select count(*)::int n from public.attendance_logs`))[0].n;

if (restoreFile) {
  const snap = JSON.parse(readFileSync(restoreFile, "utf8"));
  say(`Restore ${snap.cards.length} cards and ${snap.events.length} history rows from ${restoreFile} (${db.target}).`);
  if (!(await confirm("Type yes to restore:"))) process.exit(1);
  const insert = (table, rows) => (rows.length ? `insert into public.${table} select * from json_populate_recordset(null::public.${table}, ${lit(JSON.stringify(rows))}::json);` : "");
  // Cards that replace other cards go in after them (replaces_card_id).
  const cards = [...snap.cards].sort((a, b) => (a.replaces_card_id ? 1 : 0) - (b.replaces_card_id ? 1 : 0));
  await db.exec(`begin; ${triggersOff}
    ${insert("rfid_cards", cards)}
    ${insert("rfid_card_events", snap.events)}
    ${snap.profiles.map((p) => `update public.profiles set rfid_uid = ${lit(p.rfid_uid)} where id = ${lit(p.id)};`).join("\n")}
    ${triggersOn} commit;`);
  say("Restored. Cards now:", JSON.stringify(await counts()));
  process.exit(0);
}

const cards = await db.rows(`select c.*, p.employee_id as code, p.full_name, p.is_demo from public.rfid_cards c left join public.profiles p on p.id = c.employee_id where c.status <> 'lost' order by c.status, p.employee_id`);
const ids = cards.map((c) => lit(c.id)).join(", ") || "null";
const events = cards.length ? await db.rows(`select * from public.rfid_card_events where card_id in (${ids})`) : [];
const profiles = cards.length ? await db.rows(`select id, rfid_uid from public.profiles where rfid_uid in (${cards.map((c) => lit(c.uid)).join(", ")})`) : [];
const lostLinks = cards.length ? (await db.rows(`select count(*)::int n from public.rfid_cards where status = 'lost' and replaces_card_id in (${ids})`))[0].n : 0;

say(`Target: ${db.target}`);
say("Cards by status now:", JSON.stringify(await counts()));
say(`To DELETE: ${cards.length} card records (${["active", "inactive", "replaced"].map((s) => `${s} ${cards.filter((c) => c.status === s).length}`).join(", ")}), ${events.length} card history rows; ${profiles.length} profiles lose their card number.`);
say(`Kept: every Lost card${lostLinks ? ` (${lostLinks} of them lose their "replaces" link to a deleted card)` : ""}.`);
for (const c of cards) say(`  ${c.status.padEnd(9)} ${String(c.code || "?").padEnd(14)} ****${c.uid_last4}  ${c.is_demo ? "demo" : "original"}  ${c.full_name || ""}`);
if (dryRun || !cards.length) { say(dryRun ? "Dry run: nothing changed." : "Nothing to delete."); process.exit(0); }

mkdirSync(SNAP_DIR, { recursive: true });
const file = join(SNAP_DIR, `rfid-reset-${db.target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const snapCards = cards.map(({ code, full_name: _n, is_demo: _d, ...card }) => card);
writeFileSync(file, JSON.stringify({ created_at: new Date().toISOString(), target: db.target, cards: snapCards, events, profiles }));
say(`Snapshot written: ${file}`);

if (!(await confirm(`Type yes to DELETE ${cards.length} card records on ${db.target}:`))) { say("Nothing was done."); process.exit(1); }

const before = await attendanceCount();
const audit = cards.map((c) => `(${[
  "rfid", "rfid_card_removed", "rfid_card", c.id,
  `RFID card ending in ${c.uid_last4} removed for ${c.code || c.employee_id}. By: System (defense reset). Reason: Reset before the defense.`,
  "success", "script",
].map(lit).join(", ")}, ${lit(c.branch_id)}, true, ${lit({ employee_id: c.employee_id, uid_last4: c.uid_last4, status: c.status, batch: "defense-rfid-reset-2026-11" })}, 'System (defense reset)', 'system')`).join(",\n");
await db.exec(`begin; ${triggersOff}
  update public.rfid_cards set replaces_card_id = null where status = 'lost' and replaces_card_id in (${ids});
  delete from public.rfid_card_events where card_id in (${ids});
  delete from public.rfid_cards where id in (${ids});
  update public.profiles set rfid_uid = null where rfid_uid in (${cards.map((c) => lit(c.uid)).join(", ")});
  insert into public.audit_logs (module, action, entity_type, entity_id, description, status, source, branch_id, is_system_event, metadata, actor_name, actor_role) values ${audit};
  ${triggersOn} commit;`);
const after = await attendanceCount();
say("Done. Cards by status now:", JSON.stringify(await counts()));
say(`Audit entries written: ${cards.length}. Attendance rows before ${before}, after ${after}${before === after ? " (unchanged)" : " — CHANGED, check!"}.`);
