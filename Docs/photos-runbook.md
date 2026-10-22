# Photos Runbook

Operational notes for the DWS Photos hub (uploads, confirmed changes, repair sweep).

For hosted assistant configuration, shared-key rotation, photo handoffs, and
confirmed issue submission recovery, see the [DWS MCP runbook](dws-mcp-runbook.md).

Albums, optional projects, folder review, and sharing require the ordered
[photo-albums rollout](../plans/active/photo-albums/plan.md#rollout): compatible
migrations before merge, deploy, production checks, then the Sheet # column drop. Production
activation remains operator work; sharing starts closed.

## Album rollout and recovery

The [activation sequence](#activation-sequence) below is a prerequisite, not an
alternative to the albums rollout. The operator must verify the `20260907*`
schema, release gates, and global content-hash index before applying any album
migration. Missing tables or index stop the rollout; dated observations below are
not a current production-readiness record.

Retain `sheet_number` until the new deploy passes the production checks in the
album plan. Its old readers still select that column. Keep the big office import
paused until the operator records the real folder count/depth and keyword/sidecar
inspection; the tested bar is 5,000 folders, so a larger tree needs another scale
check. The column drop is a later, deliberate step, followed by another read smoke
check. Sharing remains closed until its separate activation gate is satisfied.

If the rollout fails, close `sharing_enabled`, `photo_writes_enabled`, and
`mcp_enabled`, stop imports, and disable the repair cron using the existing
activation procedure. Retain the database schema and grants. Before reverting
this PR's code, check in the operator's database session:

```sql
select exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='photos' and column_name='sheet_number')
  as old_column_exists;
select count(*) as projectless_photos from public.photos where job_id is null;
select count(*) as migration_batches from public.migration_batches;
```

A code revert is eligible only if the column remains, both counts are zero, and
the activation sequence's existing rollback conditions also hold. Otherwise
deploy a forward fix with gates closed. Old code cannot safely read album-only
photos or resume folder-model batches, even paused or not-yet-sealed ones. Do not assign invented
projects or delete new metadata to make an old build start. Reopening any gate
requires the operator's recovery checks; changing a browser-origin setting does
not roll back the data model.

## Confirmed photo changes and trash

Move a photo through its review/confirmation screen. Direct `PATCH job_id`
writes are rejected; tag edits apply only to active photos. Any signed-in
employee can move or restore any photo, and `deleted_by` records who removed it.
Each confirmation belongs to the employee who started it; a consumed MCP handoff
authorizes only its bound consumer, action, and confirmed targets.

**Who may delete.** A *photo admin* (`user_profiles.photo_admin`, separate from
the Receipts `role`) may trash any photo, delete forever, empty the trash, and
delete any project or album. Anyone else may trash only photos they uploaded in
the last 30 days (`photos.created_at`, the upload time, not the capture time),
and delete only albums they created. The rule is one SQL function,
`photo_can_trash`; the trash confirmation functions (`photo_materialize_action`,
`photo_approve_action`, `photo_apply_action`) raise `forbidden` for any other
photo, whether the list came from the app or from an MCP `remove_photos`
hand-off. Set the flag with the **Photo admin** checkbox on the Users page
(Receipts admins only), or in SQL:
`update public.user_profiles set photo_admin=true where user_id=<id>`. It takes
effect on that person's next request. To widen or narrow the rule, edit
`photo_can_trash`, and change the app's copy as the header of
`src/lib/photos/permissions.ts` describes.

Removal sends a photo to `/photos/trash` for 30 days. Repeating removal does
not extend its original `purge_after`; restoration is unavailable at or after
that timestamp, even if permanent cleanup has not run. The public bucket is
unchanged: someone with a known object URL can still fetch it during retention.
Library listings, search, counts, tags, and deep links exclude all trash.

**Delete forever.** A photo admin can delete Trash items forever from
`/photos/trash`: one photo, several selected photos, a deleted album, a deleted
project (with all of its trashed photos), or **Empty trash** for everything.
Everyone else sees only **Restore** there; the purge route answers 403 and every
`photo_purge_*` function raises `forbidden` for them.
`POST /api/photos/trash/purge` marks the items (`photo_purge_request`); a marked
photo leaves the Trash list at once and can no longer be restored. The route then
removes its Storage files and row the same way the daily repair sweep does
(`photo_purge_pending`, `photo_purge_authorize_delete`, `photo_purge_finish`), for
up to about 45 seconds per call; the page keeps calling while each call makes
progress, so the tab must stay open for a large delete. This path needs only
`photo_writes_enabled`, not `repair_enabled`. An album or project deleted forever
stays as a hidden row (`purged_at`), because import, upload, and share-link
history still point at it; a project's number becomes `deleted:<id>`, so its
real number is free again.

A photo whose files could not be removed, or whose request was cut off (a closed
tab, a timeout), stays marked: out of Trash, not restorable, its files still in
the bucket. Trash then shows "N photos are still being deleted forever" with
**Finish deleting**, which posts `{}` and finishes only what is already marked
(Empty trash would also delete everything else in Trash).
Count marked photos with
`select count(*) from public.photos where deleted_at is not null and purge_claimed_at is not null`.
The only way to stop a running delete is to close `photo_writes_enabled`, which
also stops every upload and edit.

**Wiping the library** (as a photo admin). Delete each project first: that sends every photo in it
to Trash, with no selection limit. Then trash the photos left with no project,
up to 500 selected at a time, and delete each album. Finally press **Empty
trash** and keep the tab open until the toast says the trash is emptied. After
Empty trash, the next office sync (`shop.refresh_jobs()`, every 15 minutes, or a
manual `scripts/import-jobs.mjs` run) recreates any deleted project that is still
an open office job, because its number is free again.

A legacy duplicate in trash points to its canonical photo. Review the canonical
target before restoring or moving it; restoration never creates another active
copy. Uploading matching bytes keeps the item unresolved until that action
succeeds or the employee explicitly skips it. The employee restores the matching
photo from the upload tray's **Review restore** link (any signed-in employee
can, while the 30 days last), then retries the original queue item to resolve
the canonical result.

## Browsing, select all, download, and album order (Wave 2, 2026-10-12)

What an operator needs to know about the client-feedback round; the employee
view is in `Employee-Features.md` § DWS Photos.

- **Filters live in the URL** (`project, uploader, tags, type, from, to, sort,
  group`); `GET /api/photos` and `GET /api/photos/ids` parse them in one place
  (`src/lib/photos/server/list-filters.ts`). `from`/`to` are zoned ISO instants
  the browser computes in its own local time; the server never picks a
  timezone. `q` is split into words (at most 8) and every word must match.
- **Select all**: while photos are selected, the bar asks only
  `GET /api/photos/ids?count=1` for its "Select all M" label (one cheap count).
  The ids themselves are fetched when the link is clicked, or when the count
  alone cannot tell whether every match is already selected (a selection
  carried over from another filter): `GET /api/photos/ids`
  walks the match server-side 1,000 rows at a time and stops at 5,000
  (`truncated: true`). The selection
  cap is 5,000 (`MAX_SELECTION_PHOTOS`); the action batch accepts it as one
  request, while the tag, album, and purge routes keep 500 per request and the
  client chunks. Trash and its Undo from the selection bar and the viewer go
  through `POST /api/photos/bulk` (`src/lib/photos/server/bulk.ts`), 1,000
  photos a request (`MAX_ACTION_RUN_PHOTOS`): the server creates, materializes,
  approves and applies one ordinary batch per request with the same SQL
  functions as the confirm page, so each slice is one `photo_action_batches`
  row like before. Photos that are gone or that the person may not trash are
  left out and counted, never asked about; a photo already in Trash is skipped. No SQL cap changed. Lower `MAX_SELECTION_PHOTOS` if `/ids`
  ever times out. The "Select all N" label only asks `/ids?count=1`, one
  counting query with no ids sent. The confirm page's batch responses leave
  out `selector` (up to about 255 KB); to see what a batch named, read
  `photo_action_batches.selector` in the database.
- **Zip download is built in the browser** from the public originals
  (`client-zip`, store-only). Without `showSaveFilePicker` (Safari, Firefox,
  iPhone) the zip is held in memory, so the confirm warns above 400 MB there
  (`ZIP_WARN_BYTES_IN_MEMORY`) and above 2 GB where it streams to disk; there
  is no hard cap. Sizes and names of selected photos the grid has not loaded
  come from `POST /api/photos/rows` (500 ids a request). A failed original is
  left out and named in the toast.
- **Album order.** Migration `20261012223043_album_custom_order.sql` adds
  `album_photos.position` and `albums.sort_mode` (`date` | `custom`),
  `photo_album_reorder` (full order, or `null` to return to date order while
  keeping positions), a trigger that gives a newly added photo `max+1` when the
  album is custom (covers Add to album, upload into an album, and folder
  import), and the `album_photo_order` view the photos route reads for
  `sort=custom`. `photo_share_read` orders by `(position, id)` for a custom
  album and hands out a `{position, id}` cursor; switching an album's mode
  while someone pages a share link makes their next page read as nothing (the
  existing foreign-cursor behavior). Arrange is capped at 2,000 photos
  (`MAX_ARRANGE_PHOTOS`).
- **Format twins.** `GET /api/photos/twin?job=&base=&captured_at=&sha=` finds an
  active image in the project with the same base name and a capture time
  within 1 s and different bytes. The check runs in the browser before any
  attempt row or bytes, images only. `.CR3` is now a RAW image in the upload
  table, so folder imports include it.

## Hand-made projects

A photo has at most one job, which employees call a project, and may have none
(`photos.job_id` is nullable; the app shows "No project"). It can also sit in any
number of albums (`albums`, `album_photos`). Every upload must name a project, an
album, or both; after that, edits are free, including a move to "No project".
Any signed-in employee can create, rename, and restore any album; only the
album's creator or a photo admin can delete it. A deleted album keeps its photos
and can be restored for 30 days; deleting an album never deletes a photo. Album and bulk-tag writes go through the `photo_*album*`
and `photo_bulk_tag` functions behind the `photo_writes_enabled` gate.

Where employees find things: `/photos` lists every photo, newest first (phone and
desktop both open here); `/photos/albums` and `/photos/projects` list albums and
projects; `/photos/<jobId>` is still one project, so links already sent keep
working. Deleted albums are listed on `/photos/trash` above the trashed photos,
each with **Restore album** for 30 days. "Copy link" writes
`/photos?photo=<id>`, which opens any active photo by id however old it is.

Every photo is named automatically: `<project number> – <YYMMDD> <HHMMSS>`, for
example `3962 – 260923 160432` (an en dash between single spaces; the capture time
read in Pacific time, `America/Los_Angeles`). A photo with no project is named
`260923 160432`. When another active photo in the same project (or, without a
project, another photo with no project) already holds the name, the first free of
` (2)`, ` (3)` … is added; trashed photos do not count, and a photo restored from
Trash is named again, so it takes the first name free at that moment. The name is
`photos.display_name`, filled by the `photo_auto_name` trigger (the format lives in
the SQL function of the same name) when a photo is uploaded and again whenever its
project changes, so moving a photo to project 4100 renames it `4100 – …`.
Renumbering a project does not rename its photos. Plain files (documents, not
photos or videos) keep their uploaded filename.

A photo can be renamed by hand from the viewer (**Rename**) or, with exactly one
photo selected, from the selection bar (`photo_rename_photo`). A hand-given name
sets `photos.name_source='manual'` and is kept on a move; an empty name goes back
to `'auto'` and recomputes the automatic name. The name is the download filename,
in the app and on share links, with the uploaded file's extension kept
(`3962 – 260923 160432.HEIC`). `original_name` never changes, because MCP
references and imports match on it; the viewer shows it under "About this file".
Storage paths never change either. The Albums and Projects lists have **Select**:
pick one to **Rename**, or any number to **Delete** (a mixed pick reads "Delete the N
you can delete").

Selecting many photos: **Add to album**, **Tag**, and **Remove from album** act at
once on up to 500 photos (`MAX_BULK_PHOTOS`). **Set project** and **Trash** open
the confirm page (`/photos/actions`) with exactly the selected photos, up to 500
in one batch. Review and apply requests process at most 100 photos per page;
nothing changes until the employee confirms the complete selection.

Until the office project database is bridged, any photo actor can create a
project wherever a job is chosen (upload, move, and the `/migrate` page) or with
**New project** on the Projects list, and rename one from its page. Both go through `photo_create_job` /
`photo_rename_job` behind the `photo_writes_enabled` gate.

- A project created without an office job number receives a generated `P-<n>`
  code from `job_project_code_seq`. Office job numbers are digits, so the two
  never collide, and a typed `P-` code is refused.
- Creating with a job number that already exists returns that job; nothing is
  duplicated. Where a job is being picked (upload, move, `/migrate`) that job is
  used; on the Projects page's **New project** it is an error, since only a new
  project will do. A number held by a project in Trash is refused (`job_in_trash`).
- Rename can also change the number (`photo_rename_job` with `p_job_number`).
  A number another project holds is refused (`job_number_taken`); so is one held
  by a project in Trash (`job_in_trash`). An office job (`synced_at` set) cannot
  be renamed or renumbered at all (`job_office_managed`,
  `20261022130000_photo_office_jobs.sql`): the office wins, so its name and number
  change in the office database and reach the app with the next sync.
- **Deleting a project** (`photo_delete_job`, photo admins only) sends it and every active photo in
  it to Trash together, with one shared timestamp. Only an active project can be
  deleted. It stays hidden from project lists and pickers (`is_active` false,
  enforced by the `jobs_deleted_not_active` check), and the `photo_guard_live_job`
  trigger refuses any live photo written into it, including an upload or move
  that raced the delete. **Restore project** within 30 days (`photo_restore_job`)
  brings back the photos that left with it; photos trashed on their own earlier
  stay in Trash. A photo restored on its own while its project is deleted comes
  back with no project. After 30 days the project stays listed in Trash, can no
  longer be restored, and still holds its number until someone deletes it
  forever.
- Hand-made rows have `synced_at` null and `created_by` set. The office sync
  is `shop.refresh_jobs()` (every 15 minutes), with `scripts/import-jobs.mjs` as
  the manual fallback. Both upsert on `job_number`,
  so an office job with the same real number takes over a hand-made row in
  place, sets `synced_at`, and from then on owns its name and location. `P-`
  projects are never touched, and neither is a number held by a project in
  Trash: both skip and list those, since the `jobs_deleted_not_active` check
  would fail the whole upsert. Neither ever deactivates a job; whether a job
  that leaves the office's open list should be deactivated is still undecided.

## Importing folders (`/migrate`)

Each imported folder that directly holds photos is one review row — project,
tags, and a **Make an album** switch, off by default (round three,
`20261014120200_photo_import_album_optional.sql`). Turned on, the row's album is
named from its path under the picked folder (`Smith Residence/Finished` arrives
as `Smith Residence – Finished`) and can be renamed; `migration_folders.album_name`
null means no album, which is what `migration_seal` now writes. A row with photos
needs a project or an album before approval (the page says which rows lack one).
A project and tags may be set on a top-level folder to cover every folder inside
it. The rows live in `migration_folders`.

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
- **Rescans preserve reviewed rows.** While the import is a draft, newly found
  folders start with visible source defaults and name suggestions, without
  inheriting earlier ancestor edits. After approval, a rescan may refresh files
  in existing folders but refuses newly discovered folders before importing them.
  Start a new import to review those folders; already imported photos are kept.
- **Folder import needs Chrome or Edge on a computer.** Phones, Safari, and Firefox
  cannot open folders; the page says so and offers "Add photos" (up to 500 files,
  which need a project or an album).

Large imports: the local regression sealed 100,000 entries with 1,500 live photos
in 3.4 seconds, under its 8-second limit, even with a stale one-row planner estimate.
The density-zero statistics state is reproduced by the local harness; its
occurrence in production is unverified. The setting is defensive, and the timings
are not production throughput or evidence that ordinary growth causes this state. Previously
Postgres compared every scanned file with every existing photo (1.7 s became
11.5 s at only 1,500 photos). The two trigger functions on that insert now refuse
nested-loop joins (`set enable_nestloop=off` on `migration_reserve_uuids` and
`photo_repair_guard_owner_ids`); do not remove that setting when editing them. The
test "seals 100,000 entries inside the limit with 1,500 live photos the planner
believes are one row" in `integration/db/migrations.test.ts` guards it.

## Settings, default tags, and list order (round three, 2026-10-14)

Three migrations, applied to production on 2026-10-14 before the deploy:

- `20261014120000_photo_list_order.sql`: `get_photo_job_summaries_by_number_page`
  (projects by job number descending, `P-` codes last) and
  `get_photo_album_summaries_by_name_page` (albums by name, digits as numbers,
  via `photo_sort_key`). The activity-ordered page functions the old app called
  are left in place; drop them once no deploy calls them.
- `20261014120100_photo_settings_and_tags.sql`: `photo_settings` (one row;
  `starter_tags`, read by every signed-in session, written only by a photo admin
  through `photo_set_starter_tags`), `user_profiles.slideshow_shuffle` and
  `slideshow_delay_seconds` (own row, through `photo_set_slideshow`), and the
  tag rename: `professional` → `Photoshoot`, `shop`/`shop drawing` → `Shop`,
  `field`/`field dimension` → `Field`, on every photo and on draft import rows.
  `GET/PATCH /api/photos/settings` carries both; the Settings page is
  `/photos/settings`. The rename block is repeat-safe. It was re-run once after
  the deploy of `13fa30b` (2026-10-14 22:58 UTC): the app live between the
  migration and the deploy had tagged 17 more photos `professional`; afterwards
  0 remain and 258 carry `Photoshoot`.
- `20261014120200_photo_import_album_optional.sql`: see Importing folders.

## Saved lists on the device and the cold open (performance round, 2026-10-16)

- **Saved query cache.** The browser keeps some photo lists in IndexedDB
  (database `dws-query-cache`, key `photos-query-cache`): the full project and
  album lists, album headers, and the first page of the 6 most recently
  loaded grids. Not kept: permissions and settings (`photo-me`, one answer
  that carries the admin flag), searches, trash, photo details, anything from
  Receipts. Logic:
  `src/lib/query-persist.ts`; wiring: `src/components/providers/query-provider.tsx`.
- It belongs to one person: each save records the user id, and a restore is
  refused (and deleted) when the signed-in session is someone else or no one.
  When the session cannot be checked (the token refresh failed on a weak
  signal), that launch starts cold and the saved cache is kept.
  Sign-out and any change of signed-in person delete it.
- It expires after 7 days and is thrown away by every deploy (the buster is
  the commit sha, `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`, which Vercel exposes
  because "Automatically expose System Environment Variables" is on for
  `dws-receipts`). Restored lists always refetch when shown.
- **A user sees an out-of-date list:** it refreshes by itself within a second
  or two of opening the page. To force it, sign out and back in (deletes the
  saved copy), or clear the site's data in the browser.
- **Cold open.** Before the session check finishes, the photos frame (tab bar,
  desktop top bar and rail, grey tiles) is drawn instead of "Verifying
  authentication"; only the page waits. A signed-out visitor sees that frame
  for a moment before the redirect to `/login?next=...`.
- **Code loaded on demand.** The viewer, the "+" pop-ups, Download, Arrange
  and the upload engine download when first used. A failed download keeps the
  page and the next try downloads again; when the file is gone from the server
  (404: a tab opened before a deploy), the page reloads onto the new build, at
  most once a minute (`src/lib/photos/redeploy.ts`).
- **Project and album pages are cached HTML.** `/photos/[jobId]` and
  `/photos/albums/[albumId]` render once per id and are then served from the
  Vercel cache until the next deploy (their segment layouts export an empty
  `generateStaticParams`). The pages hold no data; everything is fetched in
  the browser. `/login` is static too: the photos tab title is set in the
  browser.
- **Providers per area.** React Query is mounted in each signed-in area's
  layout (photos, migrate, capture, photo-actions, employee, dashboard,
  batch-review, users), not the root one, so the public share page does not
  load it. A new top-level page that uses React Query needs a `layout.tsx`
  that wraps it in `QueryProvider`, or it fails with "No QueryClient set".

## Favorites (`photo_favorites`)

`20261013210000_photo_favorites.sql` adds one table, `photo_favorites
(user_id, photo_id)`, and one function, `photo_favorite(p_actor, p_photo_ids,
p_on)`, behind the `writes` gate. A favorite is personal: the table's row rule
shows a person only their own rows, so `GET /api/photos` embedding
`favorites:photo_favorites(user_id)` through the employee's session returns
`[]` or `[{user_id: me}]` per photo, and `favorites=1` reads the
`photo_favorite_photos` view (since `20261016140400`) to list only
theirs: the Favorites chip in every grid, kept in the URL as `favorites=1`
(`/photos/favorites` redirects there). `POST /api/photos/favorites { photo_ids,
on }` adds or removes up to 500 at once. Rows cascade with the photo's permanent deletion and with the user.
Apply the migration before the deploy that ships it (additive only).

## Server and database speedups (performance round 1, 2026-10-16)

One migration, `20261016140400_photo_perf_server_reads.sql`. Apply it to
production BEFORE the deploy, with `-f` like any transactional file. It only
adds things or keeps their shape, so the app that is live in between keeps
working. What it adds, and what reads it:

- `photo_actor_context(p_actor)` (service role only). Every write and every
  upload step checks who is asking. That check is now Auth's `getUser` plus this
  one read, instead of `getUser` plus three reads one after another (profile,
  `photo_require_actor`, release gates). The refusals are the same, in the same
  order: no live profile is 403, a deleted or banned Auth user is 401, a closed
  gate is 503.
- `get_photo_me()` (signed-in sessions). Answers `GET /api/photos/me`
  (`{ actor, settings }`), which the app reads once for both its permission
  checks and its settings, and also `GET /api/photos/actor` and
  `GET /api/photos/settings` (no longer read by the app). Who is asking comes from the database-verified
  token, so these reads no longer call the Auth server.
- `get_photo_album_cards(q)`. Album cards in one pass over each album's photos,
  with `created_by`, `sort_mode` and `has_custom_order` added.
  `get_photo_album_summaries_by_name_page` (what `GET /api/photo-albums` calls)
  now reads it, so the album list makes one database call.
  `get_photo_album_summaries` keeps its six columns and reads it too.
- `photo_favorite_photos` view. `favorites=1` starts from the reader's own
  favorites. In the same way, `album=…` now always reads `album_photo_order`,
  date order included. Both used to walk the whole library newest first. The
  favorites row rule is now `user_id = (select auth.uid())`, which shows the
  same rows.
- Index `photos_active_job_created` on `photos(job_id, created_at desc)
  include (thumb_path) where deleted_at is null`, for the Projects list. It is
  built without CONCURRENTLY, which briefly holds writes to `photos`: well under
  a second at today's size. If `photos` has grown past about 100k rows, run that
  one statement by itself with CONCURRENTLY instead (see
  `supabase/migrations/README.md`).

`album_photo_order` and `photo_favorite_photos` both copy the `photos` column
list at the moment they were created. A new column on `photos` that a list needs
must be added to both views.

App-side changes that go with the migration:

- **Region.** `vercel.json` pins functions to `cle1` (Cleveland, AWS us-east-2),
  the same region as the database. They used to run in `iad1` (Washington DC).
  After the deploy, check that a response's `x-vercel-id` reads
  `sfo1::cle1::…`. The Hobby plan allows one region. If the dashboard's
  Functions region setting disagrees, `vercel.json` wins on the next deploy.
- **Paged lists.** A next-page cursor on `GET /api/photos` and
  `/api/photos/ids` also bounds the sort column (`captured_at <=` the cursor
  value, or `>=` for oldest first). That lets Postgres start each page from the
  index instead of re-reading every row before it.
- **One response shape.** `GET /api/photos`, `/api/photos/ids` and
  `/api/photo-tags` now answer like every other photo route: `no-store`, and
  errors as `{ error: { code, message, retryable } }` with no database text.
- **ffmpeg for posters.** `/api/photos/[id]/derive` now ships with the ffmpeg
  binary (about 45 MB more in that one function). A video poster the browser
  could not make now appears right after the upload, not after the 09:00 UTC
  sweep.
- **Image allow-list.** `next/image` only optimizes
  `/storage/v1/object/public/receipt-images/**`. Photos never went through it.
  The old pattern let anyone spend the image-optimization quota on any photo.

To check the album list after applying (read-only):
`explain (analyze, buffers) select * from public.get_photo_album_summaries_by_name_page(null, 200, null, null);`
run as a signed-in role. Compare it with the audit's 20,074 buffers.

## Share links (`/s/<token>`)

An employee can share one album or one project with a link, from the **Share**
button on it. Anyone who has the link can see that album's or project's name, a
photo count, and its photos and videos, and download them, **without signing
in**. It is the only page in the app that works without a login. A visitor never
sees who took a photo, its tags, its XMP file, or any other album. A visitor sees
each photo's name, hand-given or automatic, and downloads under it; a project
number appears only at the start of an automatic name. Any signed-in employee may
turn any link on or off.

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
in production for the first time: an independent security review of the current
public route and `photo_share_read` is recorded in the pull request (the builder's
carried handoff read alone is insufficient), and with the gate still
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

**Opened in production on 2026-10-13 18:01 UTC** by Ariav Asulin (operator user
`4829df26-0658-4edf-b2df-f66c5f21b506`), at the owner's request after the Wave 2
release, with the statement above. Checks before: PR 20 records the security
read of `photo_share_read` and the public route, and the Wave 2 review confirmed
that function unchanged; a live project link answered 404 while the switch was
off. Checks after: the same project link opened without a login, and a made-up
token still answered 404.

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

   **Done 2026-10-13** by Ariav Asulin (operator user
   `4829df26-0658-4edf-b2df-f66c5f21b506`): `repair_enabled` opened at
   20:18 UTC after deploy `95f4103` (server-made previews). `CRON_SECRET` was
   rotated the same day, so the manual runs used the new value; the schedule
   had stayed enabled in Vercel since cutover. Three manual runs:
   `{"counts":{"fillImageDerivatives":30},"error_count":0,"work_deferred":1}`
   (241 s, deadline), `{"counts":{"fillImageDerivatives":14},"error_count":0}`
   (98 s), then `{"counts":{},"planned":0}` (40 s). All 278 active photos had
   thumbnails after it, none became a file tile. The first scheduled report
   (09:00 UTC 2026-10-14) is still to be saved here. `PHOTOS_TRANSCODE=1` was
   set in production the same day, for the next deploy.

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

## Previews made on the server (`POST /api/photos/<id>/derive`)

The uploader's browser makes each photo's thumbnail and preview while it
uploads, for images up to 24 MB and 40 megapixels (read from the file header)
that it can decode. For anything else — a HEIC picked on a desktop browser, a
TIFF or RAW, an image over 24 MB or 40 MP, a video the browser cannot play —
the upload client asks the server for them as soon as the row is in, through
this route, which uses the same renderers the nightly sweep uses (sharp;
Supabase image transforms for HEIC; ffmpeg for a video poster). The request
runs in the background, two at a time per tab (the folder import too), so the
next file does not wait for it; the tray row's "Previews…" note clears when it
lands. So a 60 MB TIFF has a preview minutes after upload, not the next
morning. Any
signed-in employee may call it for any active photo: it fills only an empty
slot at that photo's fixed derived keys. A refusal (a RAW, a HEIC over 25 MB,
an image over 250 MB) answers `thumb_path: null` with the reason and changes
nothing; the sweep decides later whether the row becomes a file tile. On
success it also removes the upload's "Previews skipped…" note from
`upload_warnings`. It needs `photo_writes_enabled`, not `repair_enabled`, and
has the same 300-second limit as the sweep. If it fails (offline, a timeout),
the upload still completes and the sweep fills the preview that night. Like the
sweep, it ships with the ffmpeg binary (`outputFileTracingIncludes` in
`next.config.ts`), so a video poster can be made here too.

## Thumbnail format and caching (performance round 1, 2026-10)

**Format.** Thumbnails and previews are WebP where the uploader's browser can
encode WebP, and JPEG (quality 0.8) where it cannot: every iPhone and iPad
browser, since all of them are WebKit. The file keeps its `_thumb.webp` /
`_preview.webp` name either way; the stored Content-Type is the real format,
and browsers go by that, not the name. Before this, iPhones stored PNGs under
those names, about 15x the bytes of a WebP thumbnail.

**Caching.** Every upload now sets how long browsers and the storage CDN may
keep the file (`src/lib/photos/storage-cache.ts`): one year for thumbnails,
previews, video posters and playback renditions; one week for originals and
sidecars. Files stored before this keep their old one-hour cache until
rewritten (see the backfill below). The one-year cache depends on a rule
written on `derivedKeys` (`src/lib/photos/repair/sweep.ts`): a derived key is
only ever rewritten with another rendering of the same picture. A future
feature that changes what a photo looks like (rotate, crop, edit) must write a
new key or add a version to the URL; otherwise people keep seeing the old
picture for up to a year. A purged photo's files can also stay in caches (and
on the CDN, for anyone holding the exact URL) for up to that long.

