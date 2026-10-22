---
status: active
created: 2026-10-17
updated: 2026-10-22
---

# Shop database bridge and mirror: read the on-prem SQL Server from the web apps

Shape: recommendation + tech spec + implementation plan. Ari's words are in
[`sources/ticket.md`](sources/ticket.md); the codebase facts in
[`sources/research-app.md`](sources/research-app.md) and
[`sources/research-conventions.md`](sources/research-conventions.md) (commit `f32010b`,
tip of `main` at authoring); the shop database facts in
[`sources/research-shop-db.md`](sources/research-shop-db.md) (from the `dwsTables`
catalog, data as of Jan 2024); vendor facts in
[`sources/research-external.md`](sources/research-external.md).
**Consequence: consequential** (a new always-on runtime in the shop, a copy of office
tables in Supabase, and the web apps reading the office database). **Delivery: gated**
(the apps change nothing until the new env vars and the `shop` schema exist).

**Agent brief.** Intent: give the DWS web apps (receipts and photos, Next.js on Vercel in
`cle1`, Supabase Postgres `qebbmojnqzwwdpkhuyyd`) read access to the shop's on-prem SQL
Server Express two ways: a live read-only query path for ad-hoc use, and a 15-minute
mirror of chosen tables in Postgres for the apps. No inbound hole in the shop network.
Source of truth: this plan, then the ticket, then the research. Locked decisions:
Decisions 1–28 below. Current phase: **Built on branch `shop-db-bridge` (decisions 17–28 applied); Phase 0 items 2, 4, 5, the admin's statements, the production migrations, and the shop install (Phase 3) are Ari's.**
Stop-and-ask triggers: anything run against the shop's SQL Server or the production
Supabase project (including migrations); creating or changing a Cloudflare account,
zone, or token; any production env var. Everything else (file layout, helper names,
test fixtures) is implementation-owned.

## Words

- **Shop server**: the Windows host `SQL2016` running SQL Server Express (named instance
  `SQL2016\SQLEXPRESS`), live database `DWS`. Microsoft Access on office workstations
  links to it over the office network with Windows login. Sage MAS 90 lives on the same
  host. (`sources/research-shop-db.md` § 1)
- **Bridge box**: the always-on Windows computer Ari will set up in the shop.
- **Bridge**: the small read-only HTTP query service this plan adds on the bridge box,
  reached from the internet only through a Cloudflare Tunnel.
- **Mirror**: the copy of chosen shop tables in a `shop` schema in Supabase Postgres,
  refreshed every 15 minutes by the same service on the bridge box.

## Recommendation, in plain terms

One Node service on the bridge box does two jobs:

1. **The bridge.** It runs only the statements listed in `queries.json` on the box, which
   the shop's admin writes or approves, on the shop server with a read-only login, and
   returns rows as JSON. A Cloudflare Tunnel publishes it with no inbound port, and a
   Cloudflare Access service token in front stops anything without the token at
   Cloudflare's edge. The apps call a named statement with `shopQuery(name, params)`; Ari
   calls it from the laptop with one command.
2. **The mirror.** Every 15 minutes it reads each table on a short list from the shop
   server and sends it over HTTPS to one of two Supabase functions, which replaces the
   copy in Supabase's `shop` schema in one transaction. The apps read the mirror like any
   other Postgres table. After each run the other function refreshes `public.jobs` from the
   mirrored project tables, so the jobs list stays current without a CSV.

Why both: the mirror is what the apps use day to day (fast, no dependence on the shop
being online at request time). The bridge serves named live reads and reports health.
Adding a table to the mirror is one `mirror` entry in `queries.json`, agreed with the
admin (Decision 17).

Why the mirror is pushed from the shop box and not pulled by Vercel: the Vercel Hobby
plan runs crons once a day, and Ari wants 15 minutes.

Options compared:

| Option | What it is | Verdict |
|---|---|---|
| **A. Bridge behind Cloudflare Tunnel + mirror pushed from the box (pick)** | Live read path plus a scheduled Postgres copy | Agnostic, one service to maintain, no inbound port, two auth layers, good DX. Ari's pick. |
| B. Mirror only | The push service alone; no Cloudflare, no domain | Simplest possible. Loses live reads; every new question is a config change and a 15-minute wait. Ari chose A over this (2026-10-17). Since decision 17 no `live` statement ships, so until the first one is agreed the tunnel carries only `/health`, and its Cloudflare setup (Phase 3 step 2) can wait. |
| C. Bridge behind Tailscale Funnel | Same bridge on a `*.ts.net` name | No domain needed, but Vercel cannot join a tailnet, so the endpoint is public and the bridge's own token is the only lock. Fallback if Cloudflare becomes a problem. |
| D. Postgres foreign tables ("remote columns") | Supabase's SQL Server wrapper | Needs the shop server reachable from the public internet. Ruled out. |

