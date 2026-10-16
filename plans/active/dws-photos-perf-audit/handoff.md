# Handoff: implement the DWS Photos performance audit as one PR

Written 2026-10-16 for a fresh session. Read this file, then `audit.md` beside it (the audit:
summary in § 1, every finding with evidence in § 5, the triage tiers in § 6, refuted claims in § 7).
Then plan and run the implementation as one multi-agent workflow and open ONE pull request.
Do not merge it; Ari merges.

## The ask, in Ari's words
"Orchestrate a large scale implementation of fixing all this. Focus obviously on highest impact but
you can do a similar dynamic workflow to fix all this at once. End with a single PR." Users are all
in the SF Bay Area. The app is live and in daily use (uploads every day), going to ~100 users soon,
many on phones. Target feel: Google Drive / Dropbox. Keep Next.js App Router, TanStack Query,
Supabase, Vercel. Paid options only where the audit marks them and only if Ari says yes.

## Standing rules (from Ari, carried from earlier sessions)
- Ship fast. One PR for the whole round; no per-item PRs or review rounds.
- Do NOT add attribution lines (Claude-Session or similar) to commit messages or PR bodies.
- Browser Playwright suites in `integration/browser` are not to be re-run; Ari reviews on a dev
  server himself. Unit tests (`npx vitest run`), `npx tsc --noEmit -p .`, and the targeted database
  integration tests (`npm run test:db -- integration/db/<file>.test.ts`) are expected to pass.
- Migrations: additive, applied to the LIVE database before the deploy, safe for the app that is
  live in between (the live app must keep working on the new schema). Apply with
  `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f <file>`
  from `dws-app/`. Write-protect: `photo_guard_direct_write` only blocks client roles; migration
  SQL runs as the operator. The production database is used by real people right now: never run
  anything destructive, never touch gates in `photo_release_state`.
- Explain plainly to Ari (junior engineer, first job). Surface decision points; do not block on them.

## Where you are
- Repo: `/Users/ariavasulin/orca/workspaces/OpenReimbursements/plan-dws-photos-client-feedback`
  (git worktree). Local branch `main-hotfix` tracks `main`; the Desktop checkout holds `main`, so
  push with `git push origin HEAD:main` only when landing. For this round: create a branch
  (`perf-round-1`), push it, open the PR against `main` with `gh pr create`. The repository has a
  pre-merge hook on `gh pr merge` that wants a `/peprkit:ship --automerge` pass; leave merging to Ari.
- App: `dws-app/`. `dws-app/.env.local` exists (copied from the Desktop checkout, git-ignored) and
  points at the LIVE Supabase project, so `npm run dev -- -p 3000` runs against real data (sign-in
  needs a real phone; Ari does that). Do not run write-heavy experiments against it.
- Review stack (Docker, seeded, isolated): from `dws-app/`,
  `npm run review:stack -- --dev --seed-dir /Users/ariavasulin/orca/workspaces/OpenReimbursements/.artifacts-store/photo-albums/review-seed --info-file /tmp/review-stack.json`
  (drop `--dev` for a production build; needs Docker Desktop running, `open -a Docker`; takes 3-5
  minutes; serves a COPY of the tree, so restart after edits; kill the pid in the info file to stop).
  Sign in from Playwright: `POST /api/auth/send-otp {phone:'+15555550199'}` then
  `POST /api/auth/verify-otp {phone, token:'4321'}`; mutations need an `Origin` header equal to the
  base URL. Database: `docker exec supabase_db_<project> psql -U postgres`. Make the reviewer a photo
  admin with `update public.user_profiles set photo_admin=true where user_id in (select id from auth.users where phone like '%5555550199')`.
  Temp scripts go in `dws-app/*.tmp.mjs` and must be deleted before committing.
- Deploys: merging to `main` deploys on Vercel (project `dws-receipts`, team
  `team_21gnJLJcbKXgadoR9MvZaCDb`, Hobby plan). Poll with the Vercel API `v6/deployments` using the
  token in `~/Library/Application Support/com.vercel.cli/auth.json` (parse with `strict=False`).
  Live hosts: https://photos.design-workshops.app (photos) and https://www.dws-receipts.com.
- Session log of earlier work (newest first): `/tmp/dws-wave1/STATE.md`. Raw production measurements:
  `/tmp/dws-perf/real-db.md`. The audit brief every reader followed: `/tmp/dws-perf/brief.md`.
- Docs to keep true: `Docs/photos-runbook.md` (operators), `Docs/Employee-Features.md` (users).

## What the audit found (read audit.md § 1 and § 6 for the full lists)
64 findings: 3 high, 26 medium, 35 low. The ones that matter most, with their ids:
1. IMG-1 (high, small): iPhone/Safari uploads store PNG thumbnails (~560 KB) and previews (~4.7 MB)
   under `.webp` names because `canvas.convertToBlob('image/webp')` silently returns PNG. 230 photos
   hold 67% of all thumbnail bytes; every upload on 2026-10-16 came out PNG. Fix the client fallback
   (JPEG q0.8 when the blob is not WebP) AND backfill the existing files server-side.
