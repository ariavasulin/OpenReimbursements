---
status: active
created: 2026-09-20
updated: 2026-09-20
---

# Albums, optional projects, and sharing for DWS Photos

Shape: design doc + tech spec + implementation plan (standalone; no PRD).
**Consequence: consequential** — it changes durable photo data and adds the app's
first page that works without a login. **Delivery: live** for every phase except
share links, which are **gated** behind a new `sharing_enabled` switch.

**Agent brief.** Intent: let a photo live in albums, make its project optional,
remove the Sheet # field, add bulk tools and share links, and make folder imports
arrive as albums — all simple enough for a non-technical person who thinks in folders.
Source of truth: this plan; the request and client context in
[`sources/ticket.md`](sources/ticket.md); the planning contract at
`plans/active/dws-hosted-mcp/sources/planning-contract/`.
Locked decisions: Decisions 1–14 below.
Current phase: see the ticked Verify boxes; the orchestrator runs every phase through to the ship sequence without pausing (user instruction 2026-09-20). Production-side checks stay open until the ship.
Stop-and-ask triggers: any role or permission rule beyond "signed-in employee";
anything that would make the storage bucket private; nested albums; changing a public
URL shape in § URLs after it ships; running the office's big folder import before
Phase 6 is live.

## Why

Today a photo must belong to exactly one project (`photos.job_id` is `not null`) and
nothing else can group photos. That cannot hold the client's real cases: a Christmas
party has no project; a marketing collection spans many projects. The client comes
from Mylio and organizes by folders, so "where did my folder go?" needs a plain answer.

**Do nothing:** people invent fake projects ("Christmas Party") that pollute the
project list, and the 100 GB import flattens every folder tree into one bucket per
project. **Timing:** production holds 41 photos in one project, 0 tags, 0 Sheet #
values, and the big import has not moved a file — the cheapest moment to change the
model. **Rejected framing:** "give him real nested folders" — see Alternatives.

## Words employees see

The whole app uses three words. Code keeps `job` for project (`public.jobs`).

| Word | Plain meaning shown in the app | In the database |
| --- | --- | --- |
| **Album** | "Like a folder. A photo can be in more than one." | `albums` + `album_photos` |
| **Project** | "The job a photo belongs to. Optional." | `photos.job_id` → `jobs`, nullable |
| **Tag** | "A label you can filter by, like *professional* or *shop drawing*." | `photos.tags text[]` |

"Sheet" has two unrelated meanings in the code today. This plan removes the photo
field **Sheet #** (`photos.sheet_number`). It does **not** touch `SheetShell` /
`FullScreenSheet`, the pop-up containers for forms.

## Goals and non-goals

Goals: (G1) a photo can be in any number of albums and have zero or one project;
(G2) every upload names a project or an album; (G3) people browse by Photos, Albums,
or Projects on phone and desktop; (G4) select many photos and act on them; (G5) an
imported folder becomes an album with the same name; (G6) an album or project can be
shared by link; (G7) the words an employee has to learn are exactly the three in
§ Words — Sheet # is gone and nothing new is added beside Album.

Non-goals (rejected on purpose): albums inside albums; roles or per-album
permissions; link expiry or passwords; download-as-zip; a tag management screen
(rename/merge); reading Mylio or Picasa albums, faces, ratings, or keywords
(keywords: see Open questions); choosing an album cover; the office database bridge;
an album selector in the MCP move/remove/restore scripts.

## System sketch

```
Browser (phone + desktop)                     Public visitor (no login)
  /photos            all photos by date          /s/<token>  one album or project
  /photos/albums     albums   /photos/albums/<id>      |
  /photos/projects   projects /photos/<jobId>          v
  /migrate           import folders -> albums    GET /api/share/<token>  (service role,
        |                                          gate: sharing_enabled)
        v
  /api/photos, /api/photo-albums, /api/photo-jobs, /api/photo-tags, /api/photo-migrations
        |   requirePhotoActor: any signed-in employee or admin; gate: photo_writes_enabled
        v
  Postgres: photos(job_id NULLABLE, tags) -- album_photos -- albums
            jobs · photo_share_links · migration_folders (one row per imported folder)
  Storage bucket `photos` (public; unchanged)

DWS MCP (shared-key URL) -> mints a hand-off link -> employee confirms in /migrate
```

Ownership: all photo writes stay in `security definer` SQL functions callable only
by the service role, reached through the app's API routes — the existing pattern.

## Premise anchors

Re-run each probe at phase entry. SQL runs with the convention in
`dws-app/supabase/migrations/README.md`.

| # | Premise | Probe |
| --- | --- | --- |
| P1 | No production photo uses Sheet # | `select count(*) from public.photos where sheet_number is not null` → 0 |
| P2 | One photo per content hash, across projects | index `photos_content_sha256` exists on `public.photos` |
| P3 | The big import has not started | `select count(*) from public.migration_items` → 0 |
| P4 | The import page works without an MCP hand-off | `dws-app/src/app/migrate/page.tsx` creates an `origin='ui'` batch when no `token` is present |
| P5 | The `photos` bucket is public | `select public from storage.buckets where id='photos'` → true |
| P6 | Photo queries left-join the project | `PHOTO_COLUMNS` in `dws-app/src/lib/photos/apiShared.ts` embeds `job:jobs(...)` without `!inner` |
| P7 | The new address is attached to the app | `vercel domains inspect design-workshops.app` lists `photos.design-workshops.app` under project `dws-receipts` |

P3 failing means folders were already imported without albums: stop and ask.

## Decisions

Posture key: *first-release* = reversible on first-release evidence; *later* =
reversible on later experience; *structural* = no planned reversal.

1. **Project becomes optional by making `photos.job_id` nullable.** The `jobs` table,
   job numbers, and `P-<n>` codes stay. A photo still has at most one project
   (`dws-hosted-mcp/plan.md:245` holds). *Structural* once a project-less photo
   exists; undoing it means assigning a project to every such photo.
2. **Albums are a flat many-to-many collection.** No nesting; names need not be unique.
   Deleting an album never deletes photos. *Later*: nesting could be added, not removed.
3. **The upload rule applies at upload only.** Every upload names a project, an
   album, or both. Later edits are free, because Photos always shows every photo, so
   nothing can be lost. *Later*: tighten by adding the same check to the edit functions.
