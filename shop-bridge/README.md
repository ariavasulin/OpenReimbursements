# shop-bridge

A small Node service that runs on the always-on Windows "bridge box" in the shop. It
gives the DWS web apps read access to the shop's SQL Server (`SQL2016\SQLEXPRESS`,
database `DWS`). It does two jobs:

1. **The bridge.** An HTTP service on `127.0.0.1:8787`. It takes one `SELECT`, runs it
   on SQL Server with a read-only login, and returns the rows as JSON. A Cloudflare
   Tunnel (`cloudflared`, on the same box) is its only client and publishes it to the
   internet with no open port. Use it to explore the shop database and for one-off reads.
2. **The mirror.** Every 15 minutes it copies a short list of tables
   (`mirror.config.json`) into the `shop` schema in Supabase Postgres, then calls
   `shop.refresh_jobs()` so `public.jobs` stays current. The apps read the copy like any
   other Postgres table.

The full design is in `plans/active/shop-db-bridge/plan.md`; day-to-day operation is in
`Docs/shop-bridge-runbook.md`.

## Files

| File | What it does |
|---|---|
| `server.mjs` | The HTTP server (`/health`, `/query`, `/ddl`). Run directly, it also starts the mirror. |
| `guard.mjs` | Decides whether a SQL string is a single read-only `SELECT`. |
| `mirror.mjs` | The mirror loop. |
| `db.mjs` | SQL Server connection settings from env, and the shared connection pool. |
| `types.mjs` | SQL Server to Postgres type map and the `create table` builder. |
| `ddl.mjs`, `scripts/ddl.mjs` | Print `create table` SQL for shop tables from live SQL Server metadata. |
| `mirror.config.json` | The tables to mirror. |
| `install/setup.ps1`, `install/uninstall.ps1` | Install, update, or remove the Windows service. |
| `*.test.mjs`, `testing-stubs.mjs` | Tests and their fake database drivers. |

## Settings (environment variables)

| Variable | Required | Example | Meaning |
|---|---|---|---|
| `SHOP_DB_SERVER` | yes | `SQL2016\SQLEXPRESS` | SQL Server: `HOST\INSTANCE`, `host,port`, or a plain host |
| `SHOP_DB_NAME` | yes | `DWS` | Database name |
| `SHOP_DB_USER` | yes | `dws_bridge_ro` | Read-only login (Windows user name when `SHOP_DB_DOMAIN` is set) |
| `SHOP_DB_PASSWORD` | yes | | Password for that login |
| `SHOP_DB_DOMAIN` | no | `DWS` | Set only for a Windows login (uses NTLM) |
| `SHOP_DB_TRUST_CERT` | no | `true` | Accept the server's self-signed certificate (default `true`) |
| `SHOP_BRIDGE_TOKEN` | yes | 64 hex chars | Bearer token for `/query` and `/ddl`; at least 32 characters |
| `SHOP_BRIDGE_PORT` | no | `8787` | Local port (default `8787`) |
| `SHOP_MIRROR_DATABASE_URL` | no | `postgresql://shop_mirror...:5432/postgres` | Supabase session pooler URL for the `shop_mirror` role. Unset = mirror off |
| `SHOP_MIRROR_INTERVAL_MINUTES` | no | `15` | Minutes between mirror runs (default `15`) |

`.env.example` lists them all with comments. On the bridge box they live in
`C:\dws-bridge\.env`, which only Administrators, SYSTEM, and the service account can read.

## Run it locally

Needs Node 22 or newer.

```bash
cd shop-bridge
npm install
cp .env.example .env        # then fill it in
node --env-file=.env server.mjs
```

Without a reachable SQL Server it still starts: `/health` answers `502` and
`/query` answers `502` (or `401`/`400` before it gets that far).

## Test

```bash
npm --prefix shop-bridge test
```

The tests use fake SQL Server and Postgres drivers (`testing-stubs.mjs`), so they need
no database.

## The API

Every response is JSON with `Cache-Control: no-store`. Every error looks like
`{ "error": { "code": "...", "message": "..." } }`.

### `GET /health` (no token needed)

```json
{ "ok": true, "server": "SQL2016\\SQLEXPRESS", "database": "DWS",
  "version": "Microsoft SQL Server 2016 ...", "durationMs": 12,
  "mirror": { "enabled": true, "lastRunAt": "...", "lastOk": true, "inFlight": false,
              "tables": { "tblProject": { "rowCount": 1809, "ok": true, "finishedAt": "...", "error": null } } } }
```

`502` with `"ok": false` when SQL Server cannot be reached. `mirror` is
`{ "enabled": false }` when `SHOP_MIRROR_DATABASE_URL` is unset.

### `POST /query`

Body: `{ "sql": "...", "params": { "name": value }, "maxRows": 100 }`. `params` and
`maxRows` are optional. Refer to a param in SQL as `@name`; values may be strings,
numbers, booleans, or `null`.

