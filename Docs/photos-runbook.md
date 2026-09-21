# Photos Runbook

Operational notes for the DWS Photos hub (uploads, confirmed changes, repair sweep).

For hosted assistant configuration, shared-key rotation, photo handoffs, and
confirmed issue submission recovery, see the [DWS MCP runbook](dws-mcp-runbook.md).

Albums, optional projects, folder review, and sharing require the ordered
[photo-albums rollout](../plans/active/photo-albums/plan.md#rollout): compatible
migrations before merge, deploy, then the Sheet # column drop. Production
activation remains operator work; sharing starts closed.

## Confirmed photo changes and trash

Move a photo through its review/confirmation screen. Direct `PATCH job_id`
writes are rejected; tag edits apply only to active photos. Any signed-in
employee can move, remove, or restore any photo, and `deleted_by` records who
removed it. Each confirmation belongs to the employee who started it; a consumed
MCP handoff authorizes only its bound consumer, action, and confirmed targets.

Removal sends a photo to `/photos/trash` for 30 days. Repeating removal does
not extend its original `purge_after`; restoration is unavailable at or after
that timestamp, even if permanent cleanup has not run. The public bucket is
unchanged: someone with a known object URL can still fetch it during retention.
Library listings, search, counts, tags, and deep links exclude all trash.

A legacy duplicate in trash points to its canonical photo. Review the canonical
target before restoring or moving it; restoration never creates another active
copy. Uploading matching bytes keeps the item unresolved until that action
succeeds or the employee explicitly skips it. The employee restores the matching
photo from the upload tray's **Review restore** link (any signed-in employee
can, while the 30 days last), then retries the original queue item to resolve
the canonical result.

## Hand-made projects

A photo has at most one job, which employees call a project, and may have none
(`photos.job_id` is nullable; the app shows "No project"). It can also sit in any
number of albums (`albums`, `album_photos`). Every upload must name a project, an
album, or both; after that, edits are free, including a move to "No project".
Any signed-in employee can create, rename, delete, and restore any album. A
deleted album keeps its photos and can be restored for 30 days; deleting an album
never deletes a photo. Album and bulk-tag writes go through the `photo_*album*`
and `photo_bulk_tag` functions behind the `photo_writes_enabled` gate.

Where employees find things: `/photos` lists every photo, newest first (phone and
desktop both open here); `/photos/albums` and `/photos/projects` list albums and
projects; `/photos/<jobId>` is still one project, so links already sent keep
working. Deleted albums are listed on `/photos/trash` above the trashed photos,
each with **Restore album** for 30 days. "Copy link" writes
`/photos?photo=<id>`, which opens any active photo by id however old it is.

Selecting many photos: **Add to album**, **Tag**, and **Remove from album** act at
once on up to 500 photos (`MAX_BULK_PHOTOS`). **Set project** and **Trash** open
the confirm page (`/photos/actions`) with exactly the selected photos, up to 500
in one batch. Review and apply requests process at most 100 photos per page;
nothing changes until the employee confirms the complete selection.

Until the office project database is bridged, any photo actor can create a
project wherever a job is chosen (upload, move, and the `/migrate` page) and
rename one from its page. Both go through `photo_create_job` /
`photo_rename_job` behind the `photo_writes_enabled` gate.

- A project created without an office job number receives a generated `P-<n>`
  code from `job_project_code_seq`. Office job numbers are digits, so the two
  never collide, and a typed `P-` code is refused.
- Creating with a job number that already exists returns that job; nothing is
  duplicated. Rename changes the name only, never the job number.
- Hand-made rows have `synced_at` null and `created_by` set.
  `scripts/import-jobs.mjs` upserts on `job_number`, so an import row with the
  same real office number takes over a hand-made row in place, and may overwrite
  a renamed imported job's name. `P-` projects are never touched by the import.
  How the future office sync should reconcile is undecided.

## Importing folders (`/migrate`)

