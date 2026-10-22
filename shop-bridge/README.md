# DWS shop bridge

The office runs on Microsoft Access over a SQL Server Express database (`DWS`, instance
`SQL2016\SQLEXPRESS`) that exists only inside the shop network. The company's two web
apps (receipts and job photos) run outside it and need to see the office's job list and
contact list. This document describes the one small program that connects the two: what
it is, how it reaches the shop without opening anything, what it can and cannot do, how
it is installed, and how it is run day to day.

It is written for everyone involved: the developer who installs it, the shop's database
administrator who approves it, and whoever has to look at it a year from now.

## 1. The short version

- One Windows service runs on an always-on computer in the shop. It connects to SQL
  Server the way an Access workstation does, with its own login that only reads.
- Every 15 minutes it runs a short, fixed list of `SELECT` statements and copies the
  results to the apps' hosted database. That is the whole job.
- The list of statements lives in one file on the shop computer. The program cannot run
  anything that is not in that file. The database administrator writes or approves every
  line of it.
- Nothing is opened on the shop's firewall or router. The shop computer only makes
  outbound connections, the same kind a web browser makes. Nothing on the internet can
  connect into the shop.
- It never writes to `DWS`, never changes anything in SQL Server, never needs `sa`, and
  installs nothing inside SQL Server.
- Disabling its login, or stopping the service, ends it immediately.

## 2. How the pieces fit

```
shop LAN                                      internet                    cloud
SQL Server  <--read-only login--  dws-bridge  --outbound HTTPS-->  Cloudflare  <--  apps / laptop
(DWS)                             (one Node     (kept open by                (Access: service token)
                                   service)      cloudflared)
                                      |
                                      +----------outbound TLS-------------->  Supabase Postgres
                                                                              (schema "shop")
```

Two things cross the shop boundary, both outbound:

1. **The mirror.** Every 15 minutes the service runs the statements in its list and
   writes the rows into a `shop` schema in Supabase (the hosted PostgreSQL the apps
   already use), then calls one function there that refreshes the apps' job list. The
   apps read the copy, never the shop.
2. **The tunnel.** A second service, Cloudflare's `cloudflared`, keeps an outbound
   connection to Cloudflare open so the apps can ask the bridge two things: "are you
   healthy?" and, only if a query has been written into the list under a name, "run that
   named query". Today the list of such live queries is empty.

The mirror is what the apps depend on. The tunnel exists for health checks and for
future needs that the administrator agrees to.

## 3. The list of statements: `queries.json`

This file is the contract. It sits next to the program on the shop computer
(`C:\dws-bridge\queries.json`) and is the complete list of SQL the program will ever
send to SQL Server. Anything else is impossible by construction: there is no code path
that runs SQL from anywhere but this file. The service checks every statement when it
starts (one `SELECT` or `WITH ... SELECT`, no `;`, no write, exec, or system-procedure
keywords) and refuses to start if any line fails.

It has two sections:

- `mirror`: statements run every interval. Each has a `sql` and an `into`, the name of
  the table in Supabase that receives the result.
- `live`: named statements the apps may run on request through the tunnel. Empty today.
  A live query can only be added by editing this file on the shop computer and
  restarting the service. Nothing over the network can add one.

### What the apps need, and why

The apps need four small results. The statements below are suggestions written from a
catalogue of the database; the administrator is the authority on `DWS` and may replace
any of them with a different statement, a view, or a narrower column list, as long as
the named columns come back. If a column must be named differently, the function on the
apps' side that reads it is a short piece of SQL that we adjust.

**Projects** (`into: projects`), from `tblProject`. The apps show a job picker and file
receipts and photos under a job number. They need the job number, its name, and whether
it is finished or archived, plus the location id to look up a site name.

```sql
SELECT ProjectID, Project, Completed, Archived, Location FROM dbo.tblProject
```

**Locations** (`into: locations`), from `tblLocation`. Only so the job picker can show a
site name next to the number.

```sql
SELECT LocationID, LocationName, LocationAddress, LocationCity FROM dbo.tblLocation
```

**Open jobs in accounting** (`into: open_jobs`), from `tblMas90JobMasterOpen`. The office
treats a job as open only when it is open in both DWS and Sage MAS 90, which is what the
old manual import did, so the apps need Sage's open list too. Two columns.