Security, layer by layer:

1. No inbound port: `cloudflared` dials out; the mirror dials out to Supabase; nothing dials in.
2. Cloudflare Access with a **Service Auth** policy: no token, no entry, and no log line in the shop.
3. The bridge checks its own bearer token too, so a mis-set tunnel still fails closed.
4. The shop database login is read-only (`db_datareader` plus `db_denydatawriter`).
5. The bridge runs only the statements in `queries.json`, each checked by a keyword
   filter at startup, with a 30-second deadline and a row cap.
6. The bridge box has no Supabase database login. It holds a mirror token that can call
   exactly two functions over the HTTPS API: replace one copied table's rows, and refresh
   `public.jobs`. It cannot read anything, run SQL, or create objects in Supabase, and
   deleting the token's hash revokes it (decision 25). The box never holds the
   service-role key.
7. Every bridge query and every mirror run is logged.

Maintenance: two Windows services that start at boot (`cloudflared` and the bridge),
one `.env` file on the box, one `queries.json` listing every statement, four secrets in
Vercel, one document with exact commands and a token-rotation checklist.

Cost: Cloudflare Zero Trust free tier; the tunnel is free; a throwaway domain registered
in Cloudflare, about $10 a year.

## Why

The apps already carry office data by hand: `public.jobs` was loaded once from CSV
exports of `tblProject` and `tblMas90JobMasterOpen` by `dws-app/scripts/import-jobs.mjs`,
and nothing refreshes it (`sources/research-app.md` § 1). Employees are onboarded by
script from a CSV (`onboard-users.mjs`). Three plans and the runbook defer "the office
database bridge" (`sources/research-conventions.md` § 5). Ari wants a general read
capability, with a Postgres mirror of specific tables as the everyday path.

## Goals

- Server-side code in `dws-app` can run the bridge's named read-only statements on the live `DWS` database.
- The same from Ari's laptop with one command.
- A `shop` schema in Supabase holds a copy of the listed tables, at most 15 minutes old,
  replaced atomically so readers never see a half-copied table.
- `public.jobs` refreshes from the mirror after every run.
- Adding a table to the mirror is one `mirror` entry in `queries.json`.
- No inbound port or public IP at the shop; the shop box holds only least-privilege credentials.
- Setup and recovery documented so Ari can do both alone.

## Non-goals

- Writes to the shop database.
- Querying Sage MAS 90 directly. `tblMas90JobMasterOpen` and the `vewMas90*` views are
  the Sage window.
- Replacing Access, or moving the shop database.
- Changing how the apps read `jobs` today; they keep reading `public.jobs`.
- Syncing employees into Supabase Auth. `tblContact` is mirrored; what onboarding does
  with it is a later plan.
- Incremental (changed-rows-only) sync. The source has no reliable modified-at columns,
  and the listed tables are small, so each run copies whole tables.

## System sketch

```mermaid
flowchart LR
  subgraph shop [Shop network]
    SQL[(SQL2016\SQLEXPRESS<br/>DWS)]
    S[dws-bridge service<br/>bridge on localhost:8787<br/>+ mirror loop every 15 min]
    C[cloudflared<br/>Windows service]
    S -- TDS, read-only login --> SQL
    C -- http://localhost:8787 --> S
  end
  CF[Cloudflare edge<br/>Access: Service Auth]
  C -. outbound only .-> CF
  PG[(Supabase Postgres<br/>schema shop)]
  API[Supabase HTTPS API<br/>shop_mirror_replace, shop_mirror_refresh]
  S -. outbound only, HTTPS + mirror token .-> API
  API --> PG
  V[Vercel function]
  L[Ari's laptop<br/>scripts/shop-query.mjs]
  V -- "shopQuery: HTTPS + service token + bearer" --> CF
  L -- "HTTPS + service token + bearer" --> CF
  V -- reads shop.* and public.jobs --> PG
```

## Premise anchors