Each imported folder that directly holds photos becomes one album named from its
path under the picked folder (`Smith Residence/Finished` arrives as
`Smith Residence – Finished`). A project is optional. The employee reviews one row
per folder — album name, project, tags — and may set a project and tags on a
top-level folder to cover every folder inside it. Pressing Start with no edits is
always valid. The rows live in `migration_folders`.

- **No album is created before Start, and then only once a photo lands in it.**
  So a folder whose photos all fail, are skipped, or already sit in trash leaves no
  album, and closing the page, choosing the folder again, or retrying never makes a
  second album for the same folder (`migration_folders.album_id` is set once).
- **A folder of copies becomes an album of the photos you already have.** Matching
  bytes never make a second photo: the existing photo joins the folder's album. It
  keeps an existing project; if it has no project, the reviewed choice can fill it.
  Existing tags stay unchanged; use bulk Tag to change them. The file list says
  "Already in DWS Photos".
- **The choices freeze when the import starts.** To change a project or tags after
  that, use the bulk tools on the album, not the import page.
- **A project is suggested, never assigned silently.** A folder whose name holds an
  existing project number as a whole word (`3612 Smith`, not `13612`) is pre-filled
  with that project, as are the folders inside it; project numbers shorter than three
  characters are never suggested. An MCP `job_number` hint takes precedence. Review
  shows every suggestion before Start.
- **Rescans preserve reviewed rows.** Newly found folders start with visible source
  defaults and name suggestions, without inheriting an earlier edit to an ancestor
  row. Applying a parent choice changes the current subtree; review new rows before
  starting again.
- **Folder import needs Chrome or Edge on a computer.** Phones, Safari, and Firefox
  cannot open folders; the page says so and offers "Add photos" (up to 500 files,
  which need a project or an album).

Large imports: the local regression sealed 100,000 entries with 1,500 live photos
in 3.4 seconds, under its 8-second limit, even with a stale one-row planner estimate.
This measures the former statistics cliff, not production throughput. Previously
Postgres compared every scanned file with every existing photo (1.7 s became
11.5 s at only 1,500 photos). The two trigger functions on that insert now refuse
nested-loop joins (`set enable_nestloop=off` on `migration_reserve_uuids` and
`photo_repair_guard_owner_ids`); do not remove that setting when editing them. The
test "seals 100,000 entries inside the limit with 1,500 live photos the planner
believes are one row" in `integration/db/migrations.test.ts` guards it.

## Share links (`/s/<token>`)

An employee can share one album or one project with a link, from the **Share**
button on it. Anyone who has the link can see that album's or project's name, a
photo count, and its photos and videos, and download them, **without signing
in**. It is the only page in the app that works without a login. A visitor never
sees who took a photo, its tags, its XMP file, a project number, or any other
album. Any signed-in employee may turn any link on or off.

**What the switch on one album or project does**

- *On* makes a link: `https://photos.design-workshops.app/s/<token>`. The token is
  32 random bytes, so it cannot be guessed. The pop-up shows the same link again
  whenever it is opened.
- *Off* stops that page at once: it answers "This link is not available" (HTTP
  404) from then on. Pages are never cached, so there is no delay.
- *On again* makes a **new** link. The old address never works again.
- A link that is off, a link that never existed, and any link while sharing is
  switched off for everyone all look exactly the same to a visitor, on purpose.
- Trashing a photo removes it from every shared page immediately; restoring it
  brings it back. Deleting an album stops its page; restoring the album within 30
  days brings the same link back.

**What turning a link off cannot do.** The `photos` storage bucket is public, so
every image has its own permanent address. Turning a link off stops the *page*;
it cannot take back an image address that someone already saved or copied, and it
cannot take back a photo they downloaded. The Share pop-up says this in plain
words. The way to close that gap is a private bucket with signed image links
(Alternative D in `plans/active/photo-albums/plan.md`); revisit it before sharing
anything client-confidential.