4. **Same-photo rule.** When uploaded bytes already exist as an active photo, no
   second photo is made and the existing one is added to the upload's album(s). For
   the project: empty → filled in; same → nothing; different → the existing project is
   kept and the outcome is today's `job_conflict`. This is what turns a "Marketing"
   folder full of copies into an album of the same photos. *Structural* (follows P2).
5. **Tags stay a text list on the photo;** no tag table. Adding a tag that matches an
   existing one ignoring case uses the existing spelling. Three starter tags are
   always offered: `professional`, `field dimension`, `shop drawing`. *Later*: move
   to a tag table only if renaming or merging tags becomes a real request.
6. **Sheet # is removed outright.** Warrant: P1. *Structural* (column dropped).
7. **Any signed-in employee can trash and restore any photo, and create, rename,
   delete, and share any album** (user ruling 2026-09-20). `deleted_by` still records
   who. Deployment tools (`photo_install_write_boundary`, identity cutover) stay
   admin-only; they are not app features. *First-release*: re-add the uploader check.
8. **Deleted albums are recoverable for 30 days** from the Trash page, because anyone
   can delete one and an album may be the only trace of an imported folder. Album rows
   are never auto-purged. *Later*: add purging only if dead album rows ever matter.
9. **An imported folder becomes an album.** Every folder that directly holds photos
   becomes one album named from its path under the picked folder, joined with " – "
   (`Smith Residence – Finished`). Pressing Start with no edits is always valid.
   *Later*: names are editable before and after import.
10. **The folder row is the unit of import choices.** Each row carries an album name,
    an optional project, and optional tags applied to every photo in that folder. A
    choice on a top-level folder applies to the folders inside it. Finer tagging
    happens after import with the bulk tools. *Later*: add per-photo choices only if
    the first real import shows folder-level choices are too coarse.
11. **Bulk Trash and Set project reuse the existing confirm page**
    (`/photos/actions`), which already handles many photos for MCP hand-offs. Tag and
    add/remove-from-album act immediately — they only add, and one tap undoes them.
    *First-release*: if the extra confirm screen annoys people for Set project, give
    it an immediate path too; Trash keeps its confirm page.
12. **Share links:** one link per album or project, off by default, no expiry. The
    token is stored as-is in a service-role-only table so the link can be shown again
    (the hand-off pattern stores only a hash; it never needs redisplay). Visitors can
    view and download; they never see uploader names, tags, or other albums. The
    bucket stays public, so **turning a link off stops the page but cannot recall
    image addresses someone already saved** — the limit `dws-hosted-mcp/plan.md:246`
    already accepts for trash. *Later*; the real fix is Alternative D.
13. **`photos.design-workshops.app` is the address every generated link uses** —
    MCP hand-offs and share links (user ruling). The app itself answers on both
    `photos.design-workshops.app` and `photos.dws-receipts.com`: commit `30e75ed`
    landed that on `main` while this plan was being written, so old bookmarks keep
    working with no redirect. A sign-in does not carry between the two domains. The
    app opens on Photos (all photos by date), per "think Google Photos".
    *First-release*: both are a config change.
14. **Every phase that changes what people see gets a rendered look-and-feel review
    by a second model before it is reported for human review** (user instruction
    2026-09-20; mechanics in § Rendered look-and-feel review). The review is advice.
    The orchestrator fixes, defers, or declines each finding with a reason and lists
    them for the human, who can overrule any of them at the PR; the reviewing model's
    opinion never passes or fails a phase by itself. *First-release*: drop it if the
    findings stop being useful.

## Alternatives

- **A. Real nested folders** (what a folder-thinker asks for). A photo sits in one
  place, so the marketing collection needs copies and the same picture exists twice.
  It rebuilds the problem inside a database. Rejected on outcome risk.
- **B. Keep the project required and add albums** (the obvious small change). The
  Christmas party still needs a fake project, which pollutes the project list and
  any later office-database bridge. Rejected: fails the stated rule in the request.
- **C. Albums only; a project is just another album or tag.** Projects carry a job
  number, the MCP addresses photos by it, and the office bridge will key on it.
  Rejected on ownership cost.
- **D. Private bucket with signed image links** (the strongest alternative for
  sharing). Makes turning a link off complete. It changes how every image in the app,
  the repair sweep, and the public page are served. Rejected for now on blast radius;
  revisit if a shared link ever exposes something it should not, or before sharing
  anything client-confidential.

## Contract surface

### Database

Every new function follows the existing pattern: `security definer`,
`set search_path=public,pg_temp`, calls `photo_require_actor` and
`photo_require_gate('writes')`, granted to `service_role` only. New function
parameters take defaults so the deployed app keeps working between migration and deploy.

- `photos.job_id` → nullable. `photos.sheet_number` and index `photos_sheet` → dropped.
  Column grant to `authenticated` becomes `update(tags)`.
- `albums(id uuid pk, name text not null 1–120 chars, created_by, created_at,
  updated_at, deleted_at, deleted_by)`. RLS: `select` to `authenticated` where
  `deleted_at is null`; no direct writes.
- `album_photos(album_id, photo_id, added_by, added_at)`, primary key
  `(album_id, photo_id)`, both foreign keys `on delete cascade` (a purged photo leaves
  its albums; trashing keeps membership, so restore puts it back). RLS: `select` to
  `authenticated`.
- Upload path (`photo_create_upload_attempt`, `photo_finalize_upload`,
  `photo_upload_attempts`): accept a null project plus `album_ids uuid[]`; refuse
  `invalid_input` when both are empty; apply the same-photo rule.
- Album functions: create, rename, delete, restore; `photo_album_add` /
  `photo_album_remove(p_actor, p_album, p_photo_ids uuid[])` — idempotent, 1–500 ids,
  active photos only. `get_photo_album_summaries(q)` mirrors `get_photo_job_summaries`
  (name, active-photo count, four newest thumbnails).
- `photo_bulk_tag(p_actor, p_photo_ids uuid[], p_add text[], p_remove text[])` —
  1–500 ids; returns `{updated, skipped}`; a photo that would pass the 20-tag limit
  is left unchanged and counted as skipped.
- Actions: `move` accepts a null destination meaning "No project";
  `photo_action_items.expected_job_id` → nullable; the uploader-or-admin checks in
  `photo_materialize_action`, `photo_approve_action`, `photo_apply_action` are removed.
