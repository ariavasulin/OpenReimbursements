---
date: 2026-08-31T12:48:04-07:00
git_commit: 142b09c80977c25206ff6883294aa54326efb0d5
branch: ariavasulin/Picasa-Migration
repository: ariavasulin/OpenReimbursements
topic: "Hosted DWS MCP and large-scale photo migration"
type: research
tags: [research, codebase, mcp, photos, supabase, vercel, migration]
status: complete
---

# Research: Hosted DWS MCP and large-scale photo migration

**Date**: 2026-08-31T12:48:04-07:00  
**Git Commit**: 142b09c80977c25206ff6883294aa54326efb0d5  
**Branch**: ariavasulin/Picasa-Migration  
**Repository**: ariavasulin/OpenReimbursements

## Research Question

1. What are the current deployed architecture and authentication boundaries of `dws-app`, including Vercel, the three Supabase client modes, OTP/session cookies, employee/admin authorization, cron access, RLS, credentials, and retained identity/audit data?
2. How does the current photo-ingestion system work end to end, and what constraints does it impose on migrating a corpus that may total 100 GB or more?
3. What are the current official Supabase contracts for standard uploads, TUS/resumable uploads, signed upload URLs, S3 uploads, limits, RLS, ownership, and image transforms, and where does the current code correspond to them?
4. What current state-transition and human-review patterns exist for staging, interrupted uploads, manifests, previews, confirmation, idempotence, live rechecks, repair, and durable versus browser-local state?
5. What operational scripts and command conventions already exist, including arguments, dry-run/execute behavior, dependencies, authentication, logging, output, and tests?
6. What does the current MCP specification require, and how do official OpenAI and Anthropic products currently differ in transport, discovery, tools, authentication, approval, sessions, errors, and compatibility?
7. What current DWS design-system and interface patterns govern colors, typography, spacing, borders, shadows, responsive behavior, upload progress, errors, and review interfaces?

## Research Methodology (verbatim)

This document will remain objective and factual. It does not contain any recommendations or implementation suggestions.
Open questions will not ask Why things haven't been built or what should be built in the future.

There is no "implementation" section - that is intentional.

## Summary

`dws-app` is a single Next.js 15 App Router deployment on Vercel backed by Supabase Auth, Postgres, and Storage. Authentication begins with SMS OTP and becomes an apex-scoped Supabase browser session. The code has three distinct Supabase authority levels: anon-key browser access under RLS, anon-key server access bound to the user's cookies, and a server-only service-role client that bypasses RLS. Photos are available to any authenticated user; receipt administration and user administration add an `admin` profile check; the repair cron is a fourth authority boundary using `CRON_SECRET` and the service role.

Photo ingestion is already direct-to-Supabase and browser-led. The browser classifies files, pairs XMP sidecars, extracts timestamps, optionally hashes files up to 100 MB, generates derivatives where the browser can decode the source, uploads originals with standard Storage at 6 MB or below and TUS above 6 MB, then finalizes a Postgres row. The database row is the durable admission point. Queue metadata is kept for 24 hours in `localStorage`, but browser `File` objects are memory-only; a reload therefore changes pending items to `interrupted` and requires the user to re-pick matching files. The current code has no Picasa metadata parser and no signed-upload or S3 upload path.

The official Supabase contracts align closely with the current TUS implementation: direct Storage upload, exact 6 MiB chunks, bearer authorization per request, retry delays, progress events, previous-upload resumption, and upload URLs valid for up to 24 hours. Supabase also exposes two server-authorized alternatives not used by the current photo pipeline: two-hour signed upload tokens and S3-compatible single/multipart uploads. The current Vercel runtime cannot proxy large photo bodies because function request and response bodies are capped at 4.5 MB; the present direct browser-to-Storage topology avoids that boundary.

As of the research date, MCP's current specification is `2026-07-28`. Hosted MCP is a stateless, per-request Streamable HTTP protocol: one HTTPS endpoint, one JSON-RPC message per POST, JSON or request-scoped SSE responses, explicit workflow handles instead of protocol sessions, mandatory `server/discover`, and `tools/list` for tool discovery. OpenAI documents one hosted MCP plugin surface shared by ChatGPT and Codex, with ChatGPT-specific OAuth-linking, approval, administrative action controls, and optional iframe UI. Anthropic's remote connectors work across Claude, Cowork, Desktop, and Claude Code from Anthropic's cloud, while Claude Code additionally supports local stdio. Anthropic's Messages API connector currently supports MCP tool calls only.

## Detailed Findings

### 1. Deployed application and authority boundaries

The deployed application is Next.js 15 with App Router route handlers, React 19, and one Vercel cron. Vercel installs dependencies with `--legacy-peer-deps` and invokes `/api/photos/repair` daily at `0 9 * * *`. The Next configuration externalizes BAML and ffmpeg, includes the ffmpeg binary in the repair function trace, allows Supabase public Storage images, and currently permits builds to continue despite TypeScript and ESLint errors (`dws-app/vercel.json:1-7`; `dws-app/next.config.ts:3-28`). Middleware applies only at `/` and rewrites that path to `/photos` when the host equals `NEXT_PUBLIC_PHOTOS_HOSTNAME` (`dws-app/src/middleware.ts:4-23`).

```mermaid
flowchart LR
  U[Employee or admin browser] -->|SMS OTP| A[Supabase Auth]
  A -->|access + refresh tokens| B[Browser Supabase client]
  B -->|anon key + user JWT| R[RLS-protected Postgres and Storage]
  U -->|session cookies| N[Next.js route handlers on Vercel]
  N -->|anon key + caller session| R
  N -->|server-only service role| S[Supabase admin operations]
  C[Vercel cron] -->|Bearer CRON_SECRET| P[/api/photos/repair]
  P --> S
```

The three Supabase client modes are explicit:

| Client | Credential | Session source | Effective boundary |
|---|---|---|---|
| Browser client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser cookies/session | User JWT and RLS |
| Server session client | public anon key | Next request cookies | User JWT and RLS |
| Admin client | `SUPABASE_SERVICE_ROLE_KEY` | No persisted session | Server-only, bypasses RLS |

