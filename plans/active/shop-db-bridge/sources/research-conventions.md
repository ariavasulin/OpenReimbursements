# Plan shape and server-side patterns (OpenReimbursements)

Repo: OpenReimbursements, branch `perf-round-1`, commit `fe41309` (the same tree as `f32010b` on `main`).
All paths below are relative to the repo root unless absolute.

---

## 1. Plan document shape under `plans/`

### 1.1 What exists

`plans/` contains only `active/`. There is **no** `plans/README.md`, no `plans/AGENTS.md`, no template file, no `completed/` and no `.archive/` folder (checked with `ls -a plans` and `find ... -iname completed|archive*|*template*`; nothing found).

The planning rules that *are* in the repo are a frozen copy stored inside one plan: `plans/active/dws-hosted-mcp/sources/planning-contract/{AGENTS.md, IMPLEMENTATION.md, refs/authoring.md}`. The hosted-MCP plan describes them as "frozen alongside this plan for portability" and "reference context, not commands" (`plans/active/dws-hosted-mcp/plan.md:13`).

Every plan directory and its files (line counts):

```
plans/active/dws-hosted-mcp/
  plan.md                                    473
  journal.md                                  42
  preflight.md                                52
  reviews/2026-09-04-claude.md                90
  sources/ticket.md                           18
  sources/research.md                        413
  sources/system-design.md                   403
  sources/planning-contract/AGENTS.md         86
  sources/planning-contract/IMPLEMENTATION.md 64
  sources/planning-contract/refs/authoring.md 221
plans/active/dws-photos-client-feedback/
  plan.md                                    688
  sources/ticket.md                           50
  sources/design-discussion.md               105
  sources/research-questions.md               35
  sources/research.md                        406
plans/active/dws-photos-perf-audit/          (no plan.md)
  audit.md                                  1297
  handoff.md                                 183
plans/active/photo-albums/
  plan.md                                    837
  sources/ticket.md                           44
  reviews/2026-09-20-baseline.md             227
  reviews/2026-09-20-phase-2.md               77
  reviews/2026-09-21-repair.md                46
  reviews/2026-09-21-review-fixes.md          76
  reviews/2026-09-21-verification.md          49
plans/active/photo-folders/
  plan.md                                    123   (single file, "quick patch")
```

