# DWS shop bridge

## 1. Overview

The office uses Microsoft Access over a SQL Server Express database, `DWS` on instance `SQL2016\SQLEXPRESS`, reachable only on the shop LAN. The receipts and job photos web apps run outside the shop and need the job list and contact list. `dws-bridge` is a Windows service on a shop computer that connects to `DWS` with a read-only login and copies fixed `SELECT` results to the apps' hosted database.

## 2. How the pieces fit

```
shop LAN                                      internet                    cloud
SQL Server  <--read-only login--  dws-bridge  --outbound HTTPS-->  Cloudflare  <--  apps / laptop
(DWS)                             (one Node     (kept open by                (Access: service token)
                                   service)      cloudflared)
                                      |
                                      +----------outbound HTTPS------------>  Supabase API
                                                                              (two mirror functions,
                                                                               schema "shop")
```

1. **The mirror.** Every 15 minutes the service runs its `SELECT` list, sends each result to Supabase over HTTPS, where it replaces a table in the `shop` schema, and then asks Supabase to refresh the apps' job list. The apps read that copy, never `DWS`.
2. **The tunnel.** Cloudflare's `cloudflared` service holds an outbound connection so the apps can check health or call a named query from the local file.

## 3. The list of statements: `queries.json`

`C:\dws-bridge\queries.json` is the complete list of SQL the service can send to SQL Server, apart from one fixed statement: `/health` runs `SELECT @@VERSION` to show that SQL Server answers. At startup the service checks every entry with a conservative keyword filter: the statement must start with `SELECT` or `WITH`, contain no `;`, and contain none of a list of words covering writes, procedures, transactions, session settings, control flow, and lock hints. The filter is not a parser, so two `SELECT`s in a row would pass it. The read-only login is what makes the statements harmless; the filter only catches mistakes early. If any entry fails, the service stops and does not restart until the file is fixed.

- `mirror`: statements run every interval, each with `sql` and `into`, the target table in Supabase.
- `live`: named statements callable through the tunnel. Empty today. Adding one requires editing `C:\dws-bridge\queries.json` on the shop computer and restarting the service.

### What the apps need, and why

The administrator may replace any statement with a different query, view, or narrower column list that returns the same columns. If a column name changes, `shop.refresh_jobs()` is updated to match.

**Projects**, `into: projects`, from `tblProject`. Job number, name, completion and archive flags, and location id for filing receipts and photos.

```sql
SELECT ProjectID, Project, Completed, Archived, Location FROM dbo.tblProject
```

**Locations**, `into: locations`, from `tblLocation`. Site name and address for the job picker.

```sql
SELECT LocationID, LocationName, LocationAddress, LocationCity FROM dbo.tblLocation
```

**Open jobs in accounting**, `into: open_jobs`, from `tblMas90JobMasterOpen`. A job is open only when open in both `DWS` and Sage MAS 90, matching the previous manual import.

```sql
SELECT JobNo, JobStatus FROM dbo.tblMas90JobMasterOpen
```

**Contacts**, `into: contacts`, from `tblContact`. Only a contact in `DWS` may hold an app account: employees today, and external contacts such as architects or contractors later. The apps match by phone number for text-message sign-in and by name, and distinguish employees by `CompanyID`. `tblContact` has 54 columns; this takes 10.

```sql
SELECT ContactID, CompanyID, EmplCode, FirstName, LastName, email, Mobile, OfficePhone,
       CurrentEmp, dbTermDate
FROM dbo.tblContact
```

The company owner has approved this data, including phone numbers, leaving the shop.

The four results total a few thousand rows and copy in seconds. Large tables such as `tblTimesheet` at about 290,000 rows do not belong here; the service stops reading at 100,000 rows and refuses the result.

Three column types must be cast to text in the statement, because the copy cannot hold them exactly: `time`, `datetimeoffset`, and `decimal` or `numeric` wider than 15 digits. A run that meets one says so in its error. `money` and ordinary dates copy as they are; dates keep millisecond precision.

## 4. What runs on the shop computer

Two Windows services run on one always-on shop computer, appear in `services.msc`, start at boot, and restart on crash:

- **`dws-bridge`**: About 1,000 lines of JavaScript, run by Node.js, in `C:\dws-bridge\`. It runs under its own virtual service account, `NT SERVICE\dws-bridge`, so only administrators, SYSTEM, and this one service can read `.env`. Logs go to `C:\dws-bridge\logs\bridge.log`.
- **`cloudflared`**: Cloudflare's outbound tunnel connector.

Nothing is installed inside SQL Server or the Access database.

### How it talks to SQL Server

The service connects over the LAN to `SQL2016\SQLEXPRESS` via SQL Browser as `dws_bridge_ro` over TLS. The pool keeps at most four connections and closes idle ones after 30 seconds. At 30 seconds a statement is sent a cancel, and the service waits for SQL Server to stop it before answering. Sessions use application name `dws-bridge`:

```sql
SELECT session_id, login_name, host_name, program_name, login_time, status
FROM sys.dm_exec_sessions
WHERE program_name = 'dws-bridge';
```

### The login

The service never needs `sa`, `sysadmin`, `db_owner`, or write access. The administrator creates the login; Option B is narrower once the statements are settled:

```sql
-- Option A: read everything in DWS, write nothing.
USE [master];
CREATE LOGIN dws_bridge_ro WITH PASSWORD = '<strong password>', CHECK_POLICY = ON;
USE [DWS];
CREATE USER dws_bridge_ro FOR LOGIN dws_bridge_ro;
ALTER ROLE db_datareader ADD MEMBER dws_bridge_ro;
ALTER ROLE db_denydatawriter ADD MEMBER dws_bridge_ro;