2. HOST-2 (medium, small): every derived file is stored with `cacheControl: '3600'`; a CDN miss costs
   0.8-1.0 s. HOST-1 (medium, small): functions run in `iad1` while the database is `us-east-2`.
3. GRID-1, GRID-2 (high/medium, small): every tile re-renders on every tap, swipe, keystroke.
4. SHELL-1, SHELL-2, HOST-3 (medium): cold opens show "Verifying authentication", load ~90 KB of
   upload/viewer code early, and keep nothing between visits.
5. VIEW-1 (high, medium): bulk trash/move is ~150-250 serial requests with no progress.
6. DB-1 (medium, small): `requirePhotoActor` makes 4 sequential round trips before any write
   (~30 per uploaded photo). DB-10 (medium): the Albums list RPC is the slowest read (103 ms mean,
   941 ms max). DB-2: a date-ordered album scans the whole library.

Bay Area note: users are ~70 ms RTT from the east coast, so the fixes that remove sequential round
trips and let the browser/CDN serve from cache matter more here than the audit's numbers say. Do
not move functions to the west coast: each request makes several database calls, so functions
belong next to the database (`cle1`, Ohio). The user-facing hop is paid once per request either way.

## How to run the implementation
Use a dynamic workflow (the session's Workflow tool) with these shapes. Ari explicitly asked for a
multi-agent run; "as many agents as you want". Prefer Opus at high effort for implementers and
verifiers.

1. **Plan the packages (you, inline, before spawning).** Read audit.md § 5 and group the Tier 1 and
   Tier 2 items into work packages that touch DISJOINT files, so agents can run in parallel without
   merge conflicts. A sensible split (check the evidence lines in each finding for the real file
   lists and adjust):
   - P1 Images and storage: IMG-1 client fallback (`src/lib/photos/derivatives.ts`), HOST-2 long
     `cacheControl` at every upload site (`upload.ts`, `upload-tus.ts`, `repair/transforms.ts`,
     video poster/transcode uploads) plus the write-once rule or URL versioning the audit describes,
     IMG-2/IMG-3 only if small. Plus the backfill script for the 230 PNG photos (a script under
     `dws-app/scripts/`, run later against production; see "After the PR").
   - P2 Grid rendering: GRID-1, GRID-2, GRID-3, GRID-4 step 1, CODE-5, CODE-6, CODE-7's
     low-risk part (`photo-grid.tsx`, `photos-shell-context.tsx`, `group.ts`, `sections-rail.tsx`,
     `selection-bar.tsx`).
   - P3 Shell and cold open: SHELL-1 step 1, SHELL-2, SHELL-4, SHELL-5, SHELL-7, HOST-3 persisted
     query cache keyed by user (`@tanstack/react-query-persist-client` + IndexedDB persister),
     HOST-5 (`src/app/layout.tsx`, `src/app/photos/layout.tsx`, `photos-shell.tsx`,
     `use-session-guard.tsx`, query provider, `photo-lightbox.tsx` dynamic import, upload manager
     dynamic import).
   - P4 Server and database: DB-1 (`authority.ts`), DB-10 + DB-7 + the GRID-6 list columns in ONE
     migration, DB-2 (views for album/favorites reads in `list-filters.ts`), DB-3, DB-4, DB-5, HOST-6
     (`http.ts` cache headers), HOST-1 (`vercel.json` regions). Migrations here are the only ones in
     the round; name them `202610XXHHMMSS_photo_perf_*.sql`, additive, with the usual header
     explaining WHEN TO APPLY and WHAT CHANGES.
   - P5 Query layer and cache patching: CODE-1 targeted cache patches instead of
     `invalidatePhotoCaches`, CODE-2 key factory, CODE-3, CODE-4, GRID-5 parts 1-3, GRID-7, GRID-8
     (`src/lib/photos/api.ts`, `browse-state.ts`, hooks). This overlaps P2/P3 on `api.ts`: run P5
     AFTER P2 and P3, or give P5 ownership of `api.ts` and have P2/P3 leave it alone.
   - P6 Viewer and bulk: VIEW-1 server-side bulk route with progress, VIEW-2, VIEW-4 step 1, VIEW-5,
     VIEW-6, VIEW-7 (`photo-lightbox.tsx` viewer internals only, `selection-bar.tsx` actions,
     `zip-download.ts`, `album-arrange.tsx`, new route under `src/app/api/photos/`). Coordinate
     `photo-lightbox.tsx` with P3 (P3 only wraps it in `next/dynamic`; P6 edits its body).
   - P7 Uploads: UP-1, UP-2, UP-3, UP-4, UP-5, UP-6, UP-8, UP-9, UP-10 (`upload*.ts`,
     `upload-manager.tsx`, `upload-tray.tsx`, `derive/route.ts`, `migrate/page.tsx`). UP-5's
     sharp change touches `repair/transforms.ts`, which P1 also edits: give that file to P1 and
     have P7 describe what it needs.
   Tier 3 items (virtualization, service worker, server-rendered landing pages, new derivative
   sizes, paid options) are OUT of this round unless Ari says otherwise.
2. **Implement in parallel with isolation.** One implementer agent per package, each with
   `isolation: 'worktree'` so they cannot step on each other, each briefed with: the package's
   finding ids and the exact text of those findings from audit.md, the files it owns, the files it
   must not touch, the acceptance criteria below, and the verification commands. Each returns a
   structured result: files changed, what it did per finding id, what it skipped and why, test
   results, and a short note for the PR body. Then you merge the worktree branches into
   `perf-round-1` in dependency order (P1, P2, P4, P6, P7, then P3, then P5), resolving conflicts
   yourself; after each merge run `npx tsc --noEmit -p .` and `npx vitest run`.
   If the Workflow tool's worktree isolation returns branches/paths, use those; if it only returns
   diffs, apply them in order. Verify what it gives you before planning the merge step.
3. **Verify adversarially.** For each package after merge, one skeptic agent reads the diff
   (`git diff main...perf-round-1 -- <files>`) against the finding's acceptance criteria and tries
   to find: behaviour changes a user would notice, broken invariants the audit's refuted list warns
   about, missing error handling, and anything the finding asked for that was not done. Fix what
   they find (small follow-up agents or yourself), re-run tests.
4. **Measure on the review stack** (production build, `--info-file`): repeat the audit's
   measurement script shape (requests, bytes, LCP at phone + slow-4G + 4x CPU, repeat-visit cache
   hits, tile re-render counts via React Profiler if feasible) before and after, and put the table
   in the PR body. Keep the caveat that the seed is small.
5. **Docs.** Update `Docs/photos-runbook.md` (new migration, cache-control rule and versioning,
   bulk route, backfill procedure, region setting) and `Docs/Employee-Features.md` only where a
   user-visible behaviour changed (progress on bulk trash, faster revisits).
6. **One PR.** Branch `perf-round-1`, commits grouped by package with plain messages (no attribution
   lines), PR body: thesis, per-package summary with finding ids, migrations and when to apply,
   the measurement table, a test plan with what was run and what is left to Ari (sign-in on
   production, iPhone upload producing WebP/JPEG not PNG, the backfill run). End the PR body with
   nothing extra. Do not merge.

## Acceptance criteria per headline finding
- IMG-1: on a browser that cannot encode WebP, the derivative blob type is checked and a JPEG at
  quality 0.8 is produced, with the stored path/extension and `mime_type` matching the real
  format (decide: keep the `.webp` path name with correct Content-Type, or name it `.jpg`; the
  audit's IMG-1 entry discusses the trade-off; the storage path rule in SQL
  `photo_*_upload` functions only allows the fixed derived paths, so changing the extension needs a
  migration; the simplest correct route is to keep the path and set the right Content-Type). A
  backfill script re-renders thumb+preview for every photo whose stored derived object is PNG
  (`sharp` via `fillImageDerivatives`), idempotent, resumable, logging counts, dry-run flag.
- HOST-2: every derived upload passes a cache-control of at least 1 week (prefer 1 year +
  immutable) and the code comment states the write-once rule; any path that overwrites a derived
  file (repair sweep, backfill, derive route) either writes a new versioned key or the audit's
  chosen versioning scheme makes the URL change. Originals too.
- HOST-1: `vercel.json` has `"regions": ["cle1"]` (confirm the region id in Vercel's current docs
  before relying on it; the audit's HOST-1 entry has the reasoning).
- GRID-1/2: with React Profiler on the review stack, ticking one tile re-renders O(1) tiles, not
  every tile; typing in search does not re-render the grid.
- DB-1: `requirePhotoActor` does its independent reads concurrently (or in one RPC), with the same
  refusals as before (tests in `integration/routes` cover the refusals; run the relevant file).
- DB-10/DB-7/GRID-6: one migration; the album list route makes one RPC call; the integration test
  `integration/db/albums.test.ts` passes.
- VIEW-1: one request per slice of up to 500 photos runs the batch server-side; the selection
  bar shows progress; non-admin refusals still reported per photo.
- SHELL-2: the viewer and the upload pipeline are not in the First Load JS of `/photos/projects`
  (`npx next build` route table shows the drop; quote before/after).
- HOST-3: a revisit within the persisted cache's age paints lists from cache before the network
  answers; the cache is cleared on sign-out and keyed by user id.

## After the PR (for Ari, write it into the PR body)
1. Merge; wait for the Vercel deploy; apply the migration(s) BEFORE merging (additive).
2. Run the PNG backfill script against production once (dry run first), then spot-check a tile.
3. Re-run the thumbnail byte count from `/tmp/dws-perf/real-db.md`'s query to confirm the drop.
4. Watch Vercel function invocations and Supabase CPU for a day (HOST-7, DB-11 are the paid
   escape hatches if either runs hot).

## Things that look like bugs but are not (see audit § 7)
Do not "fix" these: the nightly sweep repairing PNG thumbnails (it only fills missing files), a
blanket timeout in `fetchJson` (it carries writes), trimming the infinite query before refetch
(loses scroll position), `prefetch={false}` together with `loading.tsx`, mini exifr (no HEIC).
