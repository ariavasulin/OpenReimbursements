---
status: active
created: 2026-10-12
updated: 2026-10-12
---

# DWS Photos: client feedback round 1

Shape: tech spec + implementation plan. The design-doc work happened in conversation with Ari on
2026-10-12 and is recorded in [`sources/design-discussion.md`](sources/design-discussion.md); the
codebase facts are in [`sources/research.md`](sources/research.md) (commit `53dd82f`, tip of
`main` at authoring); the client's words are in [`sources/ticket.md`](sources/ticket.md).
**Consequence: consequential** (it changes who may delete durable photo data, renames every
photo, and wipes the current library). **Delivery: live** (every unit reaches the ordinary
production path once deployed; nothing new is gated). No PRD.

**Agent brief.** Intent: turn the DWS owner's first feedback round into shipped changes: a photo
admin role and a "trash only your own recent photos" rule, automatic file names, per-project tag
suggestions, grouping/sorting/filtering that feels like a mature photo app, select-all that means
all, zip download, hand-arranged albums, an edge-to-edge viewer with slideshow, and a warning for
the same shot arriving in two formats — then a launch wipe. Source of truth: this plan, then the
design discussion, then the research. Locked decisions: Decisions 1–12 below. Current phase:
**plan authored; Wave 1 ready to start.** Stop-and-ask triggers: any production mutation (a
migration, setting admins, the wipe) — Ari confirms each one; a required project (the owner
agreed "No project" stays); a tag table; making the bucket private; roles beyond the photo-admin
flag; a server-side zip; a change to a public URL shape. Everything else — helper names, file
layout, library choices within the named options, test fixtures — is implementation-owned.

## Why

The owner reviewed the app and sent 17 notes (ticket). Several are already live; the rest fall
into three real problems. **Safety:** since 2026-09-20 any signed-in employee can trash, purge, or
delete any photo, project, or album, and the owner wants ordinary users limited to their own
recent uploads. **Findability:** photos carry capture time, uploader, file type, and tags, but the
app can only group by date or tag, sort one way, and search one phrase, so "project 3962, by Yana,
in September" is not askable. **Feel:** the viewer keeps chrome on screen, albums cannot be put
in presentation order, and there is no slideshow or bulk download. Do nothing and the first real
upload of professional sets lands in an app where anyone can empty the trash and nobody can find
anything by anything but date. Rejected framing: "build the office-database bridge first" — it
needs discovery nobody has done, and rename-by-hand already covers the gap.

## Words employees see

The photo-albums plan's three words hold: **Album**, **Project**, **Tag**. This plan adds none.
"Photo admin" appears only on the Users page. In code `job` still means project.

## Goals

- (G1) An employee who is not a photo admin can trash only photos they uploaded within the last
  30 days, and cannot delete forever, empty the trash, or delete a project.
- (G2) Every photo has an automatic name `<project number> – <YYMMDD> <HHMMSS>` and downloads
  under it.
- (G3) Every photo grid can group by Date, Tag, Uploader, or File type; sort newest or oldest;
  and filter by project, uploader, several tags, file type, and date range, with the state in
  the URL. Search words combine with AND.
- (G4) "Select all" selects every matching photo; a selection can be tagged, moved, trashed,
  added to an album, or downloaded as one zip.
- (G5) An album can be arranged by hand, and the order is what everyone sees and what the
  slideshow plays.
- (G6) The viewer shows photos edge to edge, hides every control on a tap, and can play a
  slideshow.
- (G7) Inside a project, the tag picker suggests that project's tags plus the three starters.
- (G8) At launch the library holds the 22 office projects and nothing else, with three photo
  admins set.

## Non-goals

Chosen against, not omitted: a required project (owner ruling via Ari); a tag table or tag
management screens; roles or permissions per album or project; the office-database bridge;
visual (pixel) duplicate matching; capture-date editing; a private bucket; export as PowerPoint
(noted as a later idea); saved searches; server-side zip building.

## System sketch

```
Browser (phone + desktop)
  grid toolbar: Filter · Group by · Sort ──► GET /api/photos?…&sort=&type=&from=&to=&tags=a,b&q=
  Select all ────────────────────────────► GET /api/photos/ids?…same filters   (ids only, ≤5000)
  bulk actions (chunks of 500) ──────────► /api/photos/tags · /api/photo-albums/[id]/photos
                                           /api/photo-actions/batches (move, trash → confirm page)
  Download ──► fetch originals from the public bucket ──► one .zip written by the browser
  viewer: YARL + Zoom · Video · Counter · Slideshow (+ Inline · Thumbnails · Fullscreen on desktop)
  album Arrange mode (dnd-kit) ──────────► PATCH /api/photo-albums/[id]/order

Routes: requirePhotoActor ──► security-definer SQL (service role only)
  photo_can_trash(actor, photo)      admin, or own upload ≤ 30 days
  photo_actor_is_admin(actor)        user_profiles.photo_admin
  trigger photo_auto_name            display_name from job_number + captured_at (Pacific)
  album_photos.position              hand order; albums.sort_mode 'date' | 'custom'
```

## Premise anchors

Re-run at each phase entry.

| # | Premise | Probe |
|---|---|---|
| P1 | `main` is still `53dd82f` or a descendant with no photo-permission change | `git log --oneline 53dd82f..origin/main -- dws-app/supabase/migrations dws-app/src/lib/photos/server` → empty or reviewed |
| P2 | Production is tiny, so the wipe is a hand operation | `select count(*) from public.photos` ≤ a few hundred (41 on 2026-10-12) |
| P3 | Content identity is library-wide | index `photos_content_sha256` exists (observed 2026-10-12) |
| P4 | Auto-purge is off, so the wipe must empty the trash by hand | `select repair_enabled from public.photo_release_state` → false (observed 2026-10-12) |
| P5 | Photo writes are reached only through `requirePhotoActor` + service-role SQL | `rg -n "requirePhotoActor" dws-app/src/app/api` covers every mutating photo route |

## Decisions