- Import: `migration_sources.job_id` → nullable (now only a default).
  `migration_folders(id, source_id, folder text, album_name text, album_id uuid null,
  job_id uuid null, tags text[] not null default '{}')`, unique `(source_id, folder)`;
  `folder` is the path under the picked folder, `''` for the folder itself. Rows are
  derived from the sealed inventory, editable while the batch is a draft, frozen on
  approve. Each imported photo takes its row's project and tags and joins its row's album.
- Sharing: `photo_share_links(id, token text unique, album_id null, job_id null,
  created_by, created_at, revoked_at, revoked_by)` with exactly one of
  `album_id`/`job_id` set and at most one un-revoked link per target. No grants to
  `anon` or `authenticated`. `photo_release_state.sharing_enabled boolean not null
  default false`; `photo_require_gate` accepts `'sharing'`.
  `photo_share_read(p_token, p_after, p_limit)` returns the name, count, and active
  photos of exactly that target, and nothing else.

### URLs *(public shapes; hard to change once pasted into messages)*

| URL | Meaning |
| --- | --- |
| `/photos` | Photos: every photo, newest first. `?photo=<id>` opens one — any active photo, however old |
| `/photos/albums`, `/photos/albums/<albumId>` | Album list; one album (also takes `?photo=`) |
| `/photos/projects` | Project list (today's home screen) |
| `/photos/<jobId>` | One project — unchanged, so every link already sent keeps working |
| `/s/<token>` | Public share page; token is 32 random bytes, base64url |
| `/migrate` | Import folders (unchanged; also the MCP hand-off landing) |

"Copy link" on a photo writes `/photos?photo=<id>`. The MCP photo-link parser
(`dws-app/src/lib/photos/server/http.ts`) accepts that shape, the old
`/photos/<jobId>?photo=<id>` shape, and both the new and old origins.

### MCP (`dws-app/src/lib/mcp/registry.ts`, `harness/skills/photos/SKILL.md`)

- `add_photos`: `{ job_number?, new_project_name?, album_name?, tags? }` —
  `sheet_number` removed; the schema is strict, so sending it is `invalid_input`.
- `migrate_photos.sources[]`: `{ label, job_number?, new_project_name?, album_name?, tags? }`.
- All remain suggestions. Nothing is created until the employee confirms in the
  browser (`photo-folders/plan.md` Decision 4 holds). The skill text explains:
  folders become albums, a project is optional, and tags can be set per folder.

### Screens — visual direction

Reference: Google Photos on the web and iPhone, built from the existing DWS Photos
dark theme and components (`PhotoGrid`, `SheetShell`, `FilterChip`, `GroupByToggle`,
`JobCombobox`). No new visual language.

- **Three sections: Photos · Albums · Projects.** Phone: a bottom tab bar; the two
  capture buttons fold into one round "+" above it (Take photos, Upload, New album);
  the upload tray sits above the bar. Desktop: the left rail shows the three sections,
  then the list for the open section (albums or projects); the top bar keeps search
  and gains **Import folders**.
- **Albums and Projects pages** show a one-line explainer from § Words, cards with
  name, count, and four thumbnails, and a **Share** button on each album or project.
- **Upload pop-up:** Project (optional), Album (optional, can pick several or type a
  new one), Tags. Helper: "Pick a project, an album, or both." Upload stays disabled
  until one is set. It pre-fills from the page you are on.
- **Tag dropdown:** opens to a list of existing tags plus the starter tags; typing
  narrows it; the last row is `Add "<typed>"`. One component for upload, edit, bulk
  tag, and import rows.
- **Filters and grouping:** Project, Tag, Uploader filters on Photos; Tag and
  Uploader on album and project pages; group by Date or Tag (a photo shows under each
  of its tags; "No tags" last). The Sheet filter and group are gone.
- **Select many:** phone — press and hold a photo, then tap others; desktop — tick
  the box on hover, shift-click for a range; a header tick selects a whole date group.
  A bar shows the count and **Add to album · Tag · Set project · Trash**, plus
  **Remove from album** inside an album. Limit 500.
- **Import review ("Your folders"):** rows grouped under each picked folder,
  collapsed by top-level folder with counts. Each row: folder path → album name
  (editable), photo count, Project, Tags. One line at the top: "Each folder becomes an
  album with the same name."

## Rendered look-and-feel review

Automated suites prove behavior, not whether a screen looks modern and clean or
makes sense to a non-technical person. For Phases 2, 4, 5, 6, and 7 the orchestrator
runs this once the phase's automated checks pass, and folds the findings into the
phase summary the human reviews.

- **Where:** Phase 2 needs no new tables, so it is reviewed on a Vercel preview of the
  working tree, which shows real production photos in look-only mode. From Phase 3 on
  the new tables exist only locally (nothing touches production before the ship), so
  the review runs against a local app on a throwaway database seeded with realistic
  photos — where the reviewer can also complete every flow instead of stopping short.
- **Sign-in:** the reviewer signs in through the real login page with the operator's
  own phone number and reads the texted code with the operator's `imsg` CLI (user
  ruling 2026-09-20, chosen over the orchestrator signing in and passing cookies).
  Its brief limits `imsg` to reading the newest sign-in code: never send, never open
  other conversations. The phone number is given in the brief, never written here.
- **Reviewer:** `/peprkit:delegate design-engineer --target codex --tier xhigh
  --permissions default --app-url <preview URL>`, which gives it a live browser it
  clicks through and screenshots. `default` means the operator's own Codex settings;
  the sandboxed profiles cannot reach the Messages database. Viewports: phone 390×844 and desktop 1440×1000, matching the browser
  specs. It reports looks (spacing, hierarchy, consistency with the existing dark
  theme) and sense (would a folder-thinker know what to do next) with a screenshot
  per finding.
- **Real data is in play.** The reviewer looks and opens pop-ups but does not
  confirm changes to real photos, projects, or albums. Where a flow can only be
  judged by completing it, it works on scratch items whose names start with
  `UX Test`, and the orchestrator removes them afterwards.
- **Outcome:** each finding is dispositioned by the orchestrator — fixed in this
  phase, deferred to a named phase, or declined with a reason — and the list goes in
  the PR for the human to overrule. Reports are kept in `reviews/`; screenshots in the
  git-ignored `.artifacts/photo-albums/reviews/`.

## Baseline findings