Recurring layout: `plan.md` is the main document; `sources/` holds frozen inputs (`ticket.md` = user's words, `research.md`, sometimes `design-discussion.md`, `research-questions.md`, `system-design.md`); `reviews/` holds dated review records named `YYYY-MM-DD-<topic>.md`; `journal.md` is an append-only revision log; `preflight.md` records an environment check.

### 1.2 Frontmatter and status conventions

Every `plan.md` starts with the same YAML block (the perf-audit's `audit.md`/`handoff.md` and the hosted-MCP `journal.md`/`preflight.md` have none):

`plans/active/dws-photos-client-feedback/plan.md:1-5`
```yaml
---
status: active
created: 2026-10-12
updated: 2026-10-12
---
```
Same shape at `plans/active/dws-hosted-mcp/plan.md:1-5` (`updated: 2026-09-21`), `plans/active/photo-albums/plan.md:1-5`, `plans/active/photo-folders/plan.md:1-5`.

The frozen authoring rules define it (`plans/active/dws-hosted-mcp/sources/planning-contract/refs/authoring.md:192-206`):
```yaml
---
status: active          # active | done | abandoned | deferred
created: 2026-04-29
updated: 2026-04-29
---
```
"Update `updated:` on substantive content edits and `status:` on lifecycle change."

Lifecycle rule (`.../planning-contract/AGENTS.md:37-39`): "Plans are created in `active/` and worked continuously. A completed implementation plan is archived or deleted in the merging PR ... Abandoned or deferred plans take a terminal status and move to `.archive/` with a one-line reason."

Placement rule (`.../planning-contract/AGENTS.md:23-31`):
```
- scoped to one module → `active/<module>/`
- spanning multiple modules → `active/<initiative>.md` or `active/<initiative>/plan.md`
- exploratory planning with durable process trace → optional initiative directory with `sources/`, `journal.md`, and `discarded/`

Filenames are `kebab-case.md`; no `_plan` suffix. Existing `active/` plans are reference material, not templates.
```

In-body status: plans also carry a bolded "Current phase" inside the Agent brief, e.g. `plans/active/dws-photos-client-feedback/plan.md` brief: "Current phase: **plan authored; Wave 1 ready to start.**"; `plans/active/dws-hosted-mcp/plan.md:11`: "Current phase: **issue-interview revision and local implementation verified; external office/activation checks outstanding**".

### 1.3 Preamble conventions (directly after the H1)

Shape/consequence/delivery declaration, `plans/active/dws-photos-client-feedback/plan.md:9-15`:
```
Shape: tech spec + implementation plan. The design-doc work happened in conversation with Ari on
2026-10-12 and is recorded in [`sources/design-discussion.md`](sources/design-discussion.md); the
codebase facts are in [`sources/research.md`](sources/research.md) (commit `53dd82f`, tip of
`main` at authoring); the client's words are in [`sources/ticket.md`](sources/ticket.md).
**Consequence: consequential** (it changes who may delete durable photo data, renames every
photo, and wipes the current library). **Delivery: live** (every unit reaches the ordinary
production path once deployed; nothing new is gated). No PRD.
```
`plans/active/photo-albums/plan.md:9-12`: "Shape: design doc + tech spec + implementation plan (standalone; no PRD). **Consequence: consequential** ... **Delivery: live** for every phase except share links, which are **gated** behind a new `sharing_enabled` switch."

Agent brief paragraph (Intent / Source of truth / Locked decisions / Current phase / Stop-and-ask triggers / implementation-owned), `plans/active/dws-photos-client-feedback/plan.md` (brief, ~lines 17-27):
```
**Agent brief.** Intent: turn the DWS owner's first feedback round into shipped changes: ...
Source of truth: this plan, then the
design discussion, then the research. Locked decisions: Decisions 1–12 below. Current phase:
**plan authored; Wave 1 ready to start.** Stop-and-ask triggers: any production mutation (a
migration, setting admins, the wipe) — Ari confirms each one; ... Everything else — helper names, file
layout, library choices within the named options, test fixtures — is implementation-owned.
```

### 1.4 Heading skeletons

`plans/active/dws-hosted-mcp/plan.md`
```
7   # Hosted DWS MCP, photo migration, and issue reporting
17  ## Why and scope
27  ## System sketch                       (mermaid flowchart)
45  ## Premise anchors and execution scope (table: Anchor | Revalidation probe)
60  ## Contract surface
62    ### Two MCP tools dispatch six allowlisted scripts
104   ### Browser identity and confirmed targets bound photo authority
126   ### Durable relationships make retries explicit
165   ### Inventory and uploads scale by bounded work
195   ### Global identity and trash preserve recovery without duplicate active rows
207   ### Issue publication is confirmed and retry-safe without relying on the model
219   ### Error and compatibility rules are shared by every new caller
225 ## Acceptance criteria                 (AC-1 .. AC-14)
242 ## Decisions and risks                 (table: Decision | Warrant and mitigation | Reversal condition and posture)
265 ## Rollout and migration contract      (numbered Expand / Dual-write / Backfill / Cutover / Contract)
277 ## Phase 1 — Establish the durable schema and authority boundaries
281   ### Steps / 287 ### Verify / 295 ### Exit criteria
301 ## Phase 2 — Share streaming hashing and canonical finalization
340 ## Phase 3 — Build inventory, approval, and resumable migration
365 ## Phase 4 — Deliver exact photo actions and recoverable deletion
390 ## Phase 5 — Make repair and permanent purge obey one deadline
413 ## Phase 6 — Expose the complete MCP and issue-reporting workflow
444 ## Phase 7 — Rehearse cutover, prove the clients, and prepare activation
    (each phase: ### Steps / ### Verify / ### Exit criteria)
```

`plans/active/dws-photos-client-feedback/plan.md`
```
7   # DWS Photos: client feedback round 1
29  ## Why
42  ## Words employees see
47  ## Goals
66  ## Non-goals
73  ## System sketch
92  ## Premise anchors
104 ## Decisions
163 ## Alternatives
176 ## Contract surface
178   ### Database (additive; each migration applied before its unit's deploy)
206   ### API
222   ### Screens (what the worker builds; mechanism is theirs)
258   ### Acceptance criteria
298 ## Execution shape                     (orchestration, waves table, branching, shared-files table, entry/exit recipes)
366 ## Phase W1-A — Photo admins and the delete rule
400 ## Phase W1-B — Automatic names
425 ## Phase W1-C — Group by, sort, scoped tags
455 ## Launch ops (after W1-A and W1-B deploy; step 3 after the Wave 2 PR merges)
478 ## Phase W2-A ... 521 W2-B ... 549 W2-C ... 571 W2-D ... 592 W2-E
619 ## Final — docs and retro
628 ## Round three — the owner's notes of 2026-10-14 (one PR, branch `round3-dad-notes`)
648 ## Rollout
657 ## Risks
671 ## Open questions
680 ## Relationship to other plans
```

`plans/active/photo-albums/plan.md`: Why / Words employees see / Goals and non-goals / System sketch / Premise anchors / Decisions / Alternatives / Contract surface (Database, URLs, MCP, Screens) / Rendered look-and-feel review / Baseline findings / Security and privacy / Acceptance criteria / Execution shape / Phase 1..7 (Steps/Verify/Exit criteria) / Integration judgments — 2026-09-21 / Rollout / Risks / Open questions / Relationship to other plans (lines 31-827).

`plans/active/photo-folders/plan.md` (lightweight): `# Create and rename photo projects by hand` / `## Why and scope` / `## Decisions` / `## Contract surface` / `## Acceptance criteria` / `## Phase 1 — Database and routes` / `## Phase 2 — Pickers, rename, and MCP suggestion` / `## Rollout` (lines 7-120). Phases here use inline `Steps:` / `Verify:` paragraphs instead of sub-headings.

`plans/active/dws-photos-perf-audit/` (an audit + handoff, not a plan):
- `audit.md`: `# DWS Photos performance audit (2026-10-16)` / `## 1. Summary` / `## 2. What is already good` / `## 3. Measurements` / `## 4. Production measurements` / `## 5. Findings, ranked` (subsections `### 5.1 First load and shell` ... `### 5.8 Code shape`, each finding an H4 like `#### SHELL-1 · <title>`) / `## 6. Suggested order of work` / `## 7. Refuted claims`. Opens with a "How to read this" paragraph defining id prefixes, Status (*confirmed* / *unverified-low* / *Confirmed in production*) and Effort (small/medium/large) (`audit.md:3-12`).
- `handoff.md`: `# Handoff: implement the DWS Photos performance audit as one PR` / `## The ask, in Ari's words` / `## Standing rules (from Ari, carried from earlier sessions)` / `## Where you are` / `## What the audit found ...` / `## How to run the implementation` / `## Acceptance criteria per headline finding` / `## After the PR (for Ari, write it into the PR body)` / `## Things that look like bugs but are not (see audit § 7)`.

Companion files in `dws-hosted-mcp/`:
- `journal.md`: `# Plan revision journal`, then dated H2 entries `## 2026-09-04 — Incorporate Claude review`, `## 2026-09-07 — Local implementation retrospective`, `## 2026-09-08 — Deliver the DWS harness through skills`, `## 2026-09-09 — Interview before publishing an issue` (lines 1-40). The first entry has a `| Finding | Disposition in the revised plan |` table (lines 9-15).
- `preflight.md`: `# Implementation preflight — 2026-09-07`, a `Status: **...**` line, a `| Check | Evidence / outcome |` table, then `## Local setup changes` / `## Authentication verification` / `## Implementation boundary`.

### 1.5 Phases, steps, verify items, acceptance criteria (verbatim)

Template: `plans/active/dws-hosted-mcp/sources/planning-contract/AGENTS.md:50-65` (Phase N heading; one framing sentence; `### Steps` / `### Verify` with `[AC-n]` checkboxes / `### Exit criteria`).
And (`AGENTS.md:45`): "Contract requirements use AC IDs (`AC-1`, `AC-2`, ...) plus examples or named scenarios ... every AC advances a plan goal and appears in a phase Verify block where the code lands ... Keep AC-evidence probes such as grep patterns and line anchors in phase Verify blocks, not AC prose."

Representative full phase: `plans/active/dws-photos-client-feedback/plan.md:366-398` (W1-A; numbered Steps naming files, Verify items tagged `[AC-n]` with the suite to run, a one-sentence Exit criteria).

Completed-phase variant: checkboxes ticked `[x]` and an `**Observed evidence (date):**` paragraph appended after Exit criteria — `plans/active/dws-hosted-mcp/plan.md:287-299`:
```markdown
### Verify

- [x] [AC-2, AC-8] `npm --prefix dws-app run test:db` proves concurrent one-use consume, expired tokens, wrong consumer/script, server-only table denial, and direct photo/ledger mutation denial against actual RLS and grants.
...
- [x] `npm --prefix dws-app test` remains green for existing photo/auth helpers.

### Exit criteria

The isolated database enforces the declared identities and permission matrix. New service-side functions cannot be called with client credentials; no production data or configuration changed.

**Observed evidence (2026-09-07):** Independent Astra Low verification reran the real PostgreSQL 15 database suite (20 tests), real Auth/Storage route suite (10 tests), existing unit suite (207 tests), and TypeScript with zero failures/diagnostics. ...
```

Acceptance-criteria styles:
- Bold-titled bullets, `plans/active/dws-hosted-mcp/plan.md:227-240`, e.g.
  `- **AC-4 — Foreground recovery.** After file A finalizes and the tab closes during B, reopening/reselection skips A and resumes B; changed B gets a fresh upload attempt; cancelled B cannot finalize after cancellation.`
- Plain bullets, `plans/active/photo-folders/plan.md:100-106`, e.g.
  `- AC-6 With \`photo_writes_enabled=false\`, create and rename return 503; signed-out returns 401.`

Lightweight phase (inline, no sub-headings), `plans/active/photo-folders/plan.md:108-112`:
```
## Phase 1 — Database and routes

Steps: write the migration; add the two routes; extend `integration/db` and `integration/routes` tests.

Verify: [AC-2, AC-3, AC-5, AC-6] `npm --prefix dws-app run test:db` and `test:routes` cover generated codes, the `exists` result, rename keeping the job number, closed gate, and signed-out.
```

Decisions table with reversal metadata (`plans/active/dws-hosted-mcp/plan.md:244-246`):
```
| Decision / runtime risk | Warrant and mitigation | Reversal condition and posture |
|---|---|---|
| One PR, one existing deployment | Shared photo contracts must change together; phases provide bounded proof | Split if diff review cannot isolate contracts; **reversible on first-release evidence** |
```
Open dependencies tagged `**Needs-data:**` / `**Needs-tracking:**` (`plan.md:259-263`).

Premise-anchor table (`plans/active/dws-hosted-mcp/plan.md:49-56`):
```
| Anchor | Revalidation probe from repository root |
|---|---|
| Repair is one 300-second function | `rg -n 'maxDuration|BUDGET|planSweep|deleteDeadRow' dws-app/src/app/api/photos/repair/route.ts`; read `dws-app/vercel.json` |
```

Execution-shape entry/exit recipes (`plans/active/dws-photos-client-feedback/plan.md:355-363`):
```
**Common entry recipe** (each worker runs it): `git log --oneline main~5..main`; open every file
the phase names; `rg -n "<symbols the phase names>" dws-app/src dws-app/supabase` to find every
caller before changing a signature; `npm --prefix dws-app test` green before the first commit.

**Common exit recipe:** unit tests, `npm run test:db`, `npm run test:routes`, and
`npm run test:browser` green (the integration suites need Docker); `tsc --noEmit` clean; ...
```

Rollout (lightweight form), `plans/active/photo-folders/plan.md:120-123`:
```
## Rollout

Apply the migration to production first (additive; old code ignores it), then merge.
No gate changes. Branch `ariavasulin/photo-folders` off `main`.
```

---

## 2. What `dws-hosted-mcp` proposes

Source: `plans/active/dws-hosted-mcp/plan.md`, ticket `sources/ticket.md`.

- **Origin** (`sources/ticket.md`): user asked for "a hosted mcp for dws employees" with "super simple auth", two tools `load_dws_skill(skill_name)` and `execute_dws_script(script_name)`, first skill `migrate_photos`, uploads "upwards of 100 gb" to migrate existing images to the photos site.
- **What it builds** (`plan.md:9-11`): two hosted MCP tools inside the existing Next.js app (Vercel project `dws-receipts`), delivering two skills, `photos` and `report_issue`. One PR, seven sequential phases, then an operator-controlled production cutover.
- **Why** (`plan.md:19`): "The hosted assistant cannot read the office `J:` drive." So uploads are browser-led: the MCP returns a one-use handoff URL; the employee's browser (SMS login) reads `J:` folders and uploads directly to Supabase Storage via the existing TUS engine. A durable control plane (inventory, approval, batches, ledgers) is added around that engine.
- **Endpoint/auth** (`plan.md:98-100`): `mcp.design-workshops.app/mcp/<shared-key>`, Streamable HTTP, official TypeScript MCP SDK, **stateless per-request transport** ("no in-memory MCP session map or workflow state dependent on a particular function instance"). A 256-bit shared key in the URL is validated on every request; no OAuth.
- **Scripts** (`plan.md:72-93`): `migrate_photos`, `add_photos`, `move_photos`, `remove_photos`, `restore_photos` (each returns `{ handoff_url, expires_at }`), and `create_github_issue` (confirmed, idempotent publication to a fixed GitHub repo).
- **Other contracts**: global content-hash identity for photos, 30-day trash with active-only RLS, recoverable deletion, a repair/purge cron that obeys one deadline, server-side gates in `photo_release_state` (`mcp_enabled`, `photo_writes_enabled`, `repair_enabled`).
- **Explicit non-goals that touch your topic** (`plan.md:23`): "OAuth, a second Vercel project, server access to local shares, background uploads after the browser closes ...". Stop-and-ask trigger (`plan.md:11`): "provision another runtime".
- **Long-running work handling**: there is no long-running service. Work is bounded per request: the repair cron is one 300-second Vercel function (`plan.md:52`, `dws-app/vercel.json`), and the operator cutover script runs "at most 100 groups or 30 seconds per operator-script invocation, checkpointing each committed group" (`plan.md:271`).
- **Status** (`plan.md:11,21`): Phases 1-6 verified; Phase 7 implementation verified, "external office/activation checks remain open" (the office Chrome/Edge drive drill and real ChatGPT/Claude account checks).
- **External integration points**: GitHub Issues API with a dedicated fine-grained token (`Docs/dws-mcp-runbook.md:19`, `dws-app/src/lib/mcp/issues-github.ts:32`); vendor MCP clients.

---

## 3. Server-side patterns in `dws-app/`

### 3.1 API route authenticated by a cron secret (Bearer header)

`dws-app/src/app/api/photos/repair/route.ts:1-7,36-61`
```ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { WorkBudget } from '@/lib/photos/repair/deadline';
import { emptyReport, runRepair } from '@/lib/photos/repair/run';

export const maxDuration = 300;
...
async function run(request: Request) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const budget = new WorkBudget(startedAt);
  const admin = client(budget);
  // Both cron GET and manual POST fail closed before lease/Storage mutation.
  const gate = await admin.from('photo_release_state').select('repair_enabled,schema_generation').eq('singleton', true).maybeSingle();
  if (gate.error || gate.data?.repair_enabled !== true || gate.data?.schema_generation !== 1) {
    return NextResponse.json({ ...emptyReport(), error_count: 1, errors: ['Repair is temporarily unavailable'] }, { status: 503 });
  }
  ...
  console.info('photos.repair', JSON.stringify(report));
  return NextResponse.json(report, { status });
}
export const GET = run;
export const POST = run;
```
Scheduled by `dws-app/vercel.json`:
```json
  "regions": ["cle1"],
  "crons": [{ "path": "/api/photos/repair", "schedule": "0 9 * * *" }]
```
Pattern: Bearer `CRON_SECRET` check, then a database gate row (`photo_release_state`) checked before any work, `maxDuration = 300`, same handler for GET (Vercel cron) and POST (manual), structured `console.info('<area>', JSON.stringify(report))` log.

### 3.2 API route authenticated by a shared secret in the URL path

`dws-app/src/app/mcp/[shared-key]/route.ts:1-38`
```ts
import { timingSafeEqual } from 'node:crypto';
...
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ 'shared-key': string }> };
const reject = (status: number, code: string) => Response.json({ error: { code, message: 'DWS request unavailable.' } }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

async function handle(request: Request, context: Context): Promise<Response> {
  try {
    const configured = process.env.MCP_SHARED_KEY;
    const supplied = (await context.params)['shared-key'];
    if (!configured || !/^[0-9a-f]{64}$/.test(configured)) return reject(503, 'temporarily_unavailable');
    if (!/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(configured), Buffer.from(supplied))) return reject(404, 'not_found');
    const { supabaseAdmin } = await import('@/lib/supabaseAdminClient');
    const gate = await supabaseAdmin.from('photo_release_state').select('schema_generation,mcp_enabled').eq('singleton', true).maybeSingle();
    if (gate.error || !gate.data || gate.data.schema_generation !== 1 || gate.data.mcp_enabled !== true) return reject(503, 'temporarily_unavailable');
```
Pattern: misconfigured secret → 503; wrong secret → 404 via `timingSafeEqual`; then the same `photo_release_state` gate; `Cache-Control: no-store`.

(For contrast, user-session admin routes use `requireAdmin()` in `dws-app/src/lib/requireAdmin.ts:11-40`: cookie session → `user_profiles.role === 'admin'` → 401/403.)

### 3.3 Server-only Supabase client with the service role

Shared singleton, `dws-app/src/lib/supabaseAdminClient.ts:1-17`:
```ts
import { createClient } from '@supabase/supabase-js'
import 'server-only' // Prevents client-side import

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable')
}

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)
```

Per-call client with a request timeout, `dws-app/src/lib/photos/server/purge.ts:1-2,22-30`:
```ts
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
...
/** A service-role client whose every request carries its own timeout. */
function timedClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(CALL_MS), ...(init?.signal ? [init.signal] : [])]),
      }),
```
The repair route has a third variant with a shared deadline budget and a 4 MiB response cap (`dws-app/src/app/api/photos/repair/route.ts:9-34`).

Cookie/session (anon key) server client for user requests: `dws-app/src/lib/supabaseServerClient.ts:19-40` (`createServerClient` from `@supabase/ssr` with `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

### 3.4 Scripts under `dws-app/scripts/`: env loading and client construction

Scripts (all `.mjs`): `attach-orphan-sidecars`, `backfill-png-derivatives`, `import-jobs`, `onboard-users`, `photo-identity-cutover`, `reproduce-receipt`, `review-stack`, `set-auth-display-names`, `test-*` (integration harness). None import `dotenv`; env comes from outside the process in one of two documented ways:

- Shell sourcing: `set -a; source .env.local; set +a` (`dws-app/scripts/import-jobs.mjs:7`)
- Node flag: `node --env-file=.env.local scripts/...` (`dws-app/scripts/backfill-png-derivatives.mjs:34`, `dws-app/scripts/reproduce-receipt.mjs:8`)

**Representative script** (and the only office-database import in the repo), `dws-app/scripts/import-jobs.mjs:1-43, 95`:
```js
#!/usr/bin/env node
// One-time import of active jobs from the office DB CSV dumps into public.jobs.
// Joins tblProject (ProjectID, Project, Location, Archived) with
// tblMas90JobMasterOpen (JobNo, JobStatus) on ProjectID = JobNo, keeps open
// un-archived rows, and upserts by job_number with the service-role client.
//
// Usage (env from shell, e.g. `set -a; source .env.local; set +a`):
//   node scripts/import-jobs.mjs --projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv>            # dry run
//   node scripts/import-jobs.mjs --projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv> --execute  # write
//
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'

function parseArgs(argv) {
  const args = { execute: false, projects: null, jobs: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--execute' || a === '-x') args.execute = true
    else if (a === '--projects') args.projects = argv[++i]
    else if (a === '--jobs') args.jobs = argv[++i]
  }
  return args
}
...
async function main() {
  const args = parseArgs(process.argv)
  ...
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    process.exit(1)
  }
  ...
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
```
Conventions visible across scripts: header comment with purpose, `Env:` and `Usage:` lines; dry run by default with `--execute` to write (`import-jobs.mjs:8-9`, `backfill-png-derivatives.mjs:34-36`); `NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL` fallback; `createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })`. Same block in `onboard-users.mjs:82-89`, `set-auth-display-names.mjs:52-59`, `attach-orphan-sidecars.mjs:15-22`.

Testable variant, `dws-app/scripts/backfill-png-derivatives.mjs:192-199`:
```js
export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.')
  const { createClient } = await import('@supabase/supabase-js')
  ...
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
```

Strict-target variant (refuses a mismatched project), `dws-app/scripts/photo-identity-cutover.mjs:87-98`:
```js
function connection(options) {
  const endpoint = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!endpoint || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY explicitly');
  const url = new URL(endpoint);
  const isolated = process.env.DWS_TEST_ISOLATED === '1' && options.projectRef === 'dws-isolated-cutover'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
  if (!isolated && (url.protocol !== 'https:' || url.hostname !== `${options.projectRef}.supabase.co` || url.port)) {
    throw new Error('Explicit project ref does not match the Supabase target');
  }
```

Direct Postgres (`pg`) is used only by the local test harness, which builds an allowlisted env and never loads `.env.local`: `dws-app/scripts/test-integration.mjs:8,18-19,77` (`new pg.Client({ connectionString: env.DWS_TEST_DATABASE_URL })`), same in `review-stack.mjs:24,104,515`.

Target table for office data, `dws-app/supabase/migrations/00000000000003_photos_schema.sql:3-10`:
```sql
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  job_number  text unique not null,           -- office JobNo, e.g. '3612'
  name        text not null,
  location    text,
  is_active   boolean not null default true,
  synced_at   timestamptz
);
```

---

## 4. Docs conventions under `Docs/`

Files: `_sidebar.md`, `Admin-Features.md`, `API.md`, `Architecture.md`, `Authentication.md`, `Components.md`, `Configuration.md`, `Database.md`, `dws-mcp-runbook.md`, `Employee-Features.md`, `index.html`, `photos-runbook.md`, `README.md`, `Receipts.md`, `screenshots/`, `vercel.json`. `index.html` + `_sidebar.md` indicate a docsify-style site; runbooks are listed under **Reference** (`Docs/_sidebar.md`):
```
- **Reference**
  - [API](API.md)
  - [Database](Database.md)
  - [Components](Components.md)
  - [Photos Runbook](photos-runbook.md)
  - [DWS MCP Runbook](dws-mcp-runbook.md)
```

### How a runbook documents a new operational component

**Standalone runbook for one component** — `Docs/dws-mcp-runbook.md` headings:
```
1   # Hosted DWS MCP
10  ## Configuration and activation
97  ## Shared guidance and skill loading
138 ## Photo browser handoffs
154 ## Confirmed issue publication and recovery
227 ## Key rotation and diagnostic handling
244 ## Isolated protocol proof
```
It opens with a prose paragraph naming the host/deployment (`dws-mcp-runbook.md:3-8`), then an env-var table (`dws-mcp-runbook.md:16-21`):
```
| Variable | Value / purpose |
| --- | --- |
| `MCP_SHARED_KEY` | A fresh, independently generated 32-byte value encoded as 64 lowercase hexadecimal characters. Never prefix it with `NEXT_PUBLIC_`. |
| `DWS_GITHUB_ISSUES_TOKEN` | A dedicated fine-grained token restricted to `ariavasulin/OpenReimbursements`, with Issues read/write and implied Metadata read only. ... |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | The existing application's Supabase configuration. Only the last value is privileged; it stays server-side. |
```
followed by the required gate state and pre-open checks (`:23-34`).

**Section inside the big runbook** — `Docs/photos-runbook.md` adds one H2 per component, often with a date/round tag, e.g. `## Browsing, select all, download, and album order (Wave 2, 2026-10-12)` (`:119`), `## Server and database speedups (performance round 1, 2026-10-16)` (`:383`). The cron component section, `## Repair sweep (/api/photos/repair)` (`:837`), has sub-headings:
```
837  ## Repair sweep (`/api/photos/repair`)
851  ### Run it by hand
869  ### What each `counts` key means
901  ### `?olderThan=<ms>` (drills only)
916  ### Recovery after failure, overlap, or process death
956  ### Video transcoding (`PHOTOS_TRANSCODE`)
997  ### Reading the logs
```
Its opening (`photos-runbook.md:839-861`) states schedule, auth, gate, time budget, then a manual curl:
```
A daily Vercel cron (09:00 UTC, `vercel.json`) first permanently purges up to
500 expired photos, then repairs active photos and cleans orphan objects.
Both GET and POST require `CRON_SECRET` and the server-only
`photo_release_state.repair_enabled` gate with schema generation 1. ...

### Run it by hand

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://photos.design-workshops.app/api/photos/repair
```
```
**One-off script documentation** — `### One-off backfill: PNG and mislabelled derivatives` (`photos-runbook.md:772-804`): what it does, that it is dry-run unless `--execute` and safe to re-run, then the exact commands "From `dws-app/`":
```bash
node --env-file=.env.local scripts/backfill-png-derivatives.mjs                      # dry run: counts and the list
node --env-file=.env.local scripts/backfill-png-derivatives.mjs --execute --limit 4  # spot-check a few in the app
node --env-file=.env.local scripts/backfill-png-derivatives.mjs --execute            # the rest
```
followed by the recorded result of the real dry run on a date.

Operator-cutover procedure shape (`photos-runbook.md:537-703`): `## Hosted photo release: operator cutover` / `### Read-only preflight and administrator review` / `### Activation sequence` / `### Execute and resume` / `### Recovery posture`. Also `## Triage: "a user says their upload vanished"` (`:1009`) and `## Launch drills (run on production after the first deploy)` (`:1063`).

---

## 5. Keyword mentions (outside node_modules)

**SQL Server / MSSQL / ODBC / Sage / tailscale / tunnel / ETL**: no matches anywhere.

**MAS 90** (as the table name `tblMas90JobMasterOpen`):
- `dws-app/scripts/import-jobs.mjs:4,8,9,34,48`
- `plans/active/dws-photos-client-feedback/sources/research.md:85` (mermaid: `CSV[Office DB CSV exports\ntblProject + tblMas90JobMasterOpen] -->|scripts/import-jobs.mjs --execute\nupsert on job_number| J[(jobs)]`)
- `plans/active/dws-photos-client-feedback/sources/research.md:91`: "**Office import (the only outside source).** `scripts/import-jobs.mjs` is a "one-time import of active jobs from the office DB CSV dumps" ... upserts `{job_number, name, location, is_active, synced_at}` keyed on `job_number` ... `synced_at` is the only provenance marker. No cron, API, or scheduled sync exists; the script has no tests. The photo-folders plan records 22 production jobs from this import."
- `plans/active/dws-photos-client-feedback/sources/research.md:404` (open question): "What does the office database (source of `tblProject` / `tblMas90JobMasterOpen`) run on, and is it reachable from Vercel or only on the office network? Only the CSV import path is visible in this repo."

**Cloudflare** (only as the Supabase Storage CDN, measured):
- `plans/active/dws-photos-perf-audit/audit.md:285`, `:1031`

**office** (relevant hits; receipt "Office Supplies" category hits in `Docs/Database.md:95`, `Docs/Receipts.md:77,95`, `Docs/Employee-Features.md:36`, `Docs/API.md:92,114,151` are unrelated):
- `plans/active/photo-folders/plan.md:9` "Until the office project database is bridged to this app, employees need to make a new home for photos themselves"
- `plans/active/photo-folders/plan.md:21-22` "The 22 production jobs came from the one-time `dws-app/scripts/import-jobs.mjs` import of office job numbers"
- `plans/active/photo-folders/plan.md:35-36` "Out of scope (decided with the user 2026-09-20): the office database bridge and how it reconciles with hand-made projects"
- `plans/active/photo-folders/plan.md:45-46` P-codes "cannot collide with office numbers, which are digits"
- `plans/active/photo-folders/plan.md:50-51` "Rename changes `name` only, never `job_number`. A later office sync ..."
- `plans/active/photo-folders/plan.md:61-64` "6. **Sync reconciliation is deferred, and nothing here blocks it.** Fact for whoever designs it: `import-jobs.mjs` upserts on `job_number`, so today a hand-made project carrying a real office number would be taken over by an import row with the same number, photos in place. `P-` projects are never touched by the import."
- `plans/active/photo-albums/plan.md:70` (non-goal "the office database bridge"), `:187`, `:189` ("the office bridge will key on it" — job number)
- `Docs/photos-runbook.md:221` "Until the office project database is bridged, any photo actor can create a ..."; `:226-227` P-codes vs digit office numbers; `:250-254` "an import row with the same real office number takes over a hand-made row in place ... How the future office sync should reconcile is undecided."
- `dws-app/supabase/migrations/00000000000003_photos_schema.sql:5` (`-- office JobNo, e.g. '3612'`)
- `dws-app/supabase/migrations/20260920214954_photo_job_projects.sql:1-5` "Hand-made photo projects. Until the office project database is bridged ... cannot collide with the office's numeric job numbers."
- `dws-app/supabase/migrations/20260923180000_photo_manage_followups.sql:77` "An office job the import left inactive is not_found here"
- `dws-app/supabase/migrations/20261012182343_photo_auto_names.sql:36`
- Office *drive* (J: drive / office desktops) mentions: `plans/active/dws-hosted-mcp/plan.md:11,19,21`, `Docs/photos-runbook.md:542,607,1065`, `plans/active/photo-albums/plan.md:28,645,764,784,809,818`, `plans/active/dws-photos-perf-audit/audit.md:853,1274`, and test fixtures labelled `'Office drive'` in `dws-app/src/lib/photos/migration/{folders,engine}.test.ts`.

**sync** (word, excluding `async`):
- `plans/active/photo-folders/plan.md:51,61` (office sync, above)
- `Docs/photos-runbook.md:254` ("future office sync")
- `plans/active/dws-photos-client-feedback/sources/research-questions.md:11` (research question on where jobs come from)
- `public.jobs.synced_at` column (`00000000000003_photos_schema.sql:9`), set by `import-jobs.mjs`
- Unrelated UI uses: `dws-app/src/hooks/use-photo-deep-link.ts:49`, `dws-app/src/app/globals.css:5`.
