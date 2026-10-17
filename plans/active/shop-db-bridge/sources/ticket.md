# Ticket: read the shop database from the web apps

Ari's words, gathered across the 2026-10-16 and 2026-10-17 sessions.

- "a local SQL server that runs only in the shop on-prem"
- "I would set up a computer that I can just keep always on in the shop running as a
  server that has read-only access to the database"
- "we essentially only really need to do reads"
- "primarily to get employee phone numbers and stuff as well as job information
  projects. But you can even make this agnostic"
- "we might end up just making hourly snapshots or essentially ETLing it to the
  Postgres database or adding these as remote columns"
- "figure out an easy way that we can essentially set something up locally at the
  shop that we can connect to securely web-based and have a good developer experience"
- "I can talk to the admin ... I would just give you my credentials or we'd make a new
  service credentials"
- "I don't want to flood you with my opinion on how we should build this ... I'm sure
  you know more about this than I do."
- 2026-10-17: "It's a SQL Express server. Runs locally. We connect to it via Microsoft
  Access or SQL. SQL Express. It's not that deep."
- 2026-10-17: "the idea of this is more of just an agnostic ability. Let's not worry
  about write for now, but we just need a way to essentially read data from this local
  database with decent DX and security that's easy and not too difficult for me to set
  up and maintain."
- 2026-10-17: "I'll be setting it up on a window machine, by the way."
- 2026-10-17: "I was leaning towards just Cloudflare Tunnel. Tailscale will do too
  though. Don't have to overcomplicate it."

Context Ari pointed at: `~/Desktop/dwsTables`, a prior catalog of the shop database
(CSV exports of all 128 tables, the reconstructed Access queries, and a data dictionary).

## 2026-10-17, after the first draft of the plan

- "I'm down for a small throwaway domain for hostname. I'll get the login type later."
- "I think all of this can leave the shop." (on whether phone numbers may leave the shop network)
- "I think the easiest way is we actually just keep a mirror in Postgres of specific
  tables from the database in the shop."
- Picked, when asked: "Tunnel bridge + mirror" over "Mirror only"; mirror freshness
  "Every 15 minutes".
