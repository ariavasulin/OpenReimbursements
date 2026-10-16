# DWS Photos performance audit (2026-10-16)

**How to read this.** This is a read-only audit of the signed-in photo app in `dws-app`. Nothing here has been changed yet. Each finding below has an id made of its theme and a number (`SHELL-1`, `GRID-3`, ...). "Merged from" lists the ids of the area-reader findings it combines, so you can trace an entry back to the raw audit output. The prefixes mean: `query` (TanStack Query layer), `server` (API routes and SQL), `image` (image delivery), `rendering` (React renders and JS size), `upload` (phone uploads), `app` (shell, auth, navigation), `http` (caching, CDN, hosting), `viewer` (viewer, selection, bulk actions), `code` (code health), `mobile` (bad phone / bad network), `measure` (the measuring agent on the local stack), `realdb` (the production measurer: real database and live host, see section 4).
**Status** is either *confirmed*, meaning a second agent re-read the code and agreed, possibly after correcting numbers, or *unverified-low*, meaning a low-severity finding nobody double-checked. *Confirmed in production* is added when the production measurements back the finding with real numbers. **Effort:** small means under a day, medium means a few days, large means a week or more.
Within each theme, entries are listed in rank order. Ids are fixed labels, not ranks, so a later-added entry (such as DB-10) can sit above a lower-numbered one.
A few words used throughout:
- A *round trip* is one request going out and its answer coming back.
- A *derivative* is the thumbnail (640 px) or preview (2048 px) made from an original photo.
- *Memo* means `React.memo`, which lets React skip re-rendering a component whose inputs did not change.
- *Virtualization* means rendering only the rows currently on screen.
- *RSC* is the small server payload Next.js fetches when you navigate to a page.
- *Cold open* means launching the app with nothing in memory.

## 1. Summary

1. **iPhones upload PNG "thumbnails" about 15x too big, and it is getting worse** (IMG-1, confirmed in production). Safari cannot make WebP from a canvas, so it quietly makes PNG instead.
   - In production, 230 photos from 6 uploaders have PNG thumbs (564 KB on average, against 38 KB for WebP) and PNG previews (4.75 MB, against 265 KB).
   - Those photos are 12% of the library but hold 67% of all thumbnail bytes (118 of 177 MB). Scrolling one 96-photo project downloads 49 MB of thumbnails.
   - All 97 uploads made on 2026-10-16 came out as PNG.
   - It is a small fix, plus a one-off backfill of the 230 photos.
2. **Two free hosting settings are wrong** (HOST-2, HOST-1, both confirmed in production). Everyone feels both, and each fix is about one line.
   - All 3,758 thumbnail and preview files are cached for only 1 hour. Every daily revisit re-checks every tile, and a tile the CDN has dropped takes 0.8-1.0 s to start arriving instead of 62-100 ms.
   - Server functions run in Virginia (`iad1`) while the database is in Ohio. That adds a typical 10-15 ms to every database call (a published figure; the hop was not measured from inside Vercel).
3. **The grid re-renders every loaded photo on every tap, swipe and keystroke** (GRID-1, GRID-2). Phone users deep in a big project feel it as laggy taps, stuttering swipes and dropped keystrokes. The fix is mostly `React.memo` plus splitting one React context.
4. **Every cold open of the home-screen app starts from nothing.** It shows a "Verifying authentication" screen and loads about 90 KB (gzipped) of upload and viewer code it does not need yet, and nothing from the last visit is saved on the phone (SHELL-1, SHELL-2, HOST-3). The live start page references 30 JS files, 375 KB brotli. Phone users on mobile data feel this every day.
5. **Trashing a big selection takes about 150 requests, one after another** (VIEW-1). Anyone who trashes or moves hundreds to thousands of photos, especially a non-admin, waits minutes with no progress shown. It is fifth rather than second because the fix is medium effort and production shows bulk actions are still rare: the execute step has run only 29 times since statistics were last reset.

**How the evidence was gathered:** 10 code readers, 1 measurer on a small local stack, and 1 production measurer (read-only queries on the real database and signed-out requests to the live host). A skeptic agent challenged every medium and high claim before it went in.
**Caveat:** nothing was measured signed-in on production. The database queries ran under a real user's role inside rolled-back read-only transactions, but no page, API call or upload was timed through a signed-in session on the live app.

## 2. What is already good

- **Client caching:**
  - TanStack Query has sensible defaults: 5-minute staleTime, 10-minute gcTime, and no refetch on window focus (`query-provider.tsx:12-14`).
  - Going back and forth between pages makes 0 API calls (measured).
  - The cache is cleared when the signed-in user changes (`query-provider.tsx:43-60`).
- **Photo grid paging:**
  - It uses `useInfiniteQuery` with server keyset cursors. A keyset cursor means "give me rows after this one" instead of an offset.
  - The sentinel that triggers the next page has a 600 px margin and does not loop when a page fails (`infinite-sentinel.tsx:35-54`).
  - The previous grid stays on screen, dimmed, while filters change.
- **Shared list cache:** the rail, the pages and the shell share the same query keys, so TanStack sends one request for all of them. Jobs and albums fetchers pass an abort signal through.
- **Favorites are done right:** they are optimistic, patched into the cache, and do no refetch (`api.ts:378-394`). This is the pattern CODE-1 should copy.
- **URL state is cheap:** filters, sort and group are written with `history.replaceState`, so changing them causes no router round trip.
- **Read routes check auth cheaply:**
  - Hot read routes use a local `getSession` (`reads.ts:33-38`), not a call to the Auth server.
  - Middleware only matches `/`.
  - Read routes skip the gate reads.
- **Database basics are sound:**
  - Indexes exist for every list order, and keyset paging is used everywhere.
  - Measured on 50k photos: a deep photo page takes 0.04 ms and a 5,000-photo project's tag list takes 0.8 ms.
  - Row rules on photos, jobs and profiles are cheap.
- **Image basics are sound:**
  - Grids never show originals.
  - Tiles are `loading="lazy"` inside fixed square boxes, so nothing shifts as images arrive.
  - Videos use `preload="none"`.
  - `canPlayType` answers are cached.
  - Photos skip `next/image`, so they do not use up Vercel's image quota.
  - Object URLs are revoked when they are no longer needed.
- **Upload basics are sound:**
  - Hashing runs in a Worker, reading 6 MB slices.
  - TUS (the resumable upload protocol) uses 6 MB chunks, a fresh token per chunk, and bounded, jittered retries.
  - Only one image is decoded at a time.
  - The manifest is not written on progress ticks.
  - The cache is invalidated once per batch, not once per file.
  - The camera stops its tracks on close.
- **Static hosting:**
  - `/_next/static` files are `immutable` and brotli-compressed.
  - Static photos pages are prerendered and served from the CDN.
  - The photos host has no redirect.
  - sharp and ffmpeg only load in the routes that need them.
  - Photo bytes never pass through Vercel.
  - A warm reload on slow 4G showed content at 0.55 s with 12 KB transferred.
- **Selection logic:**
  - It uses Sets and refs, keeps callbacks stable across pages, and has a generation counter for late answers.
  - Bulk tag, album and favorite actions go in 500-id slices with one progress toast.
  - The zip download uses a bounded fetch pool and streams to disk where the browser supports it.
- **Other good habits:** no scroll handlers anywhere; safe-area padding is handled; pinch zoom works; the keyboard-inset hook is coalesced to one frame; React Query Devtools are not shipped; `lucide-react` is tree-shaken; `hash-wasm` is split into its own chunk; hydration is light (about 115-140 ms of long tasks at 4x CPU slowdown).
- **Production database (measured, see section 4):**
  - The photo grid query (`GET /api/photos`) returns 101 rows in 2.9-4.4 ms from `photos_captured_id` or `photos_job_captured_id`. Uploader and project lookups are cached inside the query (95/101 and 93/101 hits), favorites use `photo_favorites_pkey`, and the row rules cost almost nothing. No normal grid filter scans the whole table; only a rare-tag filter does (1,875 rows, 1.2 ms).
  - `GET /api/photos/ids`: 0.8 ms for the biggest project (170 photos, index-only count) and 3.6 ms for the first 1,000 ids of the whole library plus its exact count.
  - Project cards (`get_photo_job_summaries*`) take 5-9 ms warm; each project is one count plus a top-4 index scan.
  - Auth reads are cheap: profile 0.15 ms and release state 0.14 ms (both primary-key lookups). `photo_require_actor` is a pure read.
  - Tables are healthy: few dead rows (photos 326 of 1,875; album_photos 73 of 1,441; migration_items 273 of 1,379), and autovacuum and autoanalyze are current.
  - The whole database is 51 MB (`photos` is 3.8 MB with indexes) and sits in memory: the cache-hit ratio is 99.99%.
  - Connections cannot run out: 8 backends against a limit of 60. The app never connects to Postgres directly; both Supabase clients talk HTTPS, so pooling is PostgREST's job.
  - Indexes in real use: `photos_pkey` (547k scans), `album_photos_photo` (137k), `photos_active_display_name` (16.8k), `photos_job_created` (13.8k), `photos_captured_id` and `photos_job_captured_id` (about 1.2k each). `photos_tags_gin` and `photo_favorites_photo` have 0 scans; keep the second, because it serves deletes that cascade from photos. No missing index matters at this size.
  - The top statement by total time, `storage.search` (mean 85 ms, 3,218 calls), was an old receipts upload check removed in commit 91d9d73. It is not live; nobody needs to chase it.
  - Not a cost, but worth knowing: the `photos_sheet` index and `sheet_number` column still exist in production even though the repo has `20260920235021_photo_drop_sheet_number.sql` (schema drift).
- **Live host (measured, see section 4):**
  - `/` on the photos host is rewritten to the prerendered `/photos/projects` shell and served from the Vercel edge cache (HIT, 3.5 KB brotli, first byte in 35-56 ms warm).
  - `/_next/static` chunks are `public,max-age=31536000,immutable`, brotli, edge HIT. The web manifest is 628 bytes.
  - Storage supports range requests (206), sends ETags, and sets `access-control-allow-origin: *`.
  - Region: the production report counted the `iad1` function region as the right placement. That line is *not* carried here: `iad1` is Vercel's Virginia region (AWS us-east-1) and the database is in Ohio (us-east-2). See HOST-1.

## 3. Measurements

**Caveats, read first.**
- The local stack is a production build with a small seed (8 projects, about 32 photos, 400x300 thumbs). Treat the numbers as *shapes*: request counts, bytes, waterfalls and how cost grows. They are not real-world timings.
- Local `next start` does not gzip API JSON, but Vercel does. A 31 KB raw photo page is about 3.2 KB on the wire.
- "Phone" means iPhone 13 emulation on slow 4G (1.6 Mbps down, 750 kbps up, 150 ms RTT) with the CPU slowed 4x. Laptop micro-benchmarks will run about 4-6x slower on a mid-range phone.
- Rows marked SYNTH used fake API pages or a SQL transaction that was rolled back. The database was not changed.
- Not measured:
  - real phone CPU
  - Vercel cold starts
  - the Vercel-to-Supabase round trip (about 10-15 ms is a typical published figure)
  - Hobby quota numbers (check the Vercel pricing page)

**First-load JS (gzipped, from the build manifest).** Next's own route table undercounts photos pages because it leaves out the `/photos/layout` chunks.

| Page | First-load JS |
|---|---|
| `/photos` | ~369 KB (1.18 MB raw) |
| `/photos/projects` (PWA start page) | ~322 KB |
| `/photos/[jobId]` | ~375 KB |
| `/photos/albums/[albumId]` | ~394 KB |
| `/photos/settings` | ~310 KB |
| `/s/[token]` (public share) | ~164 KB |

| Chunk (content) | Size (gz) | Loaded on |
|---|---|---|
| supabase-js | 32 KB | every page (root layout) |
| exifr (full build) + tus-js-client | 40 KB | every photos page |
| upload-browser + derivatives | 9.6 KB | every photos page |
| camera + upload UI | 11.4 KB | every photos page |
| yet-another-react-lightbox (YARL, the viewer library) | 28 KB | grid, project, album, search |
| browser / lightbox / selection-bar app code | 23 KB | same |
| dnd-kit | 18 KB | album page only |

**Cold load.** Columns are requests, bytes transferred, then timings.

| Page | Desktop (no throttle): req / KB / LCP | Phone: req / KB / first API / LCP / settled |
|---|---|---|
| projects | 69 / 781 / 116 ms | 62 / 770 / 2.67 s / 2.88 s / 4.9 s |
| albums | 61 / 669 / 128 ms | 58 / 658 / 2.68 s / 3.25 s / 4.3 s |
| grid | 78 / 1,039 / 448 ms | 73 / 1,004 / 2.75 s / 4.05 s / 5.9 s |
| project | 69 / 710 / 448 ms | 60 / 697 / 2.77 s / 3.84 s / 4.3 s |

- On the phone, first paint is at 884 ms and shows only "Verifying authentication". The header and cards appear at about 3.0 s.
- After hydration, all API calls on a page start within 20 ms of each other, so there is no waterfall in the browser.
- Server times measured with curl: `actor` 27-34 ms and `settings` 23-27 ms (both call `getUser`), compared with photos/jobs/tags at 4-6 ms.

**Viewer.** Opening one photo loads 5 previews, 751 KB in total. On the phone the tapped photo finished *last* in one run (3.8 s) and second in another (2.6 s of 3.7 s).

**Navigation.**
- Revisiting a page makes 0 API calls.
- Focus, visibility and online events trigger 0 refetches.
- The Projects page fires 8 RSC prefetches of `/photos/<jobId>`, one per card. Each is about 190 B and marked no-store.
- A project or album page is rendered dynamically on every request.

**Scale (SYNTH).**
- Grid, 20 pages of 100 photos (phone, 4x CPU): the render cost per new page grows from about 60 ms at 100 tiles to about 250 ms at 1,900 tiles. There were 20 long tasks totalling 2.4 s, and 14.8k DOM nodes at 2,000 tiles.
- Interaction time going from 100 to 2,000 tiles: tick-select 72 → 296 ms, tap-select 24 → 152 ms, Esc clear 32 → 232 ms, open viewer 96 → 432 ms, close viewer 40 → 296 ms.
- 2,000 projects: 10 project-list requests run one after another before anything renders. First card at 4.3 s, compared with 2.9 s for 200 projects.
- SQL at 2,000 jobs / 50k photos: the project summary page function costs 27 ms per page and recomputes every job each time.
- Laptop micro-benchmarks (jsdom, M5 Pro):
  - PhotoGrid at 1,000 photos: mount 187 ms, one-tick re-render 30 ms, 7,537 elements.
  - PhotoGrid at 5,000 photos: mount 471 ms, one-tick re-render 159 ms, 37,673 elements.
  - `groupPhotos(date)` on 5,000 photos: 93-111 ms as written, about 2.4-7 ms with a cached formatter.
  - Sorting 3,000 projects: 5-8 ms.

**Images.**

| Item | WebP q80 | PNG (what WebKit makes) | JPEG q80 |
|---|---|---|---|
| 640 px thumb (12 MP phone JPEG) | ~31-47 KB | ~495-605 KB | ~43 KB |
| 2048 px preview | ~180-223 KB | ~3.8-5.4 MB | ~363 KB |
| Other sizes (WebP mean) | 1600 px 140 KB · 1280 px 93 KB · 400 px short side 23 KB · AVIF 640 17 KB | | |

- In WebKit 26.6, both `toBlob` and `convertToBlob` with `'image/webp'` return `image/png`.
- In production storage, real WebP thumbs average about 38 KB and PNG thumbs average about 564 KB. PNG thumbs are 67% of all thumb bytes.
- Pixels sent compared with pixels shown, at 640 px: about 2.6x on a phone grid tile, about 13.7x on a desktop tile, and about 5.5x (phone) to 50x (desktop) on a project cover cell.

**Production headers** (read-only curl):
- Functions run in `iad1` (Washington DC) per `x-vercel-id: sfo1::iad1::…`. The Supabase project is in `us-east-2` (Ohio).
- Storage objects are served with `cache-control: max-age=3600`.
- `GET /api/photos` returns `public, max-age=0`, while `/api/photo-albums` returns `no-store` and `Vary: Cookie`.
- The ffmpeg binary is packaged into `/api/photos/repair` only, not `/api/photos/[id]/derive`.
- Selecting 5,000 ids is about 195 KB of JSON raw, about 104 KB gzipped.