The browser client is constructed only in a browser and apex-scopes cookies through `cookieDomainForHost`. The server client uses the anon key and Next cookie hooks with a 180-day maximum age, `sameSite: lax`, root path, and production-secure cookies. The admin client contains a server-only import guard and disables token refresh and persistence (`dws-app/src/lib/supabaseClient.ts:1-26`; `dws-app/src/lib/supabaseServerClient.ts:1-44`; `dws-app/src/lib/supabaseAdminClient.ts:1-17`). Cookie domain logic applies `.dws-receipts.com` only to that apex family; localhost and Vercel preview hosts remain host-scoped (`dws-app/src/lib/cookieDomain.ts:5-33`).

SMS OTP has two public API steps. Send accepts an E.164 phone number and calls `signInWithOtp`; verify accepts an E.164 phone and four-digit token and returns the Supabase user and session. The login page then calls `setSession` in the browser. A missing or unnamed profile introduces a profile-name step before routing (`dws-app/src/app/api/auth/send-otp/route.ts:4-31`; `dws-app/src/app/api/auth/verify-otp/route.ts:4-44`; `dws-app/src/app/login/page.tsx:100-218`).

Authorization differs by surface:

| Surface | Current authorization |
|---|---|
| `/photos` shell and photo APIs | Any authenticated Supabase session |
| Employee receipts | Authenticated session; caller identity is `session.user.id`; ownership checks and RLS |
| `/dashboard`, `/batch-review`, `/users` | Authenticated session plus `user_profiles.role = admin` |
| Admin APIs | Shared `requireAdmin()` guard; some handlers then use the service role |
| `/api/photos/repair` | `Authorization: Bearer ${CRON_SECRET}`; service-role data access |

RLS allows authenticated reads of jobs and photos, inserts only when `uploader_id = auth.uid()`, limited photo updates on organizational columns, and deletes by uploader or admin. Storage policies require the `photos` bucket, an `originals` or `derived` first folder, and the caller UID as the second folder. Receipt rows allow owner or admin access, while a trigger restricts status transitions to admins or the service role. Both `photos` and `receipt-images` are declared public buckets, so possessing a public object URL is sufficient to fetch the object even though table access remains authenticated (`dws-app/supabase/migrations/00000000000003_photos_schema.sql:33-49`; `dws-app/supabase/migrations/20260822130100_rls_photos_tighten_update.sql:1-22`; `dws-app/supabase/migrations/20260822130200_rls_storage_scalar_subqueries.sql:6-74`; `dws-app/supabase/migrations/20260823120100_write_guards.sql:1-42`; `Docs/Database.md:210-230`).

The durable identity trail is distributed rather than represented by a standalone audit-log model. Receipts retain `user_id` and timestamps. Photos retain `uploader_id`, user-prefixed paths, source file attributes, capture provenance, and timestamps. Admin user APIs expose target Auth and profile fields, and the self-ban check uses the caller ID returned by `requireAdmin`. Repair calls do not have a Supabase user identity; logs identify action targets such as photo IDs and paths (`dws-app/supabase/migrations/00000000000000_baseline.sql:274-286`; `dws-app/supabase/migrations/00000000000003_photos_schema.sql:12-28`; `dws-app/src/app/api/photos/repair/route.ts:489-515`).

#### Testing patterns

Cookie behavior is unit-tested for host matching, ports, case normalization, apex scoping, and non-apex hosts (`dws-app/src/lib/cookieDomain.test.ts:4-47`). RLS behavior is represented in SQL migrations, but no database-policy integration test suite was found. No direct route-handler tests were found for OTP, `requireAdmin`, or the repair bearer-secret boundary. The photo library tests exercise session-dependent dependencies through injected fakes rather than a live Supabase project.

### 2. Current photo-ingestion and large-corpus behavior

The upload shell is mounted in the photo layout, so uploads survive navigation within `/photos`. File picker, drag/drop, and the multi-shot camera converge on the same batch path. XMP sidecars are paired by basename, invalid or unmatched sidecars are rejected, and the upload sheet captures a single job plus optional sheet and tags for the batch (`dws-app/src/app/photos/layout.tsx:15-18`; `dws-app/src/components/photos/photos-shell.tsx:73-131`; `dws-app/src/hooks/use-capture-batch.ts:32-55`; `dws-app/src/components/photos/upload-sheet.tsx:154-261`).

```mermaid
sequenceDiagram
  participant H as Human/browser
  participant Q as Upload manager
  participant S as Supabase Storage
  participant A as /api/photos finalize
  participant D as Postgres photos
  H->>Q: Pick/drop/capture batch and confirm metadata
  Q->>Q: Classify, pair XMP, parse EXIF/XMP, start SHA-256
  Q->>Q: Generate best-effort thumb/preview
  Q->>S: Upload original (standard <=6 MB; TUS >6 MB)
  Q->>S: Upload sidecar and derivatives best-effort
  Q->>A: POST row metadata and deterministic paths
  A->>A: Validate session, UUIDs, path ownership, tags
  A->>D: Insert row using session user as uploader
  D-->>A: inserted / duplicate / already exists
  A-->>Q: success-like finalization result
  Q->>S: Best-effort cleanup on content duplicate
```

Classification is extension-first. Image extensions include common web formats plus HEIC/HEIF, TIFF, DNG, CR2, NEF, and ARW; video extensions include MOV, MP4, M4V, 3GP, and WebM; XMP is a sidecar. Unknown extensions fall back to MIME prefixes and then `application/octet-stream` (`dws-app/src/lib/photos/classify.ts:1-60`). Current metadata extraction reads EXIF `DateTimeOriginal`/`CreateDate` and XMP capture dates and `dc:subject` keywords. Capture-time priority is EXIF, XMP, camera shutter time, plausible file modification time, then upload time. No Picasa-specific parser exists in the current ingestion path (`dws-app/src/lib/photos/exif.ts:10-80`; `dws-app/src/lib/photos/sidecar.ts:24-97`).

Files are uploaded to deterministic paths rooted by the authenticated uploader and a stable client-generated photo ID. Original upload occurs first; sidecar and derivatives follow; the row is finalized last. Sidecar and derivative failures do not prevent row finalization. The server disregards a client-supplied uploader identity, validates every path prefix against `session.user.id`, sanitizes sheet/tags, and inserts the row. A `photos_job_sha` uniqueness violation becomes `{ duplicate: true }`, while a repeated photo primary key becomes `{ alreadyExists: true }` (`dws-app/src/lib/photos/upload.ts:215-241`; `dws-app/src/lib/photos/upload.ts:297-395`; `dws-app/src/app/api/photos/route.ts:193-346`).

The principal current corpus constraints are:

| Area | Current value or behavior |
|---|---|
| Bucket object limit declared by migration | 50 GiB per photo object |
| Standard/TUS split | standard at `<= 6 MB`; TUS at `> 6 MB` |
| TUS chunk size | exactly 6 MiB |
| Hash/dedupe eligibility | full-file SHA-256 at `<= 100 MB`; no content hash above that |
| Queue concurrency | one queued photo at a time |
| Queue recovery | metadata for 24h; actual files must be re-picked after reload |
| Client image outputs | WebP thumb 640 px; preview 2048 px; quality 0.8 |
| Client video decode timeout | 15 seconds |
| Photo query page size | default 100; maximum 200 |
| Repair scan pages/concurrency | 1,000 rows/objects per page; eight directory listings |
| Repair settle/orphan windows | 10 minutes / 24 hours |
| Server image transform eligibility | supported MIME and at most 25 MB |
| Video transcode eligibility | feature flag plus at most 200 MB and 120 seconds |
| Repair function duration/transcode budget | 300 seconds / 240 seconds |

The browser hashes by reading the whole file into memory and stops above 100 MB. Consequently, the durable `(job_id, content_sha256)` dedupe index does not cover objects over 100 MB because their hash is null. The upload manager processes a single queue item at a time. The manifest persists identities and status, not file handles; a refresh restores unfinished entries as `interrupted`, with progress reset to zero, and matching uses `name + size + lastModified` (`dws-app/src/lib/photos/hash.ts:1-15`; `dws-app/src/lib/photos/upload-manager.tsx:151-203`; `dws-app/src/lib/photos/upload-queue.ts:129-203`).

Repair is a later convergence system. It inventories rows, row-referenced paths, and objects; plans actions with a pure planner; skips recent rows/objects; rechecks live database or Storage state before destructive actions; fills image derivatives, creates video posters, optionally transcodes playback, marks non-renderable items as file tiles, deletes dead rows, and deletes confirmed orphan objects. It returns `{ counts, errors, planned }` and uses HTTP 500 when any action fails (`dws-app/src/lib/photos/repair/sweep.ts:1-119`; `dws-app/src/app/api/photos/repair/route.ts:393-524`).

#### Testing patterns

The photo domain has extensive Vitest unit coverage: extension/MIME classification, XMP pairing and parsing, EXIF precedence, hash limits, browser derivative generation, upload ordering, TUS selection and retries, token refresh, fingerprint resume, duplicate cleanup, queue manifest recovery, repair planning, known-path ownership, transcode caps, keyset cursors, and video source selection. Dependencies are injected as fakes in upload tests; photo fixtures include EXIF, no-EXIF, and XMP samples (`dws-app/src/lib/photos/upload.test.ts:91-818`; `dws-app/src/lib/photos/upload-queue.test.ts:12-99`; `dws-app/src/lib/photos/repair/sweep.test.ts:33-124`; `dws-app/src/lib/photos/__fixtures__/`). No browser end-to-end migration test, live Supabase TUS test, or Picasa corpus fixture/parser test was found.

### 3. Supabase Storage and Vercel runtime contracts

