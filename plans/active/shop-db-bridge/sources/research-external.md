# External facts (web research, 2026-10-17)

Gathered by a research agent from vendor docs. Each line names its source.

## SQL Server Express

- No SQL Server Agent in Express, so no built-in job scheduler.
  https://learn.microsoft.com/en-us/sql/sql-server/editions-and-components-of-sql-server-2022
- TCP/IP is disabled on a fresh Express install; enable it in SQL Server Configuration
  Manager, then restart the service (and SQL Browser for a named instance).
  https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/enable-or-disable-a-server-network-protocol
- Named instances (`SQLEXPRESS`) use a dynamic port unless pinned; clients find them
  via SQL Browser (UDP 1434) or an explicit port.
  https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/configure-a-server-to-listen-on-a-specific-tcp-port
- 10 GB per-database cap (2019/2022), 50 GB in 2025.
- Support: SQL Server 2016 extended support ended 2026-07-14; 2019 extended ends
  2030-01-08; 2022 ends 2033-01-11. https://learn.microsoft.com/en-us/lifecycle/products/
- Read-only login: `db_datareader` (optionally plus `db_denydatawriter`), or
  `GRANT SELECT ON SCHEMA::<views schema>` for a narrower surface.
  https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/database-level-roles
- Express setup adds a `BUILTIN\Users` login; it can be removed safely.

## Supabase SQL Server wrapper

- Exists, read-only, pushes down where/order/limit and simple aggregates.
  https://supabase.com/docs/guides/database/extensions/wrappers/mssql
- Runs inside the hosted Postgres, so SQL Server would need to be reachable from the
  internet. Supabase publishes no outbound IP to allowlist. Not a fit for a LAN-only server.

## Cloudflare Tunnel

- Outbound-only connections; no inbound listener on the origin.
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Windows service: `cloudflared.exe service install`; config and credentials under
  `C:\Windows\System32\config\systemprofile\.cloudflared`.
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/
- Server-to-server auth: an Access service token sent as `CF-Access-Client-Id` and
  `CF-Access-Client-Secret`; the Access policy action is "Service Auth". The secret is
  shown once; tokens expire after the chosen duration.
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Raw TCP (port 1433) through the tunnel needs `cloudflared` on the client too, which a
  Vercel function cannot run. So the tunnel fronts an HTTP service, not the SQL port.
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/
- Free Zero Trust plan covers up to 50 users. A tunnel hostname needs a domain in a
  Cloudflare zone. (DNS for `design-workshops.app` is at Vercel as of 2026-10-17:
  `dig NS` returns `ns1/ns2.vercel-dns.com`.)

## Tailscale

- Windows unattended mode is supported. https://tailscale.com/kb/1088/run-unattended
- Vercel is not on Tailscale's serverless list, and there is no supported way for a
  Node Vercel function to join a tailnet. https://tailscale.com/docs/integration-serverless-apps
- Tailscale Funnel can publish an HTTPS endpoint on a `*.ts.net` name without a domain;
  authentication is then entirely the service's own token check.

## Vercel Cron

- Configured in `vercel.json` `crons`. Hobby: once per day at most, may fire up to 59
  minutes late. Pro: once per minute. Delivery is best effort (missed or duplicate runs
  possible); make jobs idempotent. `CRON_SECRET` arrives as `Authorization: Bearer`.
  https://vercel.com/docs/cron-jobs/usage-and-pricing

## Drivers and connections

- Node `mssql` (tedious): TCP only, `encrypt` defaults to true, `trustServerCertificate`
  for self-signed; supports SQL logins and NTLM (Windows account) authentication.
  https://github.com/tediousjs/node-mssql
- Supabase pooler: session mode on 5432 for long-lived IPv4 clients, transaction mode on
  6543 for serverless. https://supabase.com/docs/guides/database/connecting-to-postgres