## 4. Production measurements

**Where these come from.** Measured on 2026-10-16 (about 17:40 UTC), read-only, against the real Supabase database (Postgres 15.8 in us-east-2, holding 1,875 photos and 98 users) and the live host `photos.design-workshops.app`, from San Francisco.
- Every SQL batch ran inside `begin transaction read only; … rollback;`. So that row rules applied as they do in the app, queries ran as the `authenticated` role with a real user's id, set for that transaction only. Nothing was written to the database or storage.
- Host and storage requests were made signed out with curl. Nothing was measured through a signed-in session.
- `pg_stat_statements` is Postgres's running tally of each statement's calls and times. It has not been reset since 2025-08-04, so its numbers are totals since then, and they include the receipts app.
- The production findings are listed under "Merged from" with a `realdb-` prefix.

**Table sizes.** The whole database is 51 MB and 99.99% of reads come from memory, so the timings below are CPU work, not disk reads. The `photos` storage bucket holds 5,955 files (17 GB).

| Table | Live rows | Total size |
|---|---|---|
| photos | 1,875 (1,745 active, 130 in trash, 12 videos) | 3.8 MB |
| migration_items | 1,379 | 4.6 MB |
| album_photos | 1,441 | 512 KB |
| photo_upload_attempts | 578 | 1.7 MB |
| user_profiles | 98 | 72 KB |
| jobs (projects) | 65 | 88 KB |
| albums | 27 | 32 KB |
| photo_favorites | 6 | 40 KB |

**Hottest photo statements** (pg_stat_statements totals). "Blocks/call" is how many 8 KB pages each call touched.

| Statement | Calls | Mean ms | Max ms | Blocks/call | Finding |
|---|---|---|---|---|---|
| `get_photo_album_summaries_by_name_page` (Albums list) | 116 | **102.7** | 941 | 11,594 | DB-10 |
| `photo_bulk_tag` | 32 | 105.3 | — | — | — |
| `photo_execute_action` (one bulk-action step) | 29 | 67.7 | — | — | VIEW-1 |
| `get_photo_job_summaries_by_number_page` (Projects list) | 280 | 67.1 | 1,321 | 1,113 | DB-4, DB-11 |
| `photo_finalize_upload` | 1,884 | 40.7 | 2,918 | 285 | DB-11 |
| photos list, album filter (`albums!inner`) | 106 | 24.1 | 396 | 4,762 | DB-2 |
| `get_photo_tags` | 903 | 21.9 | 1,613 | 315 | DB-6 |
| photos list, no filter | 75 | 18.9 | 352 | 217 | — |
| `photo_claim_content` | 1,922 | 11.9 | 728 | 103 | — |
| `migration_counts` | 1,711 | 8.5 | 1,164 | 205 | UP-10 |
| photos list, project filter | 341 | 3.6 | 108 | 91 | — |
| `photo_require_actor` | 14,199 | 0.66 | 260 | 12 | DB-1 |

The gap between mean and max on routine reads is DB-11. PostgREST also reloads its schema cache after every migration (a 396 ms query, 123 times so far); that is Supabase-internal.

