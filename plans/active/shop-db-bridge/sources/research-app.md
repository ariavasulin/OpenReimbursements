# Analysis: how office jobs and employee records enter and are read by the app

All paths are relative to the repo root; line numbers as of commit `f32010b`.
No values from `.env.local` were read or printed.

## Overview

Jobs ("projects" in the UI) live in `public.jobs`. They come from two places:
a manual CLI script (`dws-app/scripts/import-jobs.mjs`) that reads two CSV exports of
the office database and upserts on `job_number` with the service-role key, and
hand-made projects created in the app through the `photo_create_job` RPC. Employees
are Supabase Auth users (`auth.users`, phone-only login by SMS OTP) plus a
`public.user_profiles` row. Phone numbers live only in `auth.users.phone`. Employees
are created by a CSV script (`onboard-users.mjs`) or the admin UI's
`POST /api/admin/users`. The only scheduled job today is one Vercel cron that hits
`/api/photos/repair`. It is protected by `CRON_SECRET` and uses a service-role client.

---

## 1. `dws-app/scripts/import-jobs.mjs`

- **What it says it is:** "One-time import of active jobs from the office DB CSV dumps into public.jobs" (`dws-app/scripts/import-jobs.mjs:2-5`).
- **CLI:** `--projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv>`. Without `--execute`/`-x` it is a dry run (`dws-app/scripts/import-jobs.mjs:7-9`, `dws-app/scripts/import-jobs.mjs:15-24`, `dws-app/scripts/import-jobs.mjs:88-93`).
- **CSV parsing:** `csv-parse/sync` with `columns: true, bom: true, trim: true, skip_empty_lines: true` (`dws-app/scripts/import-jobs.mjs:26-29`). `csv-parse` is a **devDependency** (`dws-app/package.json:61`, `dws-app/package.json:71`).
- **Columns read:**
  - From `tblProject`: `ProjectID` (the join key), `Project` (becomes `name`), `Location`, `Archived` (`dws-app/scripts/import-jobs.mjs:52`, `dws-app/scripts/import-jobs.mjs:69`, `dws-app/scripts/import-jobs.mjs:75-76`).
  - From `tblMas90JobMasterOpen`: `JobNo`, `JobStatus` (`dws-app/scripts/import-jobs.mjs:61-63`).
- **Join and filter:**
  - Builds a map keyed by trimmed `ProjectID` (`dws-app/scripts/import-jobs.mjs:50-54`).
  - For each open-jobs row it skips a blank `JobNo` (`:62`) and any `JobStatus !== 'O'` (`:63`).
  - Open job numbers that have no `tblProject` row are collected and printed as a warning, not imported (`dws-app/scripts/import-jobs.mjs:64-68`, `dws-app/scripts/import-jobs.mjs:84-86`).
  - Rows where `Archived` (lowercased) equals `'true'` are dropped and counted (`dws-app/scripts/import-jobs.mjs:69-72`).
- **Row written:** `{ job_number: JobNo, name: Project.trim(), location: Location.trim() || null, is_active: true, synced_at: <one ISO timestamp per run> }` (`dws-app/scripts/import-jobs.mjs:59`, `dws-app/scripts/import-jobs.mjs:73-79`).
- **Trash guard:** before writing, it selects `job_number` from `jobs` where `deleted_at is not null and purged_at is null`. It skips those numbers and lists them, because the `jobs_deleted_not_active` check would fail the whole upsert (`dws-app/scripts/import-jobs.mjs:96-114`).
- **Upsert:** `.from('jobs').upsert(toUpsert, { onConflict: 'job_number' })` in one call, then a total row count (`dws-app/scripts/import-jobs.mjs:115-132`). The conflict target is the unique constraint `jobs_job_number_key` (`dws-app/supabase/migrations/00000000000000_baseline.sql:322-323`).
- **What the script does not do:**
  - It never sets `is_active=false`, and never deletes rows for jobs that have dropped out of the CSV. Every row it writes has `is_active: true` (`dws-app/scripts/import-jobs.mjs:77`).
  - It does not touch `created_by`, `created_at`, `deleted_*`, or `purged_at` (`dws-app/scripts/import-jobs.mjs:73-79`).