-- Option B: read only the objects the statements use (tables, or views written for
-- this purpose), and nothing else in the database.
USE [DWS];
CREATE USER dws_bridge_ro FOR LOGIN dws_bridge_ro;
GRANT SELECT ON dbo.tblProject TO dws_bridge_ro;
GRANT SELECT ON dbo.tblLocation TO dws_bridge_ro;
GRANT SELECT ON dbo.tblMas90JobMasterOpen TO dws_bridge_ro;
GRANT SELECT ON dbo.tblContact TO dws_bridge_ro;
```

A Windows login with the same grants also works. `db_denydatawriter` in Option A blocks any write grant added later. `SQL2016\SQLEXPRESS` must accept LAN TCP connections, which is already on if workstation Access links over ODBC.

## 5. Security

### Nothing dials in

No inbound port, forward, or firewall rule is added in the shop. `cloudflared` holds an outbound HTTPS connection on port 443 to Cloudflare: the shop computer phones Cloudflare and stays on the line. When an app calls with valid credentials, Cloudflare passes the request down that open line.

- The shop computer has no public IP address.
- `dws-bridge` listens only on `127.0.0.1`.
- Stopping the tunnel or turning off the computer stops outside access.
- The bridge hostname is on a dedicated domain that resolves to Cloudflare.

### The locks between the internet and `DWS`

| Lock | Where it lives | What it stops |
| --- | --- | --- |
| 1. Cloudflare Access | Cloudflare's edge, before anything reaches the shop | A caller without the service token is rejected by Cloudflare. The shop never sees the request. |
| 2. Bridge token | This program | A second secret, checked in constant time. A caller holding only the Cloudflare token gets `401` on `/query/<name>`. `/health` answers to the Cloudflare token alone and shows status only: server and database names, SQL Server version, the query names, and the last run per table. |
| 3. The statement list | This program | Only a statement written into `queries.json` on the shop computer can run, and the list is checked to be read-only. There is no way to send SQL over the network. |
| 4. The read-only login | SQL Server | Created and controlled by the administrator. Even if every lock above were beaten, the attacker could only read what that login can read. |

Tokens stolen from the apps' hosting (`CF_ACCESS_CLIENT_*`, `SHOP_BRIDGE_TOKEN`) allow calling only `/health` and named live queries in `queries.json` until a token is rotated or the login is disabled. Compromising the shop computer exposes the read-only SQL Server login and the mirror token. The mirror token can only replace the rows of the copied tables and ask for the job refresh, until its hash is deleted in Supabase.

### Where the copied data goes

The mirror sends its copies to Supabase, in Amazon's Ohio region, over HTTPS. The shop computer has no database login. It calls exactly two functions on Supabase's web API, with the project's public browser key and its own mirror token:

- `shop_mirror_replace` replaces all rows of one copied table in schema `shop`, creating the table the first time, or records that the table could not be read.
- `shop_mirror_refresh` updates the apps' job list from the copied tables.

Supabase keeps only a SHA-256 hash of the mirror token, and refuses every call whose token does not match it. What the computer sends is only ever data: table and column names, column types from a fixed list, and values. It cannot run SQL in Supabase or read anything there, including its own copies. Browser keys cannot read `shop`; only server code and admins can. The shop computer holds no app master key, and the apps hold no SQL Server password.

### Kill switches

1. In SQL Server: `ALTER LOGIN dws_bridge_ro DISABLE;`
2. In the Supabase SQL editor: `delete from shop.mirror_token;` refuses every mirror call from then on.
3. On the shop computer: `Stop-Service dws-bridge` and `Stop-Service cloudflared`.
4. Turn the shop computer off.

To remove it entirely: `C:\dws-bridge\install\uninstall.ps1 -RemoveFiles` removes the service and folder, and `cloudflared service uninstall` removes the connector.

### What can be watched

- **In SQL Server**: sessions via section 4's query, and connection events in the error log when login auditing is on.
- **The log file** `C:\dws-bridge\logs\bridge.log`: one line per table per mirror run with name, row count, duration, and status or error, plus one per tunnel request with route, status code, duration, rows, and the first 80 characters of the statement. A database failure also logs the driver's code and message.
- **The run history**: `shop.sync_runs` in Supabase, and `/api/shop/health` for an admin signed in to the apps.
- **A warning for the admin**: the admin receipts page shows a yellow warning when some copied table has had no good copy for over an hour. Nothing else alerts anyone: no e-mail or text is sent.

## 6. Reliability

Nothing in the office depends on the bridge.

| Failure | Effect on the shop | Effect on the apps |
| --- | --- | --- |
| SQL Server down or restarting | none; the service fails to connect and retries next interval | apps keep using the last copy |
| The shop computer is off | none | same; `/api/shop/health` shows the bridge `unreachable`, and after an hour the admin receipts page shows the stale-sync warning |
| The shop's internet is down | none | same; copying resumes when it returns |
| Cloudflare or Supabase outage | none | apps show older data until it passes |
| A statement is slow | cancelled at 30 seconds | that table's copy is skipped this run |
| The service crashes | Windows restarts it; the log has the reason | a gap of seconds |
| A result changes shape (a column added or renamed) | none | that table's copy stops with a clear error until the landing table is dropped and recreated; other tables continue |
| `queries.json` or a setting is invalid | none | the service stops with the reason in the log and does not restart until it is fixed; after an hour the admin receipts page shows the stale-sync warning |
| A copy of `projects`, `locations`, or `open_jobs` fails, or any copy cannot reach Supabase | none | the job refresh is skipped for that run, so the job list never mixes a fresh table with a stale one |

Each table copy runs in one transaction, so readers see either the old copy or the new one. Missing shop rows never delete or deactivate app data. Office jobs keep their office name and number: the photos app refuses to rename or renumber them, and a rename is made in `DWS`.

## 7. Setting it up

### 7.1 At a desk, before the shop visit: about 30 minutes

Save these values in a password-manager entry called "DWS shop bridge".

**Cloudflare and the dedicated domain.** In a free Cloudflare account, register a domain under Domain Registration → Register and record it as `<domain>`. Production app DNS stays unchanged. Open Zero Trust on the free plan.

**The tunnel.** In Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared, create `dws-shop`, choose Windows, and save `cloudflared.exe service install eyJh...` as `<tunnel install command>`. Set public hostname `shop.<domain>`, type `HTTP`, URL `localhost:8787`, and save `https://shop.<domain>` as `SHOP_BRIDGE_URL`.

**The Access lock.** In Zero Trust → Access → Service Auth → Service Tokens, create `vercel-dws` with the longest duration, note the expiry date, and save `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. In Access → Applications → Add → Self-hosted, create `dws-shop-bridge` for `shop.<domain>` with policy `service-only`, action Service Auth, and token `vercel-dws`.

**The bridge's own token.** Run `openssl rand -hex 32` and save as `SHOP_BRIDGE_TOKEN`.

**Supabase.** From `dws-app/`, apply the shop migrations:

```sh
for f in supabase/migrations/20261017*_shop_*.sql; do
  env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f "$f"