**List-query plans** (EXPLAIN ANALYZE, warm, run as a signed-in user's role). "Buffers" counts 8 KB pages read.

| Query | Rows | Buffers | Exec ms | How Postgres reads it |
|---|---|---|---|---|
| Photos, no filter, first page | 101 | 232 | 3.1-3.6 | index `photos_captured_id` |
| Photos, one project (170 photos) | 101 | 261 | 2.9 | index `photos_job_captured_id` |
| Photos, tag `Shop` (156 photos) | 101 | 1,047 | 4.4 | date index, 1,030 rows filtered out; the tag (GIN) index is never used |
| Photos, rare tag | 0 | 183 | 1.5 | whole-table scan (1,875 rows) |
| Photos, cursor at row 1,600 | 101 | 1,599 | 3.8 | 1,696 rows filtered out (DB-3) |
| Same, plus `captured_at <= cursor` | 101 | 341 | 3.3 | index starts at the cursor |
| Album of 26 photos, date order | 26 | 8,671 | 9.4-9.7 | walks all 1,745 active photos (DB-2) |
| Same album through `album_photo_order` | 26 | 318 | 0.51 | album index, then photo lookups |
| Album of 369 photos, date order | 101 | 3,306 | 6.3 | walks 600 photos |
| `get_photo_album_summaries` (22 albums) | 22 | 19,539 | 15-16 | 4 photo lookups per membership (DB-10) |
| `get_photo_job_summaries` (41 projects) | 41 | 1,457 | 4.7-5.3 | one count plus a top-4 index scan per project |
| Select-all ids, whole library | 1,000 + count | 327 | 3.6 | date index plus an index-only count |
| `get_photo_tags` | — | 887 | 3.9-5.7 | unpacks the tags of every active photo (DB-6) |

Planning adds 2-3 ms on a fresh connection.

**Auth round trips per upload** (DB-1). Every write and upload step runs `requirePhotoActor`, which makes 4 network round trips in a row: Auth `getUser`, then 3 PostgREST requests.

| What | Production count | Mean database time |
|---|---|---|
| `photo_require_actor` calls | 14,199 | 0.66 ms |
| `photo_release_state` reads | 14,199 | 0.08 ms |
| profile reads (`role, deleted_at, photo_admin`) | 14,073 | 0.11 ms |
| finalized uploads (`photo_finalize_upload`) | 1,884 | 40.7 ms |
| **Actor checks per finalized photo** | **about 7.5** | |
| **Auth round trips per finalized photo** | **about 30** (7.5 × 4) | |

The database time is under 1 ms per check, so the round trips are the whole cost.

**Live host** (signed out, from San Francisco, 3 runs each).

| URL | Served from | First byte (TTFB) |
|---|---|---|
| `/` and `/photos/projects` | prerendered shell, edge cache HIT, 3.5 KB brotli | 35-116 ms (35-56 ms warm) |
| `/login` | rendered per request in `iad1`, `no-store` | 117-124 ms (SHELL-8) |
| `/api/photos`, `/api/photo-jobs` (401, signed out) | function in `iad1` | 113-149 ms |

| Page | JS files | JS on the wire (brotli) | JS raw | Other |
|---|---|---|---|---|
| `/photos/projects` | 30 | 375 KB (334 KB without the old-browser polyfills) | 1.15 MB | CSS 17 KB brotli; 2 preloaded fonts, 29.3 KB + 23.1 KB |
| `/login` | 13 | 227 KB | 724 KB | — |

The largest start-page chunks are 55.6, 46.3, 41.9 and 32.7 KB brotli. Each static file takes 34-87 ms to fetch (median 42 ms).

**Thumbnails and previews** (storage metadata for all 1,875 photos, plus live fetches).

| Derivative | Stored as | Files | Average | Median |
|---|---|---|---|---|
| thumb | WebP | 1,422 | 38 KB | 37 KB |
| thumb | **PNG** (IMG-1) | 230 | **564 KB** | 584 KB |
| thumb | WebP labelled `application/octet-stream` | 223 | 37 KB | 36 KB |
| preview | WebP | 1,422 | 265 KB | 245 KB |
| preview | **PNG** (IMG-1) | 230 | **4.75 MB** | 4.92 MB |
| preview | WebP labelled `application/octet-stream` | 223 | 267 KB | 238 KB |

- Folder-imported photos (1,220, made by sharp on the server) average 37 KB thumbs and 263 KB previews. Browser uploads (525) average 250 KB thumbs and 2.06 MB previews, because of the PNGs.
- Across the library, the 95th-percentile thumb is 605 KB and the 95th-percentile preview is 5.17 MB.

| Cache behaviour (HOST-2) | Value |
|---|---|
| `cache-control` on every derived file (3,758 files) | `public, max-age=3600` |
| First byte on a CDN miss (Cloudflare) | 0.80-0.97 s |
| First byte on a CDN hit | 62-100 ms |
| Revalidation (`If-None-Match`, answered 304) | 90 ms |
| Range request (`Range: bytes=0-1023`) | 206, 64 ms |

## 5. Findings, ranked

Severity counts: **3 high, 26 medium, 35 low** (64 entries after merging duplicates). The production measurements confirmed 7 entries with real numbers (IMG-1, HOST-1, HOST-2, DB-1, DB-2, DB-3, DB-6), added numbers to 8 more, and added 3 new ones (SHELL-8, DB-10, DB-11). No severity changed.

### 5.1 First load and shell

#### SHELL-1 · Cold opens show only "Verifying authentication" until all JS has loaded and the session check finishes
- **Severity** medium · **Effort** small for step 1, large for step 3 · **Status** confirmed · **Merged from** rendering-8, app-1, measure-auth-gate-blank, query-8, mobile-1 (part).
- **Who / when:** phone users on mobile data, on every cold open of the home-screen app and every reload.
- **Today:**
  - PhotosShell returns `<AuthLoading/>` until `useSessionGuard` sets `ready`. That only happens after `supabase.auth.getSession()` runs in an effect, after hydration (`photos-shell.tsx:47,108-110`; `use-session-guard.tsx:18-39`). The shell's own queries wait on `ready` too (`photos-shell.tsx:74-80`).
  - The prerendered `projects.html` contains only that text: no tab bar, header or cards.
  - Middleware matches only `/` (`middleware.ts:23`). So once the 1-hour access token has expired, `getSession` has to refresh it over the network (`GoTrueClient.js:833`).
- **Why it costs:** each step waits for the one before it. Most of the 2.7 s comes from JS download and hydration (SHELL-2). This finding is about *perceived* speed: nothing app-shaped appears on screen until then.
- **Do this:**
  1. In PhotosShell, render the chrome (tab bar, header, grey skeleton tiles) while `ready` is false, and gate only `children`.
     - Use the `desktop:` CSS variants instead of `useDesktop()` for the chrome. `useDesktop()` is false during server rendering, so the chrome would otherwise flash the phone layout on desktop (`use-desktop.ts:12-20`; `photos-shell.tsx:129,131,156`).
     - PhoneHeader is rendered by each page (`projects/page.tsx:52`). Either move it into the shell or draw a skeleton of it.
     - Move the Suspense in `photos/layout.tsx:35-43` so it wraps only `{children}`.
     - Gate the SectionsRail queries on `ready` (`sections-rail.tsx:67-68`).
  2. Optional: start the first queries in parallel with `getSession`. API routes authenticate from the cookie (`authority.ts:24-25`).
     - The gain is small. The token refresh already starts as soon as the root chunk loads (`supabaseClient.ts:24-27`; `GoTrueClient.js:134,1446-1450`).
     - It also risks client and server refreshing the same token at once (`supabaseServerClient.ts:30-40`).
  3. Later: make the landing pages server components that prefetch into `HydrationBoundary`. The server branch of `query-provider.tsx:22-24` already creates a QueryClient per request. This makes those routes dynamic, so do HOST-3 first.
- **Gain:** the app frame paints at about 0.9 s instead of about 3.0 s on slow 4G. Step 3 would put the cards themselves in the HTML.
- **Risk:** low-medium. A signed-out visitor briefly sees the chrome before the redirect, and the `?next=` redirect must keep working.

#### SHELL-2 · About 90-110 KB (gzipped) of upload engine and viewer code loads before it is needed
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** rendering-6, rendering-7, app-3, mobile-2, measure-eager-js, upload-8, viewer-9.
- **Who / when:** phones on every first load, and again after each deploy that changes these chunks. Upload code loads on every photos page. Viewer code loads on the grid, project, album and search pages.
- **Today:**
  - **Upload code:**
    - `photos/layout.tsx:40-41` wraps every page in UploadShell. From there, `upload-manager.tsx:22-30` statically imports `./upload` and `./upload-browser`, which pull in `exif.ts:1` (the full exifr build) and `upload-tus.ts:1` (tus-js-client).
    - `upload.ts:6` imports the *value* `RESUMABLE_THRESHOLD_BYTES` from `upload-tus.ts`. That one import keeps tus in the bundle by itself.
    - `photos-shell.tsx:13-21,180-202` statically imports and always mounts the camera, the upload sheet and the new project/album sheets.
  - **Viewer code:**
    - `photo-browser.tsx:9,438` statically imports PhotoLightbox and always mounts it.
    - PhotoLightbox imports YARL plus 7 plugins (`photo-lightbox.tsx:6-20`).
  - No client code anywhere uses `import()` or `next/dynamic`.
- **Measured:**
  - Upload chunks: 61 KB gz / 192 KB raw. Viewer chunks: 51 KB gz / 155 KB raw.
  - On the phone, the YARL chunk is the last script to finish (2.49 s) before the first API call (2.75 s).
  - Production: the live `/photos/projects` start page references 30 JS files, 375 KB brotli (1.15 MB raw), against 227 KB for `/login`.
- **Do this:**
  1. In `upload-manager.tsx`, replace the static imports with `await import('./upload')` and `await import('./upload-browser')` inside the runner and retry callbacks (`:198,234,341-343,387`). Nothing calls these at render, so this is a drop-in change.
  2. Move `RESUMABLE_THRESHOLD_BYTES` and `TUS_CHUNK_BYTES` out of `upload-tus.ts` into a module that does not import tus.
  3. In `exif.ts`, switch to `exifr/dist/lite.esm.mjs`. Do **not** use the mini build: it has no HEIC parser, and HEIC files do reach this code (`batch.ts:27`). Lite saves about 11 KB gz.
  4. Load PhotoLightbox with `next/dynamic({ssr:false})` and mount it only once a photo has been opened. Keep `useRegisterSlideshow` in a small static wrapper so the header's Play button still works (`photo-lightbox.tsx:416`). Start the chunk download on idle or on a tile's pointerdown, and make sure `?photo=` deep links still open.
  5. Load the camera and upload sheet with `next/dynamic`. Keep DropZone static, because it must be mounted to catch a drag.
- **Gain:** about 90-110 KB gz (about 25-30%) less JS before first paint on grid pages. On slow 4G that is about 0.4-0.5 s sooner to the first data request, plus less parse time on cheap Android phones.
- **Risk:** low. The first upload or first viewer open pays for one chunk download unless it is prefetched.

#### SHELL-3 · The public share page ships the signed-in app's supabase-js, React Query and toaster
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** rendering-11.
- **Who / when:** outside clients opening `/s/<token>` on phones.
- **Today:** the root layout wraps everything in QueryProvider (which imports the Supabase browser client) and the Sonner Toaster (`app/layout.tsx:5-6,48-57`; `query-provider.tsx:6`). SharedGallery imports only react and lucide (`shared-gallery.tsx:3-5`).
- **Why it costs:** about 45-50 KB gz, roughly 30% of the share page's 164 KB, is code the page never uses.
- **Do this:** move QueryProvider and the Toaster out of `src/app/layout.tsx` into the photos, receipts and migrate layouts. A route group makes this a one-line move per area.
- **Gain:** share links open faster for clients. **Risk:** low-medium. Every non-share route must still get the provider.

#### SHELL-4 · No early connection to the Supabase host, so the first thumbnail also pays connection setup
- **Severity** low · **Effort** small · **Status** confirmed (as part of mobile-1) · **Merged from** image-8, app-9, http-5, mobile-1 (part).
- **Who / when:** phones on a cold first load.
- **Today:**
  - Every image URL is on `<project>.supabase.co` (`urls.ts:13-15`). Nothing in `src` adds a preconnect hint, and `photos/layout.tsx:36-46` has none.
  - The browser only opens that connection when the first `<img>` appears, after the API answers.
- **Why it costs:** setting up DNS, TCP and TLS takes 2-3 round trips, about 200-500 ms on 4G.
- **Do this:** in `src/app/photos/layout.tsx` and the share page, call `ReactDOM.preconnect(process.env.NEXT_PUBLIC_SUPABASE_URL)` or render `<link rel="preconnect">`. Leave out `crossorigin`, because images are fetched without it.
- **Gain:** the first thumbnail appears about 0.2-0.5 s sooner on cold mobile loads. **Risk:** none of note.

#### SHELL-5 · Geist Mono (23 KB) is preloaded on every page and never used
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** app-12, mobile-11, measure-unused-mono-font.
- **Who / when:** phones on first load, where it competes with critical JS in the first second.
- **Today:** `app/layout.tsx:14-17` loads `Geist_Mono`, preloaded by default. The only reference to it is `globals.css:12`, and nothing uses `font-mono`. It was measured as preloaded at t=176 ms. The live start page also preloads two fonts, 29.3 KB and 23.1 KB; the second matches this font's size.
- **Do this:** remove `Geist_Mono` and the `--font-mono` mapping, or set `preload:false`. First check that no receipts screen uses `font-mono`.
- **Gain:** 23 KB less on the critical path. **Risk:** none found.

#### SHELL-6 · After the code is typed, login adds a fixed 500 ms wait, an extra query and a full page reload
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** app-10, mobile-12.
- **Who / when:** phone users signing in (new device, expired session).
- **Today:**
  - `login/page.tsx:209-215` waits on `setTimeout(...,500)`.
  - `:39-59` runs `needsNamePrompt`, a second query to `user_profiles`.
  - `:101,246` call `window.location.replace`, a full reload that throws away the JS the browser just loaded.
  - `setSession` (`:196-199`) checks the token with Supabase.
- **Do this:** have `/api/auth/verify-otp` return `needsName`, and drop the 500 ms timeout and the client query. Navigate with `router.replace(...)` and prefetch `/photos/projects` while the code is being typed.
- **Gain:** about 0.5-1.5 s faster from tapping Verify to seeing Projects. **Risk:** low. Test both the photos and receipts hosts.

#### SHELL-7 · The session guard re-checks the session and re-subscribes on every navigation
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** app-11.
- **Who / when:** every tap between `/photos` pages, a small CPU cost each time.
- **Today:** `use-session-guard.tsx:52` depends on `[pathname]`, so every navigation re-runs `getSession()` (`:28-39`) and tears down and recreates the `onAuthStateChange` listener (`:41-47`). QueryProvider already has a listener of its own (`query-provider.tsx:55-57`).
- **Do this:** run the guard once per shell mount (`[]` deps) and keep the SIGNED_OUT redirect. It already reads `window.location` at the moment it redirects (`:21-26`), so `?next=` stays correct.
- **Gain:** one auth lock, one cookie parse and one resubscribe fewer per tap. **Risk:** very low.

#### SHELL-8 · `/login` is rendered on the server for every visit, only to pick the tab title
- **Severity** low · **Effort** small · **Status** confirmed in production · **Merged from** realdb-login-dynamic.
- **Who / when:** phone users signing in for the first time or after their session ends. Rare, because sessions last a long time.
- **Today:**
  - `login/layout.tsx:9` reads `headers()` inside `generateMetadata` to decide whether the tab says "DWS Photos". Reading headers makes the whole route dynamic.
  - Production: `/login` comes back `private, no-cache, no-store`, `x-vercel-cache: MISS`, rendered in `iad1`. First byte takes 117-124 ms from San Francisco, against 35-56 ms for the edge-cached `/photos/projects` shell.
- **Do this:** decide the title in the browser instead. The page already calls `isPhotosHost(window.location.hostname)` (`login/page.tsx:24`), so the layout can become static.
- **Gain:** about 60-80 ms off the first byte for West Coast users, more for users farther from Virginia.
- **Risk:** low, but it is a trade-off to confirm with the owner. The comment at `login/layout.tsx:5-7` says the photos tab title is meant to be right "from the first byte"; done in the browser, the generic title may show for a moment.

### 5.2 Lists and the grid

#### GRID-1 · Every photo tile re-renders on every tick, page load and viewer swipe
- **Severity** high · **Effort** small (memo), medium if every step below is done · **Status** confirmed · **Merged from** rendering-1, rendering-3, viewer-3, code-3, mobile-3 (part), query-7 (part), measure-grid-rerender-scaling.
- **Who / when:** phone users once a few hundred photos are loaded (pages hold 100 each, `apiShared.ts:20`). Worst after scrolling deep into a project with thousands of photos, or during a long slideshow, which keeps loading pages.
- **Today:**
  - **Nothing is memoized:**
    - `Tile`, `TileGrid` and `PhotoGrid` are plain functions (`photo-grid.tsx:89,257,285`). Nothing in `src` uses `memo(`, and the React Compiler is not on (`next.config.ts`).
    - Every Tile receives the whole `selection` object, which is rebuilt on every change to `selectedIds` (`use-photo-selection.ts:91-142`; `photo-browser.tsx:306-309`). Each tile then reads `selectedIds` itself (`photo-grid.tsx:103-104`).
    - `onOpenPhoto` and `onExpandPinned` are new inline functions on every render (`photo-browser.tsx:408,412-414`).
    - Each Tile runs `useLongPress`, which builds a new handlers object each render (`use-long-press.ts:25-58`), plus 3-4 `cn()` calls.
    - Each TileGrid creates its own `usePhotoActor()` observer (`photo-grid.tsx:268`).
  - **Viewer swipes re-render the grid:**
    - Each swipe calls `setOpenPhotoId`, which is state inside PhotoBrowser (`use-photo-deep-link.ts:146-175`).
    - It then calls `replaceState` with `?photo=` (`:19-25,92`). That updates `useSearchParams`, so the project page (`[jobId]/page.tsx:36`) and `useBrowseState` (`use-browse-state.ts:24`) render a second time.
    - The slideshow keeps loading pages as it plays (`photo-lightbox.tsx:385-391`), so this gets worse the longer it runs.
  - **Page appends render twice:** each append also re-renders twice because of `setSeen` (`photo-browser.tsx:196-198`).
- **Why it costs:** the work grows with the number of loaded photos, not with what changed. SYNTH measurements going from 100 to 2,000 tiles: tick-select 72 → 296 ms, open viewer 96 → 432 ms, close viewer 40 → 296 ms. A laptop one-tick re-render takes 159 ms at 5,000 photos.
- **Do this:**
  1. Wrap `Tile` in `React.memo` and give it simple props instead of the selection object: `selected: boolean`, `selecting: boolean`, and stable callbacks.
  2. Pull `onToggle` and `onToggleGroup` out of the memo that depends on `selectedIds`. They only read refs, so this is safe (`use-photo-selection.ts:55-89`).
  3. Wrap `onOpenPhoto` and `onExpandPinned` in `useCallback`, and wrap `PhotoGrid` in `memo`. `groups` and `gridSelection` are already memoized, so swipes then skip the grid without moving any state. Moving `openPhotoId` out of PhotoBrowser is not needed.
  4. Call `usePhotoActor` once in PhotoGrid and pass the result down.
  5. Memoize by the `photo` object itself, not by group. `groupPhotos` rebuilds every group on each page (`group.ts:89-127`).
- **Gain:** a tick or swipe re-renders 1-2 tiles instead of all of them. The first tick and Clear still re-render every tile once, because each tile shows its checkbox. Interaction times stay near the 100-tile numbers at any scroll depth.
- **Risk:** low. Check shift-click ranges, group ticks and favorites against the existing selection tests.

#### GRID-2 · Typing in search, starting a selection, or opening the upload sheet re-renders the open page and its whole grid
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** rendering-2, app-6, code-2, mobile-3, query-7.
- **Who / when:** typing in the search box (the phone header on `/photos`, `phone-header.tsx:40`, and the desktop top bar, `top-bar.tsx:25`), starting or ending a selection, opening or closing the desktop viewer, and any change to the capture batch.
- **Today:**
  - `photos-shell.tsx:92-106` builds a new context value object, with new closures, on every render. It holds `query` and `debouncedQuery` (`:55-65`) next to the actions.
  - Pages call `usePhotosShell()` only to get `openPicker` (`photos/page.tsx:12`, `[jobId]/page.tsx:39`, `albums/[albumId]/page.tsx:62`). So every keystroke re-renders the page, then PhotoBrowser, then every tile.
  - `useCaptureBatch` keeps 6 more pieces of state in the shell (`use-capture-batch.ts:21-41`).
  - `setSelecting` (`selection-bar.tsx:200-204`) and the desktop-only `setViewerOpen` (`photo-lightbox.tsx:279-284`) each cause a second full grid pass.
  - `scope={{kind:"all"}}` and the `empty` JSX are new on every render (`page.tsx:19-20`), so `memo(PhotoBrowser)` alone would not stop this.
- **Why it costs:** about N+1 full grid renders for N keystrokes. The 250 ms debounce fires once per pause in typing. Each render costs time proportional to the tiles loaded.
- **Do this:**
  1. Split the context in two:
     - an **actions** context: the open* functions, `setQuery`, `setSelecting`, `setViewerOpen`, built with `useCallback`/`useMemo`, and with `uploadTarget` kept in a ref;
     - a small **search** context, `{query, debouncedQuery}`, read only by SearchBox and the search page.
  2. Move the query state into its own small provider, so keystrokes also stop re-rendering TopBar, SectionsRail, the sheets and the rest of the shell.
- **Gain:** typing re-renders only the search box. Selection start and viewer open cost one grid pass instead of two.
- **Risk:** low. The change is mechanical across about 12 `usePhotosShell` callers.

#### GRID-3 · Date grouping builds a new date formatter for every photo, on every page
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** rendering-4, code-5.
- **Who / when:** phones scrolling with date grouping, the default on Photos and albums (`photo-browser.tsx:92`). Project pages default to grouping by tag.
- **Today:**
  - `group.ts:97-112` calls `toLocaleDateString('en-US',{...})` for every photo, even when that day's group already exists (`append`, `:23-35`).
  - `photo-browser.tsx:190-193,249-257` re-flattens and regroups every loaded photo on each page.
  - The same pattern appears in `shared-gallery.tsx:13,68` and `trash/page.tsx:21`.
- **Why it costs:** measured in Node at 5,000 photos: 96-111 ms as written, against 1.4-7 ms with one cached formatter. Because every page regroups everything, the total cost grows with the square of photos loaded.
- **Do this:**
  1. Add a module-level `Intl.DateTimeFormat`, the same way `format.ts:70-90` already does.
  2. Compute the label only when a new date key appears (check `map.has` before calling `append`).
  3. Apply the same fix to the share gallery and the trash page.
- **Gain:** grouping drops from about 100 ms to a few ms per 5,000 photos. **Risk:** very low; the labels stay identical.

#### GRID-4 · No virtualization: every loaded photo stays in the page
- **Severity** medium · **Effort** small (step 1), medium-large (step 2) · **Status** confirmed · **Merged from** rendering-5, measure-grid-rerender-scaling.
- **Who / when:** phones deep in a project with thousands of photos. Memory pressure can make iOS reload the tab and lose the scroll position.
- **Today:**
  - `photo-grid.tsx:257-283,329-380` renders every tile. Nothing in `src` uses react-virtual or `content-visibility`, and the infinite query keeps every page it has loaded.
  - Each tile is about 7.4 DOM nodes plus one `<img>`. At 5,000 tiles that is about 37,673 elements, with a mount time of 471 ms on a laptop.
  - On desktop, each group header is sticky with backdrop blur (`:337`).
- **Do this:**
  1. Add `content-visibility:auto` to each group `<section>`, with `contain-intrinsic-size: auto <estimate from photo count × columns>`. Each sticky header lives inside its own section, so the headers keep working.
  2. Later, virtualize by rows with `@tanstack/react-virtual` on `#photos-scrollport`. Do GRID-1 first, so the rows are cheap to render.
- **Gain:** layout, paint and memory stay roughly flat whatever the project size. **Risk:** step 1 is very low. Step 2 is medium: shift-click ranges, group ticks, focus restore (`photo-lightbox.tsx:476-483`) and the sentinel all need checking.

#### GRID-5 · Project and album lists are downloaded in full, page after page, wherever any part of them is needed
- **Severity** medium · **Effort** small for parts 1-3, large for part 4 · **Status** confirmed · **Merged from** query-2, code-6, app-7, measure-collections-drain.
- **Who / when:**
  - The search typeahead (every debounced prefix).
  - A cold project page, which waits for the whole list just to show its own name.
  - The Photos and search grids, which load the full list for the Project filter even if it is never opened (`photo-browser.tsx:122,208`).
  - Albums at real scale: the folder importer can create one album per folder. Projects are only "a few dozen" (`photo-jobs/route.ts:10`), so the 2,000-project case is synthetic.
- **Today:**
  - `collectPages` loops one page after another until done (`collectionPagination.ts:17-36`), and is used by `fetchJobs` and `fetchAlbums` (`api.ts:67-76,232-241`).
  - The consumers override staleTime to 60 s (`api.ts:93,249`).
  - The project page and the shell `.find()` one job out of the full list (`[jobId]/page.tsx:47-48`; `photos-shell.tsx:74-76`). There is no GET for a single project (`photo-jobs/[id]/route.ts` only has PATCH and DELETE).
  - The typeahead downloads every match and then shows 5 (`search-box.tsx:17,29-32`).
  - On the server, each page call recomputes summaries for every job before applying LIMIT (`20261014120000_photo_list_order.sql:33-61`). The inner function has `set search_path`, which stops Postgres from folding it into the outer query (`20260907100410_photo_active_reads.sql:16`).
  - The albums route makes a second query on every page (`photo-albums/route.ts:35,43`).
- **Why it costs:** SYNTH at 2,000 projects: 10 sequential requests, first card at 4.3 s, about 27 ms of database time per page. Even at today's size, the header, the typeahead and the filter menu all wait on the heaviest list query.
  - Production, warm: one Projects list page takes 8-23 ms for 41 visible projects, and one Albums list page 20-47 ms for 22 albums (the album side is DB-10). Production averages are 67 ms and 103 ms, with spikes to 1.3 s and 0.9 s (DB-11). Every typeahead prefix and filter menu pays this.
- **Do this** (cheapest first):
  1. Add `fetchJobsPage`/`fetchAlbumsPage` with `limit = SUGGESTION_LIMIT+1` for SearchBox.
  2. Add `GET /api/photo-jobs/[id]` and a `usePhotoJob(id)` hook, seeded from the `['photo-jobs','']` cache, for the project header and the shell.
  3. Load the Project filter options only when the chip opens.
  4. Later, apply the keyset cursor and LIMIT to jobs/albums *first*, then compute counts and thumbs for just those rows, and add server-side ordering for each sort mode. The Sort chip currently sorts the whole list in the browser (`collection-sort.ts:1-4,33-80`).
- **Gain:** the typeahead goes from a full download per keystroke to one small request. Headers stop depending on list size. Database work per page goes from all collections to one page.
- **Risk:** medium for part 4 only. The sort order must match what the browser sort does today.

#### GRID-6 · An album page waits for the album header before it starts loading photos
- **Severity** medium · **Effort** small (option b) · **Status** confirmed · **Merged from** query-4.
- **Who / when:** phones on mobile data, on the first open of an album in a session (or more than 10 minutes after leaving it). A cached but stale header does not cause the wait.
- **Today:**
  - `albums/[albumId]/page.tsx:63,211-218` mounts PhotoBrowser only after `usePhotoAlbum` resolves, because `defaultSort` comes from `album.sort_mode`.
  - `usePhotoAlbum` has no placeholder data (`api.ts:268-281`).
  - `PhotoAlbumSummary` has no `sort_mode` (`types.ts:89-100`).
  - The header route does its own auth check plus 3 queries (`photo-albums/[id]/route.ts:15-29`).
- **Why it costs:** one extra full round trip, about 300-600 ms on mobile, before any thumbnail can start.
- **Do this:** option (b): add `sort_mode` and `has_custom_order` to the album list RPC rows, and seed `usePhotoAlbum` with `placeholderData` from the `['photo-albums','']` cache. Option (a), having the server pick the album's sort when none is given, needs the photos response to report which order it used (`browse-state.ts:80,124`; `photo-browser.tsx:137,248`), so it is medium effort.
- **Gain:** opening an album takes one round trip instead of two when you come from Albums or the rail. **Risk:** low.

#### GRID-7 · Ticking one photo fetches up to 5,000 ids just to label "Select all", and bulk actions fetch them again
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** query-3, viewer-4.
- **Who / when:** each selection start, and each filter change while selecting. Only scopes with more than 4,000 matches pay the full 5-query walk and about 100 KB gzipped.
- **Today:**
  - `photo-browser.tsx:263-266` turns the ids query on as soon as `selectedIds.size > 0`.
  - The route does `count:'exact'` plus up to 5 sequential 1,000-row steps (`ids/route.ts:46-58`). The early break at `:58` keeps small scopes cheap.
  - Before a click, the result is only used for the label and an `every()` check (`selection-bar.tsx:183-189`).
  - `done()` and `trash()` invalidate while the selection is still active, so a second full walk runs and is thrown away. `fetchPhotoIds` has no AbortSignal (`api.ts:63-65`).
  - Production shows the SQL itself is cheap: 0.8 ms for the biggest project and 3.6 ms for the first 1,000 ids of the whole library plus its count. The cost here is the sequential requests and the bytes, not the database.
- **Do this:**
  1. Add a `?count=1` mode for the label.
  2. Fetch the ids lazily in the "Select all" click with `queryClient.fetchQuery(idsQuery(listParams))`, the same pattern as group ticks (`photo-browser.tsx:236-246`). Show a spinner on the button.
  3. Skip keys ending in `'ids'` when invalidating.
  4. The count-only answer cannot tell exactly when everything is already selected, so accept that the link may sometimes show unnecessarily.
- **Gain:** a typical selection costs one cheap count. **Risk:** low.

#### GRID-8 · No data prefetch when a user is about to open a project
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** query-5.
- **Who / when:** the first open of a project. Repeat opens within 10 minutes are already served from cache.
- **Today:**
  - Nothing in the photos code calls `prefetchQuery` or `prefetchInfiniteQuery`.
  - The grid's query key and fetcher are built inline in the component (`photo-browser.tsx:94-108,173-181`).
  - The card and rail links have no pointer or touch handlers (`collection-card.tsx:132`; `sections-rail.tsx:37-55`).
- **Do this:**
  1. Move the key and fetcher into `photoListOptions(scope, filters, sort)` in `api.ts`.
  2. On `onPointerEnter`/`onFocus`/`onTouchStart`, call `prefetchInfiniteQuery` for `{kind:'job'}` with `NO_FILTERS` and `'desc'`. A fresh project's key is predictable (`browse-state.ts:146-160`).
  3. For albums, prefetch only `['photo-album',id]` (see GRID-6).
  4. Do not prefetch just because a card is visible on screen.
- **Gain:** about 200-400 ms head start on desktop hover, and about 50-150 ms on phones. **Risk:** low.

#### GRID-9 · The Projects page renders every project card at once, each with its own media-query listener
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** rendering-10.
- **Who / when:** opening Projects (the start page), once the project count grows into the hundreds.
- **Today:**
  - `projects/page.tsx:73` maps over the full list. Albums already pages at 60 (`albums/page.tsx:23,75,87-95`).
  - Every card calls `useDesktop()` (`collection-card.tsx:50`), which starts as false and flips in an effect, so on desktop every card renders twice.
- **Do this:** page projects at 60 the way Albums does. Use one shared `useSyncExternalStore` media query (see CODE-6).
- **Gain:** the start page's render cost stays bounded. **Risk:** low. Check that shift-range selection works across pages (`use-collection-select.ts:31,50-51`).

### 5.3 Images

#### IMG-1 · iPhone and Safari uploads store PNG thumbnails (~560 KB) and previews (~4.7 MB) under `.webp` names
- **Severity** high · **Effort** small (fix), small-medium (backfill) · **Status** confirmed, and confirmed in production · **Merged from** image-1, upload-1, measure-webkit-png-derivatives, realdb-iphone-png-derivatives.
- **Who / when:**
  - Every iOS uploader. All iOS browsers use WebKit, which cannot encode WebP from a canvas (WebKit bug 226950, closed WONTFIX).
  - Everyone, on any device, who views those photos: the grid, cards, share page and viewer.
  - It is getting worse: PNG share of browser uploads by day was 17/17 on 10-13, 99/155 on 10-14, 17/280 on 10-15 and 97/97 on 10-16.
- **Today:**
  - `scaleToWebp` asks for `image/webp` on both the OffscreenCanvas and `<canvas>` paths and never checks what comes back (`derivatives.ts:151-180`; the comment at `:165-166` admits a PNG may come back).
  - `uploadDerivative` uploads whatever `body.type` is (`upload.ts:366-370`).
  - The SQL fixes the stored names as `_thumb.webp`/`_preview.webp` (`photo_albums.sql:144,255`).
  - The bucket has no MIME limit (`review_fixes.sql:229-232`).
  - The grid and viewer serve those files directly (`photo-grid.tsx:176`; `urls.ts:13-43`).
  - Video posters made on iPhones go through the same path (`derivatives.ts:135-138`).
  - The test mock defaults to PNG, so no test catches this (`derivatives.test.ts:31`).
  - The repair sweep only fills *missing* derivatives (`sweep.ts:94,101`), so existing PNGs are never repaired.
- **Measured locally:** WebKit 26.6 returns PNG: thumbs 495-605 KB and previews 3.8-5.4 MB, against WebP at 31-47 KB and 180-223 KB.
- **Measured in production** (storage metadata plus live fetches):
  - 230 photos from 6 uploaders have PNG derivatives. PNG thumbs average 564 KB (WebP: 38 KB) and PNG previews 4.75 MB (WebP: 265 KB), so about 15x and 18x.
  - The 210 active PNG thumbs (12% of active photos) hold 118 MB of the library's 177 MB of thumbnail bytes (67%).
  - Project 4118: 96 of 96 photos PNG, 49.2 MB of thumbnails. Project 4060: 50 of 50 PNG, 29.7 MB. The default grid's first page (newest 100) has 17 PNG thumbs and 12.1 MB of thumbnails in total.
  - A live sample: `…/4b4c51d4-…_thumb.webp` is served as `content-type: image/png`, 451,488 bytes (PNG magic bytes `89504e47`); its preview is 3,450,510 bytes and took 1.06 s on a cold fetch.
  - Related: 223 more photos (2 uploaders, 10-13 to 10-15) have real WebP files stored as `application/octet-stream`. Browsers sniff and display them correctly, but the label is wrong. Their cause was not traced.
- **Why it costs:**
  - About 4-5 MB extra upload per iPhone photo, roughly 47 s more at 750 kbps.
  - A 30-tile grid of iPhone photos is about 16 MB instead of about 1.4 MB.
  - Opening the viewer on such a photo loads about 19 MB.
  - The desktop filmstrip also loads these previews (`photo-lightbox.tsx:720`).
- **Do this:**
  1. In `scaleToWebp`, probe once whether the browser can encode WebP (a 1x1 canvas, result cached), or simply check `blob.type` after encoding. If it is not WebP, encode as `image/jpeg` at quality 0.8 (about 40-70 KB for a thumb and about 300 KB for a preview). Keep the `.webp` key names; browsers go by the Content-Type header, not the file name.
  2. The affected rows are already counted in production: 230 photos. Re-check right before the backfill, because new ones arrive daily until step 1 ships:
     `select count(*) from storage.objects where bucket_id='photos' and name like 'derived/%' and metadata->>'mimetype'='image/png'`.
  3. Backfill with a small one-off script that calls `fillImageDerivatives` (`repair/transforms.ts:160`) for those photo ids. It already uploads with `upsert:true`, and sharp makes real WebP. Route video rows through `makeVideoPoster` (`derive/route.ts:58`). Include the 223 `application/octet-stream` photos so they come back labelled `image/webp`.
  4. Do this together with HOST-2, because browsers may keep showing the old PNG for up to an hour.
- **Gain:** about 15x fewer bytes per grid tile and about 18x fewer per viewer slide for iPhone photos, and about 5 MB less upload per iPhone photo. In today's library that is about 115 MB less; project 4118's grid drops from about 49 MB to about 4 MB, and the default first page from 12.1 MB to about 4 MB.
- **Risk:** low. JPEG has no transparency, which photos do not need.

#### IMG-2 · One 2048 px preview serves every screen; phones would be fine with about 1280 px
- **Severity** medium · **Effort** large · **Status** confirmed · **Merged from** image-4. Has a paid option.
- **Who / when:** phones on mobile data, on every viewer slide and slideshow step, mainly for landscape photos.
- **Today:**
  - Only two sizes exist: 640 and 2048 px (`derivatives.ts:9-10`; `transforms.ts:15,124`).
  - The slides set only `src`, with no `srcSet` (`photo-lightbox.tsx:293-321`).
  - `PhotoRow` has no width or height (`types.ts:34-35`), and YARL needs both for every `srcSet` entry (`yarl index.js:715-728`).
  - The derived file names are fixed in SQL (`photo_repair.sql:161`).
- **Why it costs:** a landscape slide is 223 KB where 93 KB would do. Decoding a 2048x1536 image takes about 12.6 MB of memory, against about 4.9 MB at 1280, and YARL decodes neighbouring slides too.
- **Do this** (after IMG-1 and VIEW-2):
  1. Store width and height at upload (the bitmap already has them at `derivatives.ts:41`).
  2. Add a `_screen.webp` derivative at 1280 px in both pipelines, the SQL path checks and `PATH_COLUMNS` (see IMG-3 for why that matters).
  3. Build each slide with `srcSet [{screen,1280w},{preview,2048w}]` so pinch-zoom upgrades to 2048 (`zoom/index.js:453-480,541`). Portrait photos would still pick 2048 because the choice is made by width.
  4. **Paid alternative:** Supabase image transforms (Pro plan plus a fee per image) can serve a 1280 version without storing a new file. The project already calls them in `transforms.ts:53-55`. Width and height must be stored either way.
- **Gain:** about 40-58% fewer viewer bytes on phones, and less decode memory.
- **Risk:** medium: a schema change, a new derivative in two pipelines, and a backfill.

#### IMG-3 · Grid, card and desktop thumbnails are larger than the boxes they fill
- **Severity** low · **Effort** small (lower the constant), medium (new size) · **Status** confirmed · **Merged from** mobile-8, image-6, measure-thumb-overdelivery.
- **Who / when:** project and album cover mosaics (cells about 78-85 CSS px), desktop tiles at normal pixel density, and phone grids.
- **Today:**
  - A single 640 px thumb serves every surface (`derivatives.ts:9`; `photo-grid.tsx:176,270`; `collection-card.tsx:69-81`; `album-arrange.tsx:86`).
  - The code's own comment says it was sized for an about 190 px tile at 2x, which needs about 380 px (`derivatives.ts:17`).
  - The thumbs have no `decoding="async"`.
- **Why it costs:** about 2.6x the needed pixels on a phone grid tile and up to about 50x on desktop cover cells, so more bytes and more decode memory.
- **Do this:**
  1. Do IMG-1 first: PNG thumbs dwarf this cost.
  2. The cheapest option: lower `THUMB_MAX_DIM` to about 400-480 px. One file per photo, no `srcset`. `action-thumbnail.tsx:18` will look slightly soft in its 320 px box.
  3. If you add a separate `_grid.webp` instead, it **must** get a database column added to `PATH_COLUMNS` (`repair/known-paths.ts:11-19`). The sweep deletes any file no column points to (`sweep.ts:119`).
  4. Add `decoding="async"` to the tile and card `<img>` tags.
- **Gain:** about 25-50% fewer grid bytes for new uploads. **Risk:** low for lowering the constant. A new derivative must be tracked in `PATH_COLUMNS`, or the sweep deletes it.

### 5.4 Viewer and bulk actions

#### VIEW-1 · Trashing or moving a big selection makes about 150-250 requests, one after another
- **Severity** high · **Effort** medium · **Status** confirmed · **Merged from** viewer-1, server-3.
- **Who / when:** anyone who trashes or moves 1,000-5,000 selected photos (`MAX_SELECTION_PHOTOS`, `apiShared.ts:49`). It is worst for a non-admin selecting other people's photos, which costs about one extra request per refused photo.
- **Today:**
  - **Trash** (`selection-bar.tsx:227-233` → `trash-now.ts:15,24-55`): create, then about 50 materialize calls of 100 each (`actions.ts:107`), then approve, then for every 100 photos a GET page plus a POST apply. That is about 152 sequential requests.
  - **Move** goes through `/photos/actions` at 50 per page (`photo-actions.tsx:24,93-100,159-168`; `set-project-sheet.tsx:51-58`), about 250 requests.
  - **Every response repeats the whole selection:** `getActionBatch` uses `select('*')` (`actions.ts:41`), so each one echoes the full selector, about 255 KB for 5,000 ids. That is about 10-25 MB repeated over one trash.
  - **Every request is expensive:** `requirePhotoActor` (`authority.ts:24-40`), a batch-actor RPC (`actions.ts:78`), and an exact-count reference query while in draft (`:80-87`).
  - **The 100 cap exists in four places:** SQL `photo_materialize_action` (`20261012182335`), SQL `photo_execute_action` (`photo_actions.sql:117`), `actionIds` (`actions.ts:194`) and `actionPage` (`:19`).
  - **The client cannot tell what is refused:** unloaded photos count as trashable on the client (`permissions.ts:52-55`).
  - **No progress shown:** Trash shows nothing while it runs (`selection-bar.tsx:139`), and Undo runs the whole pipeline again (`:245`).
- **Why it costs:** at about 300-500 ms per request on mobile, a 5,000-photo trash takes about 1-1.5 minutes and a move about 2 minutes, with no progress and the tab kept open.
  - Production adds database time on top: `photo_execute_action` averages 67.7 ms per call, so the 50 apply steps of a 5,000-photo trash spend about 3.4 s in the database alone.
  - Production also shows bulk actions are rare so far: that step has run only 29 times since statistics were last reset. The severity stays high for the move to about 100 users, but it is no longer the second item in the Summary.
- **Do this:**
  1. Add one server route, `POST /api/photo-actions/run {action, photo_ids}`. It filters out ids the actor may not touch with one `.in()` query, then runs create, materialize, approve and execute in slices on the server. This follows the existing chain in `DELETE /api/photos/[id]` (`route.ts:53-56`).
  2. Point `runPhotoAction` at it, in slices of 1,000 ids per call to stay under the function time limit.
  3. Separately, select explicit columns without `selector` in `readActionBatch`.
  4. Give Trash the same `sendInSlices`-style progress toast.
- **Gain:** about 1-5 requests and a few KB instead of about 150 requests and MBs. A non-admin's mixed selection goes from thousands of requests to one.
- **Risk:** medium. Keep the same SQL functions so the rules and the audit trail stay in SQL. Test with the largest allowed selection.

#### VIEW-2 · Opening the viewer downloads 5 full previews at once, and the tapped photo often arrives last
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** image-3, viewer-8, measure-viewer-preload-contention, mobile-9.
- **Who / when:** phones on mobile data, on every viewer open and every swipe faster than the network. The desktop filmstrip is affected too.
- **Today:**
  - **5 previews per open:**
    - `photo-lightbox.tsx:659` sets `{finite:false, padding:0}`, so YARL's default `preload: 2` applies (`index.js:154`). The library then mounts the current slide plus 2 on each side (`:122-123,1327-1330`).
    - Slides carry only the 2048 px preview (`photo-lightbox.tsx:292-299`; `urls.ts:40-43`).
  - **The cached thumbnail is never used:** the 640 px grid thumb is already in cache (`photo-grid.tsx:175-176`), but the viewer never shows it.
  - **A spinner first:** YARL hides the image and shows a spinner from about 0.8 s (`index.js:731-734`; `styles.css`).
  - **The desktop filmstrip shows previews:** with no `slide.thumbnail`, it renders the full previews in its 120x80 cells (`thumbnails/index.js:40-44`). These are the same URLs, so the cost is decoding, not extra bytes.
- **Measured:** 751 KB per open. The tapped photo finished last at 3.8 s in one run.
- **Do this** in PhotoLightbox:
  1. Add `render.slideContainer` (or `render.slide`) that draws the cached thumb at contain-fit behind the preview, and set `render.iconLoading: () => null`. The placeholder must not catch taps: use `data-tap="photo"` or `pointer-events:none` (`:213-225`), and hide it once the preview loads.
  2. Set `carousel.imageProps: (slide) => ({fetchPriority: current ? 'high':'low', decoding:'async'})` (`index.js:729`).
  3. Set `carousel.preload: 1` on phones.
  4. Set `thumbnail: publicUrl(thumb_path)` on each slide.
  5. Do **not** use a thumb+preview `srcSet` for this. The browser picks one image and, on 2x/3x phones, picks the 2048 one.
- **Gain:** a recognisable image the instant the viewer opens, the tapped preview sharp in about 1 s instead of 2.6-3.8 s on slow 4G, and about 40% fewer bytes per open.
- **Risk:** low. With preload 1, a very fast double swipe briefly shows the thumbnail.

#### VIEW-3 · The share-link viewer shows a black screen on every Next until the preview arrives
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** image-5.
- **Who / when:** outside clients on `/s/<token>`, mostly on phones, on every Next or Previous tap.
- **Today:** the viewer renders `<img key={current.id} src={current.preview_url}>` on a black stage (`shared-gallery.tsx:88,93-98`). The key remounts the image on each step, nothing preloads the neighbours, and there is no spinner. The grid already loaded `thumb_url` (`:73`, lazily).
- **Why it costs:** about 1-2 s of black per photo (about 4.7 MB for iPhone PNG previews until IMG-1 lands), on the page clients see.
- **Do this:** put `current.thumb_url` behind the preview as a contain-fit background on the stage div (`:91`). Preload `photos[open±1]` previews with `new Image().src` in an effect keyed on `open`.
- **Gain:** an instant image on each step. **Risk:** low; it is one self-contained component.

#### VIEW-4 · On phones, Safari and Firefox, zip download builds the whole zip in memory; the only warning is at 2 GB
- **Severity** medium · **Effort** small (threshold), medium (service-worker streaming) · **Status** confirmed · **Merged from** viewer-2, mobile-13.
- **Who / when:** iOS Safari above all, when downloading a few hundred originals or any videos.
- **Today:**
  - Without `showSaveFilePicker`, the target is a blob (`zip-save.ts:32,41`), and `await new Response(zip).blob()` collects everything before saving (`:109`).
  - 4 whole originals are fetched at once (`:14,60-64`; `zip-download.ts:94-98`).
  - The warning threshold is 2 GiB on every device (`zip-download.ts:17`; `selection-bar.tsx:976,1024-1027`).
  - `beforeunload` (`:875`) does not prompt on iOS.
- **Why it costs:** iOS can kill the tab well below 2 GB, which wastes all the mobile data spent and saves nothing. The plan already accepts this risk (`plan.md:148-150,666-667`).
- **Do this:**
  1. On the blob path, warn at about 300-500 MB with phone-specific wording ("this phone may run out of memory"), and suggest splitting the selection. Update `zip-download.test.ts:77-80`.
  2. Later, stream through a service worker using client-zip's documented pattern. Test it on a real iPhone first.
- **Gain:** large phone downloads stop failing silently. **Risk:** low for step 1.

#### VIEW-5 · Sizing a zip download walks the whole list again, then fetches leftover photos one by one
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** viewer-5, code-9.
- **Who / when:** Download after "Select all", which fills ids the grid has not loaded, or a selection carried over from another filter.
- **Today:**
  - `findRows` pages through `GET /api/photos` from page 1, 200 rows per request, one after another, with no page cap (`zip-download.ts:123-155`).
  - Each page carries every photo column plus the favorites join (`photos/route.ts:68-71`), but the zip needs only 6 fields.
  - Missing ids are then fetched with one `GET /api/photos/[id]` each, 6 at a time (`selection-bar.tsx:858-863`).
  - Closing the sheet does not stop the work (`selection-bar.tsx:942-959`; `api.ts:48-50` has no signal).
- **Why it costs:** 25 or more sequential heavy requests, possibly followed by thousands of single requests, just to show a size.
- **Do this:**
  1. Add `POST /api/photos/rows {photo_ids}`, 500 ids per call using `inChunks` (`chunks.ts`; `apiShared.ts:42`), returning only the zip fields. Or add a `fields=zip` mode to `/api/photos/ids`, which already walks the list 1,000 rows at a time (`ids/route.ts:43-56`).
  2. Use it in `findRows`, and pass an AbortSignal from the effect cleanup.
  3. Update `zip-download.test.ts`.
- **Gain:** 1-10 small requests and about a second to show the size. **Risk:** low.

#### VIEW-6 · Album Arrange loads up to 2,000 full rows and every thumbnail at once, and its drag library ships on every album visit
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** viewer-7, rendering-12.
- **Who / when:** whoever curates an album. dnd-kit (18 KB gz) loads on every album open.
- **Today:**
  - `album-arrange.tsx:62-76` loads 200 full rows per request, serially.
  - `:85-90` `<img>` tags have no `loading="lazy"`.
  - `:116-120,285-290` every tile is a sortable.
  - It is a static import at `albums/[albumId]/page.tsx:9`.
  - Cancel does not abort requests already sent (`api.ts:48-50`).
- **Do this:**
  1. Add `loading="lazy" decoding="async"` to `TileFace`.
  2. Load `AlbumArrange` with `next/dynamic`.
  3. Later, load the order from `/api/photos/ids?album=&sort=custom` plus a small lookup of thumbnail fields.
- **Gain:** only visible thumbs load, and about 18 KB gz comes off every album open. **Risk:** low.

#### VIEW-7 · Each tick rebuilds lookup maps over every loaded photo and re-renders five closed sheets
- **Severity** low · **Effort** small-medium · **Status** unverified-low · **Merged from** viewer-10, code-14.
- **Who / when:** phones while selecting in big grids.
- **Today:**
  - `photo-browser.tsx:274-285` builds a Map over all loaded photos in `sharedJobId`; `scope` is a new object on every page render.
  - `permissions.ts:49-51` (`trashableIds`) builds another Map.
  - `selection-bar.tsx:179` runs `[...selectedIds]` on every render, and `:185` an `every()`.
  - `:611-655` keeps five sheets always mounted, each receiving a new `ids` array. The file is 1,034 lines.
- **Do this:**
  1. Build one `photosById` Map in PhotoBrowser keyed on `photos`, and pass it to both `sharedJobId` and `trashableIds`.
  2. `useMemo` the `ids` copy.
  3. Mount each sheet only when `sheet === key`, and split the sheets into their own files.
- **Gain:** per-tick work no longer grows with the number of loaded photos. **Risk:** low.

### 5.5 Uploads

#### UP-1 · Each photo makes about 5-6 API calls one after another before and after its bytes move
- **Severity** medium · **Effort** medium (merge calls), small (parts 2-3) · **Status** confirmed · **Merged from** upload-2, mobile-6 (part).
- **Who / when:** phone uploaders on mobile data, for every photo. Server invocations grow with photos × users.
- **Today:**
  - `upload.ts` awaits each call in turn:
    - twin `:267` (project uploads only)
    - attempt `:284`
    - acquire `:294` (always runs for a fresh attempt, `server/uploads.ts:71`)
    - claim `:308`
    - original-file probe `:322`
    - finalize `:388`
    - derive `:409` (when the phone made no previews)
  - Each call is its own route (`upload-browser.ts:27-33`; `upload-http.ts:120-121`), and each runs `requirePhotoActor` (DB-1).
  - Inside the server, the probe runs 3 calls in sequence (`server/uploads.ts:190-193`), and finalize runs lock → original size → derived sizes → finalize → select (`:119,147,150,162,166`).
- **Why it costs:** about 1-2 s of handshakes per photo on LTE (estimated). Uploads run one at a time (UP-2), so for a 50-photo batch that is about 35-65 s of idle network.
  - Production counts point the same way and slightly higher: about 7.5 actor-checked calls per finalized photo (14,199 actor checks against 1,884 finalized uploads; retries and folder imports are included). `photo_finalize_upload` itself averages 40.7 ms in the database, with spikes to 2.9 s (DB-11).
- **Do this:**
  1. Merge attempt, acquire, claim and probe into one `/api/photo-migrations/uploads/begin` route that calls the same SQL functions in the same order.
  2. Skip `probeOriginal` when `uploadOne` created a fresh identity (`upload.ts:274-278`). Uploads use `upsert:true`, so at worst the bytes are sent again (`upload-tus.ts:144`).
  3. In `finalizeUpload`, start `objectSize(original)` alongside the derived-size checks.
  4. Do DB-1 and HOST-1.
- **Gain:** about 2 calls per photo instead of 6, about 0.7-1.3 s saved per photo, and about 60% fewer function invocations.
- **Risk:** medium for step 1. The lease and claim protocol is delicate, so keep the server order identical. Steps 2-3 are low risk.

#### UP-2 · Uploads run strictly one file at a time, so the CPU and the network take turns sitting idle
- **Severity** medium · **Effort** medium · **Status** confirmed · **Merged from** upload-3, mobile-6.
- **Who / when:** phone uploaders, on any batch of more than a few photos.
- **Today:**
  - `upload-manager.tsx:188-234` is a sequential runner.
  - Inside `uploadOne`, these steps all happen before the original transfer at `:349`: hash `:223`, EXIF `:324`, previews `:326-341`, handshakes.
  - Thumbnail and preview uploads wait for the original to finish (`:379-382`; the order is deliberate, see the comment at `:347`).
  - The `/migrate` importer already runs two uploads at once (`migration/engine.ts:64-66,186-192`), and the hash pool is already sized 2 (`hash.ts:9,75`).
  - `inFlight` is a single ref (`upload-manager.tsx:129,142,372-374`).
- **Do this:**
  1. Split `uploadOne` into *prepare* (hash, read capture date, derivatives) and *transfer + commit*.
  2. Prepare file N+1 while file N transfers, holding at most one prepared file so only one decoded image is in memory.
  3. Optionally allow 2 transfers at once for files under 6 MB, copying the importer's `pairs()`. This needs `inFlight` turned into a map keyed by photo id.
- **Gain:** about 15-30% shorter batches on LTE (estimated), and more on Wi-Fi. **Risk:** medium, mainly in the cancel and remove bookkeeping.

#### UP-3 · Losing signal turns the rest of the batch into "Failed", one retry budget at a time
- **Severity** medium · **Effort** medium · **Status** confirmed · **Merged from** upload-4, mobile-10.
- **Who / when:** phones in dead spots (basements, job sites), and anyone who locks the phone or switches apps mid-batch.
- **Today:**
  - Nothing in `src` listens for `visibilitychange`, `pagehide`, `online`/`offline`, or uses `wakeLock`.
  - A thrown fetch becomes a retryable `network_error` (`upload-http.ts:126-128`). Each file gets 5 tries with jittered waits of up to 3/6/12/20 s (`:70-72,105`), about 20 s on average, then fails (`upload.ts:421-424`).
  - The runner then moves straight to the next file (`upload-manager.tsx:262-275`).
  - Retry is per row only (`upload-tray.tsx:111-117`; `upload-queue.ts:136-138`).
  - Each failed file has still been fully hashed first (`upload.ts:222-223`).
  - If iOS kills the tab, the queue comes back as "interrupted" and every file must be re-picked (`upload-queue.ts:198-226`).
- **Do this:**
  1. On a `network_error` failure, pause the queue and keep retrying the *same* item with backoff. Treat the `offline`/`online` events only as hints, because iOS reports "online" when there are bars but no data.
  2. Add a "Retry all" button to UploadTray.
  3. While the queue is active, request `navigator.wakeLock` (feature-detected) and show "Keep DWS Photos open while uploading". A wake lock stops the screen dimming; it does not stop iOS suspending the tab if the user locks the phone or switches apps.
- **Gain:** a dead spot pauses the batch instead of failing it, and it resumes by itself. **Risk:** low.

#### UP-4 · Browser-made previews decode every photo at full size on the main thread, with only a file-size limit
- **Severity** medium · **Effort** medium · **Status** confirmed · **Merged from** upload-5, mobile-5, image-9 (browser part).
- **Who / when:** phones during uploads, worst with 48-200 MP camera modes, whose JPEGs still fit under 24 MB.
- **Today:**
  - `derivatives.ts:41` calls `createImageBitmap(file)` with no resize, which is about 48 MB at 12 MP and about 192 MB at 48 MP.
  - `:47-50,136-139` scales both sizes from that full bitmap.
  - `:160-168` draws on the calling thread, which is the React runner (`upload.ts:332`).
  - The only limit is `canDecodePreview`, at 24 MB of *file size* (`decode-limits.ts:4,11-13`).
  - `readCapture` returns no dimensions (`upload.ts:231,324`).
  - Hashing already runs in a worker (`hash.worker.ts`), which is the pattern to copy.
- **Do this:**
  1. Make the 640 thumb from the 2048 preview instead of the original. This is trivial.
  2. Add a pixel limit (about 40 MP) next to `DERIVATIVES_MAX_BYTES` that falls back to the existing `deriveOnServer` (`upload.ts:406-409`). This needs the image dimensions from EXIF or the file header.
  3. Move `makeImageDerivatives` into a worker that uses OffscreenCanvas, keeping the main-thread path as a fallback.
- **Gain:** no scroll jank during uploads, and no tab crashes on high-megapixel photos. **Risk:** low-medium. Check that EXIF orientation still comes out upright.

#### UP-5 · Server-made previews block the queue; the server decodes twice and downloads whole videos for one frame
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** upload-6, image-9 (server part).
- **Who / when:**
  - Every phone video over 24 MB, which is most clips longer than about 10-20 s, because the 24 MB limit applies to videos too (`decode-limits.ts:4,11-13`).
  - RAW and TIFF files, HEIC on Android, and failed browser decodes.
  - The `/migrate` importer stalls the same way.
- **Today:**
  - `upload.ts:406-414` awaits `deriveOnServer` inside `uploadOne`, so the next file waits.
  - `transforms.ts:110,115-124` runs two separate sharp pipelines on the original.
  - The video poster downloads the whole video, up to 200 MB, to `/tmp` (`executor.ts:68-75`; `transcode.ts:20,85-95`).
  - The derive route already clears the warning in the database (`derive/route.ts:65-71`).
- **Do this:**
  1. Fire derive without awaiting it, after the outcome is recorded, and refresh that row when it settles.
  2. Render the preview once and make the thumb from it, or use `sharp().clone()`.
  3. Let ffmpeg read the public URL with `-ss` so it fetches only the byte ranges it needs. Keep the full download as a fallback for MP4s with the index (moov atom) at the end.
- **Gain:** no queue stalls (several to tens of seconds per such file), about half the server CPU for non-JPEG files, and a few MB of egress per poster instead of the whole video. **Risk:** low.

#### UP-6 · The upload sheet strip uses full-resolution originals for 56 px squares
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** upload-7, mobile-4, image-10.
- **Who / when:** phones picking 30-100 photos.
- **Today:**
  - `upload-sheet.tsx:27-31` creates an object URL of the full file for every image.
  - `:176-191` shows them in a horizontal strip with no `decoding="async"`.
  - Browsers only decode the roughly 6-7 tiles they actually paint, so the claimed tab crash is unlikely. The real cost is full-size decodes while scrolling the strip.
  - The camera stack uses the same pattern (`multi-shot-camera.tsx:167,258-265`).
- **Do this:** add `decoding="async"` (`loading="lazy"` does little for blob URLs). Do not build thumbnails up front for every file, because that decodes every original eagerly. If needed later, build small ones only for the visible tiles.
- **Gain:** less jank while scrolling the strip. **Risk:** low.

#### UP-7 · Most phone photos show no progress: the bar sits at 0% then jumps to done
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** upload-9.
- **Who / when:** every photo of 6 MB or less, which is most phone JPEG and HEIC files.
- **Today:** only TUS uploads (files over 6 MB) report progress (`upload-tus.ts:19-20`; `upload.ts:85,343-346`). The row reads "Uploading..." at 0% (`upload-progress.tsx:65-68`), with no visible stage during hashing, preview making or finalize.
- **Do this:** add a `stage` field (preparing / sending / finishing) to `QueueItem`, dispatch it from `uploadOne`, and show it in `statusLabel`.
- **Gain:** the batch no longer looks frozen, and fewer users cancel and retry. **Risk:** low.

#### UP-8 · Large-file progress re-renders the tray and the sheet on every network event
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** code-8, upload-10, rendering-13 (upload part).
- **Who / when:** phones during TUS uploads (files over 6 MB).
- **Today:**
  - Every `onProgress` dispatches an update with no throttle (`upload-manager.tsx:244-247`).
  - The reducer maps over every item (`upload-queue.ts:113-121`).
  - The manager's context value is rebuilt on every render (`upload-manager.tsx:323-413`).
  - UploadSheet re-renders even though it only uses `enqueue` (`upload-sheet.tsx:163`).
  - Rows are keyed by index (`upload-progress.tsx:84-86`).
- **Do this:**
  1. Dispatch progress only when the whole percent changes, or at most about 4 times a second.
  2. Split a stable actions context so the sheet stops re-rendering.
  3. Key rows by `photoId`.
- **Gain:** a few renders per second instead of tens. **Risk:** low.

#### UP-9 · A new hash worker per file, and a new Supabase client per storage upload
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** upload-11.
- **Who / when:** phones, on every upload multiplied by batch size.
- **Today:** `hash.ts:47,76-78` creates a worker and its WASM instance per file. `upload-storage.ts:51-63` calls `createClient` 3 times per photo. That call builds no GoTrue auth client when given `accessToken` (`SupabaseClient.js:62-72`), so its cost is only local allocation.
- **Do this:** keep one long-lived hash worker (recreate it only on cancel), and build the storage client once per factory.
- **Gain:** a small saving in CPU and garbage collection per photo. **Risk:** low.

#### UP-10 · The folder importer waits for a full status reload, with three whole-batch counts, after every file
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** code-7.
- **Who / when:** office desktop users running `/migrate` on large folders.
- **Today:**
  - `engine.ts:48-50,66-67` awaits `changed()` before the next pair of files starts.
  - `migrate/page.tsx:281-288` invalidates caches and awaits `refresh`, which reads the batch view and an item page in parallel (`client.ts:72-77`).
  - The batch view runs `readPhotoBatch`, then the actor check, then `migration_counts`, which does three aggregates over the whole batch (`migrations.ts:213-223`; `photo_migrations.sql:214-224`). An index keeps each of these at a few ms.
  - Production: `migration_counts` has run 1,711 times, averaging 8.5 ms with a worst case of 1,164 ms. So a typical refresh is cheap in the database; the cost is that the next file waits for it.
  - Each byte tick re-renders the 543-line page (`page.tsx:289,364`).
- **Do this:** stop awaiting `onChange` in the upload loop, and throttle the refresh to every 2-3 s plus once at the end. `run()` already fetches fresh counts before marking the batch complete (`engine.ts:80-86`).
- **Gain:** about 15-40% faster imports of small JPEGs. **Risk:** low.

### 5.6 Server and database

#### DB-1 · Every write and every upload step first makes 4 back-to-back auth calls
- **Severity** medium · **Effort** small · **Status** confirmed, and confirmed in production · **Merged from** server-1, http-2, app-4, realdb-actor-check-round-trips.
- **Who / when:**
  - Every mutation and every upload step. The code shows about 4-5 per photo; production counts show about 7.5 actor checks per finalized photo (14,199 checks against 1,884 finalized uploads).
  - About 15 less-used GET routes: trash, migrations, share, exists.
  - The busy read routes (photos list, jobs, albums, tags, detail) use the cheap `requirePhotoReader` and are not affected (`reads.ts:33-38`).
- **Today:**
  - `authority.ts:24-40` runs four calls in a row: `getUser` (a network call to Supabase Auth), then the `user_profiles` select, then the `photo_require_actor` RPC, then the `photo_release_state` read.
  - The last three need only the user id.
  - Write RPCs check the gate and actor again inside SQL (e.g. `photo_import_albums.sql:244`; `photo_albums.sql:105,133`).
  - Read routes also check the writes gate, so closing writes also blocks those reads (`:40`).
- **Measured in production:** the database work per check is under 1 ms (`photo_require_actor` 0.66 ms mean, release state 0.08 ms, profile read 0.11 ms). The round trips are the whole cost: about 7.5 × 4 = 30 sequential auth round trips per uploaded photo.
- **Why it costs:** two avoidable round trips per request, about 20-45 ms from `iad1` (see HOST-1; the hop was not measured from inside Vercel). At 7.5 checks per photo that is about 0.15-0.35 s per uploaded photo.
- **Do this:**
  1. After `getUser`, run the other three calls with `Promise.all`, then check the results in the current order.
  2. Better: one SECURITY DEFINER RPC, `photo_actor_context(p_actor)`, returning role, `photo_admin`, the ban/deleted checks and the gate flags (or have `photo_require_actor` return them). `photo_require_actor` alone does not return role today, so the profile read cannot simply be dropped.
  3. Optional and needs a deliberate decision plus a security review: `auth.getClaims()` with asymmetric signing keys checks the token locally. It is available in the installed auth-js (`GoTrueClient.js:2014`). The comment at `authority.ts:18` says remote verification is intended, so do not make this swap quietly.
- **Gain:** 4 waits become 2 (or 1). **Risk:** low for steps 1-2. Step 3 touches the security boundary.

#### DB-10 · The Albums list reads every album membership four times on each call; it is the slowest photo read in production
- **Severity** medium · **Effort** small · **Status** confirmed in production · **Merged from** realdb-album-summaries-cost.
- **Who / when:** every load of the Albums page, plus every other caller of `/api/photo-albums`: the rail, the album picker, and the importer's album choice (`album-choice.tsx`; `api.ts`). The cost grows with the total number of photos in all albums, so 100 users building albums will multiply it.
- **Today:**
  - `get_photo_album_summaries` (`20260921024651_photo_albums.sql:505-547`) has two `LEFT JOIN LATERAL`s, one for the count and latest date and one for the 4 cover thumbs. Each joins `album_photos` to `photos` separately.
  - The `album_photos_select` row rule adds one more `photos` lookup per membership on each side, so every membership costs 4 photo lookups.
  - Measured in production: the inner query does 1,438 + 1,335 + 1,438 + 1,335 lookups, 18,596 buffers, 13.4 ms. The full function takes 15-16 ms and 19,539 buffers as a signed-in user, against 10.7 ms without row rules (the row rules add about 40%). The paged version used by the Albums page takes 20-47 ms and 20,074 buffers for 22 albums.
  - For comparison, the Projects list reads 1,938 buffers for 41 projects.
- **Measured in production:** `get_photo_album_summaries_by_name_page` has run 116 times, mean 102.7 ms, standard deviation 144 ms, max 941 ms, 11,594 blocks per call. That is the highest mean of any photo read.
- **Why it costs:** about 10x the database work of the Projects list for about half as many rows, and the slope grows with every photo added to any album.
- **Do this:**
  1. In a new migration, rewrite `get_photo_album_summaries` as one lateral pass per album over a single `album_photos ⋈ photos` join, computing `count(*)`, `max(added_at)` and `(array_agg(p.thumb_path order by p.created_at desc) filter (where p.thumb_path is not null))[1:4]`. The page functions call it, so they pick it up.
  2. DB-7 (add `created_by`) and GRID-6 option (b) (add `sort_mode` and `has_custom_order`) change the same function's output. Do all three in one migration, since the return type changes and the function must be dropped and recreated anyway.
  3. Compare with EXPLAIN ANALYZE before and after.
- **Gain:** about half the lookups today (about 9k buffers, under 8 ms), and a gentler slope as albums grow.
- **Risk:** low. Same output columns, still SECURITY INVOKER. Check that the 4 cover thumbs come back in the same newest-first order.

#### DB-2 · Opening a date-ordered album, or Favorites, scans the whole photo library
- **Severity** medium · **Effort** small · **Status** confirmed, and confirmed in production (albums; Favorites were not measured there, with only 6 favorites) · **Merged from** server-5, realdb-album-grid-walks-library.
- **Who / when:** the database, on every album grid page and Favorites open. It already shows at today's 1,745 active photos and gets worse as the library grows. Small albums and albums of old photos are worst. Albums default to date order (`album_custom_order.sql:19`).
- **Today:**
  - `list-filters.ts:239-250` reads `photos` with `albums!inner(id)` or `photo_favorites!inner`. PostgREST turns that into a subquery that runs once per photo, walking `photos_captured_id` until it has 101 matches. A small album never reaches 101, so the walk goes to the end of the library.
  - Measured locally (Postgres 15, 20k photos, a 30-photo album): 34 ms with 20,000 loops, against 0.06 ms when the query starts from `album_photos`.
  - The `album_photo_order` view already exists but is only used for custom order (`album_custom_order.sql:95-99`).
  - Select-all's `count:'exact'` also scans the library (`ids/route.ts:48-49`).
- **Measured in production:**
  - A 26-photo album (all from 2012) walks all 1,745 active photos: 8,671 buffers, 9.4-9.7 ms. Read through `album_photo_order` it takes 318 buffers and 0.51 ms, about 18x faster.
  - A 369-photo album walks 600 photos: 3,306 buffers, 6.3 ms, against 1,521 buffers and 3.2 ms through the view.
  - In real use, the album-filtered list has run 106 times, mean 24.1 ms, max 396 ms, 4,762 blocks per call. The unfiltered list reads 217 blocks per call.
- **Do this:**
  1. In `filteredPhotos`, when `filters.album` is set, read from `album_photo_order` with `.eq('album_id', …)` for date order too, not only for custom order. Then drop the `albums!inner(id)` join and the matching `delete row.albums` in `photos/route.ts:88-91`. `GET /api/photos/ids` gets the fix for free through the same `filteredPhotos`.
  2. Add a `security_invoker` favorites view (`photo_favorites` join `photos` where `user_id = (select auth.uid())`), and change the favorites row rule to the `(select auth.uid())` form.
  3. Compare with EXPLAIN ANALYZE before and after.
- **Gain:** cost grows with the album or favorites size, not the library: about 18x less today on small albums, and 100+ ms saved per page at about 20k photos. **Risk:** low-medium. The view's row rules must hide the same rows (the album view joins `albums` with `deleted_at is null`, and the `photos_select` rule still applies).

#### DB-3 · The cursor for the next page does not give the index a starting point
- **Severity** low · **Effort** small · **Status** confirmed, and confirmed in production · **Merged from** server-4, realdb-keyset-or-unbounded.
- **Who / when:** deep scrolls through a project or all Photos, and Select all.
- **Measured in production:** with the cursor at page 3, Postgres filters out 223 rows (340 buffers, 2.9 ms). At row 1,600 it filters out 1,696 rows (1,599 buffers, 3.8 ms). Adding the extra `captured_at <= cursor` bound brings that back to 36 rows and 341 buffers (3.3 ms). Small today, but each page's cost grows with depth: at 20k photos the last pages would each read about 20k rows.
- **Today:**
  - `afterFilter` builds only `captured_at.lt.X,and(captured_at.eq.X,id.lt.Y)` (`list-filters.ts:153-154`; `keysetCursor.ts:56-68`; `photos/route.ts:72-75`; `ids/route.ts:49-51`). Postgres cannot use that OR as the index start, so each deeper page re-reads every row before it.
  - The share RPC already uses the indexable row comparison (`album_custom_order.sql:158-159`).
  - The receipts list has the same issue (`receipts/route.ts:167`).
- **Do this:** also add `.lte('captured_at', key)` (or `.gte` for ascending) next to the OR, in both `GET /api/photos` and the ids walk. `captured_at` is NOT NULL, so no rows are lost. Update `list-filters.test.ts:62-63`. This helps project, uploader and all-Photos lists, not album or favorites joins. For custom album order, bound `album_position` the same way.
- **Gain:** about 101 rows read per page at any depth (a few ms of database time at 5,000 photos). **Risk:** very low.

#### DB-4 · The Projects and Albums lists recount every active photo on every load
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** server-6.
- **Who / when:** the database, on every list load across about 12 consumers, and on every typeahead prefix.
- **Today:**
  - `20260907100410_photo_active_reads.sql:27-41` counts photos and picks the newest 4 thumbs per job, and `:50-53` sorts by an order the caller throws away.
  - The only index on (`job_id`, `created_at`) is not partial on `deleted_at` and has no `thumb_path` (`add_photos_indexes.sql:28-29`), so every active photo's table row is read.
  - The album count also goes through `album_photos` row rules (`photo_albums.sql:72-73,526-532`). That half is now its own finding, DB-10, because production shows it is much the more expensive one.
  - Production, for the project half: at 65 projects the Projects list is fine when warm (5-9 ms, 1,938 buffers, using `photos_job_created` and `photos_active_display_name`). Its production mean of 67 ms comes from spikes (DB-11), not from the plan.
- **Do this:** add `create index concurrently ... on photos(job_id, created_at desc) include (thumb_path) where deleted_at is null`. The page-first rewrite belongs to GRID-5 part 4. Counter columns can come later.
- **Gain:** counts, latest date and thumbnails come straight from the index. **Risk:** low.

#### DB-5 · The "am I admin" and settings reads call the Auth server, and the admin check runs again on every app switch
- **Severity** low · **Effort** small · **Status** unverified-low (the focus refetch is confirmed under app-4) · **Merged from** server-9, measure-actor-settings-getuser.
- **Who / when:** every cold load (both calls), and every return to the app on a phone (actor).
- **Today:**
  - `photos/actor/route.ts:16-19` and `photos/settings/route.ts:17-18,55-59` each run a remote `getUser` plus a profile read. Measured at 23-34 ms, against 4-6 ms for list reads.
  - `usePhotoActor` uses `refetchOnWindowFocus:'always'` (`api.ts:122-128`).
- **Do this:**
  1. Use `requirePhotoReader` and read the user's own row through the session. Row rules already limit it to that user.
  2. Merge the two routes into one `GET /api/photos/me`.
  3. Drop the always-on focus refetch. Every write is checked on the server anyway (`api.ts:116`).
- **Gain:** one function call and two Auth calls fewer per cold load, and none per app switch. **Risk:** low.

#### DB-6 · The tag list unpacks the tags of every active photo, including once per search word
- **Severity** low · **Effort** medium · **Status** confirmed in production (the plan) · **Merged from** server-7, production query plan for `get_photo_tags`.
- **Who / when:** the database, on each Photos visit, each tag picker open, and each search request (up to 8 words).
- **Today:** `get_photo_tags` does `unnest` over all active photos, then `distinct`, then `ilike` (`photo_active_reads.sql:59-76`). `resolveSearch` calls it once per word (`list-filters.ts:190-197`).
- **Measured in production:** the plan unpacks the tags of every active photo: 887 buffers and 3.9-5.7 ms warm at 1,745 photos. In real use it has run 903 times, mean 21.9 ms, max 1,613 ms (the spikes are DB-11). Cheap today, but it grows with the library and is multiplied by search words.
- **Do this:** keep a `photo_tag_usage(tag, n)` table updated by the tag-writing RPCs, or rebuilt by the nightly sweep, and read from it when there is no project filter.
- **Gain:** a full-table read becomes a lookup in a table of a few hundred rows. **Risk:** medium. The counts must stay correct through trash, restore and purge.

#### DB-7 · The Albums list makes a second query just to learn each album's creator
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** server-8.
- **Today:** `photo-albums/route.ts:35-45` runs the summary RPC, then `albums.select('id,created_by')`. `get_photo_album_summaries` does not return `created_by` (`photo_albums.sql:505-513`).
- **Do this:** add `created_by` to the RPC output (drop and recreate it, since the return type changes) and delete the second query. Do it in the same migration as DB-10, which rewrites this function.
- **Gain:** one fewer round trip on every Albums load. **Risk:** low.

#### DB-8 · Search has no index for matching part of a name
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** server-10.
- **Today:** each search word ORs `display_name.ilike.%w%` and `original_name.ilike.%w%` with other conditions (`list-filters.ts:201`). There is no `pg_trgm` index (a trigram index, which lets Postgres match parts of words).
- **Do this:** add partial GIN `pg_trgm` indexes on both columns where `deleted_at is null`, then check with EXPLAIN.
- **Gain:** searches for rare words cost about as much as the number of matches, not a full scan. **Risk:** low.

#### DB-9 · The file-type filter is a long text-matching chain that cannot use an index
- **Severity** low · **Effort** medium · **Status** unverified-low · **Merged from** code-11.
- **Today:** `fileTypeFilter` builds ILIKE chains on file name and MIME type (`list-filters.ts:158-177,253`). The client applies the same rule separately (`group.ts:80-87`).
- **Do this:** store a `file_type` column, set at finalize and by a backfill using `fileTypeLabel`, indexed as `(job_id, file_type, captured_at desc, id)`.
- **Gain:** type filters on big projects use an index. **Risk:** medium. It needs a migration and a backfill.

#### DB-11 · Reads that normally take a few ms sometimes take 1-3 s in production, and the database runs on the smallest compute size
- **Severity** low (watch) · **Effort** small · **Status** confirmed in production (observation only) · **Paid** possibly (a larger Supabase compute size) · **Merged from** realdb-prod-tail-latency.
- **Who / when:** users see an occasional slow Projects, Albums or tag list, most likely during upload or import bursts.
- **Today:**
  - Routine reads have a minimum of about 1 ms but a maximum of 1-1.6 s, with a standard deviation larger than the mean:

    | Statement | Max | Std dev | Warm, measured |
    |---|---|---|---|
    | `get_photo_job_summaries_page` (old) | 1,633 ms | 116 ms | — |
    | `get_photo_tags` | 1,613 ms | 95 ms | 3.9-5.7 ms |
    | `get_photo_job_summaries_by_number_page` | 1,321 ms | 145 ms | 8-23 ms |

  - Write paths in the same window: `photo_finalize_upload` mean 40.7 ms, max 2,918 ms (1,884 calls); `migration_prepare` mean 14.2 ms, max 1,077 ms (1,343 calls).
  - The settings (`shared_buffers` 280 MB, `max_connections` 60, `effective_cache_size` 480 MB) match the smallest compute size, about 1 GB.
  - All data sits in memory (23.6k blocks read from disk against 234M served from memory), so the spikes are CPU or lock contention, not disk. `pg_stat_statements` has no timestamps, so the cause could not be pinned to a moment.
- **Do this:**
  1. First cut the work per upload: IMG-1, DB-1 and UP-1.
  2. Then open the Supabase dashboard's database CPU chart during an upload burst.
  3. **Paid:** if CPU sits near 100%, move up one compute size.
- **Gain:** fewer 1 s outliers on the Projects and Albums pages during busy upload periods. **Risk:** none; this is an observation and a check.

### 5.7 Caching and hosting

#### HOST-1 · Functions run in Washington DC (`iad1`) while the database is in Ohio (`us-east-2`)
- **Severity** medium · **Effort** small · **Status** confirmed; the `iad1` placement is confirmed in production · **Merged from** server-2, http-1, the region line of the production report's "already good" list (disputed, see below).
- **Who / when:** everyone, on every API request. The cost scales with how many database calls a route makes in a row: 1-2 for the photo list, about 5 for writes, and about 30 auth round trips alone per uploaded photo (DB-1's production count).
- **Today:**
  - Production `x-vercel-id: sfo1::iad1::…`. `vercel inspect` shows functions in `[iad1]`. The production measurer saw the same `sfo1::iad1` on `/login`, `/api/photos` and `/api/photo-jobs`.
  - `supabase projects list` shows the "Receipt App" project in `us-east-2`.
  - `vercel.json` has no `regions`, and there is no `preferredRegion` anywhere.
  - All database access goes over supabase-js HTTP.
- **Why it costs:** about 10-15 ms per call between regions, against about 1-2 ms within one region (a published figure, not measured here).
- **A disagreement to know about:** the production report listed `iad1` as "next to the us-east-2 database, the right placement". This audit does not accept that. `iad1` is Vercel's Washington DC region, which runs on AWS us-east-1 (Virginia); `cle1` (Cleveland) is the Vercel region on AWS us-east-2, where the database is. Neither measurer could time the function-to-database hop from inside Vercel, so the size of the gain is still an estimate. The `x-vercel-id` check after redeploying, plus a before/after look at write-route timings, settles it.
- **Do this:** add `"regions": ["cle1"]` (Cleveland) to `vercel.json`, or set it in Project Settings → Functions. Hobby allows one region; confirm in the dashboard. After redeploying, check that `x-vercel-id` shows `::cle1::`.
- **Gain:** about 20-30 ms off reads, about 50-75 ms off writes, and about 0.25-0.35 s per uploaded photo. The derive and repair routes also move their Storage transfers into the same region. It is free.
- **Risk:** low. Deploy a preview first.

#### HOST-2 · Thumbnails, previews and originals are cached for only 1 hour
- **Severity** medium · **Effort** small · **Status** confirmed, and confirmed in production · **Merged from** image-2, http-3, measure-storage-cache-1h, app-8 (part), realdb-derived-cache-1h. Has a paid option.
- **Who / when:**
  - Phones on any revisit more than an hour later, which is almost every daily session: 100 tiles become 100 revalidation requests.
  - Anyone opening a tile nobody near the same CDN location has viewed in the last hour: a CDN miss.
- **Today:**
  - No upload sets `cacheControl`, so supabase-js uses its default `'3600'` (`StorageFileApi.js:24,66`). This covers `upload-storage.ts:63-64` (thumbs, previews and small originals via `upload.ts:346,368-370`), `transforms.ts:177-182` and `executor.ts:102-107,147-153`.
  - TUS hard-codes `"3600"` (`upload-tus.ts:149`).
  - Tiles are plain `<img>` tags pointing at public URLs (`photo-grid.tsx:176`; `collection-card.tsx:77`; `action-thumbnail.tsx:18`; `album-arrange.tsx:86`).
  - File keys are effectively write-once:
    - derived keys are built from the photo UUID (`sweep.ts:128-135`);
    - repair only fills empty slots (`sweep.ts:94`; `run.ts:118`);
    - derive returns early when a thumb already exists (`derive/route.ts:47`).
- **Measured in production:**
  - All 3,758 derived files carry `cacheControl = max-age=3600` in storage metadata, and are served with `cache-control: public, max-age=3600`.
  - Cloudflare (the storage CDN) also drops its copy after an hour. A CDN miss takes 0.80-0.97 s to the first byte; a hit takes 62-100 ms.
  - A "has this changed?" request (`If-None-Match`) is answered 304 in 90 ms.
- **Why it costs:** after an hour, every tile sends a "has this changed?" request and waits for the answer. On HTTP/2 these run in parallel, so it is about one extra round trip per screen (0.2-0.5 s on mobile), plus tens of thousands of needless requests a day. The first viewer after the CDN drops a file pays about 1 s for it.
- **Do this:**
  1. Set a default of `{cacheControl:'31536000', ...options}` inside `createAbortablePhotoStorage` (`upload-storage.ts:64`).
  2. Pass the same value in the TUS metadata, `fillImageDerivatives` and the executor uploads. Update `upload-tus.test.ts:93`.
  3. Write the rule next to `derivedKeys`: once a derived key has been shown it is never rewritten; a future rotate or re-render feature must use a new key or add `?v=` in `publicUrl`.
  4. Existing files keep 3600 until rewritten. The IMG-1 backfill re-uploads the worst ones.
  5. If a deleted original lingering on a device for a year matters, use about 7 days for originals only.
  6. If the write-once rule cannot be kept (repair and the IMG-1 backfill do overwrite in place with `upsert:true`), the production report's alternative is safer: add a version to the URL in `publicUrl`/`thumbUrl` (for example `?v=` plus the derivative's created time) and serve `max-age=31536000, immutable`, or settle for about 7 days (`'604800'`).
  7. **Paid variant:** Supabase Smart CDN (Pro plan) purges the CDN copy when a file is overwritten, which makes long CDN caching safe. Browser caching still needs step 3 or step 6.
- **Gain:** revisited tiles paint from the phone's disk cache with zero network, instead of about 100 × 90 ms revalidations per screen, and far fewer 1 s CDN misses. **Risk:** low as long as the write-once rule holds, or with versioned URLs.

#### HOST-3 · Nothing is saved between sessions, so every cold launch refetches everything
- **Severity** medium · **Effort** small-medium · **Status** confirmed · **Merged from** query-6, app-2, http-4, mobile-1 (part).
- **Who / when:** phone users of the home-screen app, which iOS often closes in the background, and desktop users after a reload.
- **Today:**
  - `query-provider.tsx:8-19,62-67` keeps the cache in memory only. There is no persister package (`package.json:34-35`).
  - The API correctly answers `no-store` with `Vary: Cookie` (`http.ts:29-34`). CDN or browser HTTP caching of per-user data would be wrong, because `invalidatePhotoCaches` relies on real refetches.
- **Why it costs:** every launch shows "Loading projects..." after the auth screen, the opposite of the "no spinners on revisits" goal.
- **Do this:**
  1. Wrap the app in `PersistQueryClientProvider` with an IndexedDB persister (`createAsyncStoragePersister` over `idb-keyval`). Set `maxAge` of about 24 h-7 d and `buster` to the build id.
  2. Persist an allow-list only (via `shouldDehydrateQuery`): `['photo-jobs','']`, `['photo-albums','']`, `PHOTO_SETTINGS_KEY`, and the *first page* of the default `photos` queries (trim `pages`/`pageParams` in a custom serialize step).
  3. Leave out receipts keys (the provider wraps the whole site, `app/layout.tsx:48`), search-prefix keys and, ideally, `PHOTO_ACTOR_KEY`.
  4. **Make it safe across users. This part is mandatory.**
     - The first auth event is treated as a baseline and never clears the cache (`query-provider.tsx:44-48`).
     - The photo keys contain no user id (`api.ts:90,124,146,246`).
     - So store the owner's user id with the blob and drop the blob on mismatch at restore.
     - Call `persister.removeClient()` next to `queryClient.clear()` (`:55`) and in `signOut`.
  5. This only shows saved data at once if SHELL-1 step 1 also stops the guard from blocking render.
- **Gain:** Projects and the last grid paint from the device right after hydration and then refresh quietly. It also skips one API round trip plus about 4 server auth calls per list.
- **Risk:** medium. Photo metadata sits on the device. Restored data can be stale for a moment.

#### HOST-4 · No service worker: no cached app shell for the installed app, and nothing works offline
- **Severity** medium · **Effort** medium · **Status** confirmed · **Merged from** app-8, mobile-1 (part).
- **Who / when:** installed-app users on weak or no signal (job sites).
- **Today:** the manifest says standalone with start_url `/photos/projects` (`manifest.webmanifest:5-7`), and `photos/layout.tsx:13-22` declares the app installable. Nothing in `src`, `public` or `next.config.ts` registers a service worker. With no signal, the installed app shows the browser's error page.
- **Do this:**
  1. Use Serwist (`@serwist/next`) scoped to `/photos`.
  2. Precache `/_next/static` and the static `/photos/*` HTML. The pages are client components with no force-dynamic, so they are safe to precache.
  3. Serve navigations stale-while-revalidate, with an offline fallback page.
  4. Serve `derived/*_thumb.webp` cache-first with an entry cap.
  5. Never cache `/api/*`.
  6. An offline shell also needs the session guard to tolerate being offline (`use-session-guard.tsx:31`).
- **Gain:** the shell opens instantly on any network, thumbnails already seen load from the device, and the app is usable read-only offline. HOST-2 gets most of the thumbnail benefit with less risk, so do it first.
- **Risk:** medium. A buggy worker can pin an old build. Use versioned caches, `skipWaiting` with a "new version" toast, and a kill switch.

#### HOST-5 · Opening a project or album waits on a server render, and every visible card fires a prefetch that returns nothing useful
- **Severity** medium · **Effort** small · **Status** confirmed · **Merged from** rendering-9, app-5, measure-rsc-prefetch-dynamic.
- **Who / when:** every tap into a project or album from a list (Back/Forward reuses the router cache). The server pays one function call per visible card per page view.
- **Today:**
  - `/photos/[jobId]` and `/photos/albums/[albumId]` are dynamic routes (`ƒ` in the build output, missing from the prerender manifest), even though both pages are `"use client"`. The RSC reply is `private, no-cache, no-store`.
  - No `loading.tsx` exists under `src/app/photos`, so the tap shows nothing new until the server answers. Next 15 sets dynamic `staleTimes` to 0.
  - Card and rail links use the default prefetch (`collection-card.tsx:132`; `sections-rail.tsx:37,183-200`). For a route with no loading boundary, the server stops early and returns only the route map (`walk-tree-with-flight-router-state.js:46-64`): 8 prefetches of about 190 B each on Projects.
- **Do this:**
  1. Add a server `layout.tsx` in each dynamic segment that exports `dynamicParams = true` and `generateStaticParams() { return [] }`. This makes each id render once and then come from cache. A client page cannot export these itself.
  2. Add a `loading.tsx` skeleton on top. Check that it and AuthLoading do not flash one after the other.
  3. Do **not** also set `prefetch={false}`. It would remove the prefetch that makes the skeleton instant.
  4. Optionally set `experimental.staleTimes.dynamic: 180`.
- **Gain:** about 100-300 ms (more on a cold function) off the most common tap. After first render, prefetches are cache hits rather than function calls.
- **Risk:** low. The page content is all client-side. Check `?photo=` deep links.

#### HOST-6 · The busiest read routes skip the shared response helper, so they go out as `public, max-age=0`
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** http-7.
- **Who / when:** nobody visibly today. It guards against a proxy or a future cache rule storing one user's list.
- **Today:**
  - GET in `photos/route.ts:40-93`, `photos/ids/route.ts` and `photo-tags/route.ts` use `NextResponse.json`, not `photoJson` (`http.ts:29-34`).
  - Production `/api/photos` returns `public, max-age=0, must-revalidate`.
  - `:79` sends the raw database error text to the browser.
- **Do this:** wrap these routes in `photoRoute`/`photoJson`, use `requirePhotoReader`, and throw `PhotoApiError`/`throwPhotoDatabaseError` for errors.
- **Gain:** the same safe headers and error handling on every photo read. **Risk:** low. The client already reads both error shapes (`api.ts:30`).

#### HOST-7 · Vercel Hobby limits at about 100 users: each photo is about 5-7 function calls (paid option)
- **Severity** low · **Effort** small · **Status** unverified-low · **Paid** (Vercel Pro) · **Merged from** http-8.
- **Who / when:** everyone, if a monthly limit runs out and Vercel pauses the project. Big `/migrate` imports, where 10,000 files is about 50-70k function calls.
- **Today:** each upload step is its own POST (`upload-http.ts:119-121`; `upload.ts:284-409`). Actor refetches on every focus (`api.ts:122-128`). `vercel.json` has no function settings.
- **Do this:**
  1. Free: turn on Fluid compute (Project Settings → Functions) if it is off.
  2. Watch the Usage page in the first month.
  3. Cut call counts with UP-1 and DB-5.
  4. **Paid:** Vercel Pro (about $20 per seat per month) if any limit passes about half in month one.
- **Gain:** avoids a hard stop mid-month, and fewer cold starts. **Risk:** low.

#### HOST-8 · The right-after-upload video poster route may deploy without the ffmpeg binary
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** http-6.
- **Who / when:** video uploads whose poster the browser could not make. They show no preview until the 09:00 UTC repair run (`vercel.json:6`).
- **Today:**
  - `next.config.ts:8-14` adds ffmpeg to the deploy only for `/api/photos/repair`.
  - The local build trace confirms `derive/route.js.nft.json` lacks it.
  - The derive route reaches `execFile(ffmpegPath)` (`derive/route.ts:57` → `executor.ts:98` → `transcode.ts:10,122`).
- **Do this:** add `'/api/photos/[id]/derive': ['./node_modules/ffmpeg-static/ffmpeg']` to `outputFileTracingIncludes`, then test with one desktop video upload.
- **Gain:** posters appear right away instead of the next morning. **Risk:** none. It adds about 45 MB to one function.

#### HOST-9 · The image-optimizer allow-list lets anyone run Vercel image optimization on any photo
- **Severity** low · **Effort** small · **Status** unverified-low · **Merged from** image-7.
- **Who / when:** the Vercel image-optimization quota. If it runs out, receipt images stop being optimized.
- **Today:** `next.config.ts:14-23` allows `/storage/v1/object/public/**`, which covers the whole photos bucket. The only remote `next/image` use is the receipt viewer (`batch-review-dashboard.tsx:335-341`). `/_next/image` needs no login.
- **Do this:** narrow the pattern to `/storage/v1/object/public/receipt-images/**`.
- **Gain:** removes an unbounded cost exposure. **Risk:** very low.

### 5.8 Code shape

#### CODE-1 · One helper refreshes almost everything after every edit, and the grid re-downloads every page it has loaded
- **Severity** medium · **Effort** medium · **Status** confirmed · **Merged from** query-1, code-1, viewer-6, upload-12.
- **Who / when:**
  - Any edit on a scrolled grid: tag, rename, add to album, trash, restore, upload finished, viewer edit.
  - Most sessions hold 1-3 pages. A user 20 pages deep pays 20 requests.
- **Today:**
  - `invalidatePhotoCaches` invalidates 10 key prefixes with the default "refetch what's on screen" (`api.ts:164-172`). It has about 49 call sites, for example:
    - `selection-bar.tsx:211-214,235,246,276,283,313,319,323,704,714,797`
    - `photo-info.tsx:64,75,107`
    - `photo-browser.tsx:441`
    - `upload-manager.tsx:310`
    - `photo-lightbox.tsx:631` (edit sheet)
  - **The grid refetch is sequential:**
    - The grid query has no `maxPages`.
    - TanStack v5 refetches every loaded page in order (`infiniteQueryBehavior.js:67-75`), and the screen updates only after the last page. So the user sees *stale* rows, such as trashed photos, until all N requests finish.
  - **Other lists refetch too:** the project list (`photos-shell.tsx:74`; `[jobId]/page.tsx:47`; `photo-browser.tsx:208`), tags (`:206`) and the open selection's ids (`:224-235`).
  - **Double invalidation:** trashing from the viewer invalidates twice (`photo-info.tsx:64` then `:80` → `photo-lightbox.tsx:795/862`).
  - **Rows are discarded:** `renamePhoto` already returns the updated row (`photo-info.tsx:104-107`), and the PATCH returns full columns (`photos/[id]/route.ts:37-41`). `bulkTagPhotos` returns only counts (`api.ts:406-411`).
- **Do this:** replace the single helper with targeted helpers in `api.ts`, modelled on `patchFavorites` (`:378-394`):
  1. `patchPhotoRows(qc, rows)` using `setQueriesData` on `photos`/`photo-search` plus `photo-detail`. Use it for rename (server row) and tag edits (compute the patch in the browser, or have the endpoint return rows).
  2. `removePhotosFromLists(qc, ids)` for trash, move and remove-from-album.
  3. After patching, invalidate with `refetchType:'none'` so the next visit reconciles. Do a full refetch when `skipped` or `missing` is above 0.
  4. Keep a broad invalidation only for uploads, create, rename or delete of projects and albums, restores, and the album sort switch (`albums/[albumId]/page.tsx:71-77`). Add `invalidateAfterUpload` that leaves out trash and deleted lists.
  5. Remove the duplicate viewer-trash invalidation.
  6. Do **not** trim the grid to its first page before refetching. That throws away a deep user's scroll position.
- **Gain:** a tag edit or rename goes from about (pages loaded + project list + tags) requests to 0-1, and the change shows instantly.
- **Risk:** medium. A patch can drift from what the server holds. Group by tag and tag-filtered views still need a refetch.

#### CODE-2 · Query keys are scattered strings, and the same lists are fetched by unrelated code paths
- **Severity** low · **Effort** medium · **Status** confirmed (key part, under query-5); the rest unverified-low · **Merged from** code-10, query-5 (part).
- **Today:**
  - Key strings are repeated across files (`photo-browser.tsx:325`; `api.ts:166-169,388,424`).
  - `/migrate` fetches projects 3 different ways outside React Query (`project-choice.tsx:34-44`; `migrate/page.tsx:105,273`).
  - `album-choice.tsx:38-52` fetches a 200-row album summary page on every keystroke to show 8 names.
  - Tags are fetched outside React Query (`migrate/page.tsx:117`).
- **Do this:** add a `photoKeys` factory in `api.ts` (`jobs(q)`, `albums(q)`, `tags(job)`, `grid(scope,params)`, `detail(id)`) and route every fetch through hooks that use it. Give pickers a `limit`.
- **Gain:** pickers open from cache, and CODE-1 and GRID-8 become straightforward to write correctly. **Risk:** low.

#### CODE-3 · Browse state is parsed from the whole query string, so each `?photo=` change rebuilds the filters
- **Severity** low · **Effort** small · **Status** unverified-low (the mechanism is confirmed under rendering-3) · **Merged from** code-4.
- **Today:**
  - `use-browse-state.ts:24,30-39` builds its memo key from the whole `useSearchParams().toString()`.
  - Each viewer swipe's `replaceState` (`use-photo-deep-link.ts:19-25,91-92`) therefore produces a new `filters` object (`browse-state.ts:84-103`). That changes `listParams` and `groupIds` (`photo-browser.tsx:152-155,236-246`) and defeats any memo on the toolbar or grid.
  - `[jobId]/page.tsx:36` also subscribes to the search params.
- **Do this:**
  1. Build the memo key from `BROWSE_KEYS` only.
  2. Read the linked photo once on mount, as `useOpenLinkedPhoto` does (`use-photo-deep-link.ts:210-212`).
- **Gain:** `filters` keeps the same identity during swipes, so GRID-1's memos hold. **Risk:** low.

#### CODE-4 · `fetchJson` has no timeout and no cancellation, and network errors read "Failed to fetch"
- **Severity** low · **Effort** small · **Status** confirmed · **Merged from** mobile-7.
- **Who / when:** phones on a connection that looks up but is stalled. Fully offline is different: React Query *pauses* the query, so the page shows neither the spinner nor an error, because the app never reads `fetchStatus` or `isPaused`.
- **Today:**
  - `api.ts:22-34` passes no signal and sets no timeout.
  - Only the jobs and albums fetchers pass the abort signal through (`:91,247`). The grid query (`photo-browser.tsx:175-179`) and `usePhotoTags`/`Actor`/`Settings` do not.
  - `photo-browser.tsx:380-383` shows the raw browser error message.
  - Grid `<img>` tags have no `onError` (`photo-grid.tsx:175-184`).
- **Do this:**
  1. Pass `({signal})` through in every read `queryFn`.
  2. Add `AbortSignal.timeout(20_000)` **only for GET reads**. `fetchJson` also carries writes (`action-client.ts:5`, share, edit, trash, receipts) and the 60 s purge (`purge/route.ts:9`). A timeout there would abort writes that may still succeed.
  3. Map TypeError and timeout errors to "No connection — check your signal and try again".
  4. Show "Waiting for connection" when `fetchStatus === 'paused'`.
- **Gain:** a clear, retryable state instead of a hang or jargon. **Risk:** low if the timeout applies to reads only.

#### CODE-5 · The desktop rail re-sorts the whole project and album list on every render
- **Severity** low · **Effort** small · **Status** confirmed (under query-7) · **Merged from** code-12, rendering-13 (rail part), query-7 (part).
- **Today:**
  - `sections-rail.tsx:72-73` memoizes on the query result object, which is a new Proxy on every render (`queryObserver.js:133-134`), so the memo never hits.
  - The `{...jobsQuery}` spread reads every tracked field, so the rail re-renders on every fetch-status change.
  - The comparator rebuilds its regex keys on every comparison (`collection-sort.ts:60-69`). Measured: 5-8 ms per sort of 3,000 projects.
- **Do this:** depend on `jobsQuery.data` and `albumsQuery.data`, and compute each row's key once before sorting.
- **Gain:** the rail sorts only when its data or the sort mode changes. **Risk:** low.

#### CODE-6 · `useDesktop` starts false in every component, so desktop renders the phone layout first
- **Severity** low · **Effort** small · **Status** confirmed (double render under rendering-10) · **Merged from** code-13, rendering-10 (part).
- **Today:** each caller has its own `useState(false)` and its own `matchMedia` listener, and flips in an effect (`use-desktop.ts:19-30`). There are 9 callers, including PhotoGrid (`photo-grid.tsx:294`) and every project card.
- **Do this:** rewrite it with `useSyncExternalStore` over one shared `matchMedia`, copying `use-mobile.tsx:13-30`. Keep the server snapshot false.
- **Gain:** one listener instead of N, and a single render for tiles that mount after hydration. **Risk:** low.

#### CODE-7 · SelectionBar is a 1,034-line file that re-renders with every page
- **Severity** low · **Effort** medium · **Status** unverified-low · **Merged from** code-14 (shares evidence with VIEW-7).
- **Today:** `photo-browser.tsx:431` passes the full `photos` array into SelectionBar. The sheets are defined inside the same file and always mounted (`selection-bar.tsx:590-648,721,818,979`). `SetProjectSheet` is imported by both the bar and the lightbox (`selection-bar.tsx:32`; `photo-lightbox.tsx:29`).
- **Do this:** split the bar and each sheet into their own files, mount sheets only when open (which also makes them easy to load lazily), and have pages pass a memoized `scope`.
- **Gain:** VIEW-7 and the per-tick work become simple to fix. Sheet code can come off the grid's first load. **Risk:** low.

## 6. Suggested order of work

**Tier 1: do first** (small effort, high or medium severity; production-confirmed items first)
- [ ] Stop iPhone PNG thumbnails, then backfill the 230 affected photos plus the 223 mislabelled ones (IMG-1). Production: 67% of all thumbnail bytes, and every upload on 2026-10-16 came out PNG.
- [ ] Set a long `cacheControl` on photo files and write down the write-once rule, or use versioned URLs (HOST-2); ship it with the IMG-1 backfill. Production: every one of 3,758 derived files is cached 1 hour, and a CDN miss costs 0.8-1.0 s.
- [ ] Pin functions to `cle1` (HOST-1). Production: functions confirmed in `iad1`.
- [ ] `Promise.all` (then one RPC) in `requirePhotoActor` (DB-1). Production: about 7.5 actor checks, so about 30 auth round trips, per uploaded photo.
- [ ] Rewrite the album summaries function as one pass, in one migration with `created_by` (DB-7) and the album sort columns for GRID-6 (DB-10). Production: the slowest photo read, mean 103 ms, max 941 ms.
- [ ] Read date-order albums and Favorites from views (DB-2). Production: a 26-photo album reads all 1,745 photos; through the view it is about 18x faster.
- [ ] Memoize Tile with simple props; `useCallback` on `onOpenPhoto` and `onExpandPinned`; memo PhotoGrid (GRID-1)
- [ ] Split the shell context; move search text into its own provider (GRID-2)
- [ ] Cached `Intl.DateTimeFormat` in `group.ts`, the share gallery and trash (GRID-3)
- [ ] Lazy-load the upload pipeline and the viewer; exifr lite; move the TUS constants out (SHELL-2). Production: the start page references 375 KB brotli of JS.
- [ ] Render the shell chrome before the session check finishes (SHELL-1 step 1)
- [ ] Viewer thumbnail placeholder, `fetchPriority`, `preload:1` on phones, slide thumbnails (VIEW-2)
- [ ] Share viewer thumbnail background plus ±1 preload (VIEW-3)
- [ ] Seed the album header from the list cache (GRID-6); its new list columns ride in the DB-10 migration
- [ ] Cacheable dynamic segments plus `loading.tsx` (HOST-5)
- [ ] Lean rows route for zip sizing (VIEW-5)
- [ ] Un-await server derive; preview-then-thumb in sharp (UP-5)
- [ ] Lower the zip warning threshold on the in-memory path (VIEW-4 step 1)

**Tier 2: next** (high severity with medium effort, other medium findings, and quick lows)
- [ ] Server-side bulk run route; stop echoing `selector`; Trash progress toast (VIEW-1). Production: bulk actions are rare so far (29 apply steps), so this can follow the Tier 1 items.
- [ ] Targeted cache patches instead of `invalidatePhotoCaches` (CODE-1), with a key factory (CODE-2)
- [ ] Persisted query cache, keyed and cleared by user (HOST-3); pairs with SHELL-1
- [ ] Upload: skip the probe for fresh uploads, then merge the begin calls (UP-1); prepare the next file during transfer (UP-2); pause on network loss plus Retry all (UP-3); worker or pixel limit for previews (UP-4)
- [ ] `content-visibility` on group sections (GRID-4 step 1)
- [ ] Typeahead single page, single-project GET, lazy filter options (GRID-5 parts 1-3)
- [ ] Quick lows, about an hour each:
  - [ ] SHELL-3, SHELL-4, SHELL-5, SHELL-6, SHELL-7, SHELL-8 (check the title trade-off with the owner first)
  - [ ] GRID-7, GRID-8, GRID-9
  - [ ] VIEW-6, VIEW-7
  - [ ] UP-6, UP-7, UP-8, UP-9, UP-10
  - [ ] DB-3 (confirmed in production), DB-4, DB-5 (DB-7 rides with DB-10 in Tier 1)
  - [ ] DB-11 step 2: look at database CPU during an upload burst, after IMG-1 and DB-1 ship
  - [ ] HOST-6, HOST-8, HOST-9
  - [ ] CODE-3, CODE-4, CODE-5, CODE-6, CODE-7

**Tier 3: later or paid**
- [ ] Row virtualization of the grid (GRID-4 step 2)
- [ ] Service worker app shell and thumbnail cache (HOST-4)
- [ ] Server-rendered landing pages with HydrationBoundary (SHELL-1 step 3)
- [ ] Page-first summary SQL and server-side sort per mode (GRID-5 part 4)
- [ ] 1280 px screen derivative (IMG-2), or **paid** Supabase image transforms
- [ ] Smaller thumbnail size (IMG-3)
- [ ] Streaming zip through a service worker (VIEW-4 step 2)
- [ ] Tag usage table, trigram search index, `file_type` column (DB-6, DB-8, DB-9)
- [ ] Fluid compute now; **paid** Vercel Pro if usage passes about half of a limit (HOST-7)
- [ ] **Paid:** one Supabase compute size up, only if CPU sits near 100% during upload bursts (DB-11 step 3)
- [ ] **Paid:** Supabase Smart CDN, if long CDN caching with in-place overwrites is wanted (HOST-2 step 7)

## 7. Refuted claims

These are sub-claims the verifiers checked and found wrong. Listed so nobody raises them again.
- "Use exifr's mini build": it cannot read HEIC. Use lite.
- "The importer will create thousands of projects": it creates albums (now only on request). The office has a few dozen projects.
- "The grid shifts while refetched pages arrive": TanStack v5 updates once at the end. The real cost is stale rows staying on screen.
- "Trim the infinite query to page 1 (or set maxPages) before a refetch": this throws away a deep user's scroll position.
- "A thumb+preview `srcSet` gives a progressive paint": the browser picks one candidate, the 2048 one on 2x/3x phones.
- "Moving `openPhotoId` out of PhotoBrowser stops swipe re-renders": `useSearchParams` still re-renders the page. Memoize the grid instead.
- "Add both `loading.tsx` and `prefetch={false}`": these cancel each other out.
- "Opening the viewer on a phone re-renders the shell": `setViewerOpen` runs on desktop only.
- "Every photo API call makes 4 auth round trips": the busy read routes use a local `getSession`.
- "Every tile revalidation costs its own round trip": they run in parallel over HTTP/2, about one round trip per screen.
- "The upload sheet decodes all picked photos when it opens": browsers decode only the tiles they paint.
- "`createClient` builds a GoTrue auth client for every storage upload": not when `accessToken` is passed.
- "The session check only starts after hydration": the token refresh starts when the root chunk loads.
- "Swapping the layout's Suspense fallback changes what `/photos` first paints": that text comes from PhotosShell's `!ready` branch.
- "Offline, the grid hangs on 'Loading photos...'": the query pauses and nothing is shown.
- "`fillImageDerivatives` must be changed to overwrite": it already upserts; its callers decide what to fill.
- "The nightly sweep will repair the PNG thumbnails": it only fills missing derivatives.
- "A refused photo in a bulk trash costs 2 extra round trips": it costs 1.
- "Select all grows the grid": it only adds ids.
- "Put a blanket timeout in `fetchJson`": unsafe, because it also carries writes.
- "A Wake Lock keeps the tab alive when the phone is locked or the user switches apps": it only stops the screen dimming.
- "`accumulateSeenOptions` adds a render on every page": only when a page brings a new uploader or tag.
- "hash-wasm is lazy through `import()`": it is deferred because it runs in a Worker.
- "A page-first summary rewrite saves a lot at today's scale": the list is one page, and the browser re-sorts the whole list.
- "Re-fetching 20 pages after an edit is 2-4 MB on a phone": that is the uncompressed size; on the wire it is under 1 MB.