**Turning every link off at once.** Share pages have their own switch,
`photo_release_state.sharing_enabled`, separate from the three existing gates. It
starts **false**: after the migration is applied, no share page works anywhere
until an operator opens it. Closing it stops every `/s/<token>` page and
`/api/share/*` immediately and touches nothing else — the signed-in app keeps
working, and employees can still flip individual switches (the pop-up tells them
links will not open until sharing is switched back on). No link is lost: opening
it again brings back every link that was on.

```sql
-- Stop every shared link now. One statement, takes effect on the next request.
update public.photo_release_state
set sharing_enabled=false,
    updated_by='<administrator-user-uuid>', updated_at=clock_timestamp()
where singleton;
```

Use the same statement with `sharing_enabled=true` to open it. Before opening it
in production for the first time: the security review of the public route and
`photo_share_read` is recorded in the pull request, and with the gate still
closed `/s/<anything>` answers 404. After opening it: one real album link opens in
a private window, and turning it off returns 404.

To see what is shared right now (operator database session; no browser role can
read this table):

```sql
select coalesce(a.name, j.name) as shared, case when l.album_id is not null then 'album' else 'project' end as kind,
       l.created_at, p.full_name as turned_on_by
from public.photo_share_links l
left join public.albums a on a.id = l.album_id
left join public.jobs j on j.id = l.job_id
left join public.user_profiles p on p.user_id = l.created_by
where l.revoked_at is null order by l.created_at desc;
```

To turn off one link without the app, set `revoked_at=clock_timestamp()` and
`revoked_by` on its row. Never clear `revoked_at` to "bring a link back": turn
sharing on again from the app, which makes a new link.

## Legacy standalone-sidecar audit

`node dws-app/scripts/attach-orphan-sidecars.mjs` is read-only and considers
active rows only. Its `--execute` / `-x` mode is retired and fails before any
network request. Keep the audit for identifying historical candidates without
modifying rows or Storage objects.

## Hosted photo release: operator cutover

The release uses the existing Vercel project `dws-receipts`
(`prj_88wyiltek8eTbBPLGzg4EsiFKOAR`, root directory `dws-app`) and Supabase
project `qebbmojnqzwwdpkhuyyd`. Merge does not activate this release. Keep the
office-drive drill and production activation evidence attached to the release
PR until each has an observed outcome.

Read-only checks on 2026-09-07 found **41 photos, zero indexed hashes, 41 legacy
null hashes, and zero repeated digest groups**. Duplicate cleanup is a no-op
for that snapshot; the null-hash rows are outside historical byte dedupe
coverage. The public `photos` bucket permits 53,687,091,200 bytes per object
(50 GiB). Production still had no `photo_release_state` or `deleted_at`
column. Repeat preflight immediately before activation because ordinary
production writes remain possible before the operator closes them.
The actual CLI default dry run took **1.552 seconds** and agreed with a separate
read-only SQL snapshot (2.449 seconds). No production rows or objects changed.
This measures metadata inspection; it is not a promised activation outage.

### Read-only preflight and administrator review

Run the CLI from the repository root with explicit environment values supplied
through the operator's credential manager. It never loads `.env.local` itself.
`SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) must identify the named project;
`SUPABASE_SERVICE_ROLE_KEY` remains private. Store reports and mappings in an
operator-owned directory outside the checkout, with directory mode 0700.
Do not paste report rows, paths, credentials, or before-images into the PR.

```sh
node dws-app/scripts/photo-identity-cutover.mjs --help
node dws-app/scripts/photo-identity-cutover.mjs \
  --project-ref qebbmojnqzwwdpkhuyyd --output "$CUTOVER_DIR/preflight.json"