done
```

Save `https://qebbmojnqzwwdpkhuyyd.supabase.co` as `SHOP_MIRROR_SUPABASE_URL`, and the project's anon (public) key from Supabase → Project Settings → API Keys as `SHOP_MIRROR_API_KEY`. The mirror token is generated at the shop (7.2).

**The SQL Server login.** Create the login from section 4 and save `SHOP_DB_USER` and `SHOP_DB_PASSWORD`, plus `SHOP_DB_DOMAIN` for a Windows login.

**Checklist to bring:**

| Value | Where it goes |
| --- | --- |
| `<tunnel install command>` | shop computer, 7.2 |
| `SHOP_DB_SERVER=SQL2016\SQLEXPRESS`, `SHOP_DB_NAME=DWS`, `SHOP_DB_USER`, `SHOP_DB_PASSWORD`, optional `SHOP_DB_DOMAIN` | shop computer, 7.2 |
| `SHOP_BRIDGE_TOKEN` | shop computer (7.2) and the apps' hosting (7.3) |
| `SHOP_MIRROR_SUPABASE_URL`, `SHOP_MIRROR_API_KEY` | shop computer, 7.2 |
| `SHOP_BRIDGE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | the apps' hosting and the laptop (7.3) |
| The agreed `queries.json`, if it differs from the shipped one | shop computer, 7.2 |

### 7.2 At the shop: about 15 minutes

In an elevated PowerShell on the shop computer:

1. Install Node.js 22 LTS from https://nodejs.org, NSSM from https://nssm.cc/download with `win64\nssm.exe` in `C:\Windows\System32\`, and `cloudflared-windows-amd64.msi` from https://github.com/cloudflare/cloudflared/releases. Reopen PowerShell and check `node -v`, `nssm version`, `cloudflared --version`.
2. Copy this folder to the computer, open it in PowerShell, and replace `queries.json` if needed.
3. Run the installer to write `C:\dws-bridge\.env`, install and start `dws-bridge`, and print the health report:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install\setup.ps1
   ```
   Press Enter at the mirror token prompt to generate one. The health JSON shows `"ok":true` and the SQL Server version, followed by a green "The bridge is up and can reach SQL Server." A yellow "The bridge is up but cannot reach SQL Server." means the login is wrong or SQL Server is not accepting LAN TCP connections (section 4); `C:\dws-bridge\logs\` has the driver's error.

   The installer then prints one `insert into shop.mirror_token ...` statement holding the token's hash (not the token). Run it once in the Supabase SQL editor; until then Supabase refuses the mirror's calls and the log says `Supabase refused the call (HTTP 401 ...)`.
4. Connect the tunnel:
   ```powershell
   <tunnel install command>
   Start-Service cloudflared
   Get-Service cloudflared, dws-bridge
   ```
   Both show `Running`, and the tunnel turns "Healthy" in Cloudflare within a minute.
5. Check the first run, then reboot once and verify both services restart:
   ```powershell
   Get-Content C:\dws-bridge\logs\bridge.log -Tail 20
   ```
   Expect one `mirror` line per table reading `ok` with a row count, a `refresh_jobs` line, then `run done ok=true`. After storing the token's hash, `Restart-Service dws-bridge` starts a mirror run immediately.

### 7.3 From the laptop and the apps' hosting

Set `SHOP_BRIDGE_URL`, `SHOP_BRIDGE_TOKEN`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET` in `dws-app/.env.local`, then test from `dws-app/`:

```sh
# No Cloudflare token: blocked at the edge (403 or a redirect); nothing in the shop log.
curl -sS -o /dev/null -w '%{http_code}\n' https://shop.<domain>/health
# Cloudflare token but wrong bearer: 401 from the bridge.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://shop.<domain>/query/anything \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Authorization: Bearer wrong' -H 'content-type: application/json' -d '{}'
# Both: the health report.
node --env-file=.env.local scripts/shop-query.mjs --health
```

In the Supabase SQL editor:

```sql
select table_name, finished_at, row_count, ok, left(error, 80) as error
from shop.sync_runs order by finished_at desc limit 12;
```

In Vercel project `dws-receipts` → Settings → Environment Variables, add the four variables to Production and Preview, redeploy, and open `/api/shop/health` as an admin on the photos site to check `bridge.ok` is true and `mirror` lists each table's age in seconds.

## 8. Day to day

### Adding or changing a statement

