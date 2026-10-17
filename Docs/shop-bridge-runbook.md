# Shop database bridge and mirror

The office runs on Microsoft Access over a SQL Server Express database (`DWS`, instance
`SQL2016\SQLEXPRESS`) that only exists inside the shop network. This runbook sets up one
small service on an always-on Windows computer in the shop that gives the web apps two
things:

- **The bridge.** A read-only query endpoint. Code on Vercel, or you on your laptop, can
  run a `SELECT` against the live shop database and get rows back. It is reachable only
  through a Cloudflare Tunnel, so the shop opens no inbound port, and only callers holding
  two secrets get through.
- **The mirror.** Every 15 minutes the same service copies a short list of shop tables
  into a `shop` schema in Supabase, and then refreshes the `public.jobs` list from them.
  The apps read the mirror like any other Postgres table.

The code lives in `shop-bridge/` at the root of this repository. It depends on nothing
else in the repository, so it can move to its own repository later by copying the folder.

```
shop LAN                                   internet                     cloud
SQL Server  <--read-only login--  dws-bridge service  --outbound-->  Cloudflare edge  <--  Vercel / laptop
                                    |  (bridge + mirror)                (Access: service token)
                                    +------------------outbound----------------------->  Supabase (schema shop)
```

## Part 1: before you go to the shop (your desk, about 30 minutes)

Do these first so the shop visit is only installing and pasting. Collect the values in a
password manager entry called "DWS shop bridge" as you go.

### 1.1 Cloudflare account and the throwaway domain

1. Sign in to Cloudflare (create a free account if needed).
2. Register a small domain for this purpose (Cloudflare → Domain Registration → Register).
   Any cheap name works; it is only ever used by machines. Write it down as `<domain>`.
   Production DNS for `design-workshops.app` stays at Vercel; nothing there changes.
3. Open Zero Trust (the "Zero Trust" item in the left menu). Pick the free plan when asked.

### 1.2 The tunnel

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → name it `dws-shop`.
2. On the "Install and run a connector" step, choose Windows. Copy the long command shown;
   it looks like `cloudflared.exe service install eyJh...`. Save the whole command as
   `<tunnel install command>`. Click Next.
3. Public hostname tab: Subdomain `shop`, Domain `<domain>`, Type `HTTP`,
   URL `localhost:8787`. Save.
   The bridge URL is now `https://shop.<domain>`. Save it as `SHOP_BRIDGE_URL`.

The tunnel shows "Inactive" until the shop computer connects. That is expected.

### 1.3 The Access lock on the hostname

1. Zero Trust → Access → Service Auth → Service Tokens → Create Service Token.
   Name `vercel-dws`, duration: the longest offered. Copy the Client ID and Client Secret
   now; the secret is shown once. Save them as `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET`. Note the expiry date in the password manager entry.
2. Zero Trust → Access → Applications → Add an application → Self-hosted.
   Name `dws-shop-bridge`, Session duration anything, Application domain
   `shop.<domain>` (subdomain `shop`, domain `<domain>`, no path). Next.
3. Add a policy: name `service-only`, Action **Service Auth**, Include → Selector
   `Service Token` → `vercel-dws`. Save the policy, then save the application.

From now on, anything hitting `https://shop.<domain>` without that token is stopped at
Cloudflare and never reaches the shop.

### 1.4 The bridge's own token

Generate a second secret that the bridge itself checks (defence in depth):

```sh
openssl rand -hex 32
```

Save it as `SHOP_BRIDGE_TOKEN`.

### 1.5 Supabase: the `shop` schema and the mirror's login

Apply the shop migrations to the production project, in order, the same way as every
other migration (from `dws-app/`):

```sh
for f in supabase/migrations/20261017*_shop_*.sql; do
  env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f "$f"
done
```

They add a `shop` schema, the five mirror tables, a `sync_runs` log, a role `shop_mirror`
that can only write that schema, and the `shop.refresh_jobs()` function. They touch
nothing else.

Then give the role a password. Generate one (`openssl rand -base64 24`), save it as
`<shop_mirror password>`, and set it:

```sh
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd \
  "alter role shop_mirror password '<shop_mirror password>'"
```

(If that form of the command is not accepted by your CLI version, run the same statement
once in the dashboard SQL editor. It is a credential, not a schema change.)

Build the connection string the shop computer will use. In the Supabase dashboard open
Connect → Session pooler and copy the host (it looks like
`aws-0-us-east-2.pooler.supabase.com`). The string is:

```
postgresql://shop_mirror.qebbmojnqzwwdpkhuyyd:<shop_mirror password>@<pooler host>:5432/postgres?sslmode=require
```

Save it as `SHOP_MIRROR_DATABASE_URL`. If the password contains `@`, `:` or `/`, URL-encode
those characters.

### 1.6 The SQL Server login (ask the admin)

Ask the shop's admin for one of these, whichever needs no restart of SQL Server:

- **A SQL login** (works when the instance allows "mixed mode"; check with
  `SELECT SERVERPROPERTY('IsIntegratedSecurityOnly')` returning `0`):

  ```sql
  USE [master];
  CREATE LOGIN dws_bridge_ro WITH PASSWORD = '<strong password>', CHECK_POLICY = ON;
  USE [DWS];
  CREATE USER dws_bridge_ro FOR LOGIN dws_bridge_ro;
  ALTER ROLE db_datareader ADD MEMBER dws_bridge_ro;
  ALTER ROLE db_denydatawriter ADD MEMBER dws_bridge_ro;
  ```

  Save as `SHOP_DB_USER=dws_bridge_ro` and `SHOP_DB_PASSWORD`.

- **A Windows account** (when the answer is `1`): a domain or local account that is a
  `db_datareader` on `DWS`. Save `SHOP_DB_USER`, `SHOP_DB_PASSWORD`, and
  `SHOP_DB_DOMAIN` (the domain or the machine name for a local account).

Also confirm the instance accepts network connections from other machines. It already
does if Access on the workstations links to `SQL2016\SQLEXPRESS`, which it does today.
If the bridge computer cannot connect in Part 2, the fix is on the shop server: SQL
Server Configuration Manager → Protocols for SQLEXPRESS → TCP/IP enabled, the SQL
Server Browser service running, and a Windows Firewall rule allowing `sqlservr.exe`.

### 1.7 Checklist to bring

| Value | Where it goes |
| --- | --- |
| `<tunnel install command>` | shop computer, Part 2.3 |
| `SHOP_DB_SERVER=SQL2016\SQLEXPRESS`, `SHOP_DB_NAME=DWS`, `SHOP_DB_USER`, `SHOP_DB_PASSWORD`, optional `SHOP_DB_DOMAIN` | shop computer, Part 2.2 |
| `SHOP_BRIDGE_TOKEN` | shop computer (Part 2.2) and Vercel (Part 3) |
| `SHOP_MIRROR_DATABASE_URL` | shop computer, Part 2.2 |
| `SHOP_BRIDGE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Vercel and your laptop (Part 3) |

## Part 2: at the shop (the Windows computer, about 15 minutes)

Use a computer that stays on. Sign in as an administrator. Everything here is run in
PowerShell opened "as Administrator".

### 2.1 Install the three tools

1. **Node.js 22 LTS**: https://nodejs.org → download the Windows installer → defaults.
2. **NSSM** (runs the bridge as a Windows service): https://nssm.cc/download → unzip →
   copy `win64\nssm.exe` into `C:\Windows\System32\`.
3. **cloudflared**: https://github.com/cloudflare/cloudflared/releases → download
   `cloudflared-windows-amd64.msi` → install.

Close and reopen PowerShell so the new tools are on the path. Check:

```powershell
node -v          # v22.x
nssm version     # prints a version
cloudflared --version
```

### 2.2 Get the code and install the service

Download the repository (it is public; nothing secret is in it):

```powershell
cd $env:USERPROFILE\Downloads
Invoke-WebRequest https://github.com/ariavasulin/OpenReimbursements/archive/refs/heads/main.zip -OutFile OpenReimbursements.zip
Expand-Archive OpenReimbursements.zip -Force
cd OpenReimbursements\OpenReimbursements-main\shop-bridge
```

(If Git is installed, `git clone https://github.com/ariavasulin/OpenReimbursements.git`
and `cd OpenReimbursements\shop-bridge` does the same.)