```sql
SELECT JobNo, JobStatus FROM dbo.tblMas90JobMasterOpen
```

**Contacts** (`into: contacts`), from `tblContact`, all rows. The rule being built is
that only a person who already exists as a contact in `DWS` may hold an account in the
apps: employees today, and later an architect or contractor the office has entered as a
contact. The apps match a person by phone number (sign-in is a text-message code) and
name, and tell employees from others by `CompanyID`. Nothing else from the contact
record is needed. `tblContact` has 54 columns; this takes 10.

```sql
SELECT ContactID, CompanyID, EmplCode, FirstName, LastName, email, Mobile, OfficePhone,
       CurrentEmp, dbTermDate
FROM dbo.tblContact
```

The company owner has approved this data, including phone numbers, leaving the shop.

These four results are a few thousand rows in total. The copy takes seconds, about the
load of one user opening those tables in Access. Large tables (`tblTimesheet` has about
290,000 rows) do not belong in this list, and the service refuses a result over 100,000
rows rather than copy it.

### The login

The administrator creates the login and decides how narrow it is. Either of these works;
the second is tighter and is the better choice when the statements are settled:

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

If the instance is Windows-authentication only, a Windows account with the same
permissions does the same job. `db_denydatawriter` in option A is belt and braces: an
explicit deny wins over any grant added by accident later. In option B the login simply
has no write permission to deny.

The instance must accept TCP connections from another computer on the LAN. It already
does if the Access front end on the workstations links to `SQL2016\SQLEXPRESS` over
ODBC, which is how the office works today.

## 4. What runs on the shop computer

Two Windows services on one always-on computer: the SQL Server host itself or any PC
that stays on. Both appear in `services.msc`, start at boot, and restart if they crash.