### One-off backfill: PNG and mislabelled derivatives

`scripts/backfill-png-derivatives.mjs` rewrites, at the same keys, every
thumbnail and preview whose stored type is not `image/webp` or `image/jpeg`:
PNGs are re-encoded to WebP with sharp, and real WebP or JPEG files stored as
`application/octet-stream` get the right label. It re-encodes the stored
derivative, not the original, so HEIC originals and videos need nothing
special. Each rewrite gets the one-year cache. It uses storage `update`, so a
file purged mid-run is reported as an error rather than recreated. It is a
dry run unless given `--execute`, and safe to stop and re-run: a fixed file no
longer matches.

From `dws-app/`, after the release that stops new PNGs has deployed:

```bash
node --env-file=.env.local scripts/backfill-png-derivatives.mjs                      # dry run: counts and the list
node --env-file=.env.local scripts/backfill-png-derivatives.mjs --execute --limit 4  # spot-check a few in the app
node --env-file=.env.local scripts/backfill-png-derivatives.mjs --execute            # the rest
```

The first line says what it found. The dry run on 2026-10-16 listed 3,758
derived files: 460 PNG (230 photos) and 446 mislabelled (223 photos). The last
line of an `--execute` run gives the counts and the bytes before and after; it
exits 1 if any file failed, and a re-run retries only those. Browsers holding
an old PNG refresh it within the hour (those files carried the one-hour
cache).