```

The default is read-only, including against the legacy production schema.
Review total rows, duplicate groups, redundant rows, legacy null hashes, and
elapsed time. `duplicate_rows` includes every member of the repeated groups;
subtract `duplicate_groups` to count noncanonical rows awaiting cleanup.
Once additive helpers exist, take another dry run to obtain
the authoritative before-image digests for administrator review. The
administrator chooses the canonical photo and owning job for every repeated
digest; the tool never selects these production identities automatically.
Keep their approval actor/time and the exact reviewed mapping with the report.
An empty collision set still requires an administrator-approved activation.

The mapping has `version: 1`, `project_ref`, `approved_by`, `approved_at`, and
`groups`. Each group has `digest`, `expected_before_image_digest`,
`canonical_photo_id`, `canonical_job_id`, `approved_by`, and `approved_at`.
Choose an existing photo and its current owning job, including an inactive
legacy job. The tool rejects a mismatched photo/job pair and does not move the
canonical row. A later confirmed move handles a new active destination.
Use the database snapshot's digest without alteration, and the administrator's
real user UUID and UTC approval time. A no-collision mapping has `groups: []`;
it does not require inventing a canonical photo. Administrator status is
validated in the database before execution.

Reproduce the isolated rehearsal with
`npm --prefix dws-app run test:cutover`. Its deterministic generator contains
cross-job collisions, shared paths, legacy null hashes and an interrupted
upload. The harness provisions and removes a disposable local stack and never
loads the production `.env.local`.
The final 102-group rehearsal measured 279 ms for dry-run inspection and
1,389 ms for a bounded 100-group resume page, with a 28 ms remaining-work
projection. It preserved 207 rows, including three null hashes, while moving
102 noncanonical rows into retained history. Use these as reproducible local
measurements; network latency and index work must be measured on the chosen
operator target before promising an outage window.

### Activation sequence

1. Finish isolated verification and the office Chrome/Edge drill first. Select
   two representative `J:` folders against the isolated environment, verify
   mappings/exclusions, interrupt/reselect/resume, then move/trash/restore.
   Record selected/finalized/skipped totals and hashes. In browser network
   tools, confirm original request bodies go to Supabase Storage. The scripted
   directory fixture does not replace this native picker/drive observation.
2. Apply the reviewed additive migrations in timestamp order using the existing
   Supabase deployment process. They add nullable provenance, ledgers, active
   SELECT policy and closed gates; they do not pick identities or install the
   final index. Do not put operator activation into a build hook.
3. In **dws-receipts → Settings → Cron Jobs**, disable cron jobs. Stop manual
   repair calls, record the last old invocation and wait for its completion or
   the full 300-second runtime. Record the pause start. Old service-role repair
   must be drained before any row enters trash.
4. With all three release gates false, invoke
   `select public.photo_install_write_boundary('<administrator-user-uuid>');`
   through the operator database session. It installs revoked direct grants
   and the write guard. Drain in-flight control requests. Deploy the complete
   compatible app with all gates closed and verify the production alias points
   to that exact build. With the real cron credential, both GET and POST to
   `/api/photos/repair` must return 503. Record both responses before cleanup.
5. Take the final dry run, review/approve its exact mapping, and execute it with
   the [execute/resume commands](#execute-and-resume). Record before-image and
   checkpoint locations, committed groups, elapsed time and remaining-time projection.
   A drift error blocks that group and cutover; do not edit a digest to suppress
   the conflict. Reinspect the live rows and obtain a new administrator ruling.
6. Require zero repeated non-null hashes and a valid global partial unique
   `photos_content_sha256` index before retiring the per-job `photos_job_sha`
   index (confirmed present in the production preflight). Keep writes closed until the CLI
   reports successful index validation and the production read/schema checks
   pass. Recheck that old unfiltered session reads/RPCs hide trash and direct
   hard DELETE remains denied. Keep the new schema and grants on code rollback.
7. Configure the existing project and complete the production connector checks
   in the [MCP runbook](dws-mcp-runbook.md). Open compatible photo writes and MCP
   only for the operator's checks. Record one ordinary upload/move/remove/restore
   on operator-owned smoke data. Hold employee URL distribution until both
   actual ChatGPT and Claude accounts pass. If either fails, close MCP.
8. While cron remains disabled, open the repair gate and save one manual
   new-handler repair report. On failure close repair and fix it. On success
   re-enable the schedule, then save the first successful scheduled report.
   The release remains outstanding until this scheduled result is observed.

Gate changes require an operator database session and an administrator identity:

```sql
-- Emergency closure; this does not disable an already deployed old handler.
update public.photo_release_state
set photo_writes_enabled=false, mcp_enabled=false, repair_enabled=false,
    updated_by='<administrator-user-uuid>', updated_at=clock_timestamp()