| Anchor | Revalidation probe |
|---|---|
| Access reaches the shop server over the network with Windows login, so the instance accepts network connections already | On a workstation: Access → linked table properties show `SERVER=SQL2016\SQLEXPRESS;Trusted_Connection=Yes;DATABASE=DWS` |
| Vercel Hobby crons run once a day | `Docs/photos-runbook.md` "Hobby plan allows one region"; Vercel cron docs in `sources/research-external.md` |
| `jobs` writes are service-role only; `synced_at` marks imported rows | `rg -n 'synced_at' dws-app/scripts/import-jobs.mjs dws-app/supabase/migrations` |
| Migrations are files applied with `supabase db query -f` before the deploy that needs them | `dws-app/supabase/migrations/README.md` |
| DNS for the production domain is at Vercel | `dig +short NS design-workshops.app` |
| The listed source tables are small | `sources/research-shop-db.md` § 2–3, § 6: `tblContact` 5,066 rows, `tblProject` 1,809, `tblLocation` 668, `tblHardware` 79, `tblMas90JobMasterOpen` 35 |

## Decisions

| Decision | Warrant | Reversal condition |
|---|---|---|
| 1. HTTP query service, not the raw SQL port, behind the tunnel | Vercel functions cannot run `cloudflared`, which raw TCP through a tunnel requires | None expected |
| 2. ~~The bridge accepts arbitrary single `SELECT`s~~ Superseded 2026-10-22 by 17: the bridge runs only statements listed in `queries.json` on the box (mirror entries and named live queries, the latter empty today); the keyword guard, timeout and row cap still apply to every listed statement | The shop's admin asked for the specific queries rather than open query rights; the apps need no ad-hoc reads today | Reopen ad-hoc `SELECT`s only with the admin's agreement |
| 3. Bridge and mirror run on the bridge box, not on the shop server | Ari's stated setup; keeps new software off the machine that runs the business | Move onto the shop server if the admin prefers |
| 4. Plain Node (`.mjs`), dependency `mssql` only, built-in `http` and `fetch`, no build step | Smallest thing to install and debug on Windows; one language with the rest of the repo | None expected |
| 5. Two auth layers on the bridge (Cloudflare service token at the edge, bearer inside) | Cheap; survives either side being misconfigured | None expected |
| 6. Bridge binds to `127.0.0.1`; `cloudflared` on the same box is its only client | No LAN exposure of the HTTP service | None expected |
| 7. Secrets on the box live in `C:\dws-bridge\.env`, NTFS-restricted to the service account and Administrators | Simplest thing that is not world-readable | Admin asks for Windows Credential Manager or a vault |
| 8. Windows services via NSSM (bridge) and `cloudflared service install` (tunnel), both start at boot | Survives reboots and crashes without a person | Task Scheduler "at startup" if NSSM is unwanted |
| 9. Tunnel hostname on a throwaway domain registered in Cloudflare | Production DNS is at Vercel; a separate domain touches nothing in production. Ari agreed 2026-10-17 | Move production DNS to Cloudflare later if wanted |
| 10. All shop data, phone numbers included, may leave the shop over TLS | Ari 2026-10-17: "all of this can leave the shop" | — |
| 11. The mirror is pushed from the bridge box every 15 minutes, in the same service as the bridge | Vercel Hobby crons are daily; one service is one thing to install and watch | Pull from a Vercel cron if the plan becomes Pro and the box is unwanted |
| 12. Each mirrored table is replaced whole, inside one Postgres transaction (since 25: one `shop_mirror_replace` call per table, not a direct `pg` connection) | No reliable modified-at columns in the source; tables are small; a transaction means readers never see a half-copied table | Incremental sync for a large table if one is ever added |
| 13. ~~The box holds a dedicated Postgres role `shop_mirror` with rights only on the `shop` schema and `execute` on `shop.refresh_jobs()`~~ Superseded 2026-10-22 by 25 | Least privilege; the box never holds the service-role key | — |
| 14. ~~Mirror table DDL is generated into a migration file~~ Superseded 2026-10-22 by 18: the service creates each landing table (`shop.<into>`, all columns nullable, no PK) from the statement's result set on first run, and stops that entry with a clear error if the shape later differs; it never drops or alters | The admin authors the statements, so their shape is not known when migrations are written | Return to committed DDL if the admin wants the landing shape reviewed in the repo |
| 15. `public.jobs` refresh runs in SQL (`shop.refresh_jobs()`) after each mirror run, follows `import-jobs.mjs`'s rules (the differences are listed in its migration's header), and never deactivates | Pure SQL is testable in `test:db`; deactivation hides photos and the runbook calls it undecided | Decide deactivation after a few weeks of "dropped from open" logs |
| 16. A new runtime is being added (the hosted-MCP plan asks before this) | Ari asked for it explicitly in the ticket | — |
| 17. Least privilege by a statement file: `queries.json` on the box is the complete list of SQL the service can run; the admin writes or approves every line; the shipped statements are suggestions with the needed columns named | Ari 2026-10-22, after meeting the admin: limit the bridge to what the receipts and photos apps need now and build trust; "she can write the queries" | Add statements only by agreement with the admin |
| 18. Landing tables are created from the result set (see 14), since 25 by `shop_mirror_replace` from the column list the service sends; the Supabase migrations ship only the schema, `sync_runs`, the token table, `refresh_jobs()`, the two mirror functions, and the status function | Follows from 17 | As 14 |
| 19. Mirror set is `projects`, `locations`, `open_jobs`, `contacts` (all rows of `tblContact`, 10 columns); `tblHardware` dropped | Ari 2026-10-22: all contacts, because only a person who exists as a DWS contact may register an account (employees now, architects and contractors later); hardware is not used by any app | Add a table only by agreement with the admin |
| 20. One document, `shop-bridge/README.md`, for developer, admin, and future maintainer; shared with the admin as a secret gist rather than the repository | Ari 2026-10-22: do not point the admin at the whole repository; one neutral document instead of a runbook plus an admin explainer | Move to the service's own repository when it gets one |
| 21. ~~`shop.refresh_jobs()` runs with the caller's rights; `shop_mirror` gets `select, insert, update` on `public.jobs` and a narrow RLS policy there~~ Superseded 2026-10-22 by 25: invoker rights limited only that one function, and any privileged reader of a landing table the role owned still ran its code | Independent review 2026-10-22 (definer escalation through a planted view) | — |
| 22. ~~The mirror verifies Supabase's TLS certificate against `shop-bridge/supabase-ca.crt`~~ Superseded 2026-10-22 by 25: the API's certificate chains to a public root, which Node checks by default | — | — |
| 23. The service runs under the virtual account `NT SERVICE\dws-bridge`; `NetworkService` is the documented fallback | `NetworkService` is shared by many services, all of which could read `.env`; the account is set with `sc.exe config ... obj=` because the NSSM 2.24 download predates virtual-account support | Fall back if the box rejects the account |
| 24. The guard is described as a conservative keyword filter, extended with transaction, session, control-flow and lock-hint words; every statement runs under a 30-second wall-clock deadline and the mirror stops reading at the row cap | Both reviews: T-SQL needs no `;` between statements, so "one SELECT" was not enforced; tedious's requestTimeout only covers the first packet; the cap was checked after buffering | A real T-SQL parser if the filter ever has to prove single-statement |
| 25. The bridge box has no database login. It calls `public.shop_mirror_replace` (replace one table, or record why it could not be read) and `public.shop_mirror_refresh` over Supabase's HTTPS API with the public anon key and a mirror token; Supabase keeps only the token's SHA-256 in `shop.mirror_token`. Both functions run as `postgres`, take only data (names quoted as identifiers, column types from a fixed built-in list, values), and create the landing tables, which `postgres` owns | Review round three, 2026-10-22: any login role on Supabase can `CREATE EXTENSION` and `DROP EXTENSION ... CASCADE` on Supabase's allowlist through the `supautils` hook, which no grant can stop; and a role that owns landing tables and can create in `shop` can plant code that runs as a privileged reader. Ari chose "A: HTTPS function" over the tunnel pull and a written risk acceptance | Supabase adds a per-role restriction on extension commands |
| 26. The office wins on office jobs: `photo_rename_job` refuses a different name or number for a job with `synced_at` set (`job_office_managed`) | The refresh writes the office's name back every 15 minutes, and an app renumber made the next refresh create a duplicate empty project. Ari 2026-10-22: "Office wins" | Staff need app-side names for office jobs: add a display-name override the refresh does not touch |
| 27. `shop.refresh_jobs()` runs only when the latest copy of `projects`, `locations`, and `open_jobs` each succeeded; a failed `contacts` copy does not stop it | Review round three (Codex): a fresh `projects` joined with a stale `open_jobs` made a closed job active for good, and a failed `locations` copy blanked locations | — |
| 28. No alerting service. The docs say so, and the admin receipts page shows a warning when some copied table has had no good copy for over an hour (`/api/shop/mirror-status`) | Review round three (Claude): a stopped mirror reached nobody, and the docs named a monitor that did not exist. Ari 2026-10-22: "Docs + admin warning" | Add a push notification if the warning is missed in practice |