Optional `--recache` also rewrites every correctly typed thumbnail and preview
that still has the one-hour cache (same bytes, new cache header), so the whole
existing library, not only new uploads, loads from the phone's cache on a
revisit. On 2026-10-16 that was 2,844 more files; it downloads and re-uploads
each one once, which counts against the Supabase egress quota.

## Upload requests (`/api/photo-migrations/uploads/*`)

An ordinary upload makes one `POST .../uploads/begin` before its bytes: it runs
`photo_create_upload_attempt`, `photo_acquire_upload`, `photo_claim_content`
and, only when the browser is retrying an identity it recorded earlier, the
original-file check (renew, lock, Storage size), in that order, behind one
actor check. A fresh attempt skips the original check: nothing can be stored
under a new photo id yet. If a step after the lease fails, the route releases
the lease (`retryable_failed`, `claim_failed`) before answering, so the
browser's automatic retry can take a new one. The separate `attempt`,
`acquire`, `claim` and `original` routes stay: the folder import still uses
them (its attempts come from `prepare`), and a tab loaded before a deploy keeps
working. Then come the bytes, then `POST /api/photos` (finalize), which checks
the original's size alongside the derived files'.

When the connection drops mid-batch, the tray holds the batch on the same file
and retries it (5 s, 10 s, 20 s, 40 s, then every minute, sooner on the
browser's `online` event or when the page returns to the front), up to 30
minutes, before failing it. Only failures with no HTTP answer count as a
dropped connection; a 503 (writes gated off) still fails the file at once.
Offline, the cut-off try's lease release fails too, so the lease stays live for
up to two minutes. The browser remembers that lease's generation and sends it
to `begin` as `release_generation`; `begin` releases it
(`retryable_failed`, `connection_lost`) before acquiring, so the retry starts
at once. If the lease is still live anyway (that release missed, or the lost
request was `begin` itself), `begin` answers `200` with
`lease_busy: { retry_after_ms }` (read on the server's clock) instead of a
409, and the tray waits that long and tries again, at most three times. Before
each retry the browser reads one byte of the picked file; a file the phone can
no longer read fails at once ("File can no longer be read — re-pick it")
instead of holding the batch for 30 minutes.

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
| `fillImageDerivatives` | An image row had no thumbnail (the browser did not make one — a HEIC picked in Chrome, a TIFF, an image over the browser's 24 MB decoding budget). The sweep rendered a thumb + preview and filled the row: with sharp from a /tmp copy of the original for every format libvips reads (JPEG, PNG, WebP, TIFF, GIF, AVIF), with no 25 MB ceiling; through Supabase image transforms for HEIC/HEIF, which the prebuilt sharp cannot decode, under that endpoint's 25 MB input cap. |
| `markFileTile` | No renderer could read the image (a RAW format, a HEIC over 25 MB, an original over the server's 250 MB cap, or corrupt bytes). The row was set to `kind='file'` — a deliberate file tile, not a hole. Check the log line for the reason. |
| `makeVideoPoster` | A video row had no poster. The sweep extracted a frame with ffmpeg (~1 s in), uploaded it as thumb + preview WebPs, and recorded `duration_secs`. ffmpeg first reads straight from the original's public URL with range requests (only the header and the bytes near the frame); if that fails or gives no duration, the log shows `photos.repair posterFromUrl … fallback=download` and the whole original is downloaded as before. A row that also needs a rendition always downloads once. |
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
- [x] **Transcode turn-on** (after the above): set `PHOTOS_TRANSCODE=1`, run
  the sweep by hand, confirm the backlog clips gain `playback_path` and play
  in desktop Chrome/Firefox (see "Video transcoding" above).
  Done 2026-10-13 (Ariav Asulin): `PHOTOS_TRANSCODE=1` set in production,
  live with deploy `24cc7ce`; one manual run answered
  `{"counts":{"transcodeVideo":1},"error_count":0}` in 62 s and the one
  QuickTime clip (1.6 MB, 0.6 s) gained its `playback_path`. Desktop playback
  check is still the owner's.