Until the `shop-db-bridge` branch is merged, replace `main` in the URL with `shop-db-bridge`
(the unzipped folder is then `OpenReimbursements-shop-db-bridge`).

Run the installer. It asks for each value from the checklist, writes them to
`C:\dws-bridge\.env` with permissions limited to administrators and the service account,
installs the `dws-bridge` Windows service, starts it, and checks it:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install\setup.ps1
```

The last line should be a health report with `"ok": true` and the SQL Server version. If
it says the database is unreachable, the login or the network step in Part 1.6 is the
problem; `C:\dws-bridge\logs\` has the exact error.

### 2.3 Connect the tunnel

Paste the install command from Part 1.2, then start the service:

```powershell
cloudflared.exe service install <token from the command>
Start-Service cloudflared
Get-Service cloudflared, dws-bridge
```

Both should show `Running`. In the Cloudflare dashboard the tunnel turns "Healthy"
within a minute.

### 2.4 Confirm, then reboot once

Watch the first mirror run in the log (it starts right after the service starts):

```powershell
Get-Content C:\dws-bridge\logs\bridge.log -Tail 20
```

You want one `mirror` line per table with `ok=true` and a row count, then a
`refresh_jobs` line. Then restart the computer and run `Get-Service cloudflared,
dws-bridge` again: both `Running`. The shop visit is done.

## Part 3: from your laptop and Vercel

### 3.1 Prove the lock from the laptop

Put the four values in `dws-app/.env.local` (never in a committed file):

```
SHOP_BRIDGE_URL=https://shop.<domain>
SHOP_BRIDGE_TOKEN=...
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
```

Then, from `dws-app/`:

```sh
# 1. No Cloudflare token at all: must be blocked at the edge (403 or a redirect), and
#    the shop log must show nothing for it.
curl -sS -o /dev/null -w '%{http_code}\n' https://shop.<domain>/health

# 2. Cloudflare token but wrong bearer: the bridge answers 401.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://shop.<domain>/query \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Authorization: Bearer wrong' -H 'content-type: application/json' -d '{"sql":"select 1 as ok"}'

# 3. Both: rows come back.
node --env-file=.env.local scripts/shop-query.mjs --health
node --env-file=.env.local scripts/shop-query.mjs "select top 5 ProjectID, Project from tblProject order by ProjectID desc"
```

### 3.2 Check the mirror in Supabase

In the dashboard SQL editor:

```sql
select table_name, finished_at, row_count, ok, left(error, 80) as error
from shop.sync_runs order by finished_at desc limit 12;

select count(*) filter (where synced_at > now() - interval '1 hour') as refreshed_last_hour
from public.jobs;
```

### 3.3 Vercel

Project `dws-receipts` → Settings → Environment Variables → add the same four values
for Production and Preview. Redeploy. Then, signed in as an admin, open
`https://photos.design-workshops.app/api/shop/health`: `bridge.ok` is `true` and
`mirror` lists each table with its age in seconds.

## Using it

In server-side code:

```ts
import { shopQuery } from '@/lib/shop/query';

const open = await shopQuery<{ ProjectID: number; Project: string }>(
  'select ProjectID, Project from tblProject where Completed is null and ProjectID > @since',
  { since: 3600 },
);
```

Parameters use SQL Server's `@name` form and are sent separately, so values are never
pasted into the SQL. Only one `SELECT` (or `WITH ... SELECT`) per call; no `;`. Results
are capped at 5,000 rows unless `maxRows` is raised (hard cap 50,000); a query past
30 seconds is cancelled.

From the laptop, `scripts/shop-query.mjs` (examples in its header) prints a table, or
`--json` for rows. Anything the apps need every day should come from the mirror
(`shop.*` tables, service role only) rather than a live query, so a shop outage never
reaches a user.