- **Credentials:** `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`, plus `SUPABASE_SERVICE_ROLE_KEY`, read from the shell environment. The usage comment says to load them with `set -a; source .env.local; set +a` (`dws-app/scripts/import-jobs.mjs:7`, `dws-app/scripts/import-jobs.mjs:38-43`). The client is built with `createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })` (`dws-app/scripts/import-jobs.mjs:95`).
- **What `synced_at` and `is_active` mean:**
  - `synced_at` is set only by this import. Hand-made rows insert `synced_at` as null and set `created_by` (`dws-app/supabase/migrations/20260923120000_photo_manage_and_purge.sql:94-95`; runbook `Docs/photos-runbook.md:248`).
  - Nothing in `dws-app/src` reads `synced_at`. A repo-wide grep finds it only in the script, the table DDL, and the two `photo_create_job` inserts.
  - `is_active` is the "listable/usable" flag:
    - `get_photo_job_summaries` filters `where j.is_active` (`dws-app/supabase/migrations/20260907100410_photo_active_reads.sql:42`).
    - Upload, move, import, and share RPCs require `is_active` (for example `dws-app/supabase/migrations/20260907100200_hosted_photo_uploads.sql:86`, `dws-app/supabase/migrations/20260907100200_hosted_photo_uploads.sql:167`).
    - Deleting a project sets `is_active=false` along with `deleted_at` (`dws-app/supabase/migrations/20261012182335_photo_admin_and_trash_rule.sql:184`).
    - The check `jobs_deleted_not_active` requires `deleted_at is null or not is_active` (`dws-app/supabase/migrations/20260923180000_photo_manage_followups.sql:19-20`).
- **What the runbook records about reconciliation:**
  - The import "takes over a hand-made row in place" when the office number matches, and may overwrite a renamed imported job's name.
  - `P-` projects are never touched.
  - "How the future office sync should reconcile is undecided" (`Docs/photos-runbook.md:248-254`).
  - Renumbering an imported job means a later import creates a new row under the old number (`Docs/photos-runbook.md:233-236`).

## 2. Employee creation: `onboard-users.mjs` and `set-auth-display-names.mjs`

### `dws-app/scripts/onboard-users.mjs`
- **Input:** `--csv <path>`. The default is `<repo root>/joined_employees.csv` (`dws-app/scripts/onboard-users.mjs:79-80`). It is parsed by a naive split on commas, so quoted fields are not handled (`dws-app/scripts/onboard-users.mjs:20-33`).
- **Columns read:** `First Name`, `Last Name`, `Employee #`, `Preferred Name`, `Mobile Phone` (`dws-app/scripts/onboard-users.mjs:107-111`).
- **Phone handling:**
  - `digitsOnly` strips everything that is not a digit (`dws-app/scripts/onboard-users.mjs:35-37`).
  - `toE164Plus` turns 10 digits into `+1XXXXXXXXXX`, and 11 digits starting with 1 into `+1...`. Anything else is just prefixed with `+` (`dws-app/scripts/onboard-users.mjs:39-46`).
  - Rows with no digits are skipped (`dws-app/scripts/onboard-users.mjs:113-117`).
- **Matching existing users:** pages through `supabase.auth.admin.listUsers` (1000 per page) and keys the users by the digits-only `auth.users.phone` (`dws-app/scripts/onboard-users.mjs:57-75`, `dws-app/scripts/onboard-users.mjs:120-124`).
- **Create:** only when no phone match exists and `--execute` is set. It calls `auth.admin.createUser({ phone: +E164, phone_confirm: true, user_metadata: { full_name: "Last, First", preferred_name, employee_id_internal } })` (`dws-app/scripts/onboard-users.mjs:48-55`, `dws-app/scripts/onboard-users.mjs:126-143`).
- **Profile write:** for every matched or created user, when `--execute` is set:
  - It runs `update user_profiles set role='employee', full_name, preferred_name, employee_id_internal where user_id=…`.
  - If no row was updated, it inserts one instead (`dws-app/scripts/onboard-users.mjs:146-172`).
  - Existing users are also forced to `role: 'employee'` (`dws-app/scripts/onboard-users.mjs:148-153`).
- **Output:** a JSON report, `onboard_report.json` or `onboard_dry_run.json`, written at the repo root (`dws-app/scripts/onboard-users.mjs:178-180`).
- **Credentials:** the same `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` pair as the jobs import (`dws-app/scripts/onboard-users.mjs:82-89`).
- **Things it never does:** change an existing user's phone, or deactivate anyone.