1. Agree the statement with the administrator.
2. Edit `C:\dws-bridge\queries.json` and the repo copy, then run `Restart-Service dws-bridge`. If the filter rejects a statement, the service stops until the file is fixed; the log names the entry.
3. Then, by kind of change:
   - **New `mirror` entry**: creates `shop.<into>` on the next run.
   - **Changed columns**: that table's copy fails until `drop table shop.<into>` is run in Supabase; update `shop.refresh_jobs()` if it reads the table.
   - **Removed entry**: run `delete from shop.sync_runs where table_name = '<into>'`, or the admin page keeps warning that its copy is stale.
   - **New `live` entry**: callable as `POST /query/<name>` after the restart.

### Rotating a secret

| Secret | How |
| --- | --- |
| Cloudflare service token | Zero Trust → Access → Service Auth → create a new token, add it to the `service-only` policy, update the apps' hosting and `.env.local`, delete the old token. Nothing changes on the shop computer. |
| `SHOP_BRIDGE_TOKEN` | New `openssl rand -hex 32`; update `C:\dws-bridge\.env`, `Restart-Service dws-bridge`; update the apps' hosting and `.env.local`. |
| Mirror token | Delete the `SHOP_MIRROR_TOKEN` line from `C:\dws-bridge\.env` (as Administrator), run `install\setup.ps1` again, press Enter at the token prompt to generate a new one, and run the `insert into shop.mirror_token ...` statement it prints. The old token stops working once that runs. |
| SQL Server login | The administrator changes it; update `C:\dws-bridge\.env`; restart the service. |

### When something is wrong

| Symptom | Where to look |
| --- | --- |
| `/api/shop/health` says `edge_blocked` (403) | The Cloudflare service token expired or the Access policy changed. Rotate it. |
| `unreachable` or `timeout`, tunnel "Down" in Cloudflare | The shop computer is off, offline, or `cloudflared` stopped: `Get-Service cloudflared`, `Start-Service cloudflared`. |
| Tunnel healthy, bridge reports `db_unreachable` | SQL Server is down or the login changed. `C:\dws-bridge\logs\` has the driver's message. `sqlcmd -S SQL2016\SQLEXPRESS -d DWS -U dws_bridge_ro -Q "select 1"` from the shop computer isolates it. |
| The admin page warns that the sync is stale, or `/api/shop/health` shows the mirror's age growing while the bridge answers | Check `bridge.mirror.lastError` in `/api/shop/health` first. It reports a wrong `SHOP_MIRROR_SUPABASE_URL` or `SHOP_MIRROR_API_KEY`, or a token whose hash is not in `shop.mirror_token`, none of which reach `shop.sync_runs`. Otherwise `select table_name, finished_at, left(error, 120) from shop.sync_runs where ok = false order by finished_at desc limit 5` shows the error, such as a changed result shape. |
| `/api/shop/health` says `http_502` | The tunnel is up but the `dws-bridge` service is not answering: `Get-Service dws-bridge`, and the end of `C:\dws-bridge\logs\bridge.log` for why it stopped. |
| The service will not start | A statement in `queries.json` failed the filter, the file is malformed, or a setting is missing or out of range. The log says which; fix it and `Start-Service dws-bridge`. |
| `public.jobs` is missing a job | It must be open in both `projects` (`Completed` null, not `Archived`) and `open_jobs` (`JobStatus` `O`). `select detail from shop.sync_runs where table_name = 'public.jobs' order by finished_at desc limit 1` shows what the last run saw. |

`shop.refresh_jobs()` never deactivates a job; jobs no longer open are listed in `detail.dropped_from_open` on the `public.jobs` row in `shop.sync_runs`.

## 9. Reference

### Files

| File | What it does |
| --- | --- |
| `server.mjs` | The HTTP service (`/health`, `/query/<name>`). Run directly, it also starts the mirror. |
| `queries.json` | The only SQL the service runs: `mirror` entries and named `live` queries. |
| `config.mjs` | Loads and validates `queries.json`. |
| `guard.mjs` | The keyword filter every statement must pass. |
| `query.mjs` | Runs one statement with a 30-second deadline and a row cap, streaming rows. |
| `mirror.mjs` | The mirror loop: run each statement, send the result to Supabase's `shop_mirror_replace`, then call `shop_mirror_refresh`, and log the run. |
| `db.mjs` | SQL Server connection settings from the environment, and the shared pool. |
| `types.mjs` | SQL Server to Postgres type map, value conversion, and the landing table's column list. |
| `install/setup.ps1`, `install/uninstall.ps1` | Install, update, or remove the Windows service. |
| `*.test.mjs`, `testing-stubs.mjs` | Tests and their fakes for SQL Server and the Supabase calls. `npm test` needs no database. |

### Settings: `C:\dws-bridge\.env`

| Variable | Required | Meaning |
| --- | --- | --- |
| `SHOP_DB_SERVER` | yes | `HOST\INSTANCE` (named instance), `host,port`, or a plain host |
| `SHOP_DB_NAME` | yes | Database name (`DWS`) |
| `SHOP_DB_USER`, `SHOP_DB_PASSWORD` | yes | The read-only login |
| `SHOP_DB_DOMAIN` | no | Set only for a Windows login |
| `SHOP_DB_TRUST_CERT` | no | Accept the instance's self-signed certificate (default `true`) |
| `SHOP_BRIDGE_TOKEN` | yes | Bearer token for `/query/<name>`; at least 32 characters |
| `SHOP_BRIDGE_PORT` | no | Local port (default `8787`) |
| `SHOP_MIRROR_SUPABASE_URL` | no | `https://<project-ref>.supabase.co`. Unset = mirror off |
| `SHOP_MIRROR_API_KEY` | with the mirror | The project's public anon (or publishable) key |
| `SHOP_MIRROR_TOKEN` | with the mirror | This computer's mirror token; at least 32 characters. Supabase holds its SHA-256 in `shop.mirror_token` |
| `SHOP_MIRROR_INTERVAL_MINUTES` | no | Minutes between runs (default `15`) |
| `SHOP_MIRROR_MAX_ROWS` | no | A result larger than this is refused, not copied (default `100000`) |
| `SHOP_QUERIES_FILE` | no | Path to the statement file (default: `queries.json` beside the program) |