## Alternatives considered

- **Free single-`SELECT` queries instead of a statement file.** The first design; the
  shop's admin asked for the specific queries instead (Decision 17).
- **Mirror via `supabase-js` upserts with the service-role key.** Familiar in this repo,
  but plain REST upserts cannot do a transactional replace, and the box would hold the key
  to everything. Decision 25 also uses the HTTPS API, through two functions that each do
  one transactional replace and accept a token that can do nothing else.
- **The app pulls the mirror through the tunnel.** Keeps every credential off the box's
  Supabase side, but makes the tunnel required and needs a 15-minute scheduler Hobby lacks.
- **Mirror pulled by a Vercel cron through the bridge.** Daily only on Hobby.
- **Python service.** Fine too, but the repo is TypeScript/Node and Ari maintains it.
- **Supabase's SQL Server wrapper.** Needs public reachability. Ruled out.

## Contract surface

What is built:

- **Bridge and mirror** (`shop-bridge/`): routes, settings, limits, rejections, and files
  are in [`shop-bridge/README.md` § 9 Reference](../../../shop-bridge/README.md). The
  service runs only the statements in `queries.json`: `mirror` entries `{ into, sql }`
  sent to `shop.<into>` every `SHOP_MIRROR_INTERVAL_MINUTES`, and named `live`
  statements served at `POST /query/<name>` (none shipped).
