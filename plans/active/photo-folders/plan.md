---
status: active
created: 2026-09-20
updated: 2026-09-20
---

# Create and rename photo projects by hand

A quick patch. Until the office project database is bridged to this app, employees
need to make a new home for photos themselves, both when uploading in the app and
when an upload starts from the DWS MCP.

**Words.** The database and code call a photo's home a *job* (`public.jobs`). The
people using it call it a *project* — it works like a folder, and need not be an office
job (office photos, a party). This plan keeps `job` in code and says *project* in the
text employees read. A photo already belongs to exactly one job (`photos.job_id` is
required); this plan does not change that.

## Why and scope

Today nothing can create a job. The 22 production jobs came from the one-time
`dws-app/scripts/import-jobs.mjs` import of office job numbers, and `authenticated`
has SELECT only on `public.jobs`. So photos that belong to a project the import did
not carry, or to something that is not an office project at all (office photos, a
party), have nowhere to go.

In scope:

- Create a project while choosing where photos go: in the app upload picker, in the
  move-photos picker, and on the `/migrate` browser page that MCP handoffs open.
- Rename any project, imported office jobs included.
- A plain warning when the typed name or job number matches an existing project.
- Let the MCP suggest a new project name the same way it already suggests a job number.

Out of scope (decided with the user 2026-09-20): the office database bridge and how
it reconciles with hand-made projects; archive or delete; admin-only permissions;
fuzzy duplicate detection.

## Decisions

1. **Job number is optional to the employee, never empty in the database.**
   `jobs.job_number` is `unique not null`, and 21 source files plus every MCP photo
   script address a job by that number. Making it nullable would ripple through all of
   them. Instead, a project created without a number gets a generated code `P-<n>` (a typed `P-` code is refused) from
   a sequence (`P-1`, `P-2`, …). The prefix cannot collide with office numbers, which
   are digits. An employee who knows the real office number types it.
2. **Anyone who can manage photos can create and rename.** Same authority as every
   other photo write: a logged-in active `employee` or `admin`, with the
   `photo_writes_enabled` gate open. No new role check.
3. **Any project can be renamed**, imported office jobs included (user ruling
   2026-09-20). Rename changes `name` only, never `job_number`. A later office sync
   may overwrite a renamed imported job's name; that is accepted for now.
4. **The MCP does not create projects directly.** MCP scripts have no authenticated
   person; every photo change is confirmed in the SMS-authenticated browser page.
   `add_photos` and `migrate_photos` gain an optional `new_project_name` suggestion
   that pre-fills the create form there. The employee confirms it.
5. **Duplicate warning is a substring match, nothing more.** The pickers already hold
   the active job list. While a name is typed, list jobs whose name contains it
   (case-insensitive) or whose number equals the typed number, with "use this one".
   Creating with a job number that already exists returns that job instead of an error.
6. **Sync reconciliation is deferred, and nothing here blocks it.** Fact for whoever
   designs it: `import-jobs.mjs` upserts on `job_number`, so today a hand-made project
   carrying a real office number would be taken over by an import row with the same
   number, photos in place. `P-` projects are never touched by the import.

## Contract surface

**Database — one additive migration** `dws-app/supabase/migrations/<ts>_photo_job_projects.sql`,
idempotent, applied with the `db query -f` convention in the migrations README:

- `alter table public.jobs add column if not exists created_by uuid references public.user_profiles(user_id)`, `created_at timestamptz default now()`.
- `create sequence if not exists public.job_project_code_seq`.
- `photo_create_job(p_actor uuid, p_name text, p_job_number text default null, p_location text default null) returns jsonb` —
  `security definer`; calls `photo_require_actor` and `photo_require_gate('writes')` (the `photo_writes_enabled` switch);
  trims input; name 1–120 characters, job number ≤ 32, location ≤ 200; blank number becomes
  `'P-' || nextval(...)`; an existing number returns `{status:'exists', job}`; otherwise inserts with
  `is_active=true`, `synced_at=null`, `created_by=p_actor` and returns `{status:'created', job}`.
- `photo_rename_job(p_actor uuid, p_job_id uuid, p_name text) returns jsonb` — same guards and name
  limits; updates `name` only; an unknown job is the shared `not_found` error.
- Both: `revoke all … from public, anon, authenticated` (service role only, like the other photo RPCs).

**Routes** (both use `requirePhotoActor` and `photoRpc`, shared error mapping):

- `POST /api/photo-jobs` `{ name, job_number?, location? }` → `201 {status:'created', job}` or `200 {status:'exists', job}`.
- `PATCH /api/photo-jobs/[id]` `{ name }` → `200 { job }`.

**Browser** — one small `NewJobForm` component (name, optional job number, the match
list from decision 5) used from `job-combobox.tsx` (upload), `job-picker-sheet.tsx`
(move), and the job `<select>` on `src/app/migrate/page.tsx`. After create, the new
job is selected. A "Rename" action on `/photos/[jobId]`.

**MCP** — `registry.ts`: optional `new_project_name: text(120)` on `add_photos` and on each
`migrate_photos` source; passed through the handoff payload as a suggestion.
`harness/skills/photos/SKILL.md`: when the employee's project has no job number or is not
an office project, suggest a project name; say the project is created only when the employee
confirms it in the browser.

## Acceptance criteria

- AC-1 An employee can create a project with only a name from each of the three pickers, and it is selected for the pending upload or move.
- AC-2 A project created without a number gets an `P-<n>` code; one created with a number keeps it.
- AC-3 Creating with an existing job number selects the existing job and creates nothing.
- AC-4 Typing a name that is contained in an existing job's name shows that job before creating.
- AC-5 Any project can be renamed, and its job number does not change.
- AC-6 With `photo_writes_enabled=false`, create and rename return 503; signed-out returns 401.
- AC-7 An MCP `add_photos` call carrying `new_project_name` opens the browser page with the create form pre-filled; nothing is created until the employee confirms.

## Phase 1 — Database and routes

Steps: write the migration; add the two routes; extend `integration/db` and `integration/routes` tests.

Verify: [AC-2, AC-3, AC-5, AC-6] `npm --prefix dws-app run test:db` and `test:routes` cover generated codes, the `exists` result, rename keeping the job number, closed gate, and signed-out.

## Phase 2 — Pickers, rename, and MCP suggestion

Steps: build `NewJobForm`; wire the three pickers; add Rename on the job page; add `new_project_name` to the two scripts and the skill text; update `Docs/photos-runbook.md` with a short "Hand-made projects" note (what `P-` codes are, decision 6).

Verify: [AC-1, AC-4, AC-7] `npm --prefix dws-app test` for the match filter and registry schema; `test:browser` creates a project from the upload picker and from a `/migrate` handoff with a pre-filled name; `tsc` clean.

## Rollout

Apply the migration to production first (additive; old code ignores it), then merge.
No gate changes. Branch `ariavasulin/photo-folders` off `main`.
