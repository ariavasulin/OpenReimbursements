# The shop database bridge, explained for the database administrator

This document is for the person who looks after the shop's SQL Server. It explains what
we want to run, how it touches your server, why it cannot write to it, how the outside
world reaches it without opening anything on your network, and how you can watch it or
shut it off. It assumes you know SQL Server and Access well and have not used Cloudflare
or hosted databases before. Nothing here requires you to.

## The short version

- We want the company's two web apps (the receipts app and the job-photos app) to see
  the office's job and contact lists, which live only in the `DWS` database on
  `SQL2016\SQLEXPRESS`.
- One small program will run on an always-on Windows computer in the shop. It connects
  to SQL Server the same way an Access workstation does, with its own login that you
  create and that can only read.
- Every 15 minutes it copies five small tables out to the apps' hosted database. It can
  also answer a single `SELECT` on request. That is all it does.
- It never writes to `DWS`, never changes anything in SQL Server, never needs `sa`, and
  nothing is opened on your firewall or router. The shop computer only makes outbound
  connections, the same kind a web browser makes.
- You keep a kill switch: disable the login, or stop the service, and it is over.

## What we are asking you for

One thing: a login on the instance that can read `DWS` and nothing else. If the
instance allows SQL logins ("mixed mode"), this is the whole request:

```sql
USE [master];
CREATE LOGIN dws_bridge_ro WITH PASSWORD = '<strong password>', CHECK_POLICY = ON;
USE [DWS];
CREATE USER dws_bridge_ro FOR LOGIN dws_bridge_ro;
ALTER ROLE db_datareader ADD MEMBER dws_bridge_ro;
ALTER ROLE db_denydatawriter ADD MEMBER dws_bridge_ro;
```

If the instance is Windows-authentication only, a Windows account with the same two
database roles does the same job. `db_denydatawriter` is belt and braces: even a
`db_datareader` cannot write, but an explicit deny wins over any grant that might be
added by accident later.

We would also like to know that the instance accepts TCP connections from another
computer on the LAN. It already does if the Access front end on the workstations links
to `SQL2016\SQLEXPRESS` over ODBC, which is how the office works today. No change is
expected.

You do not need to install anything, change any setting, or touch Access.

## What will run in the shop

Two Windows services on one always-on computer. It can be the SQL Server host itself
or any other PC that stays on. Both are ordinary services in `services.msc`, start at
boot, and restart if they crash.