- **Supabase side**: the four `dws-app/supabase/migrations/20261017100*_shop_*.sql`
  files. `shop` schema, owned with everything in it by `postgres`; `shop.sync_runs`;
  `shop.mirror_token` (one row, the token's SHA-256); `public.shop_mirror_replace(p_token,
  p_table, p_columns, p_rows, p_error)` and `public.shop_mirror_refresh(p_token)`, security
  definer, executable by `anon` only, refusing a token whose hash does not match (42501);
  and `public.shop_sync_status()` for the admin (service role only), with each table's
  newest run and `last_ok_at`. No login role exists for the box.
- **`shop.refresh_jobs()`**, callable only by its owner (`shop_mirror_refresh` calls it):
  refuses to run unless the latest copy of each table it reads succeeded (decision 27); upserts
  into `public.jobs` from `shop.projects` joined to `shop.open_jobs` (`JobStatus = 'O'`,
  `Completed IS NULL`, `Archived = false`) and `shop.locations` for the location text;
  sets `name`, `location`, `is_active = true`, `synced_at = now()`; skips numbers held by
  trashed rows; never touches `P-` rows; never sets `is_active = false`; returns
  `{ ok, upserted, skipped_trashed, dropped_from_open }` and writes it to `sync_runs`
  under `table_name = 'public.jobs'`. On failure it records an `ok = false` row and returns
  `{ ok: false, error }` instead of raising (raising would roll back the failure row); the
  mirror reads that flag. Location text is `coalesce(LocationName, "LocationAddress, LocationCity")`.
- **App client** (`dws-app/src/lib/shop/query.ts`, server-only): `shopQuery(name, params?,
  { maxRows?, timeoutMs? })` → rows, `shopQueryResult` for the full result, and
  `shopHealth()`. Env in Vercel: `SHOP_BRIDGE_URL`, `SHOP_BRIDGE_TOKEN`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, none prefixed `NEXT_PUBLIC_`. CLI:
  `node --env-file=.env.local scripts/shop-query.mjs --health` or `<name> [--param k=v]`.
  `GET /api/shop/health` behind `requireAdmin()` returns bridge health plus
  `public.shop_sync_status()`; `GET /api/shop/mirror-status`, also admin-only, feeds the
  admin receipts page's stale-sync warning (decision 28).
- **Office jobs** (`20261022130000_photo_office_jobs.sql`): `photo_rename_job` refuses a
  different name or number for a job with `synced_at` set, as `job_office_managed`
  (decision 26).

### Acceptance criteria

- **AC-1 Outbound only.** No new inbound firewall rule or port forward on the bridge box.
- **AC-2 Edge auth.** A request to the tunnel hostname without the Cloudflare service
  token is rejected by Cloudflare and leaves no line in the bridge log.
- **AC-3 Bridge auth.** A request with the service token but a wrong bearer gets `401`.
- **AC-4 Read-only at the source.** As the bridge's SQL login, `INSERT` and `UPDATE` fail
  with a permission error; the service refuses to start when a `queries.json` statement
  fails the read-only filter (decision 17: no route accepts SQL).
- **AC-5 Bounded.** A query over `maxRows` returns `truncated: true`; a query past 30 s
  returns `504` and releases its connection.
- **AC-6 Works from production.** `GET /api/shop/health` as an admin on production
  reports `bridge.ok: true` and a fresh `ok` mirror row for each of the four tables and
  `public.jobs`.
- **AC-7 Works from a laptop.** `node --env-file=.env.local scripts/shop-query.mjs --health`
  prints the same bridge report.
- **AC-8 Survives restarts.** After rebooting the bridge box, both services run and
  `/health` passes; after SQL Server restarts, the next query and the next mirror run succeed.
- **AC-9 Mirror is whole and fresh.** For each configured table, `count(*)` in `shop`
  equals the source count at the same moment, the newest `sync_runs` row is under 15
  minutes old, and a reader during a run never sees an empty or partial table.
- **AC-10 Least privilege in Supabase.** The box's only Supabase access is the two mirror
  functions: a missing or wrong token is refused, no login role exists for it, and every
  object in `shop` is owned by `postgres` whatever the box sends.
- **AC-11 Jobs refresh.** After a run, open office jobs exist in `public.jobs` with
  `synced_at` set; no row was set `is_active = false`; `P-` rows and trashed rows are untouched;
  `sync_runs` holds the dropped-from-open list.
- **AC-12 Adding a table.** Adding a `mirror` entry to `queries.json` and restarting the
  service yields a filled `shop.<into>` on the next run, with no code change.
- **AC-13 Documented.** `shop-bridge/README.md` covers setup, the env tables (box and Vercel),
  rotating the Access token, the bearer, and the mirror token, adding a table,
  and recovery when the tunnel, the bridge, the mirror, or SQL Server is down.

## Phase 0 — Decisions and shop prerequisites (Ari and the admin; no code)

Settles the facts the code depends on.

### Steps
1. Settled 2026-10-17: option A; 15-minute mirror; throwaway domain in Cloudflare; all
   data may leave the shop; the bridge box is a separate Windows machine.
2. **Login type** (open): the admin runs `SELECT SERVERPROPERTY('IsIntegratedSecurityOnly')`.
   `0` → create SQL login `dws_bridge_ro` with `db_datareader` and `db_denydatawriter` on
   `DWS`. `1` → create a Windows account for the service; it will use NTLM. Turning on
   mixed mode needs a SQL Server restart, so prefer whichever needs no restart.
3. Ari registers the throwaway domain in a Cloudflare account (or confirms one exists).
4. **SQL Server version** (open): `SELECT @@VERSION`. If 2016, note extended support ended
   July 2026; not blocking.
5. **Admin** (open): who creates the login and, if needed, the service account.
6. From the bridge box, with the chosen login: `sqlcmd -S SQL2016\SQLEXPRESS -d DWS -Q "select 1"`.

### Verify
- [ ] Items 2, 4, 5 recorded here under Decisions.
- [ ] `sqlcmd` from the bridge box returns `1`.

### Exit criteria
Login type, version, and admin are recorded; the bridge box can reach the instance.

## Phase 1 — The service: bridge and mirror (local, no shop access)

Establishes the service and its guards with tests, before any shop setup.

### Steps
1. `shop-bridge/server.mjs`: `http` server on `127.0.0.1`; `mssql` pool; `/health` and
   `POST /query/<name>` for named `live` statements; bearer check with `timingSafeEqual`;
   statement guard as a pure function in `shop-bridge/guard.mjs`, run on every
   `queries.json` statement at startup.
2. `shop-bridge/mirror.mjs`: the loop (`setInterval` with an in-flight flag), per-entry
   read, one `shop_mirror_replace` call per table over HTTPS, then `shop_mirror_refresh`;
   `shop-bridge/types.mjs` maps result-set column types to the functions' fixed type list.
3. `shop-bridge/queries.json` with the four mirror entries and no `live` statements.
   `package.json` with `mssql` only; `npm test`.
4. Tests: `guard.test.mjs` (accepts `select`/`with`; rejects `;`, write keywords,
   `select ... into`, keywords hidden in comments); `server.test.mjs` with a stub pool
   (auth, size limit, truncation, timeout mapping); `mirror.test.mjs` with stub drivers
   (one table fails → others commit, run recorded, overlap skipped).
5. Integration: SQL Server container (`mcr.microsoft.com/mssql/server:2022-latest`; on
   Apple Silicon enable Rosetta in Docker Desktop) plus the repo's Postgres test harness.
   If the SQL Server container will not run on the Mac, run that test on the bridge box in
   Phase 3 and say so. Not run yet: the first real SQL Server contact is the shop install,
   and the Windows scripts have not been executed (no PowerShell on the Mac).
6. `shop-bridge/README.md`: what it is, env table, how to run locally.

### Verify
- [x] [AC-3, AC-4, AC-5] `npm --prefix shop-bridge test` green (67 tests, 2026-10-17).
- [ ] [AC-9] Integration: the four tables copy from the container into a local `shop`
      schema; counts match; a concurrent reader mid-run sees the old full table.
- [x] [AC-4] A `queries.json` statement that fails the filter stops the service with the entry named (`config.test.mjs`).

### Exit criteria
The service runs locally against containers with every guard and the mirror proven by tests.

## Phase 2 — Supabase side

Establishes the `shop` schema, the mirror's two token-checked functions, and the jobs refresh.

### Steps
1. Migration `<ts>_shop_schema.sql`: schema, grants, `sync_runs`, and (since decision 25)
   `shop.mirror_token` instead of a login role.
2. Migration `<ts>_shop_refresh_jobs.sql`: `shop.refresh_jobs()` per § Contract surface.
   Decide the location text column by comparing five current `jobs.location` values with
   `tblLocation` fields (read-only query on production, Ari confirms first).
3. `test:db` cases: the mirror functions' boundary (AC-10); `refresh_jobs()` rules (AC-11) with fixtures
   for a trashed number, a `P-` row, a renamed imported job, and a job that left the open set.
4. Apply the four shop migrations and `20261022130000_photo_office_jobs.sql` to
   production (Ari confirms). The mirror token's hash is stored at the shop install
   (Phase 3), from the statement `setup.ps1` prints.

### Verify
- [x] [AC-10, AC-11] `npm --prefix dws-app run test:db` green for the new cases (6 tests in `integration/db/shop.test.ts`, 2026-10-17; 13 after decisions 25–27, 2026-10-22).
- [ ] Migrations applied to production; `select count(*) from shop.sync_runs` returns `0`.

### Exit criteria
Production has an empty `shop` schema, `shop.mirror_token`, the two mirror functions, and the
refresh function; photos refuses renames of office jobs; nothing else changed.

## Phase 3 — Shop install (the bridge box)

Establishes the running service in the shop and the tunnel in front of it.

### Steps
1. `shop-bridge/install/setup.ps1`: creates `C:\dws-bridge`, copies the service and
   config, writes `.env` from prompts (never echoing secrets), restricts the folder ACL,
   installs the service with NSSM (stdout to `C:\dws-bridge\logs\`), starts it, and
   checks `http://127.0.0.1:8787/health`.