The live app was reviewed before this plan changed anything
([`reviews/2026-09-20-baseline.md`](reviews/2026-09-20-baseline.md)). Its findings are
requirements for the phase that owns each screen. "Keep": the dark palette, the
compact square grid with date groups, the desktop viewer's large image area, the
always-reachable phone capture buttons, and the 30-day recovery facts.

| Finding (severity) | Handled in |
| --- | --- |
| Phone viewer: details sit on top of the photo and are hard to read (high) | Phase 4 — photo unobscured by default; details and actions in an opaque panel opened from the viewer |
| Enlarged text pushes the phone Upload action off-screen (high) | Phase 4 — the bottom bar and "+" survive browser text at 200%; names and headings scale |
| "Where did my folder go?" — no overview, unlabeled numbers beside counts (high) | Phases 4 and 6 — the three sections; job numbers labeled; imported folders arrive as albums of the same name |
| Move/trash/restore confirm page reads like a batch console: "exact targets", "draft", "pending", "MCP restore handoff" (high) | Phase 5 — it becomes the bulk confirm page: photos first, one plain sentence ("Move 3 photos to …?" / "Move 3 photos to trash?"), verb + Cancel, recovery time stated; conflict detail only when there is a conflict |
| Controls too small: 28–34 px targets, 12 px labels (medium) | Phases 4–5 — 44 px minimum touch targets and 16 px body text on every screen they touch |
| Long project names truncated in the list and rail (medium) | Phase 4 — two-line names in lists and cards; full name on focus/tap |
| Desktop header: red Sign out dominates; too many peers (medium) | Phase 4 — Sign out and Receipts move into a quiet account menu |
| Phone pop-ups have no visible Cancel (medium) | Phase 4 — a labeled Cancel in the header of every phone pop-up |
| "Move" is hidden under "Edit tags" (medium) | Phase 5 — "Set project" is its own action; the form is "Edit details" |
| Search: "No jobs match" shown beside successful photo results (medium) | Phase 4 — project suggestions and photo results are separate, labeled sections |
| "Sheet" is unexplained; empty Tag menus say only "None yet" (medium) | Phase 2 removes Sheet #; Phase 5 — the tag dropdown always offers the starter tags and says what a tag is |
| Import page leads with internal vocabulary (medium) | Phase 6 — lead with "Import folders" and one "Choose folder" action; XMP and exclusion detail behind "More detail"; past imports named by folder and date |
| Empty project keeps useless filters; no upload action beside the message (medium) | Phase 4 — empty states carry their own action and hide filters |
| Short forms sit in very tall pop-ups, ~300 px of blank space before the button; worse once Sheet # is gone (medium) | Phase 4 — pop-ups size to their content on desktop and phone, with a viewport-relative maximum and scrolling inside |
| Sign-in says "DWS Receipts", no resend path (low) | Phase 4 — on the photos address the title and heading say DWS Photos; a timed "Resend code" |

## Security and privacy (share links only)

The one cross-cutting concern that is load-bearing here. Everything else in the app
still requires a signed-in employee.

- **What is exposed:** job-site and office photos and videos. Nothing legally
  protected, but not meant for the public. A visitor gets the target's name, a photo
  count, capture dates, and image addresses — never people's names, tags, or XMP files.
- **Threats and the mechanism that answers each:** guessing a link → 256-bit random
  token, and unknown tokens return 404, the same as revoked ones; reading beyond the
  shared album → `photo_share_read` is the only query path and takes the target from
  the token, never from the request; a link that outlives its purpose → one switch
  per link, and `sharing_enabled` for all of them at once; search-engine indexing →
  `noindex` and `no-store` headers; stale caching after turn-off → `no-store`.
- **Accepted limit:** Decision 12 — saved image addresses outlive a turned-off link.
- **Review gate:** PR 7 gets a security review (`/security-review`) of the public
  route and `photo_share_read` before `sharing_enabled` is opened in production.

## Acceptance criteria

Address and cleanup
- **AC-1** When anyone opens `https://photos.design-workshops.app/`, the Photos app is served, not Receipts; `https://photos.dws-receipts.com/` keeps serving it too.
- **AC-2** In production an MCP hand-off link starts with `https://photos.design-workshops.app`, whichever host the MCP request arrived on; with `DWS_BROWSER_ORIGIN` unset, the fallback is that same origin.
- **AC-3** Photo `8219970d-57f5-40a3-92c9-bbd262ddb8bc` is in trash, and no active photo is a lone `.xmp` file.
- **AC-4** No Sheet # field, filter, group, API parameter, MCP input, or column remains; `SheetShell` still works. Example: `add_photos` with `sheet_number` → `invalid_input`.
- **AC-5** When a signed-in employee trashes or restores a photo someone else uploaded, it succeeds and `deleted_by` names them. Signed out → 401; `photo_writes_enabled=false` → 503.

Data model
- **AC-6** An upload naming neither project nor album is refused `invalid_input`; album only → stored with no project, in that album; project only → as today.
- **AC-7** Same-photo rule: re-uploading existing bytes into album B makes no new photo and adds the existing one to B; an empty project is filled; a different project is kept and reported `job_conflict`.
- **AC-8** A photo can be in several albums. Deleting an album removes no photo, and the album can be restored for 30 days. Trashed photos are hidden from albums and counts; restoring brings them back; purging removes the membership.
- **AC-9** Adding or removing up to 500 photos is idempotent; 501 → `invalid_input`.
- **AC-10** Bulk tag adds and removes across up to 500 photos; a photo at the 20-tag limit is skipped and counted; adding `Kitchen` when `kitchen` exists stores `kitchen`.
- **AC-11** `/photos?photo=<id>` opens any active photo, including one with no project and one older than the first loaded pages; an old `/photos/<jobId>?photo=<id>` link still opens.

Browsing and bulk tools
- **AC-12** On phone and desktop, `/photos` shows all photos by date, newest first, and the three sections are one tap apart. A photo with no project shows "No project" and breaks nothing.
- **AC-13** The upload pop-up enforces project-or-album, pre-fills from the current page, and can create a new album or project inline.
- **AC-14** The tag dropdown lists existing and starter tags, narrows as you type, and adds a new tag; filter and group by tag work on Photos, album, and project pages.
- **AC-15** Select-many works on phone and desktop on the Photos, album, project, and search grids, with all five actions. Set project (including "No project") and Trash go through the confirm page with exactly the selected photos.