### `dws-app/scripts/set-auth-display-names.mjs`
- Reads the same hard-coded `joined_employees.csv` (`dws-app/scripts/set-auth-display-names.mjs:49-50`) and matches users by digits-only phone (`dws-app/scripts/set-auth-display-names.mjs:29-46`, `dws-app/scripts/set-auth-display-names.mjs:66-73`).
- Writes only Auth `user_metadata`: `{ name, full_name, preferred_name }`, all set to `Preferred Name`, through `auth.admin.updateUserById` (`dws-app/scripts/set-auth-display-names.mjs:75-81`). It does not touch `user_profiles`.
- Writes `set_display_names_report.json` (`dws-app/scripts/set-auth-display-names.mjs:89-91`).

### Where employee data lives
- **`public.user_profiles`** columns:
  - From the baseline: `user_id` (PK, FK to `auth.users` on delete cascade), `role` ('employee' or 'admin', default 'employee'), `full_name`, `employee_id_internal`, `created_at`, `updated_at`, `preferred_name`, `deleted_at` (the soft-delete/ban marker) (`dws-app/supabase/migrations/00000000000000_baseline.sql:292-302`, `dws-app/supabase/migrations/00000000000000_baseline.sql:308`, `dws-app/supabase/migrations/00000000000000_baseline.sql:342-343`, `dws-app/supabase/migrations/00000000000000_baseline.sql:409-410`).
  - Added later: `photo_admin` (`dws-app/supabase/migrations/20261012182335_photo_admin_and_trash_rule.sql:32`), and `slideshow_shuffle` and `slideshow_delay_seconds` (`dws-app/supabase/migrations/20261014120100_photo_settings_and_tags.sql:52-53`).
  - The table has **no phone column**.
- **Phone:** stored only in `auth.users.phone`.
  - Admin reads join it in through SECURITY DEFINER RPCs: `get_auth_users_for_admin` and `get_auth_users_count`, both of which exclude the test phone `'1234'` (`dws-app/supabase/migrations/00000000000000_baseline.sql:102-177`), and `get_admin_receipts_with_phone` (`dws-app/supabase/migrations/00000000000000_baseline.sql:60-98`).
  - Code comments state that Supabase stores the phone **without the "+"** (`dws-app/src/lib/needs-name.ts:3-5`, `dws-app/src/lib/needs-name.ts:11`).
- **Signup trigger:** `on_auth_user_created` (AFTER INSERT on `auth.users`) runs `handle_new_user()`, which inserts `(user_id, role='employee')` into `user_profiles` (`dws-app/supabase/migrations/00000000000000_baseline.sql:180-189`, `dws-app/supabase/migrations/20260823100000_review_fixes.sql:209-225`). This is why the onboarding update usually finds a row.

### Is phone used for login?
- Yes. It is SMS OTP, phone only.
- The login page normalizes US input with `formatUSPhoneNumber`: 10 digits become `+1…`, 11 digits starting with 1 become `+…`, anything else is rejected (`dws-app/src/lib/phone.ts:1-9`, `dws-app/src/app/login/page.tsx:160-170`).
- `POST /api/auth/send-otp` requires E.164 `^\+[1-9]\d{1,14}$` and calls `supabase.auth.signInWithOtp({ phone })` (`dws-app/src/app/api/auth/send-otp/route.ts:14-21`). No `shouldCreateUser` option is passed.
- `POST /api/auth/verify-otp` requires a 4-digit code and calls `verifyOtp({ phone, token, type: 'sms' })` (`dws-app/src/app/api/auth/verify-otp/route.ts:30-44`). It then reads `user_profiles.full_name` to decide whether to prompt for a name (`dws-app/src/app/api/auth/verify-otp/route.ts:14-18`).
- The phone/OTP provider and its Twilio credentials are set up in the Supabase dashboard, not in the repo (`dws-app/supabase/migrations/README.md:88-91`).