Posture key: *first-release* = reversible on first-release evidence; *later* = reversible on
later experience; *structural* = no planned reversal.

1. **Photo admin is a flag, not a role.** `user_profiles.photo_admin boolean not null default
   false`, separate from the Receipts `role` column the two apps share (receipt admins are
   different people). Set on the Users page by a receipts admin, and by the operator in SQL at
   launch. *Later*: fold into a real role table only if a third app or a fourth role appears.
2. **One delete rule in SQL.** `photo_can_trash(actor, photo)` is true for a photo admin, or for
   the uploader within 30 days of `photos.created_at` (upload time, not capture time). Trash
   batches (ordinary and MCP) refuse a photo that fails it; `photo_delete_job` and every
   `photo_purge_*` entry point require a photo admin; `photo_delete_album` requires a photo
   admin or the album's creator. Restore, tag, rename, move, album membership, and creating or
   renaming projects and albums stay open to every active employee. *First-release*: widen or
   narrow by editing one function.
3. **"No project" stays.** photo-albums Decision 1 holds; the owner agreed through Ari that
   "no project" is itself a kind of project. *Structural* (not revisited here).
4. **Automatic names are a trigger, not a change to the upload function.** `display_name` is
   filled on insert and on project change by a `before` trigger when `name_source='auto'`;
   a hand rename sets `manual`; a blank rename returns to `auto`. Format `<job_number> –
   <YYMMDD> <HHMMSS>` (en dash U+2013, times in `America/Los_Angeles`), `<YYMMDD> <HHMMSS>`
   without a project, ` (2)`, ` (3)` … for same-project same-second collisions. `original_name`
   and storage paths never change. *Later*: the format string lives in one SQL function.
5. **Tags stay a text list; suggestions are scoped.** Inside a project the picker calls the
   existing `/api/photo-tags?job=` and always appends the three starters. The Photos-wide filter
   still lists all tags. *First-release*.
6. **Select all means all.** `GET /api/photos/ids` returns every id matching the current
   filters (cap 5,000, reported as `truncated`). The selection holds up to 5,000 ids; tag and
   album routes keep their 500-id limit and the client chunks; only the action batch the
   confirm page receives (move, trash) accepts the whole selection, so its request-body limit
   rises with it. The group-header tick uses the same endpoint with the group's predicate.
   *First-release*: lower the cap if a request ever times out.
7. **Filters and sort are URL state; search words AND.** `?project=&uploader=&tags=&type=&from=
   &to=&sort=&group=` on every grid; `q` is split on whitespace and every word must match
   project number/name, uploader name, a tag, or the photo's name (display or original).
   *First-release*.
8. **File type is a label computed from MIME/extension**: JPEG, HEIC, PNG, RAW (dng, cr2, cr3,
   nef, arw, tif/tiff), Video, Other. One helper serves grouping, filtering, and the tile badge.
   *Later*: add labels as formats appear.
9. **Album order is a nullable `position` plus `albums.sort_mode`.** Arrange mode saves the
   full order of the album (cap 2,000 photos per album for arranging); new photos append.
   The slideshow and share page follow the album's current mode. *Later*: per-user order was
   rejected — the owner wants one order everyone sees.
10. **Zip is built in the browser** from the public originals (no server time limits, no new
    infrastructure), with the automatic names, a size estimate first, and a warning above 2 GB.
    *Later*: a server-side zip only if browser zips prove unreliable.
11. **Format twins are a warning, never a silent drop.** After EXIF is read and before the
    content claim, an upload into a project is checked for an active photo in that project
    with the same base name (case-insensitive, extension stripped) and capture time within
    1 s and a different hash. Such files are skipped by default with a per-file **Keep**; the
    folder import has one "Keep other formats" switch per batch. *First-release*.
12. **Each unit that changes layout gets one rendered phone + desktop review** (W1-C's
    toolbar, W2-A, W2-B, W2-E; photo-albums Decision 14 continues) by a worker of a different
    model family, before the PR is called ready. There is no separate end-of-wave review: Ari's
    click-through on the review stack is the final look. *First-release*.
    *Amended 2026-10-12 (owner):* for Wave 2 the rendered reviews run once, on the combined
    branch, not per unit.

## Alternatives

- **Admin-only rename and move** (stricter employee rights). Rejected: it blocks daily
  organizing, which is not what the owner asked to stop.
- **A required project** (what the owner first wrote). Rejected by the owner himself through
  Ari: "no project" is a kind of project.
- **Per-user album order.** Rejected: the owner wants one order everyone sees, for
  presentations.
- **Server-side zip.** Rejected for now: Vercel function time and memory limits on large sets;
  stays the fallback if browser zips prove unreliable.
- **Managed per-project tag lists.** Rejected: photo-albums Decision 5 defers a tag table until
  renaming or merging is a real request; scoped suggestions solve "the list keeps growing".

## Contract surface

### Database (additive; each migration applied before its unit's deploy)

```sql
-- W1-A
alter table public.user_profiles add column photo_admin boolean not null default false;
create function public.photo_actor_is_admin(p_actor uuid) returns boolean ...;
create function public.photo_can_trash(p_actor uuid, p_photo public.photos) returns boolean ...;
-- re-created from their latest definitions, changing only the named lines:
--   photo_materialize_action / photo_approve_action / photo_apply_action: for action='trash',
--     raise 'forbidden' when photo_can_trash is false (origin ordinary and mcp alike)
--   photo_delete_job, photo_purge_request: raise 'forbidden' unless photo_actor_is_admin
--   photo_delete_album: raise 'forbidden' unless admin or created_by = p_actor
-- W1-B
alter table public.photos add column name_source text not null default 'auto'
  check (name_source in ('auto','manual'));
create function public.photo_auto_name(p_job uuid, p_captured timestamptz, p_self uuid) returns text;
create trigger photo_auto_name before insert or update of job_id, captured_at on public.photos ...;
-- photo_rename_photo: non-blank → display_name, name_source='manual'; blank → 'auto' + recompute
-- W2-E
alter table public.album_photos add column position double precision;
alter table public.albums add column sort_mode text not null default 'date'
  check (sort_mode in ('date','custom'));
create function public.photo_album_reorder(p_actor uuid, p_album uuid, p_photo_ids uuid[]) ...;
```

