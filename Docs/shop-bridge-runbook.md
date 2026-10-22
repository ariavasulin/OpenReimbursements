# Shop bridge

The shop bridge copies the office's job and contact lists from the shop's SQL Server
into Supabase. Everything about it is in
[`shop-bridge/README.md`](https://github.com/ariavasulin/OpenReimbursements/blob/main/shop-bridge/README.md).

The app-side pieces are `dws-app/src/lib/shop/query.ts` (server code),
`dws-app/scripts/shop-query.mjs` (laptop CLI), the admin route `/api/shop/health`, and
the admin receipts page's stale-sync warning (`/api/shop/mirror-status`). The bridge
writes into Supabase only through the two functions in
`dws-app/supabase/migrations/20261017100400_shop_mirror_api.sql`.
The four environment variables they use are listed in [Configuration](Configuration.md).