where singleton;
```

Use the same explicit actor/time fields when opening each gate at its step.
Never reopen repair before the new deployed handler has been verified. Closing
database gates does not disable Vercel cron or drain an old invocation.

### Execute and resume

Run these commands at step 5 of the [activation sequence](#activation-sequence),
after its write-pause, deployment and approval prerequisites are satisfied.

```sh
node dws-app/scripts/photo-identity-cutover.mjs \
  --project-ref qebbmojnqzwwdpkhuyyd --output "$CUTOVER_DIR/execute.json" \
  --mapping "$CUTOVER_DIR/approved-mapping.json" --execute

# Use the checkpoint and before-image paths emitted by the previous run.
node dws-app/scripts/photo-identity-cutover.mjs \
  --project-ref qebbmojnqzwwdpkhuyyd --output "$CUTOVER_DIR/resume.json" \
  --resume "$CUTOVER_CHECKPOINT" --execute
```

Each mutation invocation processes at most 100 digest groups and observes a
30-second budget. Continue using its saved checkpoint until index validation
finishes. A committed database group is durable even if the process dies before
the local checkpoint is saved; retrying identical choices does not repeat its
mutation or extend retention. Preserve all emitted artifacts together.
Execute writes `<output>.checkpoint.json` and `<output>.before-image.json`;
the report names both paths. Resume writes a fresh checkpoint beside its new
output while preserving the original before-image. `indexed` with
`global_index_valid: true` is completion; `checkpointed` requires another
resume. The report's `projected_remaining_ms` extrapolates measured group work;
index/deployment/client checks still need separate time.

### Recovery posture

Before any new-format photo writes or purge, the recorded metadata before-image
can restore the reviewed cleanup under closed gates. Rollback must verify that
every affected row still matches its recorded after-image. Paths and original
bytes are never changed by metadata cleanup. Preserve the permanent
`photo_repair_deleted_paths` and `photo_repair_retired_ids` records.

```sh
node dws-app/scripts/photo-identity-cutover.mjs \
  --project-ref qebbmojnqzwwdpkhuyyd --output "$CUTOVER_DIR/rollback.json" \
  --rollback "$CUTOVER_BEFORE_IMAGE" --execute
```

`rolling_back` requires the same rollback command again, then `rolled_back`.
`forward_fix_required` exits with code 2 and requires the posture below.

After a new-format write or purge, keep writes/MCP/repair closed, keep Vercel
cron disabled, retain the new RLS/grants/schema and forward-fix. Do not restore
old row snapshots after bytes may have been purged. Do not run old service-role
repair against retained trash. A successful metadata rollback alone does not
authorize restoring old app write grants: first prove that no retained trash
would become visible or hard-deletable.

## Repair sweep (`/api/photos/repair`)

A daily Vercel cron (09:00 UTC, `vercel.json`) first permanently purges up to
500 expired photos, then repairs active photos and cleans orphan objects.
Both GET and POST require `CRON_SECRET` and the server-only
`photo_release_state.repair_enabled` gate with schema generation 1. An absent
or closed gate returns 503 before any lease or Storage mutation.

One 240-second deadline starts at handler entry and covers purge, discovery,
network body reads, image transforms, and ffmpeg. Each control request also
has a 15-second timeout; ffmpeg is killed when the shared deadline or lease
cancellation fires. The final ten seconds are reserved only for backlog
reporting and lease release, inside the 300-second function limit.

### Run it by hand

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://photos.design-workshops.app/api/photos/repair
```