Error classes stay the existing ones (`forbidden`, `invalid_input`, `not_found`); the routes map
`forbidden` to 403 as today.

### API

| Route | Change |
|---|---|
| `GET /api/photos` | adds `sort=asc\|desc` (default `desc`), `type=<label>`, `from`, `to` (ISO instants, inclusive on `captured_at`), several `tags` ANDed (already), `q` word-AND; `album=…&sort=custom` orders by `position` |
| `GET /api/photos/ids` | **new**; same filters; `{ids, total, truncated}`; ≤5,000 |
| `GET /api/photos/actor` | **new**; `{photo_admin: boolean}` for the signed-in employee |
| `GET /api/photos/[id]/ownership` | `can_trash` becomes the real rule |
| `GET /api/photos/twin?job=&base=&captured_at=` | **new**; `{photo: {...} \| null}` |
| `POST /api/photo-actions/batches` | selector limit 500 → 5,000 ids, with the matching request-body limit; tag and album routes keep 500 (the client chunks) |
| `PATCH /api/photo-albums/[id]/order` | **new**; `{photo_ids}` full order, or `{sort_mode:'date'}` |
| `PATCH /api/admin/users/[id]` | accepts `photo_admin` |

Rows from `GET /api/photos` already carry `uploader_id` and `created_at`, so the client can show
or hide Trash before asking the server; the server stays authoritative.

### Screens (what the worker builds; mechanism is theirs)

**Posture for every unit:** phone and desktop parity is a requirement, not a nicety. Phone is
iPhone Safari; desktop is Windows Chrome. Touch targets stay ≥44 px, everything already in the
design system (`#222222` page, `#2e2e2e` panels, `#2680FC` accent, `rounded-full` chips,
`SheetShell` pop-ups) is reused, and the reference feel is Google Photos / Apple Photos. A worker
who finds the spec below produces something clumsy on one of the two widths changes the
mechanism and says so in the hand-back; the goal is an app non-technical people find obvious.

- **Grid toolbar** (every grid: Photos, project, album, search). One row: `Filter` (badge with
  the active count) · `Group by` (Date · Tag · Uploader · File type; search also Project) ·
  `Sort` (Newest · Oldest; an album adds Custom). Phone: `Filter` opens a `SheetShell` with
  sections Project (not on a project page), Uploader, Tags (multi), File type, Date (This week ·
  This month · This year · Custom range). Desktop: the same sections as inline chips with
  dropdowns and a date popover. Active filters render as removable chips under the toolbar with
  `Clear`. The empty state reads "No photos match" with a `Clear filters` button.
- **Select all.** When some but not all matching photos are selected, the selection bar shows
  "N selected · Select all M". The group-header tick selects the whole group. The 5,000 cap shows
  as "Select all 5,000 (of M)".
- **Download.** A `Download` action in the selection bar: a confirm with count and total size,
  "Large downloads work best on a computer" on phones, a warning above 2 GB, progress, one zip.
- **Trash gating.** `Move to trash` (viewer), the selection-bar `Trash`, `Delete forever`,
  `Empty trash`, and project `Delete` appear only when allowed; a mixed selection shows "Trash
  the 3 you can delete" rather than a dead button.
- **Viewer.** Photos edge to edge (no padding). Tap or click the photo toggles every control:
  toolbar, counter, arrows, thumbnails, and the desktop Details panel. Desktop Details is an "i"
  button, hidden by default. `Fullscreen` where the browser supports it. `Play` (slideshow) in
  the viewer toolbar and in project, album, and search page headers; 4 s, loops, photos only,
  starts in the hidden-controls state.
- **Album Arrange.** An `Arrange` button on the album page enters a drag mode (long-press on
  phone, pointer on desktop) with `Done` / `Cancel`. The sort control shows Custom once an
  order exists.
- **Users page.** A "Photo admin" checkbox beside the role select.
- **Upload tray.** A "Looks like another format of <name>" row with `Keep`; import review shows
  a "Keep other formats" switch.

### Acceptance criteria

Permissions
- **AC-1** A photo admin sees and can use Trash, Delete forever, Empty trash, and project Delete everywhere; a non-admin never sees Delete forever, Empty trash, or project Delete, and the routes answer 403 if called. _Example:_ Yana (admin) empties the trash → 200; Luis (employee) `POST /api/photos/trash/purge {everything:true}` → 403.
- **AC-2** A non-admin can trash a photo they uploaded 29 days ago and cannot trash one they uploaded 31 days ago or one a colleague uploaded; the UI hides or explains it, the SQL raises `forbidden`, and the MCP `remove_photos` hand-off refuses the same photos. _Example:_ selection of 10 photos, 3 own-recent → bar reads "Trash the 3 you can delete".
- **AC-3** Anyone can restore a trashed photo, delete an album they created, and keep tagging, renaming, moving, and creating projects and albums as today.
- **AC-4** A receipts admin can tick "Photo admin" on the Users page and the change is live on the next request; `GET /api/photos/actor` reports it.

Naming
- **AC-5** A photo uploaded to project 3962 with capture time 2026-09-23 16:04:32 Pacific is named `3962 – 260923 160432`; the same second in the same project yields `3962 – 260923 160432 (2)`; with no project the name is `260923 160432`. The original filename still shows under "About this file".
- **AC-6** Moving an auto-named photo to project 4100 renames it `4100 – …`; a hand-renamed photo keeps its name on move; renaming to blank returns it to the automatic name. In-app and share-link downloads use the display name plus the original extension.

