# Server-side patterns and office mentions (OpenReimbursements)

Repo: OpenReimbursements, commit `f32010b` (`main`).
All paths below are relative to the repo root unless absolute.

---

## 2. What `dws-hosted-mcp` proposes

Source: `plans/active/dws-hosted-mcp/plan.md`, ticket `sources/ticket.md`.

- **Origin** (`sources/ticket.md`): user asked for "a hosted mcp for dws employees" with "super simple auth", two tools `load_dws_skill(skill_name)` and `execute_dws_script(script_name)`, first skill `migrate_photos`, uploads "upwards of 100 gb" to migrate existing images to the photos site.
- **What it builds** (`plan.md:9-11`): two hosted MCP tools inside the existing Next.js app (Vercel project `dws-receipts`), delivering two skills, `photos` and `report_issue`. One PR, seven sequential phases, then an operator-controlled production cutover.
- **Why** (`plan.md:19`): "The hosted assistant cannot read the office `J:` drive." So uploads are browser-led: the MCP returns a one-use handoff URL; the employee's browser (SMS login) reads `J:` folders and uploads directly to Supabase Storage via the existing TUS engine. A durable control plane (inventory, approval, batches, ledgers) is added around that engine.
- **Endpoint/auth** (`plan.md:98-100`): `mcp.design-workshops.app/mcp/<shared-key>`, Streamable HTTP, official TypeScript MCP SDK, **stateless per-request transport** ("no in-memory MCP session map or workflow state dependent on a particular function instance"). A 256-bit shared key in the URL is validated on every request; no OAuth.
- **Scripts** (`plan.md:72-93`): `migrate_photos`, `add_photos`, `move_photos`, `remove_photos`, `restore_photos` (each returns `{ handoff_url, expires_at }`), and `create_github_issue` (confirmed, idempotent publication to a fixed GitHub repo).
- **Other contracts**: global content-hash identity for photos, 30-day trash with active-only RLS, recoverable deletion, a repair/purge cron that obeys one deadline, server-side gates in `photo_release_state` (`mcp_enabled`, `photo_writes_enabled`, `repair_enabled`).
- **Explicit non-goals relevant to the bridge** (`plan.md:23`): "OAuth, a second Vercel project, server access to local shares, background uploads after the browser closes ...". Stop-and-ask trigger (`plan.md:11`): "provision another runtime".
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

Shared singleton, `dws-app/src/lib/supabaseAdminClient.ts:1-17`: a `server-only` service-role client that throws at import when `SUPABASE_SERVICE_ROLE_KEY` is missing.

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

**Representative script** (and the only office-database import in the repo): `dws-app/scripts/import-jobs.mjs:1-43, 95`; see `research-app.md` § 1.

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

## 5. Keyword mentions (outside node_modules)

**SQL Server / MSSQL / ODBC / Sage / tailscale / tunnel / ETL**: no matches anywhere.

**MAS 90** (as the table name `tblMas90JobMasterOpen`):
- `dws-app/scripts/import-jobs.mjs:4,8,9,34,48`
- `plans/active/dws-photos-client-feedback/sources/research.md:85` (mermaid: `CSV[Office DB CSV exports\ntblProject + tblMas90JobMasterOpen] -->|scripts/import-jobs.mjs --execute\nupsert on job_number| J[(jobs)]`)
- `plans/active/dws-photos-client-feedback/sources/research.md:91`: "**Office import (the only outside source).** `scripts/import-jobs.mjs` is a "one-time import of active jobs from the office DB CSV dumps" ... upserts `{job_number, name, location, is_active, synced_at}` keyed on `job_number` ... `synced_at` is the only provenance marker. No cron, API, or scheduled sync exists; the script has no tests. The photo-folders plan records 22 production jobs from this import."
- `plans/active/dws-photos-client-feedback/sources/research.md:404` (open question): "What does the office database (source of `tblProject` / `tblMas90JobMasterOpen`) run on, and is it reachable from Vercel or only on the office network? Only the CSV import path is visible in this repo."

**office** (relevant hits; receipt-category hits omitted):
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

**sync** (word, excluding `async`):
- `plans/active/photo-folders/plan.md:51,61` (office sync, above)
- `Docs/photos-runbook.md:254` ("future office sync")
- `plans/active/dws-photos-client-feedback/sources/research-questions.md:11` (research question on where jobs come from)
- `public.jobs.synced_at` column (`00000000000003_photos_schema.sql:9`), set by `import-jobs.mjs`