Import
- **AC-16** Importing a folder tree with no edits succeeds: each folder directly holding an importable photo becomes one album named from its path. Resume, rescan, and retry never make a second album for the same folder; a folder whose photos all fail or are skipped leaves no album.
- **AC-17** Review shows one row per folder with album name, project, and tags; a top-level choice applies to its sub-folders; a project is pre-suggested from the MCP hint or from a folder name containing an existing project number as a whole word; nothing is assigned that review did not show. 5,000 folder rows stay usable.
- **AC-18** Loose files (up to 500, the `add_photos` path) need a project or an album, new or existing.
- **AC-19** MCP `album_name` and `tags` suggestions pre-fill review; nothing is created before the employee confirms.
- **AC-20** On desktop Chrome or Edge, **Import folders** opens `/migrate` with no MCP. Where the browser cannot pick folders, and on phones, the entry explains that instead of failing.

Sharing
- **AC-21** Turning sharing on for an album or project gives `https://photos.design-workshops.app/s/<token>`. Signed out, it shows the name, count, and photos with view and download — no uploader names, tags, XMP files, or other albums.
- **AC-22** Link off → 404 at once; on again → a new token; unknown token → 404; a token for album A never lists a photo outside A; trashed photos are never listed; `sharing_enabled=false` → every share page is unavailable while the signed-in app is unaffected. Responses send `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- **AC-23** The Share pop-up states the limit in Decision 12 in plain words.

## Execution shape

**Changed 2026-09-20 (user instruction): the whole plan is built and tested first,
then shipped once.** All phases land on one branch, `ariavasulin/photo-albums`, one
commit per phase, and the ship sequence opens a single PR. The orchestrator works
through every phase without pausing for approval; the human reviews at the PR. The
PR owns the union of the contracts below. Because each phase is its own commit, the
branch can still be cut into stacked PRs at ship time with no rework.

| Commit | Contract it owns |
| --- | --- |
| Phase 1 | The photos address; the leftover XMP |
| Phase 2 | No Sheet #; open trash authority |
| Phase 3 | Optional project, albums, bulk tag, photo-link shapes (database + API) |
| Phase 4 | Photos · Albums · Projects screens; upload pop-up |
| Phase 5 | Tag dropdown, tag filter/group, select-many and bulk actions |
| Phase 6 | Folder import as albums; MCP inputs; desktop entry |
| Phase 7 | Share links and the `sharing_enabled` gate |

**Nothing touches production while the plan is being built**: no production
migration and no production deploy. Every phase is proven on throwaway local
databases. The production steps all belong to the ship sequence, in the order under
§ Rollout. (Already done with the operator's approval in Phase 1: the XMP was trashed
and `DWS_BROWSER_ORIGIN` was updated.)

Each phase also corrects the lines it makes false in `plans/active/dws-hosted-mcp/plan.md`
and the two runbooks. Recipe:
`grep -nE "sheet|one active (destination )?job|exactly one|Uploader or administrator|dws-receipts\.com" plans/active/dws-hosted-mcp/plan.md Docs/photos-runbook.md Docs/dws-mcp-runbook.md`.

## Phase 1 — The photos address and the leftover XMP

Settles the address before any link is minted. Defers nothing.

**Corrected 2026-09-20 at phase entry.** Commit `30e75ed` reached `main` while this
plan was being written. It already made the app answer as Photos on both domains
and scoped the sign-in cookie per domain, so the env change for
`NEXT_PUBLIC_PHOTOS_HOSTNAME`, the cookie work, and the planned redirect are dropped
(Decision 13). What is left is where generated links point, and the XMP.

### Steps
1. Code: the MCP's fallback browser origin in `dws-app/src/lib/mcp/registry.ts`
   becomes `https://photos.design-workshops.app`, with a unit test for the fallback.
2. Docs: `Docs/dws-mcp-runbook.md` and `Docs/photos-runbook.md` name the new address
   for hand-offs and examples. Worklist recipe:
   `grep -rnE "dws-receipts\.com" dws-app/src dws-app/tests dws-app/integration Docs`.
   Complete when every remaining hit is the old-domain cookie rule, an allow-list
   entry for links already sent, a statement that the old host still serves the app,
   test sample data, or the dated 2026-09-20 operator record in
   `Docs/dws-mcp-runbook.md`, which step 3 updates.
3. Operator, at merge time: link the CLI (`vercel link --project dws-receipts` inside
   `dws-app/`; `.vercel` is git-ignored) and set Production
   `DWS_BROWSER_ORIGIN=https://photos.design-workshops.app` with `vercel env`. It
   takes effect on the deploy the merge triggers. Then bring the dated operator
   record in `Docs/dws-mcp-runbook.md` up to date with the value actually set.
4. Operator: signed in as the uploader or an admin, open
   `/photos/actions?action=trash&photo=8219970d-57f5-40a3-92c9-bbd262ddb8bc` and
   confirm. No prevention work: both upload paths already drop a lone `.xmp`.

### Verify
- [x] [AC-1] `curl -s <host>/ | grep -o '<title>[^<]*'` → `DWS Photos` on both `https://photos.design-workshops.app` and `https://photos.dws-receipts.com`. *(Observed 2026-09-20 against production, after `30e75ed` deployed.)*
- [x] [AC-2] unit (`registry.test.ts`, "falls back to the design-workshops photo host"): with `DWS_BROWSER_ORIGIN` unset the origin is the new address. *(Observed 2026-09-20: passes; fails against the old fallback.)*
- [ ] [AC-2] after the deploy: a production MCP `add_photos` call returns a `handoff_url` on the new origin. *(Production `DWS_BROWSER_ORIGIN` was updated 2026-09-20; it takes effect on the next production deploy, so this stays open until then.)*
- [x] [AC-3] `select count(*) from public.photos where deleted_at is null and kind='file' and original_name ilike '%.xmp'` → 0. *(Observed 2026-09-20: 0; the photo is in trash with `deleted_by` set, restorable until 2026-10-20.)*
- [x] `npm --prefix dws-app test` green *(2026-09-20: 46 files, 577 tests)*; `tsc --noEmit` clean.

### Exit criteria
Both addresses serve Photos, every hand-off link uses the new address, and the XMP
is in trash.

## Phase 2 — Remove Sheet #; let anyone trash

Shrinks what exists before building on it. Two migrations with opposite orderings.