**`dws-bridge`**, this program. About 500 lines of JavaScript, run by Node.js. It runs as
the built-in low-privilege `NetworkService` account, not as an administrator. Its folder
is `C:\dws-bridge\`. The file holding its passwords (`.env`) is readable only by
administrators and that service account. It writes a plain text log to
`C:\dws-bridge\logs\bridge.log`.

**`cloudflared`**, Cloudflare's connector, which keeps the outbound tunnel open.

Nothing is installed inside SQL Server: no linked server, no SQL Agent job, no trigger,
no stored procedure, no CLR assembly, no setting change, no change to any table, no change
to the Access database.

### How it talks to SQL Server

Like one more Access user. It opens a client connection over the LAN to
`SQL2016\SQLEXPRESS` (finding the instance through SQL Browser, as ODBC does), logs in as
`dws_bridge_ro`, and runs the statements from the file. The connection is encrypted. It
keeps at most four connections open and closes idle ones after 30 seconds. Every
statement has a 30-second limit and is cancelled past it. It identifies itself to SQL
Server with the application name `dws-bridge`, so its sessions are easy to find:

```sql
SELECT session_id, login_name, host_name, program_name, login_time, status
FROM sys.dm_exec_sessions
WHERE program_name = 'dws-bridge';
```

## 5. Security

### Nothing dials in

The usual way to let something on the internet reach a program in an office is to open
a port on the firewall and forward it to a machine. That is not done here. Nothing on the
internet can connect to the shop computer, and no port, forward, or firewall rule is
added anywhere in the shop.

Instead, the shop computer connects outward. `cloudflared` opens an outbound HTTPS
connection to Cloudflare, a large internet infrastructure company, and keeps it open:
the shop phones a receptionist and stays on the line. When an app wants to ask the shop
something, it calls the receptionist. Only if the caller shows the right credentials does
the receptionist pass the question down the line the shop already opened.

- The shop computer has no public address. Scanning the shop's internet connection
  shows nothing new.
- The shop's router and firewall are untouched. The connection is outbound on port 443,
  like every web browser in the building.
- The bridge program listens only on the computer it runs on (`127.0.0.1`). Even another
  PC in the shop cannot connect to it directly.
- If the tunnel is stopped or the computer is off, the outside cannot reach the program.
  There is no fallback path.
- The hostname the apps use is on a small domain registered only for this purpose. It
  resolves to Cloudflare, never to the shop.

### The locks between the internet and `DWS`

A request from outside must pass all of these. Each works even if the others fail.

| Lock | Where it lives | What it stops |
| --- | --- | --- |
| 1. Cloudflare Access | Cloudflare's edge, before anything reaches the shop | A caller without the service token is rejected by Cloudflare. The shop never sees the request. |
| 2. Bridge token | This program | A second secret, checked in constant time. A caller holding only the Cloudflare token gets `401`. |
| 3. The statement list | This program | Only a statement written into `queries.json` on the shop computer can run, and the list is checked to be read-only. There is no way to send SQL over the network. |
| 4. The read-only login | SQL Server | Created and controlled by the administrator. Even if every lock above were beaten, the attacker could only read what that login can read. |

Lock 4 is the one that truly matters, and it is not ours. The others limit who can read;
lock 4 guarantees nobody can write, whatever the program does or how it is attacked.

What a worst case looks like: if someone stole both secrets from the apps' hosting
provider, they could call the named live queries (none today) and the health check,
until a token is rotated (minutes) or the login is disabled (one statement). They could
not run SQL of their own, change a row, create anything, reach other databases, or reach
other machines. If someone instead gained control of the shop computer itself, they would
hold a read-only login and the file of statements, nothing more.

### Where the copied data goes

The copy lands in Supabase, a hosted PostgreSQL service the apps already use, in Amazon's
Ohio region, over an encrypted connection. The shop computer logs in there with a
dedicated account (`shop_mirror`) that can only create and fill tables inside one area,
the `shop` schema, and cannot read the apps' own tables. The apps' browser-side keys
cannot read the copied tables at all; only the apps' server code and the admins can.

The shop computer never holds a master key for the apps, and the apps never hold the
SQL Server password. Each side has exactly the credential it needs.

### Kill switches

Any one of these stops everything, immediately, with no help from the developer:

1. In SQL Server: `ALTER LOGIN dws_bridge_ro DISABLE;` (or drop it).
2. On the shop computer: `Stop-Service dws-bridge`, and `Stop-Service cloudflared` to
   close the tunnel as well.
3. Turn the computer off.

To remove it entirely: `C:\dws-bridge\install\uninstall.ps1 -RemoveFiles` removes the
service and folder, and `cloudflared service uninstall` removes the connector. Nothing is
left in SQL Server except the login the administrator created.

### What can be watched

- **In SQL Server**: the login's sessions, with the query in section 4. With login
  auditing on, each connection appears in the error log.
- **The log file** `C:\dws-bridge\logs\bridge.log`: one line per mirror run per table
  (name, row count, duration, success or the exact error) and one per request through
  the tunnel (route, result code, duration, rows, the first 80 characters of the
  statement). Rejected requests appear with the code that rejected them.
- **The run history** in Supabase (`shop.sync_runs`) and the apps' admin page
  (`/api/shop/health`), which shows how old each copied table is.

### What is never done without asking the administrator

- Write to `DWS`, in any form.
- Ask for `sa`, `sysadmin`, `db_owner`, or any permission beyond read on `DWS`.
- Change a table, index, procedure, setting, or anything else in SQL Server.
- Touch the Access front end, the backups, or the accounting system.
- Add a statement to the file, change the schedule, or open anything inbound.
- Install anything on the SQL Server host beyond the two services, and only there if
  that is the computer the administrator prefers.

## 6. Reliability

Nothing in the office depends on this. Access, SQL Server, and accounting carry on
exactly as before in every case below.

| Failure | Effect on the shop | Effect on the apps |
| --- | --- | --- |
| SQL Server down or restarting | none; the service fails to connect and retries next interval | apps keep using the last copy |
| The bridge computer is off | none | same; the health page shows the tunnel down |
| The shop's internet is down | none | same; copying resumes when it returns |
| Cloudflare or Supabase outage | none | apps show older data until it passes |
| A statement is slow | cancelled at 30 seconds | that table's copy is skipped this run |
| The service crashes | Windows restarts it; the log has the reason | a gap of seconds |
| A result changes shape (a column added or renamed) | none | that table's copy stops with a clear error until the landing table is dropped and recreated; other tables continue |

Each table's copy is written as one transaction: readers see the old copy or the new
one, never half. The program never deletes or deactivates anything in the apps because a
row went missing from the shop, so a bad copy cannot cascade into lost data on the apps'
side either.

## 7. Setting it up

### 7.1 At a desk, before the shop visit (about 30 minutes)

Collect the values in a password-manager entry called "DWS shop bridge" as you go.

**Cloudflare and the throwaway domain.** Sign in to Cloudflare (free account). Register
a small domain for this purpose (Domain Registration → Register); it is only ever used
by machines. Write it down as `<domain>`. Production DNS for the apps stays where it is.
Open Zero Trust and pick the free plan.

**The tunnel.** Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → name
`dws-shop`. On "Install and run a connector" choose Windows and save the whole
`cloudflared.exe service install eyJh...` command as `<tunnel install command>`. Public
hostname: subdomain `shop`, domain `<domain>`, type `HTTP`, URL `localhost:8787`. The
bridge URL is `https://shop.<domain>`; save it as `SHOP_BRIDGE_URL`. The tunnel shows
"Inactive" until the shop computer connects.