**`dws-bridge`**, our program. About 500 lines of readable JavaScript, run by Node.js
(the same runtime many Windows desktop tools ship with). It runs as the built-in
low-privilege `NetworkService` account, not as an administrator. Its folder is
`C:\dws-bridge\`; the file with its passwords is readable only by administrators and that
service account. It writes a plain text log to `C:\dws-bridge\logs\bridge.log`.

**`cloudflared`**, Cloudflare's connector. This is what lets the apps reach our program
without any inbound opening. It is explained in its own section below.

What is **not** installed: nothing inside SQL Server. No linked server, no SQL Agent
job, no trigger, no stored procedure, no CLR assembly, no extended procedure, no change
to any table, no change to the Access database.

## How it talks to your server

Exactly like one more Access user. It opens a normal client connection over the LAN
to `SQL2016\SQLEXPRESS` (using SQL Browser to find the instance, like ODBC does), logs
in as `dws_bridge_ro`, and runs `SELECT` statements. The connection is encrypted with
TLS. It keeps at most four connections open and closes idle ones after 30 seconds. It
identifies itself to SQL Server with the application name `dws-bridge`, so you can see
it:

```sql
SELECT session_id, login_name, host_name, program_name, login_time, status
FROM sys.dm_exec_sessions
WHERE program_name = 'dws-bridge';
```

Every query it runs has a 30-second limit and is cancelled past that. Live queries
return at most 5,000 rows by default and can never exceed 50,000.

### The 15-minute copy

Every 15 minutes it runs `SELECT *` on each of these five tables and sends the rows to
the apps' database:

| Table | Why the apps need it |
| --- | --- |
| `tblProject` | the job list (number, name, status) |
| `tblLocation` | job site names and addresses |
| `tblMas90JobMasterOpen` | which jobs are open in accounting |
| `tblContact` | the employee list, including phone numbers, which the apps use for login |
| `tblHardware` | hardware catalogue |

These are small tables. A copy is a few thousand rows and takes seconds, about the
load of a user opening those tables in Access. Large tables such as `tblTimesheet` are
deliberately not copied. Adding a table later is a decision made with you, not a
setting someone can flip quietly: it needs a code change on our side and, for anything
large, a different approach than a whole-table copy.

The owner has approved this data leaving the shop, including phone numbers.

## How the outside reaches it without opening a door

This is the part that usually sounds alarming, so here it is step by step.

The usual way to let something on the internet reach a program in an office is to open
a port on the firewall and forward it to the machine. We are not doing that. Nothing
on the internet can connect to the shop computer, and no port, forward, or firewall
rule is added anywhere in the shop.

Instead, the shop computer connects outward. The `cloudflared` service opens an
outbound HTTPS connection to Cloudflare (a large internet infrastructure company) and
keeps it open. Think of it as the shop phoning a receptionist and staying on the line.
When one of our apps wants to ask the shop a question, it calls the receptionist. If,
and only if, the caller shows the right credentials, the receptionist passes the
question down the line that the shop already opened, and passes the answer back.

Consequences that matter to you:

- The shop computer has no public address. Scanning the shop's internet connection
  shows nothing new.
- The shop's router and firewall are untouched. The connection is outbound on port 443,
  the same as every web browser in the building.
- Our program listens only on the computer it runs on (`127.0.0.1`). Even another PC
  in the shop cannot connect to it directly.
- If the tunnel is stopped or the computer is off, the outside simply cannot reach the
  program. There is no fallback path.

The hostname the apps use is on a small domain we registered only for this purpose.
It resolves to Cloudflare, never to the shop.

## The four locks between the internet and `DWS`

A request from outside must pass all four. Each works even if the others fail.

| Lock | Where it lives | What it stops |
| --- | --- | --- |
| 1. Cloudflare Access | Cloudflare's edge, before anything reaches the shop | Any caller without our service token is rejected by Cloudflare. The shop never sees the request, and it never appears in our log. |
| 2. Bridge token | Our program | A second secret, checked by our code. A caller holding only the Cloudflare token gets `401`. |
| 3. SELECT-only guard | Our program | The SQL text must be one `SELECT` (or `WITH ... SELECT`). No semicolons, no `INSERT`/`UPDATE`/`DELETE`/`EXEC`/`DROP`/`ALTER`/`BACKUP`/`xp_`/`sp_` and so on, even inside comments. Values are passed as parameters, never pasted into the SQL. |
| 4. Your read-only login | SQL Server | `db_datareader` plus `db_denydatawriter`. If every lock above were beaten, the attacker could still only read `DWS`. |

Lock 4 is yours and is the one that truly matters. The others reduce who can read; lock
4 guarantees nobody can write, no matter what the program does or how it is attacked.

What a worst case looks like: if someone stole both secrets from our hosting provider,
they could run `SELECT` statements against `DWS` through the tunnel, limited to 50,000
rows and 30 seconds each, visible in our log and in your session list, until we rotate
a token (a few minutes) or you disable the login (one statement). They could not
change a row, create anything, reach other databases, or reach other machines.

## Where the copied data goes and who can see it

The copy lands in Supabase, a hosted PostgreSQL service the apps already use, in
Amazon's Ohio region, over an encrypted connection. The shop computer logs in there
with its own dedicated account that can only write into one area (`shop` schema) and
cannot read the apps' own tables. The apps' browser-side keys cannot read the copied
tables at all; only the apps' server code and the admins can.

The shop computer never holds any master key for the apps, and the apps never hold the
SQL Server password. Each side has exactly the credential it needs.

## What happens when something breaks

In every case the office keeps working, because nothing in the office depends on this.
Access, SQL Server, and accounting carry on exactly as before.

| Failure | Effect on the shop | Effect on the apps |
| --- | --- | --- |
| SQL Server is down or restarting | none from us; we are a client that fails to connect and retries next time | apps keep using the last copy; a live query returns "database unreachable" |
| The bridge computer is off | none | same as above; the health page shows the tunnel down |
| The shop's internet is down | none | same; the copy resumes when it returns |
| Cloudflare or Supabase has an outage | none | apps show older data until it passes |
| A query is slow | cancelled at 30 seconds | the caller gets a timeout error |
| Our program crashes | Windows restarts it; the log has the reason | a gap of seconds |

The program never deletes or deactivates anything in the apps based on a missing row,
so a bad copy cannot cascade into lost data on the apps' side either. Each copy is
written as a transaction: readers see the old copy or the new one, never half.

## Your kill switches

Any one of these stops everything, immediately, with no help from us:

1. In SQL Server: `ALTER LOGIN dws_bridge_ro DISABLE;` (or drop it).
2. On the shop computer: `Stop-Service dws-bridge` (and `Stop-Service cloudflared` to
   close the tunnel as well).
3. Pull the computer's network cable or turn it off.

To remove it entirely: `C:\dws-bridge\install\uninstall.ps1` removes the service and
folder, and `cloudflared service uninstall` removes the connector. Nothing is left in
SQL Server except the login you created.

## What you can watch

- **SQL Server**: the login `dws_bridge_ro` appears in the error log on each connection
  if login auditing is on, and the query above lists its live sessions at any time. It
  will show the shop computer's host name and `program_name = 'dws-bridge'`.
- **The log file**: `C:\dws-bridge\logs\bridge.log` records every copy run (table, row
  count, duration, success or the exact error) and every live query (the first 80
  characters of the statement, how many rows, how long, and the result code). Rejected
  requests appear with the code that rejected them (`401` wrong token, `400` not a
  plain `SELECT`).
- **The copy history**: our side keeps a run log with the same information, and the
  apps' admin page shows how old each copied table is. We will be glad to show it to
  you.

## What we will never do without asking you

- Write to `DWS`, in any form.
- Ask for `sa`, `sysadmin`, `db_owner`, or any login beyond read on `DWS`.
- Change a table, index, procedure, setting, or anything else in SQL Server.
- Touch the Access front end, the backups, or the accounting system.
- Add a table to the copy, change the schedule, or open anything inbound.
- Install anything on the SQL Server host beyond the two services, and only if that is
  the computer you prefer.

## The parts and where they come from

| Part | Who makes it | Role |
| --- | --- | --- |
| Node.js | OpenJS Foundation (open source) | runs our program |
| `mssql` with `tedious` | open source; `tedious` is the TDS driver Microsoft maintains for Node.js | the SQL Server client, like an ODBC driver |
| `cloudflared` | Cloudflare | the outbound tunnel connector |
| NSSM | open source | wraps our program as a Windows service |
| `dws-bridge` | us, about 500 lines, with 67 automated tests | the program itself; the source is public and you are welcome to read it |

## Questions you may be about to ask

**Is my SQL Server reachable from the internet?** No. Nothing can connect inward. The
only path to it is from our program, on the LAN, with your read-only login.

**Could someone use this to get into the shop network?** The program accepts one kind
of request: a `SELECT` for SQL Server. It cannot run commands, open files, or forward
connections. Even if it were fully compromised, it runs as `NetworkService`, a
low-privilege account, on a computer that holds only a read-only database login.

**Why not a VPN?** The apps run at a hosting provider that cannot join a VPN. A tunnel
that the shop opens outward is the standard way to reach a private service from such
hosting, and it exposes less than a VPN would, since only one program is reachable
rather than the network.

**Why a copy every 15 minutes instead of live queries?** So a shop outage, a reboot, or
a slow network never reaches the apps' users, and so the load on your server is a
handful of small reads a day rather than one per page view.

**Does it slow my server down?** Five small table reads every 15 minutes and the odd
live query, each capped at 30 seconds. It is less than one user working in Access.

**Can it run while month-end or a backup is happening?** Yes; it is a reader with short
queries. If you would rather it paused at certain times, stopping the service is one
command, and starting it again is another.

**What if the computer it runs on gets a virus?** The attacker would gain a read-only
login to `DWS`, nothing more. Disable the login and the exposure ends. The computer
holds no credential that reaches anything else in the shop.

**Who do I call?** Ari, who maintains the apps. The log file on the computer is the
first thing we will ask for.

## Before you say yes: a checklist

- [ ] You have read the four locks and agree the login (lock 4) is one you control.
- [ ] You are comfortable with the five tables leaving the shop, as the owner has approved.
- [ ] You know the three kill switches.
- [ ] You have chosen which computer it runs on.
- [ ] You have created `dws_bridge_ro` (or the Windows account) with read-only roles on `DWS`.