### Steps
1. Migration A (apply **before** merge): re-create the action functions without the
   uploader-or-admin check (Decision 7). The permission opens when this migration is
   applied, not at merge: the confirm page already live relied on these SQL checks.
   Worklist recipe:
   `grep -n "role='admin'" dws-app/supabase/migrations/20260907100400_photo_actions.sql`.
   Complete when the only `role='admin'` checks left in the photo SQL are the
   deployment tools Decision 7 names.
2. Code: remove the matching checks in the app. Worklist recipe:
   `grep -rnE "canManageOwnPhoto|isPhotoAdministrator|role === \"admin\"" dws-app/src/lib/photos dws-app/src/app/api/photos dws-app/src/components/photos`
   — complete when it returns nothing. Then remove Sheet # everywhere. Worklist recipe:
   `grep -rniE "sheet_number|sheetNumber|cleanSheet|\"sheet\"|'sheet'" dws-app/src dws-app/tests dws-app/integration`
   — every product-code hit goes except the `SheetShell` / `FullScreenSheet` /
   `sheetOpen` container names. With Sheet gone a project page has only Date grouping
   left, so its group-by toggle is removed here and returns in Phase 5 with Date and Tag.
3. Migration B, in two files so a single ship stays safe. **B1** (apply before the
   merge) re-creates every function whose current body names the column —
   `photo_finalize_upload` and `photo_install_write_boundary`
   (`grep -ln sheet_number dws-app/supabase/migrations/*.sql`) — so the database stops
   writing it. **B2** (apply only **after** the deploy is live, else live queries
   selecting the column fail) drops `photos.sheet_number` and sets the grant to
   `update(tags)`. B2 re-creates no function: it runs after Phase 3's migration in a
   single ship, and would otherwise overwrite Phase 3's newer `photo_finalize_upload`.

