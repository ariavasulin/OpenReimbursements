# Shop bridge

The service that copies the office's job and contact lists from the shop's SQL Server
into Supabase, and everything about it (what it is, how it stays secure, the list of
statements it runs, setup, day-to-day operation, troubleshooting), is documented in one
place, next to its code:

[`shop-bridge/README.md`](https://github.com/ariavasulin/OpenReimbursements/blob/main/shop-bridge/README.md)

The app-side pieces are `dws-app/src/lib/shop/query.ts` (server code),
`dws-app/scripts/shop-query.mjs` (laptop CLI), and the admin route `/api/shop/health`.
The four environment variables they use are listed in [Configuration](Configuration.md).