Supabase documents four relevant upload modes. Standard upload is intended for small files, supports the SDK/REST object endpoint, and recommends switching to TUS above 6 MB. Resumable upload uses the direct Storage TUS endpoint, exact 6 MiB chunks, a unique URL valid up to 24 hours, PATCH requests, progress events, and optional prior-upload resumption. Signed uploads use a server-created token valid for two hours. S3-compatible uploads support single `PutObject` and multipart upload, with retryable parts and automatic multipart abort after 24 hours ([standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads); [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads); [signed upload URL](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl); [S3 uploads](https://supabase.com/docs/guides/storage/uploads/s3-uploads)).

| Contract | Official behavior | Current photo code |
|---|---|---|
| Standard | SDK/REST; small-file path; upsert optional | Used for originals `<=6 MB`, sidecars, thumbs, previews |
| TUS | Direct Storage host preferred; 6 MiB chunks; progress/retry/resume | Used above 6 MB; same chunks/retry/resume; endpoint is derived from general Supabase URL |
| Signed upload | Token valid two hours; direct upload without later user auth | Not present |
| Signed TUS | Signed token carried as `x-signature` | Not present |
| S3 single/multipart | S3 endpoint; multipart parts and parallelism | Not present |

The current TUS implementation matches the official example on `uploadDataDuringCreation`, `removeFingerprintOnSuccess`, `findPreviousUploads`, `resumeFromPreviousUpload`, `x-upsert`, progress callbacks, and retry delays `[0, 3000, 5000, 10000, 20000]`. It also obtains a current Supabase access token before every request. Supabase prefers `https://{project}.storage.supabase.co/storage/v1/upload/resumable`; current code builds the TUS URL from `NEXT_PUBLIC_SUPABASE_URL` (`dws-app/src/lib/photos/upload.ts:128-212`; [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)).

Storage access is denied without policies. Plain insert requires `INSERT` on `storage.objects`; upsert also requires `SELECT` and `UPDATE`. A service key bypasses RLS. User-authenticated objects derive ownership from JWT `sub`, while service-key/dashboard-created objects may have no owner. The app's photo policies authorize UID-prefixed paths and its TUS calls carry the user JWT, so their authority is user-scoped even though the bucket itself is public ([Storage access control](https://supabase.com/docs/guides/storage/security/access-control); [object ownership](https://supabase.com/docs/guides/storage/security/ownership)).

Supabase's current plan-level global maximum is 50 MB on Free, 500 GB on Pro and Team, and custom on Enterprise; bucket limits can be lower but not higher. The repository migration declares 50 GiB for `photos`. Multipart S3 has a documented paid-plan maximum of 500 GB and is interoperable with standard/TUS objects. Generated S3 access keys are server-side, full-project credentials that bypass RLS; session-token S3 credentials use the project ref, anon key, and user JWT and preserve RLS ([file limits](https://supabase.com/docs/guides/storage/uploads/file-limits); [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)).

Vercel route-handler constraints are independent of Storage limits. Function request and response bodies are capped at 4.5 MB, `/tmp` is capped at 500 MB, the standard uncompressed function bundle limit is 250 MB, and functions end at their configured duration. The repair route's `maxDuration = 300` matches Vercel's default and Hobby maximum. Cron sends a production GET, adds `Authorization: Bearer ${CRON_SECRET}` when configured, does not retry failures, can miss or duplicate delivery, and can overlap a still-running previous invocation. The direct browser-to-Supabase upload path does not pass file bytes through a Vercel function ([Vercel function limits](https://vercel.com/docs/functions/limitations); [Vercel cron jobs](https://vercel.com/docs/cron-jobs)).

Supabase image transforms are available on Pro and above, support image dimensions from 1 to 2,500, cap input at 25 MB and 50 MP, and can return WebP automatically. The repair code uses public transformed URLs and then uploads its rendered thumb/preview blobs (`dws-app/src/lib/photos/repair/transforms.ts:13-67`; [image transformations](https://supabase.com/docs/guides/storage/serving/image-transformations)).

#### Testing patterns

The repository's upload tests assert the local TUS contract through a fake resumable implementation, including threshold, chunk configuration, token refresh, retry statuses, fingerprints, and previous-upload resumption (`dws-app/src/lib/photos/upload.test.ts:428-727`). Repair tests cover transform eligibility and transcode limits as pure planning/helper behavior. No live test currently verifies Supabase plan limits, bucket configuration, signed uploads, S3 interoperability, image transforms, Vercel payload limits, or cron delivery. Supabase publishes Uppy resumable and signed-resumable examples, while MCP Inspector is unrelated to Storage testing.

### 4. Durable state, browser-local state, and human ratification

Receipt workflow state is a named database enum-like constraint: `Pending`, `Approved`, `Rejected`, and `Reimbursed`. Receipt creation always starts at `Pending`, and status writes are guarded in both API logic and a database trigger (`dws-app/src/lib/types.ts:57-75`; `dws-app/supabase/migrations/00000000000000_baseline.sql:274-286`; `dws-app/supabase/migrations/20260823120100_write_guards.sql:12-34`). Photo workflow state is row/path based: a `photos` row records the accepted original and optional derivative, sidecar, playback, and skipped-reason paths. Before that row exists, uploaded objects are pre-finalization objects rather than admitted photos.

| Workflow data | Location | Persistence |
|---|---|---|
| Photo row and paths | Supabase Postgres | Durable |
| Photo objects | Supabase Storage | Durable; may precede row finalization |
| Queue item metadata | Browser `localStorage` | 24 hours; restored as interrupted |
| Actual `File` objects | Browser memory | Lost on reload |
| TUS fingerprint/upload URL | tus-js-client browser storage | Separate from queue manifest; URL up to 24h |
| Upload sheet edits/previews | React state/object URLs | Browser-local |
| Receipt temp object | Supabase Storage under `temp_*` | Durable staging object |
| Batch-review decisions | React state | Local until confirmed and submitted |

The receipt pipeline is the existing example of a temporary server-visible staging path. The upload route writes `{userId}/temp_{id}_{timestamp}.{ext}`; OCR reads that object; receipt creation inserts a Pending row, moves the file to `{userId}/{receiptId}.{ext}`, and updates `image_url`. Insert failure best-effort removes the temp object, and move failure best-effort removes the new row (`dws-app/src/app/api/receipts/upload/route.ts:39-85`; `dws-app/src/app/api/receipts/ocr/route.ts:16-111`; `dws-app/src/app/api/receipts/route.ts:28-92`). Photos use the inverse pattern: stable final object paths exist before the durable row.

Human ratification appears in several current forms:

- The photo upload sheet previews selected files and metadata before enqueue.
- Receipt OCR may auto-submit only when required fields are present and no duplicate is detected; otherwise a manual confirmation form opens.
- Admin receipt batch-review decisions remain local until the user opens a confirmation dialog and submits all decisions.
- Bulk status changes and receipt deletion use count/detail confirmation dialogs.
- Photo delete uses a two-click inline armed state; Escape cancels the armed state.

Photo finalization is idempotent on the photo primary key and duplicate-aware on job/hash. Repair planning is designed to converge on repeated runs. Destructive repair actions are based on an inventory snapshot but recheck live row references or object existence immediately before deletion. Exceptions are accumulated into a structured response rather than aborting the whole run at the first action error (`dws-app/src/app/api/photos/route.ts:327-344`; `dws-app/src/app/api/photos/repair/route.ts:154-181`; `dws-app/src/app/api/photos/repair/route.ts:489-524`).

Operational scripts use a separate preview/commit pattern: `import-jobs`, `onboard-users`, and `attach-orphan-sidecars` default to non-mutating output and require `--execute`/`-x` to write. No literal dry-run API or route exists under `src`; UI previews and confirmation dialogs are the browser equivalents.

#### Testing patterns

Queue tests cover state transitions, manifest stripping, 24-hour expiry, interrupted restoration, re-pick matching, removal, and clearing. Upload tests cover idempotent replay, content duplicates, cleanup, and kill-point convergence. Repair planner tests cover settle windows, orphan windows, action selection, repeated-run idempotence, and transcode gating. Storage-error tests cover receipt staging cleanup behavior. No rendered component, dialog-interaction, browser-local persistence, screenshot regression, or end-to-end human-confirmation tests were found.

### 5. Operational scripts and command conventions

`package.json` exposes only `dev`, `build`, `start`, `lint`, and `test`; the root Makefile wraps setup, dev, build, and lint. Five operational `.mjs` scripts are invoked directly with Node (`dws-app/package.json:5-11`; `Makefile:1-15`; `dws-app/scripts/`).

| Script | Invocation/auth | Mutation contract | Output/error contract |
|---|---|---|---|
| `onboard-users.mjs` | optional `--csv`; Supabase URL + service role | dry-run by default; `--execute`/`-x` creates Auth users and employee profiles | JSON dry-run/report files; row errors accumulated; fatal setup exits 1 |
| `set-auth-display-names.mjs` | no args; root employee CSV; service role | always updates matching Auth metadata | JSON report with counts/errors; fatal top-level failure exits 1 |
| `import-jobs.mjs` | required `--projects`, `--jobs`; service role only in execute path | dry-run by default; execute upserts jobs on job number | counts/unmatched rows; upsert/count failure exits 1 |
| `attach-orphan-sidecars.mjs` | `--execute`/`-x`; service role | dry-run plan or move/update/delete sequence | `{ attached, unmatched, errors }`; action errors set exit code 1 |
| `reproduce-receipt.mjs` | image path, optional out dir; public Supabase vars, test OTP, running app | real temp upload and OCR calls | envelope JSON; fatal failure exits 1 |

The dry-run scripts resolve inputs, normalize and join source data, print planned mutations, and return before creating a service client or mutating. Service clients disable token refresh and session persistence. Sidecar repair paginates photo rows in blocks of 1,000, matches same uploader/job/basename, and executes storage move, row update, then orphan-row delete. Receipt reproduction obtains a real SMS OTP session, serializes Supabase cookies, calls the real upload and OCR endpoints, and writes an envelope fixture (`dws-app/scripts/import-jobs.mjs:1-119`; `dws-app/scripts/attach-orphan-sidecars.mjs:1-153`; `dws-app/scripts/reproduce-receipt.mjs:1-111`).

Migration SQL files use `<UTC timestamp>_<snake_case_name>.sql`. The documented CLI unsets `SUPABASE_ACCESS_TOKEN`, targets the linked project, and applies a named file. Concurrent index statements are applied individually because the file-mode command wraps multiple statements in a transaction. Migrations use `if not exists` and drop/create pairs for repeatability (`dws-app/supabase/migrations/README.md:13-71`).

#### Testing patterns

Vitest runs `src/**/*.test.{ts,tsx}` in a Node environment. No direct automated tests exist for the five `.mjs` scripts. Their reusable photo primitives have unit coverage, and `reproduce-receipt.mjs` is itself a live local reproduction harness rather than an assertion suite. No fixture-driven test currently exercises the onboarding CSV, job CSV join, or orphan-sidecar script from argument parsing through output.

### 6. Current MCP protocol and client compatibility

The current authoritative MCP revision on the research date is `2026-07-28`. It uses JSON-RPC 2.0 and defines a stateless Streamable HTTP transport. A hosted server exposes one endpoint, commonly `/mcp`; each request or notification is an independent POST; clients advertise both `application/json` and `text/event-stream`; a response is either one JSON object or a request-scoped SSE stream. The revision removed protocol-level sessions, the standalone GET SSE stream, server-initiated requests, DELETE session termination, and resumable `Last-Event-ID` streams that existed in older revisions ([MCP specification](https://modelcontextprotocol.io/specification/2026-07-28); [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

`server/discover` is mandatory and reports supported protocol versions, capabilities, server identity, and optional instructions. Tool discovery uses paginated/cacheable `tools/list`. Tool definitions contain a name, description, JSON Schema `inputSchema`, optional `outputSchema`, and annotations. Results can carry unstructured `content`, `structuredContent`, and `isError`. Stateful workflows return explicit handles in tool results and accept them in later calls because the protocol has no implicit session handle ([server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover); [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

HTTP authorization is optional at the protocol level. When present, the specification uses OAuth 2.1 resource-server semantics: protected resource metadata, authorization-server or OIDC discovery, supported client registration/identification, bearer tokens on every request, audience/resource validation, and HTTP 401 for invalid or expired tokens. Hosts are responsible for user consent and preserving a human ability to deny tool invocations ([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).

| Area | ChatGPT / Codex | Claude API | Claude Code | Claude / Cowork / Desktop remote connectors |
|---|---|---|---|---|
| Hosted transport | Stable HTTPS Streamable HTTP | Public HTTPS; Streamable HTTP and legacy SSE | Remote HTTP preferred; legacy SSE; local stdio | Remote MCP reached from Anthropic cloud |
| Feature coverage | Shared plugin server; ChatGPT also supports MCP Apps UI | Tool calls only | Tools plus local-client resources/prompts support | Remote connector tools/actions; local MCP does not carry into Cowork/web |
| OAuth | Host can run OAuth + PKCE and link account; server validates tokens | API caller supplies and refreshes bearer token | Built-in login plus CIMD/DCR/preconfigured clients | Per-user connector authentication |
| Approval | ChatGPT confirmations depend on permissions/action context; admin action controls | API application controls allow/deny and human loop | Permission modes, organization `ask`, forced-interaction metadata | Connector permissions reviewed by user/organization |
| Tool discovery | ChatGPT “Scan Tools”; shared server metadata for Codex | Configured MCP toolsets, allow/deny/per-tool config | Loads and searches tools; can defer definitions | Connector URL and account-level enablement |
| Client location | OpenAI-hosted product | Anthropic API service | Local process for stdio; remote HTTP otherwise | Anthropic cloud, including Cowork/Desktop remote connectors |

OpenAI documents MCP servers as a shared plugin capability for ChatGPT and Codex and calls for stable HTTPS Streamable HTTP in production. Results may use `structuredContent`, `content`, and `_meta`, while `_meta` is hidden from the model but is not a security boundary. ChatGPT adds a tool-scan flow, OAuth account linking, write-action confirmations, enterprise action controls, and optional iframe UI; Codex workflows still rely on tool-readable results because ChatGPT UI rendering is not a universal client behavior ([OpenAI plugins](https://developers.openai.com/plugins); [build an MCP server](https://developers.openai.com/plugins/build/mcp-server); [plugin authentication](https://developers.openai.com/plugins/build/auth); [ChatGPT Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)).

Anthropic's Messages API MCP connector is beta, connects to public HTTPS servers, and currently supports tool calls rather than the full MCP feature set. The API consumer obtains and refreshes any OAuth token and passes it as `authorization_token`. Claude Code has a broader local client: remote HTTP, deprecated SSE, and local stdio; built-in OAuth login; resources; schema rewriting for root combinators; oversized result persistence; organization tool controls; and per-tool forced user interaction. Claude, Cowork, and Desktop remote custom connectors connect from Anthropic's cloud rather than the user's laptop; local MCP servers configured in Desktop are not available in Cowork or claude.ai ([Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector); [Claude Code MCP](https://code.claude.com/docs/en/mcp); [Anthropic custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).

Protocol errors distinguish JSON-RPC method errors, transport/header errors, and tool-level `isError`. The current transport defines, among other cases, `HeaderMismatch` code `-32020`, unsupported protocol version `-32022`, and unknown method `-32601` with HTTP 404. Closing a request's SSE response is its cancellation signal.

#### Testing patterns

No MCP server or MCP-specific test exists in the repository at this commit. Official testing surfaces include MCP Inspector (`@modelcontextprotocol/inspector`), protocol conformance scenarios used by SDK tiering and standards proposals, ChatGPT tool scanning, OpenAI's API Playground/raw logs, and Anthropic's documented Inspector token workflow ([MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector); [SDK tiers](https://modelcontextprotocol.io/community/sdk-tiers)). No single official product-level conformance suite was found for ChatGPT, Codex, Claude, Claude Code, or Cowork.

### 7. DWS interface and design-system patterns

The UI stack is Tailwind 4, shadcn/ui in `new-york` style, Radix primitives, Vaul drawers, Lucide icons, Sonner toasts, TanStack Query, and YARL lightbox. The app uses Geist Sans and Geist Mono, a global radius of `0.625rem`, and dark browser chrome/background `#222222` (`dws-app/package.json:12-44`; `dws-app/components.json:1-20`; `dws-app/src/app/layout.tsx:1-47`; `dws-app/src/app/globals.css:8-134`).

The primary photo/admin palette is a layered dark neutral system with explicit blue and state colors:

| Color | Current role |
|---|---|
| `#222222` | page/app background and browser theme |
| `#2e2e2e` / `#333333` | raised panels, drawers, cards, dialogs |
| `#3e3e3e` / `#444444` / `#4e4e4e` | inputs, borders, table headers, secondary surfaces |
| `#2680FC` | primary photo action and focus |
| `#1a6fd8` | primary blue hover |
| `#4ade80` | upload success progress |
| red/yellow/green/blue translucent variants | error, pending, approval, and receipt status presentation |

Shared buttons are `rounded-md`, medium-weight small text, 36 px high by default, and use `shadow-xs`. Cards are `rounded-xl`, bordered, `py-6`, and `shadow-sm`. Inputs are 36 px high, bordered and rounded, with a three-pixel focus ring. Dialogs use a `black/50` overlay, centered bordered content, `p-6`, rounded corners, and `shadow-lg`; drawers use a `black/80` overlay and bottom-fixed rounded content (`dws-app/src/components/ui/button.tsx:7-59`; `dws-app/src/components/ui/card.tsx:5-82`; `dws-app/src/components/ui/input.tsx:5-19`; `dws-app/src/components/ui/dialog.tsx:33-73`; `dws-app/src/components/ui/drawer.tsx:8-56`).

`SheetShell` is the main responsive interaction container. It selects a Vaul Drawer on mobile and a Radix Dialog on desktop, pins header and footer, scrolls the middle, and uses keyboard-inset logic on mobile. Full sheets occupy `85dvh`; compact sheets use `70dvh` on mobile and a 520 px desktop cap. `useMobile` combines mobile user agent and a 767 px media query; `useDesktop` requires at least 1,024 px and hover capability (`dws-app/src/components/photos/sheet-shell.tsx:28-172`; `dws-app/src/hooks/use-mobile.tsx:5-30`; `dws-app/src/hooks/use-desktop.ts:5-30`; `dws-app/src/hooks/use-keyboard-inset.ts:5-55`).

Photo upload UI uses a hidden picker, desktop drop overlay, upload metadata sheet, fixed upload tray, and centralized progress rows. Progress labels and colors distinguish queued, uploading, done, failed, duplicate, and interrupted; errors use red border/background plus truncated detail; Retry and Re-pick are distinct actions. Batch receipt review has loading, error/retry, empty, active, and completion views, a responsive one/two-column layout, a progress bar, colored decision badges, navigation dots, and a final count-summary confirmation dialog (`dws-app/src/components/photos/upload-tray.tsx:15-166`; `dws-app/src/components/photos/upload-progress.tsx:17-89`; `dws-app/src/components/batch-review-dashboard.tsx:138-535`).

Eight checked-in documentation screenshots cover desktop admin dashboard/review/user management and mobile employee/login/edit/toast states under `Docs/screenshots/`.

#### Testing patterns

Responsive utilities are unit-tested for desktop media-query constants and visual-viewport keyboard insets. Photo batch helpers test input clearing and preview indexes. Upload progress/state logic is exercised through queue and upload unit tests. No rendered component snapshot tests, screenshot regression tests, browser viewport tests, or automated accessibility tests were found. The checked-in screenshots serve as documentation, not executable assertions.

## Code References

The commit is present on `origin/main`; links below are immutable GitHub permalinks.

### Deployment, authentication, and authorization

- [`dws-app/vercel.json`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/vercel.json#L1-L7) — Vercel install command and photo-repair cron.
- [`dws-app/next.config.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/next.config.ts#L3-L28) — external packages, ffmpeg tracing, Storage image host, and build checks.
- [`dws-app/src/middleware.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/middleware.ts#L4-L23) — photo-host root rewrite.
- [`dws-app/src/lib/supabaseClient.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/supabaseClient.ts#L1-L26) — browser client.
- [`dws-app/src/lib/supabaseServerClient.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/supabaseServerClient.ts#L1-L44) — request-cookie server client.
- [`dws-app/src/lib/supabaseAdminClient.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/supabaseAdminClient.ts#L1-L17) — server-only service-role client.
- [`dws-app/src/lib/requireAdmin.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/requireAdmin.ts#L10-L42) — shared API admin guard.
- [`dws-app/src/lib/cookieDomain.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/cookieDomain.ts#L5-L33) — apex cookie scoping.
- [`dws-app/src/app/api/auth/send-otp/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/auth/send-otp/route.ts#L4-L31) and [`verify-otp`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/auth/verify-otp/route.ts#L4-L44) — SMS session establishment.
- [`dws-app/supabase/migrations/20260822130200_rls_storage_scalar_subqueries.sql`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/supabase/migrations/20260822130200_rls_storage_scalar_subqueries.sql#L6-L74) — photo and receipt Storage policies.
- [`dws-app/supabase/migrations/20260823120100_write_guards.sql`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/supabase/migrations/20260823120100_write_guards.sql#L1-L42) — receipt status and profile role guards.

### Photo ingestion, queue, and repair

This group covers the key entry points; `dws-app/src/lib/photos/` contains 37 source/test/fixture files and `dws-app/src/components/photos/` contains 29 UI components.

- [`dws-app/src/lib/photos/upload.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/upload.ts#L109-L400) — standard/TUS upload, paths, derivatives, finalization, and duplicate cleanup.
- [`dws-app/src/lib/photos/upload-manager.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/upload-manager.tsx#L151-L308) — manifest persistence and sequential queue runner.
- [`dws-app/src/lib/photos/upload-queue.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/upload-queue.ts#L8-L203) — statuses, persisted shape, TTL, restore, and re-pick.
- [`dws-app/src/lib/photos/classify.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/classify.ts#L1-L60) — extension-first file classification.
- [`dws-app/src/lib/photos/exif.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/exif.ts#L10-L80) and [`sidecar.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/sidecar.ts#L24-L97) — capture metadata and XMP pairing/parsing.
- [`dws-app/src/lib/photos/hash.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/hash.ts#L1-L15) — 100 MB full-buffer SHA-256 boundary.
- [`dws-app/src/lib/photos/derivatives.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/derivatives.ts#L9-L180) — browser image/video derivatives.
- [`dws-app/src/app/api/photos/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/photos/route.ts#L100-L346) — listing and durable finalization.
- [`dws-app/src/app/api/photos/exists/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/photos/exists/route.ts#L6-L40) — dedupe preflight.
- [`dws-app/src/app/api/photos/repair/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/photos/repair/route.ts#L37-L528) — authenticated convergence sweep and action execution.
- [`dws-app/src/lib/photos/repair/sweep.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/repair/sweep.ts#L1-L119) — pure repair planner.
- [`dws-app/supabase/migrations/00000000000003_photos_schema.sql`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/supabase/migrations/00000000000003_photos_schema.sql#L12-L81) — photo schema, RLS, capture provenance, playback, and hash index.
- [`dws-app/supabase/migrations/20260823100000_review_fixes.sql`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/supabase/migrations/20260823100000_review_fixes.sql#L227-L233) — public bucket rows and object limits.
- [`Docs/photos-runbook.md`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/Docs/photos-runbook.md#L5-L179) — cron, response counts, logging, repair, and launch drills.

### State and review interfaces

- [`dws-app/src/components/photos/upload-sheet.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/photos/upload-sheet.tsx#L71-L261) — browser-local previews, metadata review, and enqueue.
- [`dws-app/src/components/photos/upload-tray.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/photos/upload-tray.tsx#L15-L166) — upload status summary and recovery actions.
- [`dws-app/src/components/batch-review-dashboard.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/batch-review-dashboard.tsx#L24-L535) — local receipt decisions and confirmation before batch write.
- [`dws-app/src/app/api/receipts/upload/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/receipts/upload/route.ts#L6-L85), [`ocr/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/receipts/ocr/route.ts#L16-L111), and [`receipts/route.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/api/receipts/route.ts#L8-L92) — temporary object, OCR/review, row creation, and move/finalize sequence.
- [`dws-app/src/components/photos/photo-info.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/photos/photo-info.tsx#L33-L77) — inline armed delete confirmation.

### Operational scripts

The following list is exhaustive for `dws-app/scripts/*.mjs` at this commit.

- [`onboard-users.mjs`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/scripts/onboard-users.mjs#L10-L185) — employee CSV planning/execution and reports.
- [`set-auth-display-names.mjs`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/scripts/set-auth-display-names.mjs#L10-L94) — Auth metadata synchronization.
- [`import-jobs.mjs`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/scripts/import-jobs.mjs#L1-L119) — dry-run/execute project-job import.
- [`attach-orphan-sidecars.mjs`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/scripts/attach-orphan-sidecars.mjs#L1-L153) — dry-run/execute historical XMP attachment.
- [`reproduce-receipt.mjs`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/scripts/reproduce-receipt.mjs#L1-L111) — local real-session receipt reproduction harness.
- [`dws-app/supabase/migrations/README.md`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/supabase/migrations/README.md#L13-L91) — migration naming, commands, concurrency, and dashboard-owned configuration.

### Design system and tests

- [`dws-app/src/app/globals.css`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/app/globals.css#L5-L134) — global tokens, dark theme, fonts, radius aliases, backgrounds, and responsive variant.
- [`dws-app/src/components/photos/sheet-shell.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/photos/sheet-shell.tsx#L28-L172) — responsive Drawer/Dialog shell.
- [`dws-app/src/components/ui/button.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/ui/button.tsx#L7-L59), [`dialog.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/ui/dialog.tsx#L33-L73), and [`progress.tsx`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/components/ui/progress.tsx#L5-L22) — shared primitives.
- [`dws-app/src/lib/photos/upload.test.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/upload.test.ts#L91-L818) — upload/finalization/TUS test suite.
- [`dws-app/src/lib/photos/upload-queue.test.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/upload-queue.test.ts#L12-L99) — queue and manifest tests.
- [`dws-app/src/lib/photos/repair/sweep.test.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/lib/photos/repair/sweep.test.ts#L33-L124) — repair convergence tests.
- [`dws-app/src/hooks/use-keyboard-inset.test.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/hooks/use-keyboard-inset.test.ts#L4-L39) and [`use-desktop.test.ts`](https://github.com/ariavasulin/OpenReimbursements/blob/142b09c80977c25206ff6883294aa54326efb0d5/dws-app/src/hooks/use-desktop.test.ts#L7-L16) — responsive helper tests.

## Architecture Documentation

The existing application follows a split-control-plane pattern for photos. Data-plane bytes move directly from the authenticated browser to Supabase Storage, while the Next.js API performs a smaller control-plane finalization request that validates caller identity, path ownership, metadata, and database constraints. This keeps large object bytes outside Vercel's request-body boundary. The durable admission marker is the Postgres row, not the completion of any individual Storage upload.

The upload workflow is intentionally convergent across three mechanisms. First, deterministic object paths and a stable photo ID make upload attempts repeatable. Second, TUS keeps transport progress through a client fingerprint and upload URL while the browser queue keeps human-facing metadata/status separately. Third, the repair route reconciles database rows and Storage objects after partial success, using time windows and live destructive rechecks. The queue, TUS state, Postgres row, and Storage object are independent state stores with different lifetimes.

Application authorization is layered. Supabase RLS is the base data boundary for ordinary browser and server-session calls. Next route handlers add validation and role logic, while service-role operations are restricted to server modules, admin routes after a role check, cleanup, and cron repair. The `CRON_SECRET` path is machine authorization rather than user authorization, so its operational logs contain target identities but no Supabase caller identity.

The existing human-review vocabulary is preview, local staging, explicit confirmation, structured counts/errors, and repeatable completion. Receipt temp objects demonstrate durable staging before row finalization. Photo upload demonstrates final-path objects before row finalization. Batch receipt review demonstrates local decisions followed by one confirmed mutation. Operational scripts demonstrate dry-run-by-default plans followed by `--execute`.

The current hosted MCP protocol fits a distinct external control plane. Clients discover server and tools over public HTTPS, call independent JSON-RPC requests, and carry user authorization on every request. Because modern MCP has no protocol session, any multi-step upload or ratification state is represented by explicit identifiers returned in tool results rather than by a connection-bound session. Product clients add their own authorization, approval, UI, and feature-coverage layers on top of that protocol.

## Follow-up Findings

Read-only live-environment checks were completed on 2026-08-31 after the initial report.

### Production Vercel deployment

The production Vercel project is `dws-receipts` in scope `ariavasulins-projects`, on the Hobby plan. The inspected production deployment was `dpl_9zAxYGobB2wnWTfsRebSk58ecHsj`, created 2026-08-23 at 13:26:13 PDT and in `READY` state. Its aliases include `dws-receipts.com`, `www.dws-receipts.com`, and `photos.dws-receipts.com`.

The deployed `/api/photos/repair` function uses Node 22.x, 2,048 MB of memory, and a 300-second timeout. `PHOTOS_TRANSCODE` is not present in the production environment, and Vercel reports no hidden production variables. Because the code enables transcoding only when that variable is exactly `1`, production video playback transcoding is currently disabled (`dws-app/src/lib/photos/repair/transcode.ts:14-22`; `dws-app/src/app/api/photos/repair/route.ts:46`). These facts were observed through read-only `vercel project inspect`, deployment inspection, project environment, user, and team API calls.

### Production Supabase bucket

The production bundle points to Supabase project `qebbmojnqzwwdpkhuyyd`, named `Receipt App`, in the `DWS` organization and `us-east-2` region. The project reported `ACTIVE_HEALTHY`.

The live `photos` bucket is public, has no MIME allowlist, and has `file_size_limit = 53,687,091,200` bytes, exactly 50 GiB. This confirms that the migration value in SQL is deployed. The available CLI credentials did not expose the DWS organization's exact Supabase plan name. The live 50 GiB bucket limit is above Supabase's documented 50 MB Free-plan maximum and within its documented Pro/Team configurable maximum, but that establishes a non-Free effective limit rather than distinguishing Pro from Team ([Storage file limits](https://supabase.com/docs/guides/storage/uploads/file-limits); [Supabase pricing](https://supabase.com/pricing)).

### Production TUS hostname

The production JavaScript bundle constructs resumable uploads at:

```text
https://qebbmojnqzwwdpkhuyyd.supabase.co/storage/v1/upload/resumable
```

The bundle contains the general Supabase project URL and endpoint concatenation, and contains no `storage.supabase.co` reference. Both the general host and `qebbmojnqzwwdpkhuyyd.storage.supabase.co` direct Storage host answer an HTTP preflight, but the deployed client uses the former. `photos.dws-receipts.com/storage/v1/upload/resumable` is a Vercel/Next 404 and is not involved in the upload path. This closes the runtime-host question and matches the code's `${config.supabaseUrl}/storage/v1/upload/resumable` construction (`dws-app/src/lib/photos/upload.ts:145-157`; `dws-app/src/lib/photos/upload-manager.tsx:88-126`).

### Legacy corpus availability

The current development machine has no mounted SMB shares: `/Volumes` contains only the local disk and `smbutil statshares -a` reports none. Constrained searches found no `.picasa.ini`, `.picasaoriginals`, Google Takeout archive, existing inventory, or real legacy photo corpus in the workspace. Therefore file counts, total bytes, largest object, extensions, duplicate rate, sidecar frequency, and Picasa-only metadata cannot be measured from this machine. They require read access from an office Windows machine where `J:` is mounted or an exported inventory/Takeout archive.

### DWS client/workspace capability boundary

Official product eligibility is known, but actual DWS tenant state is not externally observable. ChatGPT Developer Mode is documented for Plus, Pro, Business, Enterprise, and Education on web, subject to workspace policy. Business apps are enabled by default, while Enterprise/Education availability is administrator-controlled. Anthropic documents remote custom connectors across Claude, Cowork, and Desktop for Free, Pro, Max, Team, and Enterprise; Team/Enterprise Owners add organization connectors, and Cowork/cloud-session availability can be administrator-controlled ([ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode); [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt); [Anthropic custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp); [Cowork on Team and Enterprise](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)).

Neither vendor documents an ordinary end-user UI that exposes the negotiated MCP protocol revision. Actual connectability is established by the user's plan, managed-workspace membership and role, administrator app/connector settings, and whether the connector appears and can be connected.

The intended DWS users have individual ChatGPT and Claude accounts rather than membership in a DWS-managed workspace. Therefore DWS organization-level app allowlists, connector administration, RBAC, SSO, and managed-workspace policy do not apply to the MVP distribution path. Each employee connects the hosted MCP through the capabilities available on their own account and plan. The individual plan affects only which client surface can add the connector and its per-account setup flow; it does not change the hosted server's MCP transport or tool contract. In the current official product matrix, ChatGPT Developer Mode/custom MCP is documented for paid individual tiers (Plus and Pro), not Free, while Claude Free supports one remote custom connector.

### Current approval identity retention

Current photo rows retain uploader ID and created time; receipt rows retain submitter ID and created/updated times. Receipt batch status and bulk reimbursement routes authenticate the admin but update only status and, in the bulk path, `updated_at`. There is no durable `approved_by`, `reimbursed_by`, decision-event table, or migration-approval record in the current schema (`dws-app/supabase/migrations/00000000000000_baseline.sql:245-295`; `dws-app/src/app/api/receipts/batch-status/route.ts:5-44`; `dws-app/src/app/api/receipts/bulk-update/route.ts:4-67`). Repair logs identify targets and actions but not a Supabase user, because the repair authority is `CRON_SECRET` plus service role.

For the migration workflow, DWS requires a durable record of the approving employee, migration batch, and approval timestamp. A more extensive event history was not identified as a current business requirement.

### User-confirmed production context

The DWS Supabase organization is on the Pro plan. Combined with the live bucket inspection, the effective current boundary is therefore a Pro project with a public `photos` bucket configured for 50 GiB objects.

The exact office mapping behind `J:` is outside the hosted MCP server boundary. The hosted server does not read the office share directly; any inventory or file access occurs in the employee's local client/runtime and files transfer directly through the migration upload mechanism. Corpus measurements remain unknown until that local migration workflow scans the mounted drive, but the UNC path is not an input to the hosted server architecture.

## Open Questions

None. Legacy corpus measurements are deferred runtime inputs produced when an employee-side migration process can scan the mounted office drive; they are not an unresolved hosted-server architecture dependency.