`CRON_SECRET` is the Vercel environment variable of the same name. The
response looks like:

```json
{
  "counts": { "fillImageDerivatives": 2 }, "errors": [], "error_count": 0, "planned": 2,
  "purged": 3, "purge_failed": 0, "purge_backlog": 0,
  "work_deferred": 0, "oldest_due_at": null
}
```

### What each `counts` key means

| Key | What happened |
| --- | --- |
| `fillImageDerivatives` | An image row had no thumbnail (client couldn't decode it — e.g. HEIC picked in Chrome). The sweep rendered a thumb + preview via Supabase image transforms and filled the row. |
| `markFileTile` | An image couldn't be transformed (RAW format, or original over 25 MB, or the transform endpoint refused it). The row was set to `kind='file'` — a deliberate file tile, not a hole. Check the log line for the reason. |
| `makeVideoPoster` | A video row had no poster. The sweep downloaded the original, extracted a frame with ffmpeg (~1 s in), uploaded it as thumb + preview WebPs, and recorded `duration_secs`. |
| `transcodeVideo` | A video within the caps gained an H.264/AAC `playback_path` rendition (`derived/{uid}/{photoId}_playback.mp4`). Only planned when `PHOTOS_TRANSCODE=1`. |
| `posterSkipped` | A video exceeds the server poster processing cap. The persistent `poster_skipped_reason` explains the skip; its original and video kind are retained. |
| `playbackSkipped` | A planned transcode found the clip over a cap and set `playback_skipped_reason` instead. The sweep never replans it; the lightbox shows the download card. |
| `transcodeDeferred` | A video reached the shared work deadline. Completed poster work remains counted; unfinished work resumes on a later invocation. |
| `deleteOrphanObject` | An old object under `originals/` or `derived/` had no current retained-photo or upload-attempt owner. SQL authorizes its deletion and fences later path reuse; Storage confirms its absence. |
| `deleteDeadRow` | An active `photos` row's original object is missing from storage — finalize raced a dead upload. Row deleted. |

`errors` samples at most 50 failures, with at most 1,000 characters each.
`error_count` is the exact failure count even when details are truncated.
Action failures are isolated; a lost lease stops the run immediately. Rows younger
than 10 minutes are always skipped — the client may still be uploading its
derivatives.

**A run with any error responds `500`.** The original `counts`, `errors`,
and `planned` fields remain. `purged` counts rows actually removed;
`purge_failed` counts attempted photos with cleanup failures. `purge_backlog`
and `oldest_due_at` describe the remaining expired rows, including canonicals
held by duplicate references. A null backlog means it could not be measured
(for example, another invocation owns the lease); it does not mean zero.
`work_deferred` counts known interrupted items, with at least one when a scan
remains unfinished. It is a lower bound, not a full unscanned-corpus count.
Ordinary budget exhaustion and a busy lease return 200 with visible deferral.
A failed cron shows red under **Settings → Cron Jobs**. A `400` instead means
the request itself was bad (an unparseable `?olderThan=`); nothing was swept.

### `?olderThan=<ms>` (drills only)

For a drill (verify a killed upload's object gets swept), point
`ISOLATED_PHOTOS_ORIGIN` at the isolated fixture application and use its cron
credential to override the 24 h orphan age:

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "$ISOLATED_PHOTOS_ORIGIN/api/photos/repair?olderThan=0"
```

This override changes only orphan age, never the 30-day retention deadline
or upload ownership checks. Use an isolated fixture target for destructive
drills; do not run them against the production corpus.

### Recovery after failure, overlap, or process death

Save the response when invoking repair, inspect `errors`, and rerun the same
POST after fixing the reported dependency. Vercel cron does not automatically
retry a failed run. Storage deletion is idempotent: a missing object is already
clean, while a failed or partial delete retains the photo row and original
`purge_after`. The next run retries the remaining recorded paths. Shared paths
remain while another retained photo or protected attempt owns them. Expired
duplicate rows drain before their canonical row; a surviving duplicate
reference holds that canonical for a later run. Completed migration and action
histories do not block deletion; their audit identifiers survive.

The singleton `photo_repair_progress` lease lasts two minutes and renews every
30 seconds. An overlapping invocation performs no repair work. If the process
dies, wait for lease expiry and rerun; never manually clear a live lease.
Generation checks fence stale workers. Photo and Storage scans alternate
100-entry keyset pages and checkpoint completed items; a failed item may replay
on the next scan cycle. No whole-library list is loaded or persisted as an
ownership snapshot. A partial scan never proves that an object is unowned.

Read progress using an operator database session:

```sql
select lease_holder, lease_generation, lease_expires_at,
       photo_cursor, storage_cursor, updated_at
from public.photo_repair_progress where singleton;
```

Unfinished ordinary and migration attempts remain owners after lease expiry
so closing a tab does not lose resumable bytes. Explicit ordinary queue Remove
must durably cancel its unfinished attempt before dropping the queue item;
cancelled migration items and explicit skips likewise become eligible after
the orphan age. Completed photos remain retained owners. Deletion authorization
stores permanent path fences in `photo_repair_deleted_paths`; never erase those
records to retry an upload. A retired path requires a new attempt/photo UUID.
Upload ledgers and `photo_repair_retired_ids` prevent reuse across owners.

For production cutover, follow the [activation sequence](#activation-sequence).
Code rollback alone cannot safely run the old service-role repair over trash.

### Video transcoding (`PHOTOS_TRANSCODE`)

The H.264 playback rendition is behind the `PHOTOS_TRANSCODE` Vercel env
var — set it to `1` to turn transcoding on; unset (or anything else) means
transcodes are never planned. It is not set at first deploy — set it to `1`
once a manual sweep run and posters look healthy in production. Posters are
**not** behind the switch: a video missing its thumb always gets
`makeVideoPoster`.

Caps (`src/lib/photos/repair/transcode.ts`): originals over **200 MiB** or
**120 s** are skipped permanently via `playback_skipped_reason`. Repair also
caps a streamed input and generated rendition at 200 MiB each, and each poster
at 8 MiB, so its temporary workspace stays below the function disk limit.
A larger original with no poster gets an observable `posterSkipped` and
persistent `poster_skipped_reason`; its original and video kind remain intact.
A truncated output is never published as playback. After changing the server
processing cap or supplying a valid derivative through an authorized repair,
clear the relevant skip reason to re-queue it. A video's poster and rendition share one download. Each bounded page gets
only the time left after purge and earlier work; no transcode receives a fresh
240-second allowance. A backlog drains over repeated invocations.

Re-queue one video (e.g. after raising the caps or a bad rendition):

```sql
update photos set playback_path = null, playback_skipped_reason = null
where id = '<uuid>' and deleted_at is null;
```

then run the sweep by hand. The old `_playback.mp4` object is upserted over.

**"Why does Chrome show a download card for this video?"** triage, in order:

1. `select playback_path, playback_skipped_reason, poster_skipped_reason, mime_type from photos where id = …`
2. `playback_skipped_reason` set → expected: the clip is over a cap. Re-queue
   only if you've raised the caps.
3. Both null → the sweep hasn't reached it yet (transcodes can defer). Check
   the last run's `transcodeDeferred`/`errors`, or run manually.
4. `playback_path` set but playback still fails → fetch the rendition URL
   directly; if the object is missing, re-queue (the orphan/dead-row rules
   don't cover derived objects).

### Reading the logs

Vercel dashboard → the project → **Logs**, filter on `photos.repair`. The
handler logs its aggregate JSON report: committed action `counts`, `purged`,
`purge_failed`, backlog, deferred work, exact `error_count`, and bounded
`errors` samples. Inspect that report alongside the HTTP response; there is
no guaranteed log line for each action. Some media decisions also emit
photo-specific reason logs.

The cron's own runs appear under **Settings → Cron Jobs** with their status;
the daily schedule is `0 9 * * *`.

## Triage: "a user says their upload vanished"

Work top-down; each step tells you which layer dropped it. You need the
approximate time, the job, and ideally the filename.

1. **Ask what their tray says.** A `failed` row retries in place; an
   `interrupted` row (they reloaded/killed Safari) resumes after re-picking
   the same files from the tray. "Already in this job" means the same bytes
   were already uploaded to that job — the photo is there, under the earlier
   row.

2. **Is there a row?**

   ```sql
   -- Intentional diagnostic read includes retained trash.
   select id, original_name, kind, thumb_path, created_at, captured_at_source,
          deleted_at, purge_after, duplicate_of
   from photos
   where job_id = '<job>' and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Row present with `deleted_at` → it is in trash. Open the trash view and
     check the recovery deadline and canonical reference before restoring.
   - Active row with `thumb_path` → it landed. "Vanished" is a viewing
     problem: check which grid/filter they're looking at (wrong job, or a tag
     or uploader filter they didn't expect).
   - Active row, `thumb_path` null → derivative hole (e.g. HEIC picked in
     desktop Chrome). It shows after the next sweep; run the sweep by hand
     (above) to fix it now.

3. **No row — is there an object?**

   ```sql
   select name, created_at from storage.objects
   where bucket_id = 'photos' and name like 'originals/%'
     and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Object without a row → the bytes arrived but finalization may still be
     unfinished. Check the upload attempt or migration item and its route
     errors; have the user resume from the tray or migration page. Unfinished
     resumable attempts protect their paths until resolved or explicitly
     cancelled, even after lease expiry. The 24-hour orphan age applies only
     to genuinely unowned or explicitly cancelled paths, and cleanup still
     requires a live check that no retained photo or other attempt owns them.
   - Nothing anywhere → the upload never reached storage: the connection died
     before the first byte, or the batch was dismissed. Re-upload.

4. **Still lost?** Run the repair sweep by hand and reread step 2 — the sweep
   converges every partial state that can be converged (`counts` tells you
   what it found).

## Launch drills (run on production after the first deploy)

Run them on an iPhone over LTE (not office Wi-Fi). Record results inline.

- [ ] **30-photo batch.** Pick 30 camera-roll photos → one job → Upload.
  Navigate between pages while the tray counts. Expect: all 30 land, the
  grid refreshes, the tray stays responsive throughout.
  Elapsed time (start → "Upload complete"): ______
- [ ] **Big-video resume.** Recheck the bucket `fileSizeLimit` first; the
  2026-09-07 read-only inspection found 50 GiB. Upload a ~500 MB video, kill
  Safari at ~50%, reopen the app → tray shows "1 upload interrupted" →
  re-pick the file → progress resumes above 0%. Expect: exactly one `photos`
  row, and no `deleteOrphanObject` for it in the next sweep.
- [ ] **Sign-out mid-batch.** Start a batch, sign out in another tab.
  Expect: remaining items fail with "Signed out — sign in and retry";
  after signing back in, Retry succeeds without re-picking.
- [ ] **Three green crons.** Three consecutive daily `/api/photos/repair`
  runs green in Vercel → Settings → Cron Jobs, each with `errors: []`.
- [ ] **Transcode turn-on** (after the above): set `PHOTOS_TRANSCODE=1`, run
  the sweep by hand, confirm the backlog clips gain `playback_path` and play
  in desktop Chrome/Firefox (see "Video transcoding" above).