Browsing
- **AC-7** Group by Uploader and File type exist on every grid with the same header tick and counts as the other modes; File type labels are JPEG, HEIC, PNG, RAW, Video, Other.
- **AC-8** Sort Newest/Oldest flips the server order and paging; the second page of Oldest continues forward, never repeating or skipping.
- **AC-9** Inside project 3962 the tag picker offers only 3962's tags plus `professional`, `field dimension`, `shop drawing`; on the Photos page it offers all tags. A tag typed in 3962 appears in 3962's list and nowhere else.
- **AC-10** Filters Project, Uploader, Tags (several, AND), File type, and Date range combine with AND, live in the URL, survive reload, and reset with `Clear`; the empty state offers `Clear filters`.
- **AC-11** Search `3962 professional` returns only photos in project 3962 tagged professional; `yana sept` matches nothing unless a photo's name contains `sept` (words match fields, not dates); the Projects and Albums sections still match by name.
- **AC-12** The toolbar, filter sheet, chips, and empty state pass the rendered review on a 390×844 phone and a 1440×1000 desktop with no clipped controls, no sub-44 px targets, and no horizontal scroll.

Select all and bulk
- **AC-13** On a project with 1,200 photos, "Select all 1,200" selects every photo, Tag applies to all 1,200 (three chunked requests), and Trash goes through the confirm page with exactly 1,200. The group tick for a date selects that whole day, loaded or not.
- **AC-14** `GET /api/photos/ids` with 6,000 matches returns 5,000 ids and `truncated:true`; the bar says "Select all 5,000 (of 6,000)".
- **AC-15** Downloading 40 selected photos produces one zip whose entries are named per AC-5/6 with extensions, no duplicates, and whose byte total matches the sum of `original_bytes`; above 2 GB the confirm warns first; on a phone the confirm says large downloads work best on a computer.

Albums
- **AC-16** Arrange mode saves an order that every signed-in employee sees, the share page follows it, a newly added photo lands last, and switching the album to `Newest` then back to `Custom` restores the saved order.
- **AC-17** Arranging works by touch on the phone layout and by pointer on desktop (rendered review).

Viewer
- **AC-18** Opening a photo shows it edge to edge; one tap hides the toolbar, counter, arrows, thumbnails, and Details; a second tap brings them back; swipe, pinch, arrow keys, and Escape still work in both states.
- **AC-19** Desktop Details starts hidden and toggles with the "i" button; the choice persists for the session. Fullscreen appears on desktop Chrome and not on iPhone Safari.
- **AC-20** `Play` on a project, album, or search page starts a slideshow of that page's current set in its current order (an album's custom order included), 4 s per photo, looping, skipping videos and files, with controls hidden; any tap pauses it.

Format twins
- **AC-21** Uploading `IMG_1234.CR2` into a project that holds `IMG_1234.JPG` with the same capture second shows "Looks like another format of IMG_1234.JPG" and uploads nothing until `Keep` is pressed; `Keep` uploads it as a second photo. Album-only uploads and files with a different capture second are not flagged. In `/migrate`, the batch switch "Keep other formats" uploads them without asking.

Launch
- **AC-22** After launch ops, production holds the 22 office projects, zero photos, zero albums, zero live share links, an empty bucket (no `originals/` or `derived/` objects), and `photo_admin=true` for exactly Yoel Asulin, Yana Ronin, and Ari Asulin.

## Execution shape

**Orchestration.** This session is the orchestrator and the plan file's only writer. Every
implementation unit runs as its own `/peprkit:delegate implementation-agent --target claude
--tier high --permissions read-write --worktree own:<unit>` worker (Opus 5.5, high effort), briefed
by pointer: this plan, the phase, the ACs it owns, and the posture paragraph in § Screens. A
worker's session is sized to stay well under 500k tokens of context: units marked *split* below
run as two sequential workers in the same worktree, each with its own hand-back. The
orchestrator integrates each worker's commits, runs the suites, ships one PR per unit with
`/peprkit:ship --pr`, requests one bot-review round with `/peprkit:request-review`, triages it
with `/peprkit:triage-pr`, then starts a local review stack (`npm run review:stack`) for Ari to
click through, and **merges only on Ari's approval**. Rendered reviews (Decision 12) run a
`design-engineer` worker of the opposite model family with `--app-url` against that same stack,
once on `iPhone 15` and once on desktop. Ari is told in one or two plain sentences per PR and is
asked before every production step.