2. Cloudflare: create the tunnel in Zero Trust, install `cloudflared` as a Windows service
   with the tunnel token, add the public hostname → `http://localhost:8787`, create a
   self-hosted Access application for it, a service token `vercel-dws` (longest duration
   offered; expiry noted in `shop-bridge/README.md`), and a Service Auth policy allowing only that token.
3. Prove from Ari's laptop: no token → blocked by Cloudflare; token but wrong bearer →
   `401`; both → `/health` passes. No route accepts SQL and no `live` statement ships
   (decision 17), so a query probe waits for the first agreed `live` statement.
4. Run the `insert into shop.mirror_token ...` statement `setup.ps1` printed, watch the
   first mirror run in the log, and confirm `shop.sync_runs` has four `ok` table rows plus
   an `ok` `public.jobs` row and `public.jobs` gained `synced_at` values.
5. Reboot the bridge box; confirm both services came back and the next run happened.
6. `shop-bridge/README.md` per AC-13; `Docs/shop-bridge-runbook.md`, listed in `Docs/_sidebar.md`, points to it.

### Verify
- [ ] [AC-1] Windows Firewall inbound rules unchanged; `cloudflared` service running.
- [ ] [AC-2, AC-3] The three laptop probes behave as listed; the no-token probe leaves no bridge log line.
- [ ] [AC-4] `sqlcmd` as the bridge login: an `insert`/`update` fails with a permission error.
- [ ] [AC-8, AC-9] After reboot, `/health` passes and a fresh `sync_runs` row appears within 15 minutes.
- [ ] [AC-13] `shop-bridge/README.md` followed once end to end by Ari.