### App-side employee writes (admin UI)
- **`POST /api/admin/users`:**
  - Requires `phone` and `full_name` and normalizes the phone to `+1…` (`dws-app/src/app/api/admin/users/route.ts:93-108`, `dws-app/src/app/api/admin/users/route.ts:191-199`).
  - Calls `supabaseAdmin.auth.admin.createUser({ phone, phone_confirm: true, user_metadata })` and maps a duplicate phone to 409 (`dws-app/src/app/api/admin/users/route.ts:121-140`).
  - Then upserts `user_profiles` on `user_id`. If that fails, it deletes the Auth user (`dws-app/src/app/api/admin/users/route.ts:146-166`).
- **`PATCH /api/admin/users/[id]`:** changing the phone calls `updateUserById({ phone, phone_confirm: true })` and then signs the user out everywhere (`dws-app/src/app/api/admin/users/[id]/route.ts:75-102`, `dws-app/src/app/api/admin/users/[id]/route.ts:134-140`). It also updates the `user_profiles` fields (`dws-app/src/app/api/admin/users/[id]/route.ts:125`).
- **`DELETE /api/admin/users/[id]`:** a soft delete. It bans the Auth user with `ban_duration: '876000h'`, sets `user_profiles.deleted_at`, and signs the user out globally (`dws-app/src/app/api/admin/users/[id]/route.ts:186-212`).
- **`GET /api/admin/users`:** lists users through the `get_auth_users_for_admin` and `get_auth_users_count` RPCs, plus the `photo_admin` flags (`dws-app/src/app/api/admin/users/route.ts:17-46`).

## 3. Migrations: tables, RLS, grants

### `public.jobs`
- **Created** in `dws-app/supabase/migrations/00000000000003_photos_schema.sql:3-10` (mirrored in `dws-app/supabase/migrations/00000000000000_baseline.sql:238-245`) with:
  - `id uuid pk default gen_random_uuid()`
  - `job_number text unique not null` (commented "office JobNo, e.g. '3612'")
  - `name text not null`
  - `location text`
  - `is_active boolean not null default true`
  - `synced_at timestamptz`
- **Added later:**
  - `created_by uuid` (FK to `user_profiles`) and `created_at timestamptz default now()` (`dws-app/supabase/migrations/20260920214954_photo_job_projects.sql:7-8`).
  - `deleted_at`, `deleted_by` (FK to `auth.users`), and `purged_at` (`dws-app/supabase/migrations/20260923120000_photo_manage_and_purge.sql:44-49`).
  - The check `jobs_deleted_not_active` (`dws-app/supabase/migrations/20260923180000_photo_manage_followups.sql:19-20`).
  - The sequence `job_project_code_seq` for `P-<n>` codes (`dws-app/supabase/migrations/20260920214954_photo_job_projects.sql:9-10`).
- **Purge:** "delete forever" rewrites `job_number` to `'deleted:'||id` and sets `purged_at` (`dws-app/supabase/migrations/20261012182335_photo_admin_and_trash_rule.sql:241`).
- **Typed numbers:** at most 32 characters, and the `P-` prefix is refused (`dws-app/supabase/migrations/20260923120000_photo_manage_and_purge.sql:55-61`).
- **RLS:** enabled (`dws-app/supabase/migrations/00000000000003_photos_schema.sql:33`). There is one policy, `jobs_select` (SELECT, `authenticated`, `using (true)`). The comment reads "writes are service-role only (bypasses RLS)" (`dws-app/supabase/migrations/00000000000003_photos_schema.sql:41-44`). No INSERT, UPDATE, or DELETE policy exists in any migration (grep).
- **Grants:** the baseline grants every table privilege on `jobs` to `anon`, `authenticated`, and `service_role` (`dws-app/supabase/migrations/00000000000000_baseline.sql:491-493`). No later migration revokes them. For non-service roles, writes are blocked only by RLS having no write policy.
- **App-side writers:**
  - `photo_create_job`, `photo_rename_job`, `photo_delete_job`, and `photo_restore_job` are SECURITY DEFINER functions that run only for `service_role` (`dws-app/supabase/migrations/20260920214954_photo_job_projects.sql:51-56`).
  - They are reached through `POST /api/photo-jobs`, `PATCH /api/photo-jobs/[id]`, and `DELETE /api/photo-jobs/[id]` (`dws-app/src/app/api/photo-jobs/route.ts:53-64`, `dws-app/src/app/api/photo-jobs/[id]/route.ts:30-59`).
  - `photo_create_job` returns `status:'exists'` for a live job with the same number, and refuses `job_in_trash` (`dws-app/supabase/migrations/20260923120000_photo_manage_and_purge.sql:82-101`).