**The Access lock.** Zero Trust → Access → Service Auth → Service Tokens → create
`vercel-dws` with the longest duration offered; copy the Client ID and Secret now (the
secret is shown once) as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, and note the
expiry date. Then Access → Applications → Add → Self-hosted: name `dws-shop-bridge`,
domain `shop.<domain>`; add a policy `service-only`, action **Service Auth**, include
Service Token `vercel-dws`. Save. From now on anything hitting the hostname without that
token is stopped at Cloudflare.

**The bridge's own token.** `openssl rand -hex 32`, saved as `SHOP_BRIDGE_TOKEN`.

**Supabase.** Apply the shop migrations to the production project the same way as every
other migration (from `dws-app/`):

```sh
for f in supabase/migrations/20261017*_shop_*.sql; do
  env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f "$f"
done
```

They add the `shop` schema, the run log, the `shop_mirror` role, and the job-refresh
function; the landing tables themselves are created by the service on its first run.
Give the role a password (`openssl rand -base64 24`, saved as `<shop_mirror password>`):

```sh
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd \
  "alter role shop_mirror password '<shop_mirror password>'"
```

In the dashboard open Connect → Session pooler and copy the host. The connection string
is `postgresql://shop_mirror.qebbmojnqzwwdpkhuyyd:<password>@<pooler host>:5432/postgres?sslmode=require`
(URL-encode `@`, `:`, `/` in the password). Save it as `SHOP_MIRROR_DATABASE_URL`.

**The SQL Server login.** Section 3 above, agreed with the administrator. Save
`SHOP_DB_USER`, `SHOP_DB_PASSWORD`, and `SHOP_DB_DOMAIN` if it is a Windows account.

**Checklist to bring:**

| Value | Where it goes |
| --- | --- |
| `<tunnel install command>` | shop computer, 7.2 |
| `SHOP_DB_SERVER=SQL2016\SQLEXPRESS`, `SHOP_DB_NAME=DWS`, `SHOP_DB_USER`, `SHOP_DB_PASSWORD`, optional `SHOP_DB_DOMAIN` | shop computer, 7.2 |
| `SHOP_BRIDGE_TOKEN` | shop computer (7.2) and the apps' hosting (7.3) |
| `SHOP_MIRROR_DATABASE_URL` | shop computer, 7.2 |
| `SHOP_BRIDGE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | the apps' hosting and the laptop (7.3) |
| The agreed `queries.json`, if it differs from the shipped one | shop computer, 7.2 |

### 7.2 At the shop (about 15 minutes)

On the chosen always-on computer, signed in as an administrator, in PowerShell opened
"as Administrator".

1. Install three tools: Node.js 22 LTS (https://nodejs.org, Windows installer,
   defaults); NSSM (https://nssm.cc/download, unzip, copy `win64\nssm.exe` into
   `C:\Windows\System32\`); cloudflared (`cloudflared-windows-amd64.msi` from
   https://github.com/cloudflare/cloudflared/releases). Reopen PowerShell and check
   `node -v`, `nssm version`, `cloudflared --version`.
2. Put this folder on the computer (download the archive it was shared from, or copy it
   from a USB stick) and open it in PowerShell. If the agreed `queries.json` differs from
   the shipped one, replace the file now.
3. Run the installer. It asks for each value from the checklist, writes them to
   `C:\dws-bridge\.env` with permissions limited to administrators and the service
   account, installs and starts the `dws-bridge` service, and prints a health report:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install\setup.ps1
   ```
   The last line should show `"ok": true` and the SQL Server version. "Database
   unreachable" means the login or the TCP step in section 3; `C:\dws-bridge\logs\` has
   the exact error.