### Exit criteria
The mirror refreshes on its own every 15 minutes; a laptop with the two secrets can
reach the bridge's `/health` and named `live` statements through the tunnel; nothing else can.

## Phase 4 — App client, CLI, and health

Establishes the developer experience in the repo and proves it from production.

### Steps
1. `dws-app/src/lib/shop/query.ts` (`server-only`): `shopQuery`, `shopHealth`; fetch with
   the four headers, 20 s `AbortSignal.timeout`, errors mapped to a `ShopBridgeError`.
2. `dws-app/scripts/shop-query.mjs`: the CLI.
3. `GET /api/shop/health` behind `requireAdmin()`: bridge health plus `public.shop_sync_status()`;
   `GET /api/shop/mirror-status` feeds the admin receipts page's stale-sync warning.
4. Vercel env: the four variables, production and preview; `Docs/Configuration.md` updated.
5. Unit tests with mocked `fetch`. (No route test was written for the health route; it
   is two calls behind `requireAdmin()`.)
6. Mark `dws-app/scripts/import-jobs.mjs` as the manual fallback in its header comment and
   in `Docs/photos-runbook.md` § hand-made projects.

### Verify
- [ ] [AC-6] On production, `GET /api/shop/health` as an admin reports `bridge.ok: true`
      and fresh `ok` rows for the four tables and `public.jobs`.