### `public.user_profiles`
- **RLS** is enabled (`dws-app/supabase/migrations/00000000000000_baseline.sql:432`). There are five policies (`dws-app/supabase/migrations/20260822130000_rls_scalar_subqueries.sql:45-69`):
  - Select: own row, or any signed-in user (`user_profiles_select_policy`, `auth.uid() is not null`).
  - Update: own row.
  - Insert: tightened to "own row, `role='employee'`, not `photo_admin`" (`dws-app/supabase/migrations/20261012182335_photo_admin_and_trash_rule.sql:37-44`).
- **Grants:**
  - The baseline grants all privileges to `anon`, `authenticated`, and `service_role` (`dws-app/supabase/migrations/00000000000000_baseline.sql:509-511`).
  - Later, `authenticated` loses UPDATE except on `full_name`, and `anon` loses UPDATE entirely (`dws-app/supabase/migrations/20260823100000_review_fixes.sql:138-143`).
  - The comment notes that admin routes using the service-role key "are unaffected by these grants" (`dws-app/supabase/migrations/20260823100000_review_fixes.sql:133-137`). The write-guards migration likewise notes that the signup trigger and the service role are unaffected (`dws-app/supabase/migrations/20260823120100_write_guards.sql:8-10`).
- **Service-role pattern:** private ledger tables get `revoke all from public, anon, authenticated; grant all to service_role` (`dws-app/supabase/migrations/20260907100000_hosted_photo_schema.sql:175-183`).

## 4. Where the running app reads jobs and employees

### Jobs
- **`GET /api/photo-jobs`:** project cards and the upload dropdown.
  - It calls the RPC `get_photo_job_summaries_by_number_page` through the user's session client (`dws-app/src/app/api/photo-jobs/route.ts:31-40`).
  - That RPC wraps `get_photo_job_summaries` (`dws-app/supabase/migrations/20261014120000_photo_list_order.sql:33-60`), which selects `id, job_number, name, location` from active jobs and searches with `ilike` on `job_number` and `name` (`dws-app/supabase/migrations/20260907100410_photo_active_reads.sql:3-54`).
- **`GET /api/photo-jobs?deleted=1`:** the Trash list, through `photo_deleted_jobs` (`dws-app/src/app/api/photo-jobs/route.ts:25-30`).
- **`GET /api/photo-jobs/[id]`:** a single project card (`dws-app/src/app/api/photo-jobs/[id]/route.ts:14-24`).
- **Mapping:** `mapJobSummary` maps rows to `{ id, job_number, name, location, photo_count, thumb_paths, latest_activity }` (`dws-app/src/lib/photos/jobSummary.ts:3-13`, `dws-app/src/lib/photos/types.ts:131-153`).
- **Hook:** `usePhotoJobs` / `photoJobsOptions` (`dws-app/src/lib/photos/api.ts:310-327`).
- **UI columns actually rendered:**
  - Project list: `name`, `"Project #" + job_number`, `location` (only in the empty-state text) (`dws-app/src/app/photos/projects/page.tsx:77-81`).
  - Project page subtitle: `job_number`, `photo_count`, `location` (`dws-app/src/app/photos/[jobId]/page.tsx:110-124`).
- **Other reads:**
  - `GET /api/photo-migrations/jobs` selects `id, job_number, name` where `is_active` (`dws-app/src/app/api/photo-migrations/jobs/route.ts:8`).
  - The migrations prefill selects `id, job_number` where `is_active` (`dws-app/src/lib/photos/server/migrations.ts:125`).
  - Photo rows embed `job:jobs(id, job_number, name)` (`dws-app/src/lib/photos/apiShared.ts:10`).
  - Actions look jobs up by `job_number` (`dws-app/src/lib/photos/server/actions.ts:96`, `dws-app/src/lib/photos/server/actions.ts:209`).
  - The list filter searches `job_number`/`name` (`dws-app/src/lib/photos/server/list-filters.ts:219`).
- **Auto-naming:** photo names use the project number (`Docs/photos-runbook.md:191-201`).
- **Minimal set of job columns the app reads:** `id`, `job_number`, `name`, `location`, `is_active` (plus `deleted_at`/`purged_at` for Trash). `synced_at` is not read.