## Adding a table to the mirror

1. Get the migration SQL through the bridge, from `dws-app/`:
   `node --env-file=.env.local scripts/shop-query.mjs --ddl tblPM`
2. Paste it into a new migration `dws-app/supabase/migrations/<UTC timestamp>_shop_table_tblpm.sql`,
   add the grants (`grant select, insert, delete on shop."tblPM" to shop_mirror; grant all on shop."tblPM" to service_role;`), and apply it like any migration.
3. Add the name to `shop-bridge/mirror.config.json` in the repository, and to
   `C:\dws-bridge\mirror.config.json` on the shop computer, then
   `Restart-Service dws-bridge`. The table fills on the next run.

Keep the list to small tables. `tblTimesheet` (about 290,000 rows) does not belong in a
whole-table copy every 15 minutes.

## Rotating a secret

| Secret | How |
| --- | --- |
| Cloudflare service token | Zero Trust → Access → Service Auth → create a new token, add it to the `service-only` policy, update Vercel and `.env.local`, then delete the old token. Nothing changes on the shop computer. |
| `SHOP_BRIDGE_TOKEN` | New `openssl rand -hex 32`; update `C:\dws-bridge\.env` and `Restart-Service dws-bridge`; update Vercel and `.env.local`. |
| `shop_mirror` password | `alter role shop_mirror password '...'`; update `SHOP_MIRROR_DATABASE_URL` in `C:\dws-bridge\.env`; restart the service. |
| SQL Server login | Admin changes it; update `C:\dws-bridge\.env`; restart the service. |

## When something is wrong

| Symptom | Where to look |
| --- | --- |
| `/api/shop/health` says `edge_blocked` (403) | The Cloudflare service token expired or the Access policy changed. Rotate per the table above. |
| `unreachable` or `timeout` from the health route, tunnel "Down" in Cloudflare | The shop computer is off, offline, or `cloudflared` stopped. On it: `Get-Service cloudflared`; `Start-Service cloudflared`. |
| Tunnel healthy but bridge errors `db_unreachable` | SQL Server is down or the login changed. `C:\dws-bridge\logs\` has the driver's message. `sqlcmd -S SQL2016\SQLEXPRESS -d DWS -U dws_bridge_ro -Q "select 1"` from the bridge computer isolates it. |
| Mirror age keeps growing, bridge fine | The Supabase side: wrong `SHOP_MIRROR_DATABASE_URL`, rotated password, or a table changed shape in SQL Server. `select * from shop.sync_runs where ok = false order by finished_at desc limit 5` shows the error. A schema change needs a new migration (see "Adding a table") for the changed columns. |
| A query returns `not_read_only` | The SQL contains something other than one `SELECT`: a `;`, an `INTO`, a write keyword. Rewrite it. |
| `public.jobs` missing a new office job | Is it open in both `tblProject` (`Completed` null, not archived) and `tblMas90JobMasterOpen` (status `O`)? The refresh requires both, as the old CSV import did. `select detail from shop.sync_runs where table_name = 'public.jobs' order by finished_at desc limit 1` shows what the last run saw. |

The service never deactivates a job in `public.jobs`. Jobs that left the office's open
list are recorded in `detail.dropped_from_open` of the `public.jobs` sync row; what to do
with them is still an open decision.

## What lives where

| Thing | Place |
| --- | --- |
| Service code | `shop-bridge/` in this repository |
| Installed copy, config, secrets, logs | `C:\dws-bridge\` on the shop computer (`.env`, `mirror.config.json`, `logs\`) |
| Windows services | `dws-bridge` (NSSM), `cloudflared` |
| Tunnel, hostname, Access policy, service token | Cloudflare Zero Trust |
| Mirror tables and run log | Supabase, schema `shop`; function `public.shop_sync_status()` for the health route |
| App client and CLI | `dws-app/src/lib/shop/query.ts`, `dws-app/scripts/shop-query.mjs` |
| Admin health | `GET /api/shop/health` |
