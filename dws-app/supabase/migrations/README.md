# Migrations

Every schema change ships as a file here. Nothing is applied by hand in the
Supabase SQL editor.

The `00000000000000`–`00000000000003` files are the captured baseline of what
production already had before migrations were checked in. Do not re-apply them
to the existing project; they exist so a fresh database can be rebuilt. The
baseline is not a byte-faithful dump: `00000000000000` defines `photos` with
the columns the table had when the dump was taken, and `00000000000003` adds
the later ones.

Naming: `<UTC timestamp>_<snake_case_name>.sql`, e.g. `20260822120000_add_receipts_indexes.sql`
Generate a timestamp with: `date -u +%Y%m%d%H%M%S`

Apply:

```bash
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked \
  --project-ref qebbmojnqzwwdpkhuyyd -f dws-app/supabase/migrations/<file>.sql
```

For one-off SQL (verification queries, plan checks), pass the SQL positionally:

```bash
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked \
  --project-ref qebbmojnqzwwdpkhuyyd "select 1;"
```

## Files that must be applied statement by statement

`db query -f` wraps a **multi-statement** file in a transaction (observed on
CLI 2.115.0). `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot
run inside one: Postgres raises `ERROR 25001`, the transaction rolls back, and
nothing in the file lands. A single statement passed positionally is not
wrapped. These files contain `CONCURRENTLY` and nothing else, so apply each of
their statements on its own:

- `20260822120000_add_receipts_indexes.sql`
- `20260822120100_add_photos_indexes.sql`
- `20260823120300_drop_redundant_receipts_indexes.sql`

Every other file is transactional and applies with `-f`. A recipe that splits
a file on statement boundaries (every statement in those files ends its line
with `;`, comments are line comments):

```bash
f=dws-app/supabase/migrations/20260822120000_add_receipts_indexes.sql
grep -v '^\s*--' "$f" | tr '\n' ' ' | tr -s ' ' | sed 's/; */;\n/g' | grep -v '^\s*$' |
while IFS= read -r stmt; do
  env -u SUPABASE_ACCESS_TOKEN supabase db query --linked \
    --project-ref qebbmojnqzwwdpkhuyyd "$stmt" < /dev/null   # keep the loop's stdin
done
```

After every `CREATE INDEX CONCURRENTLY`, and before dropping the index it
replaces, check that nothing was left invalid. An interrupted concurrent build
leaves an index marked `indisvalid = false`; a re-run of
`create index concurrently if not exists` sees the name and skips with a
NOTICE:

```bash
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked \
  --project-ref qebbmojnqzwwdpkhuyyd \
  "select indexrelid::regclass from pg_index where not indisvalid;"
```

Any row is an index to `drop index concurrently` and rebuild before moving on.

Every migration must be idempotent — use `if not exists` and
`drop … if exists` / `create` pairs so re-running is a no-op.

## What the baseline does not contain

`00000000000000_baseline.sql` was dumped with `--schema public`, so anything
outside that schema was missing and a database rebuilt from this repo could not
register a user. `20260823100000_review_fixes.sql` fills the two known gaps:

- **`auth.users` trigger `on_auth_user_created`** — fires
  `public.handle_new_user()` (which the baseline does define) to create the
  `user_profiles` row on signup. Without it there is no profile row, and
  `receipts.user_id` references `user_profiles`. It is created only when absent,
  because `create trigger` on `auth.users` needs ownership of that table.
- **`storage.buckets` rows** — `receipt-images` (20 MiB limit) and `photos`
  (50 GiB limit), both public. Their policies are in
  `20260822130200_rls_storage_scalar_subqueries.sql`.

Still outside the repo, and set through the Supabase dashboard rather than SQL:
auth provider configuration (phone/OTP sign-in and its Twilio credentials),
project secrets and environment variables, and the storage service's own
configuration. A rebuilt project needs those re-entered by hand.

## Why not to re-run migrations casually

Apply once, verify, move on — every `create policy` / `create function` fires a
PostgREST schema-cache reload.