```bash
curl -s http://127.0.0.1:8787/query \
  -H "Authorization: Bearer $SHOP_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "select top 5 ProjectID, Project from tblProject where Archived = @archived order by ProjectID desc", "params": {"archived": false}}'
```

```json
{ "columns": ["ProjectID", "Project"], "rows": [{ "ProjectID": 1809, "Project": "..." }],
  "rowCount": 5, "truncated": false, "durationMs": 31 }
```

Through the tunnel, add the two Cloudflare Access headers (`CF-Access-Client-Id`,
`CF-Access-Client-Secret`) and use the tunnel hostname. From the repo,
`dws-app/scripts/shop-query.mjs` does this for you.

| Status | `error.code` | When |
|---|---|---|
| 400 | `not_read_only` | Not a single `SELECT`/`WITH`, has a `;`, or has a write/exec keyword |
| 400 | `bad_request` | Bad JSON, no `sql`, bad `params`/`maxRows`, or SQL Server rejected the query (message says why) |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 404 | `not_found` | Unknown route |
| 413 | `payload_too_large` | Body over 64 KiB |
| 502 | `db_unreachable` | Cannot connect to SQL Server |
| 503 | `not_configured` | `SHOP_BRIDGE_TOKEN` (or `SHOP_DB_SERVER`) not set on the box |
| 504 | `timeout` | The query ran past 30 seconds; it is cancelled |

`maxRows` defaults to 5,000 and is capped at 50,000. When there are more rows,
`truncated` is `true` and the query is cancelled after the limit.

A banned word is refused even inside a string literal (for example
`where Note = 'delete me'`). Pass such values as `params` instead.

### `GET /ddl?tables=tblA,tblB`

Same bearer token as `/query`. Returns `{ "sql": "...", "tables": ["tblA", "tblB"] }`:
the `create table` (and `grant ... to shop_mirror`) SQL for a migration, built from the
live SQL Server column list and primary key. An unknown table is a `400 bad_request`
naming it.

## Add a table to the mirror

1. Add its name to `mirror.config.json`, for example `"tblPM"`.
2. Get the migration SQL, either from the laptop through the tunnel
   (`node --env-file=.env.local scripts/shop-query.mjs --ddl tblPM` in `dws-app`), or
   on any machine with SQL access: `npm --prefix shop-bridge run ddl -- tblPM`
   (with the `SHOP_DB_*` settings in the environment).
3. Save the SQL as a new migration in `dws-app/supabase/migrations/`, review it, and
   apply it like any migration.
4. Copy the updated config to the box (re-run `install/setup.ps1`, or copy
   `mirror.config.json` to `C:\dws-bridge\`) and restart the service:
   `Restart-Service dws-bridge`.

The next run fills the new table. Check `/health` or `shop.sync_runs`.

## Install on the bridge box

From an elevated PowerShell in a copy of this repo on the box:

```powershell
powershell -ExecutionPolicy Bypass -File .\shop-bridge\install\setup.ps1
```

It checks Node 22 and `nssm`, copies the service to `C:\dws-bridge`, asks for each
setting (secrets are typed hidden), locks the folder down, installs the `dws-bridge`
Windows service (starts at boot, restarts on crash), and prints `/health`. Re-run it
to update. Logs are in `C:\dws-bridge\logs\bridge.log`; NSSM rotates the file at 10 MB
and keeps old files, so delete old ones now and then. `install/uninstall.ps1` removes
the service (add `-RemoveFiles` to delete the folder too).

## How it stays safe

- **Nothing dials in.** The bridge listens only on `127.0.0.1`. `cloudflared` and the
  mirror both make outbound connections.
- **Two locks on the door.** Cloudflare Access rejects requests without the service
  token before they reach the shop; the bridge then checks its own bearer token
  (compared in constant time). A missing or short token makes `/query` refuse
  everything (`503`).
- **Read-only at the source.** The SQL Server login can only read
  (`db_datareader` + `db_denydatawriter`), so even a query that slipped past the checks
  cannot change data.
- **Read-only at the door too.** `guard.mjs` accepts one `SELECT`/`WITH` statement with
  no `;` and none of the write or exec keywords (`insert`, `update`, `delete`, `into`,
  `exec`, `drop`, `sp_`, `xp_`, `openrowset`, `waitfor`, and others), checked after
  comments are removed.
- **Bounded.** 30-second query timeout, at most 50,000 rows, 64 KiB request body, and
  at most 4 connections to SQL Server.
- **Least privilege in Supabase.** The mirror's Postgres role `shop_mirror` can only
  write the `shop` schema and call `shop.refresh_jobs()`. The box never holds the
  Supabase service-role key.
- **Everything is logged.** One line per request (time, route, status, duration, rows,
  first 80 characters of the SQL) and per mirror table, in `C:\dws-bridge\logs\`.