### Employees
- **Photo authorization:** `requirePhotoActor` calls the `photo_actor_context` RPC (service role). It reads `user_profiles` (`role`, `deleted_at`, `photo_admin`) and the `auth.users` deleted/banned state (`dws-app/src/lib/photos/server/authority.ts:26-42`, `dws-app/supabase/migrations/20261016140400_photo_perf_server_reads.sql:27-43`).
- **Uploader name on photos:** `uploader:user_profiles!photos_uploader_id_fkey(full_name)` (`dws-app/src/lib/photos/apiShared.ts:10`).
- **Receipts:**
  - `full_name` and `employee_id_internal` (`dws-app/src/app/api/receipts/pending/route.ts:23-39`).
  - Admin export: `preferred_name`, `full_name`, `employee_id_internal` (`dws-app/src/app/api/admin/receipts/export/route.ts:31`).
- **Employee home:** `role, full_name, preferred_name, employee_id_internal` (`dws-app/src/app/employee/page.tsx:84-85`).
- **Admin user table:** shows `preferred_name` and `employee_id_internal` (`dws-app/src/components/user-table.tsx:181-184`).
- **Self-service:** `PATCH /api/profile` updates the caller's own `full_name`, or inserts a default row if none exists (`dws-app/src/app/api/profile/route.ts:34-57`).

## 5. Scheduled / cron plumbing

- **`dws-app/vercel.json`:** one cron, `{"path": "/api/photos/repair", "schedule": "0 9 * * *"}`, plus `regions: ["cle1"]` and `installCommand: npm install --legacy-peer-deps` (`dws-app/vercel.json:1-8`). There are no `/api/cron/*` routes.
- **The cron route** is `dws-app/src/app/api/photos/repair/route.ts`:
  - `maxDuration = 300` (`dws-app/src/app/api/photos/repair/route.ts:7`).
  - Auth: `process.env.CRON_SECRET` must exist and match `Authorization: Bearer <secret>`, otherwise 401 (`dws-app/src/app/api/photos/repair/route.ts:38-41`).
  - It then checks a database gate row, `photo_release_state.repair_enabled` with `schema_generation = 1`, and returns 503 if the gate is closed (`dws-app/src/app/api/photos/repair/route.ts:44-48`).
  - It exports both `GET` (what Vercel cron calls) and `POST` (manual runs) (`dws-app/src/app/api/photos/repair/route.ts:60-61`).
  - It logs with `console.info('photos.repair', JSON.stringify(report))` (`dws-app/src/app/api/photos/repair/route.ts:57`).
- **The middleware does not gate API routes.** Its matcher is only `"/"` (`dws-app/src/middleware.ts:22-24`).
- **Service-role client constructors on the server:**
  - `supabaseAdmin`, a module singleton in `dws-app/src/lib/supabaseAdminClient.ts:1-17`. It is marked `server-only` and throws at import time if `SUPABASE_SERVICE_ROLE_KEY` is missing. It is used by admin routes and lazily imported (`await import(...)`) by photo code (`dws-app/src/lib/photos/server/authority.ts:34`).
  - `client(budget, operationMs)` in `dws-app/src/app/api/photos/repair/route.ts:11-34`: a service-role client with a per-request timeout and a 4 MiB response cap.
  - `timedClient()` in `dws-app/src/lib/photos/server/purge.ts:22-33`: a service-role client with a per-call timeout.
- **Cookie (session) client:** `createSupabaseServerClient()` uses the anon key plus cookies (`dws-app/src/lib/supabaseServerClient.ts:19-40`). `requirePhotoReader()` wraps it (`dws-app/src/lib/photos/server/reads.ts:33-38`).
- **Runbook on cron:**
  - The daily 09:00 UTC cron needs `CRON_SECRET`, which is a Vercel env var (`Docs/photos-runbook.md:837-858`).
  - Closing the database gates does not disable the Vercel cron (`Docs/photos-runbook.md:672-673`).
  - Cron run status shows in Vercel → Settings → Cron Jobs (`Docs/photos-runbook.md:1080`).

## 6. Env and config conventions