### Verify
- [x] [AC-4] `test:routes`: `PATCH /api/photos/[id]` refuses a body carrying `sheet_number` with 400 and writes nothing, while a tags-only body still saves; `GET /api/photos?sheet=1` does not filter; the registry test rejects `sheet_number`; the step-2 grep finds no product-code hit — what remains is tests that prove the removal, plus the container names. *(Corrected 2026-09-20: the route is strict about unknown keys, the same rule that refuses `job_id`, so "refuse" is the consistent behavior; naming the field just to ignore it would keep Sheet # alive in product code. Cost: a tab left open across the deploy fails its tag edits until reloaded.)*
- [x] [AC-4] `test:browser`: upload and edit pop-ups open and save with no Sheet # field.
- [x] [AC-5] `test:db` + `test:routes`: employee B trashes then restores employee A's photo; `deleted_by` = B; signed out → 401; gate closed → 503. *(Observed 2026-09-20 by the orchestrator: `test:db` 71/71, `test:routes` 77/77, `test:browser` 15/15, unit 572/572; both migrations replayed twice on a fresh local database.)*
- [x] `npm exec -- tsc --noEmit -p tsconfig.json` (in `dws-app`) and `npm --prefix dws-app run build` pass. *(Observed 2026-09-20: `tsc` clean; build 52/52 pages with placeholder env values, since this worktree has no env file.)*
- [x] Each re-created SQL function differs from its latest prior definition only by the lines the plan names. *(Observed 2026-09-20: mechanical diff of all five functions.)*
- [x] Rendered look-and-feel review (Decision 14) run on phone and desktop against a preview of this working tree ([report](reviews/2026-09-20-phase-2.md)). Verdict: the removal looks finished — no Sheet remnants, gaps, or lopsided rows in the project header, viewer, trash, or search. Dispositions by the orchestrator: (1) upload and edit pop-ups now far taller than their content, medium — **deferred to Phase 4**, which rebuilds the upload pop-up's fields and the pop-up container, so sizing it here would be done twice; (2) phone pop-ups have no visible Cancel, medium — **deferred to Phase 4** (already in § Baseline findings); (3) restore confirm page uses internal words, low — **deferred to Phase 5**, which rewrites the confirm page in plain language. Not reviewable on production data: trashing a colleague's photo (one uploader only) — covered by `test:db`, `test:routes`, and browser test 11.
- [ ] Ship sequence (§ Rollout): migrations A and B1 applied before the merge; after the deploy is live, B2 applied and `sheet_number` is gone.

### Exit criteria
Production has no `sheet_number` column; any employee can trash any photo.

## Phase 3 — Optional project, albums, and bulk tagging (database and API)

The model everything else stands on. No new screens; the app only becomes safe with
a project-less photo. Defers import (Phase 6) and sharing (Phase 7).

**Recorded while building the database half (2026-09-20).** Accepted readings where
the plan was silent; each is pinned by a test in `integration/db/albums.test.ts`:
- The same-photo rule (Decision 4) runs from one helper at claim, finalize, and refresh —
  duplicates are normally caught at claim, before any bytes upload, so finalize alone
  could not satisfy AC-7.
- Re-uploading into an album a photo that already has a project names no project, so it
  cannot conflict: the photo joins the album and the outcome is `skipped_duplicate`.
- A copy sitting in trash is left alone; today's restore-then-retry flow applies the rule.
- Bulk calls count trashed or unknown ids as `missing` instead of failing the batch.
- The tag case rule compares against tags stored on active photos. Starter tags are not
  in SQL; matching typed text against them happens in the tag dropdown (Phase 5).
- Membership rows of trashed photos are hidden by row-level security, so no client
  count can include them.
- `photo_create_upload_attempt` keeps `p_job_id` without a default (Postgres forbids one
  before the defaulted `p_album_ids`); callers send `null` explicitly. The live app's
  nine-argument call still resolves.

### Steps
1. Migration (additive; apply before merge): § Database items for `photos.job_id`,
   `albums`, `album_photos`, the upload path, album functions, `photo_bulk_tag`, and actions.
2. Routes: `/api/photo-albums` (list, create), `/api/photo-albums/[id]` (rename,
   delete, restore), `/api/photo-albums/[id]/photos` (add, remove),
   `POST /api/photos/tags`; `GET /api/photos` accepts an album filter and a
   "no project" filter; `GET /api/photos/[id]` backs AC-11.
3. `PhotoRow.job_id` and `.job` become nullable; fix every reader
   (`grep -rnE "\.job\.|job_id" dws-app/src/components/photos dws-app/src/app/photos dws-app/src/lib/photos`).
   Complete when `tsc` passes with the nullable type — the compiler finds the rest.
4. Photo links: `buildPhotoLink` writes `/photos?photo=<id>`; the server parser
   accepts both shapes.

### Verify
- [x] [AC-6] `test:db`: finalize with neither → `invalid_input`; album only → `job_id is null` and one `album_photos` row. *(Observed 2026-09-20 by the orchestrator: `test:db` 99/99 — 71 existing + 28 new in `integration/db/albums.test.ts`; the migration replayed twice.)*
- [x] [AC-7] `test:db`: the three project cases of the same-photo rule, each also adding the album. *(Observed 2026-09-20, same run.)*
- [x] [AC-8] `test:db`: two albums, one photo; delete and restore an album; trash, restore, and purge a photo and check membership each time. *(Observed 2026-09-20, same run.)*
- [ ] [AC-9, AC-10] `test:routes`: repeat add/remove; 501 ids; the 20-tag skip count; `Kitchen` → `kitchen`. *(Database halves observed 2026-09-20 in `test:db`: 500 ids idempotent, 501 refused, the 20-tag skip count, `Kitchen` stored as `kitchen`. The route halves land with the routes.)*
- [ ] [AC-11] unit (`photo-link.test.ts`) and `test:routes` for both link shapes and both origins.
- [ ] `test:db`, `test:routes`, `test:browser`, `tsc` green — existing upload, move, trash, and MCP hand-off suites unchanged in meaning.
- [x] Every function the migration re-creates differs from its latest prior definition only by the lines its header names; every new write function is `security definer`, checks the actor and the writes gate, and is granted to `service_role` only; the two internal helpers are callable by no role. *(Observed 2026-09-20: mechanical diff and grant scan by the orchestrator; the helper and read-only-browser cases are also pinned by a test.)*

### Exit criteria
Through the API, a photo can be uploaded into an album with no project, joined to a
second album, and bulk-tagged; the existing app still works.

## Phase 4 — Photos · Albums · Projects

The browsing change people will notice. Defers tag dropdown and select-many (Phase 5).

### Steps
1. `/photos` becomes the all-photos view on both layouts (desktop stops redirecting to
   the newest project); today's project list moves to `/photos/projects`.
2. `/photos/albums` and `/photos/albums/[albumId]`: list, create, rename, delete;
   deleted albums appear in `/photos/trash` for 30 days.
3. Navigation per § Screens: phone tab bar and "+"; desktop rail and **Import folders** link.
4. Upload pop-up per § Screens. The viewer's info panel shows the project (or "No
   project") and the photo's albums.

### Verify
- [ ] [AC-12] `test:browser` at phone and desktop viewports: land on Photos, reach Albums and Projects, open a no-project photo.
- [ ] [AC-13] `test:browser`: Upload is disabled with neither set; album-only upload lands in the album; pre-fill from a project page and from an album page; create an album inline.
- [ ] [AC-8] `test:browser`: delete an album, restore it from Trash, photos still present.
- [ ] `tsc` and build pass; existing browser suite green.

### Exit criteria
On a phone and a laptop, a person can browse by date, album, or project and upload a
Christmas-party photo into a new album with no project.

## Phase 5 — Tag dropdown and select-many

### Steps
1. The tag dropdown component replaces `TagInput` in upload and edit; add the tag
   filter to Photos and the Tag group mode everywhere Date grouping exists. Typed text
   is matched ignoring case against existing AND starter tags before it is sent, so
   typing `Professional` yields `professional` even before any photo carries it.
2. Selection mode in `PhotoGrid` and the action bar per § Screens, shared by the
   Photos, album, project, and search grids.
3. Wire the actions: album add/remove and tag call the Phase 3 routes; Set project and
   Trash create one action batch with the selected ids and open `/photos/actions`
   (lift its one-photo limit in the browser; the server already pages 100 at a time).

### Verify
- [ ] [AC-14] unit: dropdown filtering, starter tags, case match; `test:browser`: add a new tag, then filter and group by it.
- [ ] [AC-15] `test:browser`, phone (press-and-hold) and desktop (tick, shift-range, date-group tick): add 3 photos to an album; tag them; Set project → confirm page lists exactly those 3 → applied; set "No project"; Trash → confirm → gone; Remove from album.
- [ ] [AC-9] selecting past 500 is refused in the bar with a plain message.

### Exit criteria
The marketing case works end to end: select photos from two projects, add them to a
new "Marketing" album, and tag them `professional`.

## Phase 6 — Folders import as albums

Must be live before the office's big import. Runs on the existing import engine.

### Steps
1. Migration (additive; apply before merge): `migration_sources.job_id` nullable;
   `migration_folders`; folder rows derived at seal; frozen at approve; prepare and
   finalize take project, tags, and album from the item's folder row (album created
   once per row, per AC-16).
2. `/migrate` review per § Screens and Decision 10, with suggestions per AC-17; the
   loose-files sheet per AC-18.
3. MCP inputs and skill text per § MCP.
4. **Import folders** opens `/migrate`; capability message per AC-20.
5. Close the import engine's row-count cliff before the big import relies on it. Found
   while building Phase 3: when `photos` was empty at the moment the content-hash index
   was built, Postgres kept planning as if the table had no rows, and sealing a
   100,000-entry inventory went from about 1.6 s to a timeout once ~1,100 photos existed
   (measured; the query plan itself was not captured). Start at
   `migration_reserve_uuids()` and the seal path: capture the plan, then fix it at the
   source (an `analyze` after large loads, or a query that does not depend on the
   estimate). Add the missing index on `migration_items.canonical_photo_id`, which makes
   every photo delete scan that table.

### Verify
- [ ] [AC-16] `test:db` + `test:browser` (the existing `migration.spec.ts` fixture tree): a 3-level tree imports with no edits; album names match paths; pause/resume, rescan, and retry make no duplicate album; an all-skipped folder leaves none.
- [ ] [AC-7] `test:browser`: a "Marketing" folder of copies yields an album of the existing photos and no new photo rows.
- [ ] [AC-17] unit: project suggestion (whole-word number match, inheritance from the nearest parent); `test:browser`: a top-level project and tag apply to sub-folders; the 5,000-row review scrolls and edits.
- [ ] [AC-18, AC-19] `test:routes` + `mcp-handoffs.spec.ts`: loose files refuse neither; `album_name`/`tags` hints pre-fill; nothing exists before confirm.
- [ ] [AC-20] `test:browser`: the entry opens `/migrate` with no token; a browser without `showDirectoryPicker` sees the message.
- [ ] Step 5: `test:db` seals a 100,000-entry inventory inside its time limit with 1,500 live photos already present and no `analyze` run by the test.