**As run (owner steering, 2026-10-12).** Wave 1 shipped as one squashed PR (#26) rather than
three. Wave 2 is one PR from one combined branch: the unit worktrees were a speed tool only,
with no PR, bot review, review stack, or rendered review per unit. Each worker ran `--permissions
yolo`, ran the unit, db, and routes suites, and wrote its browser specs without running them;
the orchestrator merged every unit branch into `wave2`, ran the full browser suite once there,
and then shipped, requested one bot-review round (claude and codex), triaged it, and started one
review stack for Ari. The production wipe (§ Launch ops step 3) moved to after the Wave 2 PR
merges, so the production photos stayed useful for testing in between.

**Waves.** Wave 1 holds what must be true before real photos arrive, in three parallel
worktrees. Wave 2 starts after Wave 1 merges (its toolbar and sort parameter are the base),
with four parallel worktrees and one that follows.

| Wave | Unit | Worktree | Depends on | Split |
|---|---|---|---|---|
| 1 | W1-A photo admins + delete rule | `w1a-delete-rule` | — | no |
| 1 | W1-B automatic names | `w1b-auto-names` | — | no |
| 1 | W1-C group by, sort, scoped tags | `w1c-browse-basics` | — | no |
| 1 | Launch ops | orchestrator, by hand | W1-A, W1-B deployed | — |
| 2 | W2-A filters, URL state, search AND, select all | `w2a-filters` | W1-C | **yes**: A1 server + ids, A2 toolbar + select all |
| 2 | W2-B viewer: edge to edge, hide chrome, slideshow | `w2b-viewer` | — | no |
| 2 | W2-C format-twin warning | `w2c-format-twins` | — | no |
| 2 | W2-D zip download | `w2d-zip` | — (merges after W2-A for "select all → download") | no |
| 2 | W2-E album arrange | `w2e-album-order` | W2-A merged (shares the photos route) | no |
| 2 | Final: Ari click-through, docs, retro | orchestrator | all | — |

**Branching.** This plan merges to `main` first as a docs PR so every unit's worktree starts
from `main` with the plan in it. Unit branches are `<unit>` names above; one phase-sized commit
per unit plus review-fix commits.

**Shared files.** Parallel units own disjoint files; where two need the same file, the owner
lands first and the other rebases onto it:

| File or area | Owner | Others |
|---|---|---|
| `photo-browser.tsx`, `filter-bar.tsx`, new toolbar/filter components, `GET /api/photos`, `/api/photos/ids` | W2-A | W2-E adds `sort=custom` after W2-A merges |
| `selection-bar.tsx` | W2-A (select all) | W2-D adds one `Download` action after W2-A merges; its zip logic lives in a new module |
| `photo-lightbox.tsx`, `shared-gallery.tsx`, page headers (`[jobId]`, `albums/[albumId]`, `search` pages: the `Play` button) | W2-B | W2-A confines its search-page edits to the `q` plumbing into the grid |
| `upload.ts`, `upload-tray.tsx`, `/migrate` review | W2-C | — |
| SQL action functions, `authority.ts`, `ownership` route, Users page | W1-A | W1-B's trigger and W1-C touch none of these |
| `group.ts`, `group-by-toggle.tsx`, `tag-dropdown.tsx`, `keysetCursor.ts` | W1-C | — |

**Common entry recipe** (each worker runs it): `git log --oneline main~5..main`; open every file
the phase names; `rg -n "<symbols the phase names>" dws-app/src dws-app/supabase` to find every
caller before changing a signature; `npm --prefix dws-app test` green before the first commit.

**Common exit recipe:** unit tests, `npm run test:db`, `npm run test:routes`, and
`npm run test:browser` green (the integration suites need Docker); `tsc --noEmit` clean; every
re-created SQL function differs from its latest prior definition only by the named lines
(mechanical diff pasted into the hand-back); a short hand-back naming changed surfaces, judgment
calls, and anything the plan did not cover.

## Phase W1-A — Photo admins and the delete rule

Establishes who may delete, before anything real is uploaded. Defers nothing.

### Steps
1. Migration `..._photo_admin_and_trash_rule.sql`: the W1-A block in § Database. Re-create the
   three action functions from `20260920234821_photo_open_trash_authority.sql`, adding the
   `photo_can_trash` check where the removed uploader-or-admin check stood (`:31`, `:48-50`,
   `:76` of `20260907100400_photo_actions.sql` show the spots); `photo_delete_job` and
   `photo_purge_request` from `20260923180000_photo_manage_followups.sql`; `photo_delete_album`
   from `20260921024651_photo_albums.sql`. Restate grants by name.
2. Routes: `GET /api/photos/actor`; real `can_trash` in `src/app/api/photos/[id]/ownership/route.ts`;
   `photo_admin` on `PATCH /api/admin/users/[id]` and `POST /api/admin/users`; `requirePhotoActor`
   gains `isPhotoAdmin` on the actor object (one extra column in its profile select).
3. Client: a `usePhotoActor()` hook; hide/explain per § Screens "Trash gating" in
   `selection-bar.tsx`, `photo-info.tsx`, `trash/page.tsx`, `collection-select-bar.tsx`
   (project Delete), and the album header; "Photo admin" checkbox in `user-form-modal.tsx`.
4. MCP: `remove_photos` batches now fail materialization for non-deletable photos; the confirm
   page already shows per-photo failures — confirm the message is plain ("You can only delete
   photos you uploaded in the last 30 days").
5. Docs: `Docs/photos-runbook.md` § trash and § hand-made projects state the new rule;
   `Docs/Admin-Features.md` gains the checkbox.

### Verify
- [ ] [AC-1] `test:db` + `test:routes`: admin purge 200; employee purge 403; employee project delete 403; employee `photo_delete_album` on own album 200, on another's 403.
- [ ] [AC-2] `test:db`: employee trashes own 29-day-old photo (fixture `created_at = now()-29d`) → ok; own 31-day-old → `forbidden`; colleague's → `forbidden`; MCP-origin batch with the same photos → `forbidden`. `test:browser`: mixed selection reads "Trash the N you can delete".
- [ ] [AC-3] `test:db`: employee restores a colleague's photo, tags, renames, moves, creates a project and an album → all ok.
- [ ] [AC-4] `test:routes`: receipts admin `PATCH /api/admin/users/[id] {photo_admin:true}` → `GET /api/photos/actor` reports true for that user; employee calling the admin route → 403.
- [ ] `integration/db/authority.test.ts` updated: the only `role='admin'` checks are still the deployment tools; the new checks use `photo_admin`.
- [ ] Mechanical diff of every re-created function; suites green; `tsc` clean.

### Exit criteria
A non-admin cannot delete forever, empty the trash, delete a project, or trash a photo that is not their own recent upload, in SQL, in routes, and on screen; a photo admin can do all of it.

## Phase W1-B — Automatic names

Establishes the naming rule so every real upload is named from day one. Independent of W1-A.

### Steps
1. Migration `..._photo_auto_names.sql`: the W1-B block. `photo_auto_name` formats in
   `America/Los_Angeles`; collision suffix counts active photos in the same job (or all
   project-less photos) whose `display_name` equals the base or `base (n)`. Backfill
   `display_name` for existing rows where `name_source='auto'` (the wipe removes them anyway;
   the backfill keeps local fixtures honest). `photo_rename_photo` sets `name_source`.
2. Server: `src/lib/photos/server/sharing.ts` download name uses `downloadName(photo)` (display
   name + original extension) — `photo_share_read` must select `display_name`.
3. Client: nothing new to show; `photo-info.tsx` already shows the name and the original
   filename. The Rename sheet's helper text says a blank name returns to the automatic one.
4. Docs: `Docs/photos-runbook.md` § Hand-made projects — replace the `display_name` paragraph
   (download filename, blank → uploaded name) with the full naming rule.

### Verify
- [ ] [AC-5] `test:db`: finalize into job 3962 with `captured_at='2026-09-23T23:04:32Z'` → `3962 – 260923 160432`; second finalize same second → `… (2)`; no project → `260923 160432`; a date in PST (January) formats with the -08 offset.
- [ ] [AC-6] `test:db`: move via `photo_apply_action` renames an auto photo and leaves a manual one; `photo_rename_photo` blank → auto name recomputed. `test:routes`: share download URL carries the display name + extension; in-app `downloadName` unit test extended in `format.test.ts`.
- [ ] `exif.test.ts` unchanged (capture time rules are not touched); suites green.

### Exit criteria
Every new photo is named by the rule, renames and moves behave per AC-6, and both download paths use the name.

## Phase W1-C — Group by, sort, scoped tags

Establishes the browsing basics the Wave 2 toolbar builds on. Independent of W1-A/B.

### Steps
1. `src/lib/photos/file-type.ts`: `fileTypeLabel(photo)` per Decision 8, with tests; the tile
   badge for non-image kinds uses it.
2. `src/lib/photos/group.ts`: `GroupBy` adds `uploader` and `type`; `group-by-toggle.tsx`
   labels Uploader · File type; `photo-browser.tsx` `DEFAULT_MODES` includes them; the Uploader
   group label is the uploader's `full_name` or "Unknown"; order A–Z like Tag.
3. `GET /api/photos?sort=asc|desc`: both `.order` calls and `keysetOrFilter` take a direction
   (`src/lib/keysetCursor.ts` gains `direction`); the cursor encodes the same tuple. A `Sort`
   chip (Newest · Oldest) in the toolbar row beside Group by, state in `useState` for now (W2-A
   moves it to the URL).
4. Scoped tags: `TagDropdown` accepts `jobId`; the existing `useTagChoices` gains a `jobId`
   argument it forwards to `usePhotoTags` as `?job=` (`tagChoices` already appends the
   starters); `upload-sheet.tsx` passes the chosen project, `edit-photo-sheet.tsx` the photo's
   project, the selection-bar Tag sheet the shared project when every selected photo has the
   same one (else global).

### Verify
- [ ] [AC-7] `group.test.ts`: uploader and type groups, "Unknown", A–Z, header counts; `test:browser`: Group by Uploader on the Photos page shows one section per uploader with a working header tick.
- [ ] [AC-8] `integration/routes/albums.test.ts`: `sort=asc` first and second page are strictly increasing on `(captured_at, id)` with no overlap against the `desc` pages' reverse.
- [ ] [AC-9] `tags.test.ts` or a `tag-dropdown` test: the job-scoped fetch is used when a project is known; `test:browser`: tag picker in project A does not list a tag only used in project B, and does on `/photos`.
- [ ] Rendered review (Decision 12) on `iPhone 15` and desktop: the toolbar row with Filters, Group by, and Sort stays one tidy row with ≥44 px targets.
- [x] Suites green; `tsc` clean.

### Exit criteria
Every grid groups by four modes, sorts both ways across pages, and the tag picker is scoped per project.

## Launch ops (after W1-A and W1-B deploy; step 3 after the Wave 2 PR merges)

Orchestrator by hand, each step confirmed with Ari first. Steps 1 and 2 ran on 2026-10-12 with
Wave 1; the owner moved step 3 (the wipe) to after the Wave 2 PR merges. Production facts on 2026-10-12: 22
office jobs, 0 hand-made, 41 active photos, 4 trashed, 1 album, 0 live links, gates
`writes=true, repair=false, sharing=false, mcp=true`.

1. Migrations W1-A and W1-B applied with `supabase db push` (or `db query` of each file)
   **before** the matching deploys; the app that is live keeps working because every change is
   additive.
2. Admins: `update public.user_profiles set photo_admin=true where user_id in (select id from
   auth.users where phone in ('15103850837','14157340483','14157162154'))` → 3 rows.
3. Wipe, as a photo admin in SQL then in the app: trash every active photo
   (`photo_apply_action` is batch-bound, so set `deleted_at/deleted_by/purge_after` directly
   for all rows, then `photo_purge_request(admin, everything)`), delete and purge the album and
   any hand-made project (none today), revoke links, then press **Empty trash** / **Finish
   deleting** in the app until `remaining=0` (the purge route deletes the Storage objects; P4
   means no cron will). List the bucket to confirm no `originals/` or `derived/` objects remain.
4. Record the run (date, counts before and after) in `Docs/photos-runbook.md` § launch drills.

### Verify
- [ ] [AC-22] counts query → jobs 22 (all `synced_at not null`), photos 0, albums 0 or purged, links 0; Storage listing empty; three `photo_admin` rows.

## Phase W2-A — Filters, URL state, search AND, select all

The central Wave 2 unit; it owns `photo-browser.tsx` and `GET /api/photos`. Starts after Wave 1
merges. **Split:** A1 (server) then A2 (client) as two workers in the same worktree.

### Steps (A1, server)
1. `GET /api/photos`: `type`, `from`, `to`, `q` word-AND per Decision 7 (each word → one
   PostgREST `or(...)` group; groups ANDed; name matched with `ilike` on `display_name` and
   `original_name`); `sort` from W1-C. The `type` predicate reuses `file-type.ts`'s
   MIME/extension lists as SQL `or` filters on `mime_type` / `original_name`.
2. `GET /api/photos/ids`: same parsing (shared helper), `select id`, keyset-walked server-side
   in pages of 1,000 up to 5,000, `{ids, total, truncated}`; `total` from `count: 'exact'` on
   the first page query.
3. Limits: split today's one constant (`MAX_BULK_PHOTOS` in `apiShared.ts`, which drives
   `validateSelector`, `bulkPhotoIds`, the purge route, and `MAX_SELECTION`) into a 500
   per-request cap and a 5,000 selection cap; the action-batch selector and its request-body
   limit (`BULK_BODY_BYTES` in `server/reads.ts`, sized for 500 ids) take the 5,000 cap; no SQL
   cap changes.

### Steps (A2, client)
4. URL state: a `useBrowseState()` hook reading and writing `project, uploader, tags, type,
   from, to, sort, group` with `history.replaceState` (the pattern in `use-photo-deep-link.ts`);
   query keys include all of them.
5. Toolbar per § Screens: `browse-toolbar.tsx` (row), `filter-sheet.tsx` (phone `SheetShell`
   with sections), inline chips on desktop (extend `filter-bar.tsx`), active-filter chips with
   ×, `Clear`, date presets, empty state with `Clear filters`.
6. Select all: selection holds up to 5,000 ids; "Select all M" in `selection-bar.tsx` calls
   `/ids`; `toggleGroupSelection` for a group calls `/ids` with the group predicate (date →
   `from/to` of that local day; tag → `tags`; project → `project`; uploader; type); bulk calls
   chunk at 500 with one progress toast; the confirm page receives one batch of all ids.
7. Search page: `q` feeds the same grid; Projects and Albums sections unchanged.

### Verify
- [x] [AC-10] `test:routes`: `type=raw&from=…&to=…&tags=a,b&uploader=…` ANDs; `test:browser` (phone + desktop): set three filters, reload, filters persist; `Clear` empties the URL; empty state shows `Clear filters`.
- [x] [AC-11] `test:routes`: `q=3962 professional` matches only the intersection; `q=yana sept` returns nothing in a fixture with no `sept` in names.
- [ ] [AC-13] `test:routes`: `/ids` on 1,200 fixtures returns 1,200; `test:browser`: "Select all 1,200" then Tag → every photo tagged (three requests observed); Trash → confirm page lists 1,200.
- [x] [AC-14] `test:routes`: 6,000 fixtures → 5,000 ids, `truncated:true`.
- [ ] [AC-12] Rendered review (Decision 12) on `iPhone 15` and desktop: no clipped controls, ≥44 px targets, no horizontal scroll, Filter sheet sections readable; dispositions recorded in `reviews/`.
- [x] Suites green; `tsc` clean; A1 and A2 each hand back separately.

### Exit criteria
Every grid has the toolbar, filters and sort live in the URL, search words AND, and select-all selects every match up to 5,000.

## Phase W2-B — Viewer: edge to edge, hide chrome, slideshow

Independent of W2-A; may run in parallel.

### Steps
1. `photo-lightbox.tsx`: `carousel.padding: 0`; `chromeHidden` state toggled by `on.click` on
   the slide (not on controls); `className="yarl__immersive"` when hidden and CSS in
   `globals.css` hiding `.yarl__toolbar`, `.yarl__navigation_prev/next`, `.yarl__counter`,
   `.yarl__thumbnails_container`; the desktop `<aside>` hides too. Desktop Details becomes an
   "i" toggle, default hidden, remembered in `sessionStorage`.
2. Plugins: add `Slideshow` (phone and desktop) with `{autoplay:false, delay:4000}`; add
   `Fullscreen` on desktop (the plugin hides its button where unsupported).
3. `Play`: a toolbar button in the viewer; a header button on project, album, and search pages
   that opens the viewer at the first openable photo with `slideshow.autoplay` and
   `chromeHidden`; the slide list for a slideshow excludes videos and unplayable slides; any
   tap pauses (`slideshow.ref.pause()`) and shows controls.
4. Share page `shared-gallery.tsx`: edge to edge and tap-to-hide its own top bar for parity.

### Verify
- [ ] [AC-18] `test:browser` (phone + desktop): open a photo → image touches both edges on at least one axis (bounding box check); tap → toolbar/counter/aside not visible; tap → visible; ArrowRight and Escape work in both states.
- [ ] [AC-19] `test:browser` desktop: aside absent on open, present after "i", persists across photos; Fullscreen button present on desktop Chromium (Playwright), absent under an iPhone device emulation.
- [ ] [AC-20] `test:browser`: `Play` on an album with one video and three photos cycles the three photos (counter advances at ~4 s, video never shown), controls hidden until a tap.
- [ ] Rendered review on `iPhone 15` and desktop: edge-to-edge, hide/show feel, "i" placement.
- [x] Suites green; `tsc` clean.

### Exit criteria
Photos fill the screen, every control hides on a tap, Details is opt-in on desktop, and Play runs a slideshow from pages and the viewer.

## Phase W2-C — Format-twin warning

Independent; small.

### Steps
1. `GET /api/photos/twin?job=&base=&captured_at=`: active photo in that job whose base name
   (case-insensitive, extension stripped, via one SQL expression on `original_name`) matches and
   `abs(captured_at - $captured_at) <= 1s` and `content_sha256 <> $sha` → `{photo}` or null.
2. `src/lib/photos/upload.ts`: after capture time is known and before the claim, call it when
   the upload names a project; on a hit, status `format_twin` with `twin` on the item; the
   queue parks it (not uploaded) unless `keep=true`.
3. `upload-tray.tsx`: "Looks like another format of <name>" row with `Keep`; `upload-manager`
   resumes that item with `keep`. `/migrate`: a batch-level "Keep other formats" switch
   (default off); off → the row reads "Left out: looks like another format of …".

### Verify
- [ ] [AC-21] `upload.test.ts`: twin hit parks the item; `keep` proceeds; album-only upload never calls `/twin`; a 2-second difference is not a twin. `test:routes`: `/twin` matches `IMG_1234.CR2` against `IMG_1234.JPG` in the same job and not across jobs. `test:browser`: tray shows the row and `Keep` uploads; `/migrate` switch on uploads both.
- [x] Suites green.

### Exit criteria
A second-format copy is flagged and held, never silently dropped, and the uploader decides.

## Phase W2-D — Zip download

Independent of the toolbar; merges after W2-A so "Select all → Download" is tested together.

### Steps
1. Add `client-zip` (streaming, store-only; originals are already compressed).
2. `Download` in `selection-bar.tsx`: confirm sheet with count, total from `original_bytes`,
   the phone note, the >2 GB warning; then fetch each original's public URL in a small
   concurrency pool, entry names via `downloadName` with ` (2)` de-duplication, write through
   `showSaveFilePicker` where available, else a blob; progress toast; failures listed by name,
   never a half-reported success.
3. Single-photo "Download original" is unchanged.

### Verify
- [ ] [AC-15] `test:browser` desktop: select 40 fixtures → one `.zip` download with 40 uniquely named entries and the expected total size (Playwright `download.path()` + a zip listing); phone device shows the note; a fixture over 2 GB (stubbed sizes) shows the warning before fetching.
- [x] Unit test for the entry-name de-duplication.
- [x] Suites green.

### Exit criteria
Any selection downloads as one correctly named zip, with honest progress and failure reporting.

## Phase W2-E — Album arrange

Starts after W2-A merges (shares `GET /api/photos`).

### Steps
1. Migration `..._album_custom_order.sql`: the W2-E block; `photo_album_reorder` validates that
   `p_photo_ids` is exactly the album's active membership (else `invalid_input`), assigns
   positions 1..n, sets `sort_mode='custom'`; `photo_album_add` appends `max+1` positions when
   custom; a `{sort_mode:'date'}` call clears the mode but keeps positions.
2. `GET /api/photos?album=X&sort=custom`: order by `position asc, id` with a keyset on that
   pair (an RPC or view is implementation-owned); the album detail response carries
   `sort_mode`; `PATCH /api/photo-albums/[id]/order`.
3. `album-arrange.tsx` with `@dnd-kit/core` + `@dnd-kit/sortable`: `Arrange` on the album
   header loads the whole album (≤2,000; above that the button explains), tiles sortable
   (TouchSensor 250 ms delay, PointerSensor 5 px), `Done` saves the full order, `Cancel`
   discards. The Sort chip gains `Custom` on albums; default follows `sort_mode`.
4. Share page and slideshow follow the album's mode (`photo_share_read` orders by position when
   custom).