- **No `.env.example` exists** anywhere in the tree: `find` turned up only `dws-app/.env.local` (not read), and `git ls-files` lists no env files.
- **`Docs/Configuration.md` is the env reference.**
  - It lists `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` ("Server-only"), `OPENROUTER_API_KEY`, and optional AI keys (`Docs/Configuration.md:5-30`).
  - It tells the reader to `cp .env.example .env.local`, a file that is not present (`Docs/Configuration.md:181-183`).
  - It says Vercel env vars are set in the dashboard (`Docs/Configuration.md:189-196`).
  - Its copy of `vercel.json` is older than the real one: no cron, no region (`Docs/Configuration.md:104-111`).
  - `CRON_SECRET` and `PHOTOS_TRANSCODE` are documented only in the runbook (`Docs/photos-runbook.md:858`, `Docs/photos-runbook.md:956-960`).
- **Scripts read env from the shell** (`set -a; source .env.local`) per `dws-app/scripts/import-jobs.mjs:7`. The cutover CLI instead says it "never loads `.env.local` itself" and takes values from the operator's credential manager (`Docs/photos-runbook.md:558-561`).
- **Project identifiers:** Vercel project `dws-receipts` (root directory `dws-app`) and Supabase project `qebbmojnqzwwdpkhuyyd` (`Docs/photos-runbook.md:539-541`).
- **Migration conventions** (`dws-app/supabase/migrations/README.md`):
  - Every schema change is a migration file; nothing is applied by hand in the SQL editor (`:3-4`).
  - Files are named `<UTC timestamp>_<snake_case>.sql` (`:13-14`).
  - They are applied with `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f <file>` (`:16-21`).
  - `CONCURRENTLY` files are applied statement by statement (`:30-43`).
  - The baseline files `00000000000000` to `00000000000003` are never re-applied to the live project (`:6-11`).
  - Auth provider (OTP/Twilio) settings and secrets live in the dashboard (`:88-91`).
- **Runbook conventions:**
  - Apply additive migrations to production before the deploy that ships them, with `-f` (`Docs/photos-runbook.md:381`, `Docs/photos-runbook.md:385-388`).
  - `vercel.json` pins functions to `cle1`, the same region as the database. The Hobby plan allows one region (`Docs/photos-runbook.md:424-428`).
  - Writes go through SECURITY DEFINER `photo_*` functions behind the `photo_writes_enabled` gate (`Docs/photos-runbook.md:221-224`).
  - No reference to MAS 90 or SQL Server connectivity exists anywhere in the repo, besides the CSV table names in the import script (git grep). The runbook says the office database is "not yet bridged" (`Docs/photos-runbook.md:221`).

---

## Unknowns
- **Which CSV files have been run.** The repo does not contain the CSVs (`tblProject.csv`, `tblMas90JobMasterOpen.csv`, `joined_employees.csv`) or the script reports, so it cannot say when imports last ran or what columns the exports actually carry beyond those the scripts read.
- **Phone format and test account.** The exact stored format of `auth.users.phone` in production is asserted only by a code comment (`dws-app/src/lib/needs-name.ts:3-5`). It was not checked against live data. Whether the `'1234'` test account still exists is also unknown (`dws-app/supabase/migrations/00000000000000_baseline.sql:115`).
- **Self-signup by unknown phones.** `send-otp` passes no `shouldCreateUser` (`dws-app/src/app/api/auth/send-otp/route.ts:19-21`). Whether a phone not already in `auth.users` can sign in therefore depends on dashboard Auth settings that are not in the repo (`dws-app/supabase/migrations/README.md:88-91`).
- **Live grants on `jobs`.** The grants on `public.jobs` were taken from the baseline dump. The live grants were not queried.
- **Vercel setup.** Whether `CRON_SECRET` is set in every Vercel environment, and the project's Vercel plan or cron limits, are not recorded beyond the "Hobby plan allows one region" note (`Docs/photos-runbook.md:427`). The plan's cron-count limit is not in the repo.
- **Office database reachability.** Where the office database (MAS 90 / SQL Server) lives and how it could be reached from Vercel is not in the code. It is listed as an open question in `plans/active/dws-photos-client-feedback/sources/research.md:404`.
- **Reconciliation rules for a future sync.** These are explicitly undecided per `Docs/photos-runbook.md:254`:
  - deactivating closed jobs;
  - renamed jobs;
  - employees who leave.