### Exit criteria
Pointing the import at a folder tree and pressing Start produces one album per
folder, and the client can find every folder by name under Albums.

## Phase 7 — Share links

The only surface reachable without a login, so it ships behind its own switch.

### Steps
1. Migration (apply before merge): `photo_share_links`, `sharing_enabled`,
   `photo_share_read`, link on/off functions.
2. Signed-in routes to turn a link on or off; public `GET /api/share/[token]` on the
   service-role client; public page `/s/[token]` with a simple grid and viewer, no app
   chrome, headers per AC-22.
3. Share pop-up on album and project pages: on/off switch, the link, Copy, and the
   Decision 12 sentence.
4. Operator: after the production checks below pass, set `sharing_enabled=true` using
   the gate procedure in `Docs/photos-runbook.md`; add a "Share links" section there
   (what the switch does, how to turn every link off at once).

### Verify
- [ ] [AC-21] `test:browser`, signed out: the page shows name, count, photos, download; the response body contains no uploader name, tag, or XMP path.
- [ ] [AC-22] `test:db` + `test:routes`: off → 404; re-enable → new token, old stays 404; unknown → 404; album A's token with a photo only in B → B's photo absent; trashed photo absent; gate closed → unavailable while `GET /api/photos` still works; both headers present.
- [ ] [AC-23] `test:browser`: the pop-up shows the limit sentence.
- [ ] [G1–G6] One end-to-end `test:browser` scenario proving the plan's goals together: import a folder tree holding a project folder, a "Christmas Party" folder, and a "Marketing" folder of copies → three albums, the party photos have no project, Marketing holds existing photos with no new rows → select across two projects, add to Marketing, tag `professional`, filter by it → share Marketing and open the link signed out.
- [ ] Security review of PR 7 recorded in the PR, per § Security and privacy.
- [ ] Production, gate still closed: `/s/<any>` is unavailable. After opening: one real album link opens in a private window; turning it off returns 404.

### Exit criteria
An employee can send a client one link to an album, and one SQL statement can turn
every link off.

## Rollout

One ship, in this order. Every migration is a timestamped file under
`dws-app/supabase/migrations/`, applied with the README convention.

1. **Before the merge — every migration except the column drop, in timestamp order.**
   They are additive or behavior-neutral for the app that is live: the open-trash
   migration (from this moment any employee can trash any photo — Decision 7), the
   stop-writing-Sheet-# migration, then the Phase 3, 6, and 7 migrations. New function
   parameters carry defaults, so the live app keeps working between this step and the
   deploy. `sharing_enabled` stays `false`.
2. **Merge, and wait until the deploy is live.** `DWS_BROWSER_ORIGIN` takes effect here.
3. **After the deploy — the column drop** (`…_photo_drop_sheet_number.sql`). It refuses
   to run if any photo holds a Sheet # value and rolls back if any function still
   names the column. It re-creates no function, so it cannot overwrite a newer one.
4. **Production checks**, then open `sharing_enabled` (see the gate paragraph below).

Rollback: before step 3, revert the PR — the new tables sit unused and a nullable
`job_id` is harmless while no project-less photo exists (afterwards Decision 1
applies). After step 3 the Sheet # column is gone (P1: no data lost). Share pages:
set `sharing_enabled=false`. Hand-off links: set `DWS_BROWSER_ORIGIN` back and redeploy.

A phase advances when its exit criteria are observed; none advances on a date. In
migration terms: making `job_id` nullable is Expand only, dropping `sheet_number` is
Contract only, and there is no dual-write or backfill because P3 means there is
nothing to convert. **Rollout gate:** the office's big import waits for Phase 6.

The `sharing_enabled` gate: scope — every `/s/<token>` page and `/api/share/*`,
nothing else; default — `false` in production and previews; who can change it — the
deployment operator by SQL that records `updated_by`, per `Docs/photos-runbook.md`;
evidence to open it — Phase 7's production check and the recorded security review;
rollback — set it back to `false`. It is a permanent off switch like the three
existing gates, not scaffolding, so it has no removal criterion.

## Risks

- **A stale open tab meets a project-less photo** and errors on `photo.job`. A reload
  fixes it; Phase 3 makes every reader null-safe before Phase 4 can create one.
- **Anyone can bulk-trash** (Decision 7). Mitigations already in place: the confirm
  page names the exact photos, 30-day restore, `deleted_by`. Signal to revisit: an
  unwanted bulk trash is reported.
- **A second large import right after the first stalls.** The row-count cliff above is
  the mechanism; Phase 6 Step 5 owns the fix and the big import waits for Phase 6 anyway.
- **A very wide folder tree** makes review slow. AC-17 sets the 5,000-row bar; the
  real shape is unknown until the office drive is inspected (Open question 2).
- **A share link is forwarded.** Accepted: that is what a link is. Decision 12's
  limit is stated in the product, and Alternative D is the named way out.

## Open questions

Neither blocks the build.

1. *needs-data* — Does the client's Mylio library carry keywords, in `.xmp` files or
   inside the image files? Evidence: the office drive inspection still open in
   `dws-hosted-mcp/plan.md` Phase 7. If yes, mapping them to tags is a small
   follow-up: `readSidecarMeta` (`dws-app/src/lib/photos/sidecar.ts`) already parses
   `.xmp` keywords during upload and discards them.
2. *needs-data* — How many folders, and how deep, is the real library? Same evidence.
   It tunes the review list, not the contract.

## Relationship to other plans

- `plans/active/photo-folders/plan.md` (shipped as PR #19): its hand-made projects,
  `P-<n>` codes, and "the MCP never creates directly" all hold. Its sentence "a photo
  already belongs to exactly one job" is replaced by Decision 1.
- `plans/active/dws-hosted-mcp/plan.md`: stays active for its open Phase 7 operator
  items. This plan changes four of its statements — the `add_photos` input (`:79`),
  sheet/tags editing (`:118`), one project per import source (`:162`), and
  uploader-or-admin delete (`:106-114`) — corrected in the PR that makes each false.
  Its non-goal "Picasa albums" holds: albums here come from folders, never from
  Picasa or Mylio metadata.
