# Local migration replay, then `migration repair`

Goal: prove every file in `supabase/migrations/` builds the database from
nothing, and that the result matches the live project, **before** the live
migration history is rewritten with `supabase migration repair`.

Nothing in steps 1–5 writes to the live project. Step 6 rewrites only the live
`supabase_migrations.schema_migrations` table (the history list), never the
schema or data. Step 7 is the only step that changes the live schema.

Live project ref: `swtlmaupaarrppypxsip`.

## 0. Why the history needs repairing

The live history lists 83 migrations and the repo has 81 files. The changes
match, but the version numbers don't: many migrations were applied through the
dashboard / MCP and stamped with the time they ran, not their file name. Three
small live fixes (`block_history_rewrite_search_path`,
`rls_helpers_private_qualified_refs`, `holiday_calendar_apply_whole_day`) were
folded into the repo files `20260927020000`, `20260927050000` and
`20261007010000`. Until the history is repaired, `supabase db push` would try
to re-run 35 files that are already live.

## 1. Install (once)

1. Install **Docker Desktop** and start it (WSL 2 backend on Windows). Check:
   `docker version`
2. The Supabase CLI runs through npx, no global install needed. Check:
   `npx supabase@latest --version`
3. Set the rotated access token in the terminal you will use
   (PowerShell: `$env:SUPABASE_ACCESS_TOKEN = "sbp_..."`).

## 2. Initialise the CLI config (once)

From the repo root:

```
npx supabase init
```

- Answer **N** to the VS Code / IntelliJ Deno settings prompts.
- It creates `supabase/config.toml` and `supabase/.gitignore` and leaves
  `supabase/migrations/` untouched. Commit those two files.

## 3. Replay every migration on a fresh local database

```
npx supabase start
npx supabase db reset
```

`db reset` drops the local database and applies every file in
`supabase/migrations/` in file-name order, including the new
`20261010030000_payroll_trigger_functions_search_path.sql`.

**Pass:** it ends with `Finished supabase db reset` and prints no `ERROR:`.
**Fail:** note the file name it stops at and the error, and stop here.

## 4. Check the new search_path fix locally

Open local Studio at http://127.0.0.1:54323 → SQL Editor and run:

```sql
select proname, proconfig
from pg_proc
where proname in ('payroll_append_only', 'payroll_cash_advances_read_only');
```

**Pass:** both rows show `{search_path=""}`.

Then confirm the triggers still block writes (expect `restrict_violation`):

```sql
insert into public.payroll_cash_advances default values;
```

## 5. Compare the replayed schema with the live project

```
npx supabase link --project-ref swtlmaupaarrppypxsip
npx supabase db diff --linked --schema public,private
```

`link` asks for the database password (Dashboard → Project Settings →
Database). `db diff --linked` builds a shadow database from the local
migration files and diffs it against the live schema. It only reads the live
project.

**Pass:** no output, or only the two `payroll_*` functions' search_path (that
migration is not live yet). Anything else is drift: stop and send it to me.

## 6. Repair the live history (only after steps 3–5 pass)

Preview first. `migration list` shows the local and remote columns:

```
npx supabase migration list
```

Mark the 38 live-only versions as reverted (they are the same changes under
their file names):

```
npx supabase migration repair --status reverted 20260926003307 20260926003337 20260926005559 20260926005628 20260926005631 20260926005741 20260926012310 20260926012738 20260926100558 20260926104057 20260926104137 20260926111147 20260926112128 20260926112300 20260927055247 20260927055249 20260927055251 20260927055252 20260927061048 20260927061406 20260927061428 20260927061537 20260927061641 20260927145321 20260927150149 20260928032332 20261006083452 20261006083453 20261006092133 20261006092913 20261007074056 20261007074217 20261007084440 20261009144903 20261009150007 20261009150913 20261010000138 20261010003259
```

Mark the 35 repo files whose changes are already live as applied:

```
npx supabase migration repair --status applied 20260924010000 20260924020000 20260924150000 20260926010000 20260926020000 20260926030000 20260926040000 20260926050000 20260926060000 20260926070000 20260926080000 20260926090000 20260926100000 20260926110000 20260927010000 20260927020000 20260927030000 20260927040000 20260927050000 20260927060000 20260927070000 20260927080000 20260927090000 20260928010000 20261003010000 20261006010000 20261006020000 20261006030000 20261007010000 20261007020000 20261009010000 20261009020000 20261009030000 20261010010000 20261010020000
```

Do **not** include `20261010030000`: it is not live yet.

**Pass:** `npx supabase migration list` shows the same versions in both columns,
except `20261010030000` (local only).

## 7. Apply the search_path fix to live (your decision)

```
npx supabase db push --dry-run
```

It must list exactly one file, `20261010030000_payroll_trigger_functions_search_path.sql`.
Then run `npx supabase db push` and re-run the Security Advisor (Dashboard →
Advisors): the two "Function Search Path Mutable" warnings should be gone.

## Stop the local stack

```
npx supabase stop
```
