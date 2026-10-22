# Shop bridge

The shop bridge copies the office's job and contact lists from the shop's SQL Server
into Supabase. Everything about it is in:

[`shop-bridge/README.md`](https://github.com/ariavasulin/OpenReimbursements/blob/main/shop-bridge/README.md)

The app-side pieces are `dws-app/src/lib/shop/query.ts` (server code),
`dws-app/scripts/shop-query.mjs` (laptop CLI), and the admin route `/api/shop/health`.
The four environment variables they use are listed in [Configuration](Configuration.md).