4. Connect the tunnel, pasting the saved command:
   ```powershell
   cloudflared.exe service install <token from the command>
   Start-Service cloudflared
   Get-Service cloudflared, dws-bridge
   ```
   Both `Running`; the tunnel turns "Healthy" in the Cloudflare dashboard within a
   minute.
5. Watch the first run, then reboot once and check both services again:
   ```powershell
   Get-Content C:\dws-bridge\logs\bridge.log -Tail 20
   ```
   One `mirror` line per table with `ok=true` and a row count, then a `refresh_jobs`
   line.

### 7.3 From the laptop and the apps' hosting

Put the four values in `dws-app/.env.local` (never in a committed file):
`SHOP_BRIDGE_URL`, `SHOP_BRIDGE_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
Then, from `dws-app/`, prove each lock:

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

In Vercel, project `dws-receipts` → Settings → Environment Variables → add the same four
values for Production and Preview, redeploy, and as an admin open
`/api/shop/health` on the photos site: `bridge.ok` true and `mirror` listing each table
with its age in seconds.

## 8. Day to day

### Adding or changing a statement

1. Agree the statement with the administrator.
2. Edit `C:\dws-bridge\queries.json` on the shop computer (and the copy in this
   folder, so the two match), then `Restart-Service dws-bridge`. The service refuses to
   start if the statement is not a plain `SELECT`; the log says which line.
3. A new `mirror` entry creates its landing table on the next run. A changed column list
   on an existing entry stops that entry with a clear error until someone runs
   `drop table shop.<into>` in Supabase; the next run recreates it. If the apps' job
   refresh reads the changed table, update `shop.refresh_jobs()` to match.
4. A `live` entry is callable as `POST /query/<name>` once the service restarts.

### Rotating a secret

| Secret | How |
| --- | --- |
| Cloudflare service token | Zero Trust → Access → Service Auth → create a new token, add it to the `service-only` policy, update the apps' hosting and `.env.local`, delete the old token. Nothing changes on the shop computer. |
| `SHOP_BRIDGE_TOKEN` | New `openssl rand -hex 32`; update `C:\dws-bridge\.env`, `Restart-Service dws-bridge`; update the apps' hosting and `.env.local`. |
| `shop_mirror` password | `alter role shop_mirror password '...'`; update `SHOP_MIRROR_DATABASE_URL` in `C:\dws-bridge\.env`; restart the service. |
| SQL Server login | The administrator changes it; update `C:\dws-bridge\.env`; restart the service. |

### When something is wrong

| Symptom | Where to look |
| --- | --- |
| `/api/shop/health` says `edge_blocked` (403) | The Cloudflare service token expired or the Access policy changed. Rotate it. |
| `unreachable` or `timeout`, tunnel "Down" in Cloudflare | The shop computer is off, offline, or `cloudflared` stopped: `Get-Service cloudflared`, `Start-Service cloudflared`. |
| Tunnel healthy, bridge reports `db_unreachable` | SQL Server is down or the login changed. `C:\dws-bridge\logs\` has the driver's message. `sqlcmd -S SQL2016\SQLEXPRESS -d DWS -U dws_bridge_ro -Q "select 1"` from the bridge computer isolates it. |
| Mirror age keeps growing, bridge fine | The Supabase side: wrong `SHOP_MIRROR_DATABASE_URL`, rotated password, or a changed result shape. `select * from shop.sync_runs where ok = false order by finished_at desc limit 5` shows the error. |
| The service will not start | A statement in `queries.json` failed the read-only check or the file is malformed. The log names the entry. |
| `public.jobs` is missing a job | It must be open in both `projects` (`Completed` null, not `Archived`) and `open_jobs` (`JobStatus` `O`). `select detail from shop.sync_runs where table_name = 'public.jobs' order by finished_at desc limit 1` shows what the last run saw. |

The job refresh never deactivates a job. Jobs that have left the office's open list are
recorded in `detail.dropped_from_open` of the `public.jobs` run row; what to do with them
is an open decision.

## 9. Reference

### Files

| File | What it does |
| --- | --- |
| `server.mjs` | The HTTP service (`/health`, `/query/<name>`). Run directly, it also starts the mirror. |
| `queries.json` | The only SQL the service runs: `mirror` entries and named `live` queries. |
| `config.mjs` | Loads and validates `queries.json`. |
| `guard.mjs` | Decides whether a SQL string is a single read-only `SELECT`. |
| `mirror.mjs` | The mirror loop: run each statement, create the landing table if missing, replace its rows in one transaction, log the run. |
| `db.mjs` | SQL Server connection settings from the environment, and the shared pool. |
| `types.mjs` | SQL Server to Postgres type map and the `create table` builder. |
| `install/setup.ps1`, `install/uninstall.ps1` | Install, update, or remove the Windows service. |
| `*.test.mjs`, `testing-stubs.mjs` | Tests and their fake database drivers. `npm test` needs no database. |

### Settings (`C:\dws-bridge\.env`)

| Variable | Required | Meaning |
| --- | --- | --- |
| `SHOP_DB_SERVER` | yes | `HOST\INSTANCE` (named instance), `host,port`, or a plain host |
| `SHOP_DB_NAME` | yes | Database name (`DWS`) |
| `SHOP_DB_USER`, `SHOP_DB_PASSWORD` | yes | The read-only login |
| `SHOP_DB_DOMAIN` | no | Set only for a Windows login |
| `SHOP_DB_TRUST_CERT` | no | Accept the instance's self-signed certificate (default `true`) |
| `SHOP_BRIDGE_TOKEN` | yes | Bearer token for `/query/<name>`; at least 32 characters |
| `SHOP_BRIDGE_PORT` | no | Local port (default `8787`) |
| `SHOP_MIRROR_DATABASE_URL` | no | Supabase session pooler URL for `shop_mirror`. Unset = mirror off |
| `SHOP_MIRROR_INTERVAL_MINUTES` | no | Minutes between runs (default `15`) |
| `SHOP_MIRROR_MAX_ROWS` | no | A result larger than this is refused, not copied (default `100000`) |
| `SHOP_QUERIES_FILE` | no | Path to the statement file (default: `queries.json` beside the program) |

### HTTP

Every response is JSON with `Cache-Control: no-store`; every error is
`{ "error": { "code": "...", "message": "..." } }`.

`GET /health` (no token): `ok`, `server`, `database`, SQL Server `version`, the mirror's
last run per table, and `queries: { mirror: [...], live: [...] }`. `502` with
`"ok": false` when SQL Server cannot be reached.

`POST /query/<name>` (bearer token): body `{ "params": { "k": v }, "maxRows": 100 }`,
both optional. Runs the `live` statement of that name; `@k` in the statement refers to a
param. Response `{ columns, rows, rowCount, truncated, durationMs }`. `maxRows` defaults
to 5,000, capped at 50,000; past the cap the query is cancelled and `truncated` is true.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Bad JSON, bad `params`/`maxRows`, or SQL Server rejected the statement |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 404 | `not_found` | No live query of that name, or an unknown route |
| 413 | `payload_too_large` | Body over 64 KiB |
| 502 | `db_unreachable` | Cannot connect to SQL Server |
| 503 | `not_configured` | `SHOP_BRIDGE_TOKEN` or `SHOP_DB_SERVER` not set |
| 504 | `timeout` | The statement ran past 30 seconds and was cancelled |

Through the tunnel, add the two Cloudflare Access headers (`CF-Access-Client-Id`,
`CF-Access-Client-Secret`). In the apps' code, `shopQuery(name, params)` from
`dws-app/src/lib/shop/query.ts` does this; from a laptop, `dws-app/scripts/shop-query.mjs`.

### The parts and where they come from

| Part | Who makes it | Role |
| --- | --- | --- |
| Node.js | OpenJS Foundation (open source) | runs the program |
| `mssql` with `tedious` | open source; `tedious` is the SQL Server driver Microsoft maintains for Node.js | the SQL Server client, like an ODBC driver |
| `pg` | open source | the PostgreSQL client |
| `cloudflared` | Cloudflare | the outbound tunnel connector |
| NSSM | open source | wraps the program as a Windows service |
| `dws-bridge` | us, about 500 lines with automated tests | the program itself |

### Running it on a developer machine

Needs Node 22 or newer: `npm install`, copy `.env.example` to `.env` and fill it in,
`node --env-file=.env server.mjs`. Without a reachable SQL Server it still starts and
`/health` answers `502`. `npm test` runs the suite against fake drivers.