### HTTP

Responses are JSON with `Cache-Control: no-store`; errors return `{ "error": { "code": "...", "message": "..." } }`.

`GET /health` takes no token and returns `ok`, `server`, `database`, SQL Server `version`, the last mirror run per table and for the job refresh (`refreshJobs.ok` and `refreshJobs.error`), the mirror's `lastError` when the last run could not reach Supabase or was refused, and `queries: { mirror: [...], live: [...] }`, or `"ok": false` with `502` when SQL Server is unreachable or `503` when the service is not configured.

`POST /query/<name>` requires the bearer token and optional body `{ "params": { "k": v }, "maxRows": 100 }`, binds `@k` in the `live` statement, and returns `{ columns, rows, rowCount, truncated, durationMs }`. `maxRows` defaults to 5,000 and caps at 50,000, cancelling the query and setting `truncated` true past the cap.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Bad JSON, bad `params`/`maxRows`, or SQL Server rejected the statement |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 404 | `not_found` | No live query of that name, or an unknown route |
| 413 | `payload_too_large` | Body over 64 KiB |
| 502 | `db_unreachable` | Cannot connect to SQL Server |
| 503 | `not_configured` | `SHOP_BRIDGE_TOKEN`, `SHOP_DB_SERVER`, or `SHOP_DB_NAME` not set |
| 504 | `timeout` | The statement ran past 30 seconds and was cancelled |

Tunnel calls also require headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`, sent by `shopQuery(name, params)` in `dws-app/src/lib/shop/query.ts` and `dws-app/scripts/shop-query.mjs`.

### The parts and where they come from

| Part | Who makes it | Role |
| --- | --- | --- |
| Node.js | OpenJS Foundation (open source) | runs the program |
| `mssql` with `tedious` | open source; `tedious` is the SQL Server driver Microsoft maintains for Node.js | the SQL Server client, like an ODBC driver |
| `cloudflared` | Cloudflare | the outbound tunnel connector |
| NSSM | open source | wraps the program as a Windows service |
| `dws-bridge` | us, with automated tests | the program itself |

### Running it on a developer machine

Requires Node 22 or newer: `npm install`, copy `.env.example` to `.env` and fill it in, then `node --env-file=.env server.mjs`. Without SQL Server it still starts and `/health` answers `502`. `npm test` runs the suite against fake drivers.