### Verify
- [ ] [AC-16] `test:db`: reorder, add (appends), switch to date and back; `test:routes`: `sort=custom` pages correctly; share read follows it. `test:browser` desktop: drag the third photo first, Done, reload → first.
- [ ] [AC-17] `test:browser` phone device: long-press drag reorders; rendered review on `iPhone 15` and desktop.
- [x] Suites green; `tsc` clean.

### Exit criteria
Albums can be arranged by hand and everyone, including the share page and slideshow, sees that order.

## Final — docs and retro

1. Ari clicks through the merged Wave 2 on the review stack (filter → select all → tag or
   download; open photo → hide chrome → Play; album → Arrange → Play) and the owner gets his
   second review.
2. `Docs/Employee-Features.md` and `Docs/photos-runbook.md` describe the toolbar, select all,
   download, arrange, slideshow, and the delete rule.
3. Completion retro per the planning contract; `status: done`; archive.

## Round three — the owner's notes of 2026-10-14 (one PR, branch `round3-dad-notes`)

Notes, verbatim in `/tmp/dws-wave1/STATE.md`; the research behind the plan in
`/tmp/dws-fanout-ciP8F8/`. Decisions (Ari, 2026-10-14): map the old tags onto the new
(`shop drawing`→Shop, `field dimension`→Field, `professional`→Photoshoot); the import's
album switch is per folder and off by default; the slideshow setting is per account (a
database column); rotate/crop and importing while browsing are not in this round.

