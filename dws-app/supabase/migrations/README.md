# Migrations

Every schema change ships as a file here. Nothing is applied by hand in the
Supabase SQL editor.

Naming: `<UTC timestamp>_<snake_case_name>.sql`, e.g. `20260822143000_add_receipts_indexes.sql`
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

Caution: `db query -f` wraps a **multi-statement** file in a transaction
(observed on CLI 2.115.0), which breaks `CREATE INDEX CONCURRENTLY`
(`ERROR 25001`). A single statement passed positionally is not wrapped —
so apply any migration containing `CONCURRENTLY` one statement at a time
using the positional form above. Every migration must be idempotent — use
`if not exists` and `drop … if exists` / `create` pairs so re-running is a no-op.

The `00000000000000`–`00000000000003` files are the captured baseline of what
production already had before migrations were checked in. Do not re-apply them
to the existing project; they exist so a fresh database can be rebuilt.

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
  (50 GiB limit), both public. Their policies were already captured, in
  `00000000000001_baseline_storage_policies.sql` and in
  `20260822130200_rls_storage_scalar_subqueries.sql`.

Still outside the repo, and set through the Supabase dashboard rather than SQL:
auth provider configuration (phone/OTP sign-in and its Twilio credentials),
project secrets and environment variables, and the storage service's own
configuration. A rebuilt project needs those re-entered by hand.

## Why not to re-run migrations casually

Every `create policy` / `create function` fires a PostgREST schema-cache reload.
Each reload scans `pg_timezone_names` (~390ms) plus several `pg_proc` /
`pg_constraint` introspection queries. The diagnosis snapshot recorded 92 reloads
costing ~52s of database time — a meaningful share of it from re-running the
idempotent photos schema file during development. Apply once, verify, move on.