- [ ] [AC-7] `node --env-file=.env.local scripts/shop-query.mjs --health` prints the same report.
- [ ] [AC-12] Add an agreed `mirror` entry to `queries.json` and restart: `shop.<into>` fills on the next run.
- [x] `npm --prefix dws-app test` and `tsc --noEmit` clean (986 tests, 2026-10-17).

### Exit criteria
Any server-side code can call `shopQuery` or read `shop.*`; Ari can explore from the
laptop; the admin health route shows the mirror's age.

## Rollout

Branch `shop-db-bridge` off `main` (`f32010b`), kept linear. One PR for Phases 1, 2, and
4 (code, migrations, docs); Phase 3 happens in the shop between the migrations being
applied and the Vercel env vars being set. Nothing in the apps changes behaviour until
the migrations are applied, so the PR can merge before the shop install; once
`20261022130000_photo_office_jobs.sql` is applied, office jobs (`synced_at` set) can no
longer be renamed in the photos app (decision 26), and the admin warning stays silent
until the mirror has run. Order on the day:

1. Snapshot `select job_number, name, location from public.jobs where synced_at is not
   null` (the first refresh rewrites every open office job's name and location;
   `import-jobs.mjs` stored the `tblLocation` id in `jobs.location`, so production values
   are probably bare numbers until then, unchecked against production).
2. Apply the migrations.
3. Install the box and store the token's hash.
4. Confirm the first run.
5. Set the Vercel env and confirm the health route.

## Risks

- **Shop internet or power outage.** The mirror goes stale and the bridge is unreachable;
  the apps keep working on the last copy. The health route shows the age.
- **Nobody is told when the mirror stops.** A bad `queries.json` edit stops the service
  for good by design (exit 78). The only signal is the admin receipts page's warning after
  an hour without a good copy (decision 28); no message is sent.
- **SQL Server Express limits** (4 cores, 1.4 GB buffer): four column-listed statements every
  15 minutes is light; the bridge's deadline, row cap, and pool of 4 bound every statement.
- **A table grows.** `tblTimesheet` (289k rows) would not suit a whole-table copy every 15
  minutes; the config keeps it out, and Decision 12 names the incremental path if needed.
- **Token or password leakage.** Each credential is scoped (edge token, bearer, mirror
  token, `dws_bridge_ro`); rotation is in `shop-bridge/README.md`. A stolen mirror token can replace
  the copied tables' rows (so put made-up jobs in `public.jobs`) until its hash is deleted.
- **Windows Update reboots.** Both services start at boot (AC-8).
- **The Sage link "goes to sleep"** (known in the shop). The mirror reads the SQL Server
  copy `tblMas90JobMasterOpen`, not Sage; staleness shows as a stable open list and is a
  shop-side fix.
- **Self-signed certificate on the instance.** `SHOP_DB_TRUST_CERT=true` on the LAN hop;
  both internet hops are TLS.
- **Access token expiry.** `shop-bridge/README.md` records the date; the health route surfaces a `403`
  from the edge as `edge_blocked`.
- **Schema drift at the source.** Statements list their columns, so a new column in SQL
  Server is not copied until a statement names it; a statement whose result no longer
  matches its landing table fails that entry, recorded in `sync_runs` (Decision 18).

## Open questions

- Phase 0 items 2, 4, 5.
- Whether the live `DWS` schema differs from the Jan 2024 export the research used.
- Deactivating closed jobs in `public.jobs`: deferred until the dropped-from-open lists
  have a few weeks of history.
- What onboarding should do with mirrored `tblContact` rows: a later plan.
- Raised by the admin and out of this plan's scope: photo and receipt storage buckets are
  public, so any object URL once seen works forever regardless of share-link state; needs
  its own plan (private buckets plus signed URLs), followed by a security audit.

## Relationship to other plans

- `plans/active/photo-folders/plan.md` and `Docs/photos-runbook.md` § hand-made projects:
  the office bridge they defer. Decision 15 keeps their rule that `P-` rows are never
  touched; decision 26 settles renames (the office wins); deactivation stays undecided.
- `plans/active/dws-hosted-mcp/plan.md`: the stop-and-ask on "another runtime" is
  answered here by the ticket.