1. Projects by job number descending, albums by name A to Z; Photos unchanged
   (`20261014120000_photo_list_order.sql`, new page functions, cursor by sort key).
2. The import file list keeps its page while the import runs (`/migrate` refreshed page 1 on
   every finished file).
3. Default tags Shop, Field, Photoshoot, editable by photo admins on a new Settings page
   (`photo_settings.starter_tags`); the project page's pinned group is Photoshoot.
4. Slideshow: random order and seconds a photo stays, per account, on the Settings page.
5. Import: **Make an album** per folder, off by default; a folder needs a project or an album.

Migrations were applied to production on 2026-10-14 ahead of the PR; the runbook notes the
tag-rename re-run owed at deploy.

## Rollout

Every migration is additive and applied before its deploy; no deploy depends on a drop. Order:
W1-A and W1-B migrations → Wave 1 deploy → launch ops (admins) → W2-E migration →
Wave 2 deploy → launch ops (wipe). Rollback for each unit is reverting its PR; the
columns stay (unused columns are harmless), and the delete rule can be widened by one function
edit if it ever blocks real work. `repair_enabled` stays as the operator left it; this plan does
not change gates.

## Risks

- **The delete rule blocks a legitimate cleanup.** Mitigation: three photo admins; restore stays
  open; one function to widen. Signal: an employee asks an admin to delete for them more than
  occasionally.
