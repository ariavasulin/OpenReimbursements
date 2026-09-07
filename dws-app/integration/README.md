# Isolated integration tests

Prerequisites: Node/npm dependencies, Docker running, and the Supabase CLI (verified
with 2.115.0) and PostgreSQL 15 (matching production). Run `npm run test:db` or `npm run test:routes` from `dws-app`.
Each invocation creates a unique temporary project and random local ports, starts
real PostgreSQL/Auth/PostgREST/Storage with an empty migrations directory, checks
Docker identity, replays repository SQL, runs the requested suite, and removes
containers and volumes. Missing services or an empty test suite fail the command.
The first invocation downloads the local Supabase images.

The child process receives an explicit system-variable allowlist and generated
local credentials. It never loads repository `.env.local` and does not pass an
inherited `SUPABASE_ACCESS_TOKEN`. Both the loopback URLs and a private database
identity marker are checked before SQL replay or fixture creation. There is no
linked-project or remote-target option.

`createFixtures()` in `fixtures.ts` returns service-role `admin`, `anon`, and
`employeeA`, `employeeB`, `administrator` actors (each with `id`, authenticated
`client`, `cookies`, and a `cookie` request-header string), plus a `sql` pg Pool
and `close()`. Actors use real local SMS OTP verification with deterministic test
numbers; no production auth bypass exists. Test scenarios own their rows and
must not assume earlier files ran. SQL transactions that must share a connection
use `sql.connect()` and release that client afterward.

Most route tests import real handlers and adapt Next's request cookie/header
context. The MCP suite additionally uses the official SDK over actual HTTP against
a separate Next process. Authentication, PostgREST, SQL permissions, and Storage
remain real.
The `server-only` alias replaces only Next's import marker in this Node test
runner. `envDir: false` prevents Vite environment-file loading.

The captured baseline applies once to the fresh database. Concurrent-index files
are explicitly enumerated in `scripts/test-migrations.mjs` and run one statement
per query, outside transactions, with index validity checked between statements.
New additive migrations are separately replayed twice over retained synthetic
rows in bootstrap assertions before the suite starts. The assertions then remove
only their own fixture rows so scenarios can exercise global-index activation. No fixtures or test credentials are committed as JSON.

For route and browser suites, the runner copies only application source/configuration
into its temporary directory, excluding `.env` files and `.next`. It supplies a
random local `MCP_SHARED_KEY`, `DWS_BROWSER_ORIGIN`, a dummy Issues credential,
and a loopback GitHub HTTP mock. The mock has runner-owned control endpoints;
these are not application routes or production authentication bypasses. Browser
suites use Playwright's existing Next lifecycle. Route suites start their own
Next process and the SDK test restarts it while retaining the same client transport
to verify that requests need no in-memory server session.

`npm run test:routes -- integration/routes/mcp-http.test.ts` runs the HTTP proof
through the same mandatory database bootstrap. It records sanitized negotiated
protocol/tool results, mock publication payloads, and retry outcomes in
`test-results/phase6-mcp-http.json`, plus a redacted Next process log. Mock issue
URLs are synthetic fixed-repository responses; no real GitHub issue is created.
The full `test:routes` entry point also includes these scenarios.