- **The wipe removes something wanted.** Mitigation: counts before and after, Ari confirms
  each step, the 22 office projects are untouched by construction (`synced_at is not null`).
- **5,000-id requests are slow on a big library.** Mitigation: cap and `truncated`; the
  library is tiny today. Signal: an `/ids` call over 5 s.
- **Browser zip fails on huge sets or on iPhone.** Mitigation: size estimate, warning, phone
  note, honest failure list; a server-side zip remains the fallback.
- **Drag on phone feels fiddly.** Mitigation: long-press sensor, rendered review; fall back to
  desktop-only Arrange with a plain phone message if the review says so.

## Open questions

None block the build.

1. *needs-data* — Which project numbers will the owner use for marketing and DWS events? He
   creates them himself with typed numbers; nothing in the build depends on the values.
2. *needs-decision, later* — Export a project or album as PowerPoint (Ari, 2026-10-12: "maybe
   we'll add that later").

## Relationship to other plans

- `plans/active/photo-albums/plan.md`: Decision 1 (optional project) holds; Decision 7 (anyone
  trashes anything) is **replaced** by Decision 2 here; Decision 5 (tags as text list) holds
  with scoped suggestions; Decision 14 (rendered reviews) continues as Decision 12.
- `plans/active/photo-folders/plan.md`: hand-made projects unchanged; the office bridge stays
  out of scope.
- `plans/active/dws-hosted-mcp/plan.md`: `remove_photos` now obeys the delete rule; nothing else
  changes.
