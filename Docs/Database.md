# Database

[[README|← Back to Index]]

## Overview

DWS Receipts uses Supabase (Postgres) with three tables, Row Level Security, and three client configurations for different access levels.

## Supabase Clients

### Browser Client

For client-side React components.

```typescript
// lib/supabaseClient.ts
import { createBrowserClient } from '@supabase/ssr';

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

### Server Client

For API routes with cookie-based auth.

```typescript
// lib/supabaseServerClient.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: { get, set, remove }  // Cookie handlers
  });
}
```

Session extended to 6 months via custom cookie options.

### Admin Client

For privileged operations bypassing RLS.

```typescript
// lib/supabaseAdminClient.ts
import 'server-only';  // Prevents client-side import
import { createClient } from '@supabase/supabase-js';

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
```

## Tables

### receipts

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK → auth.users |
| receipt_date | date | Receipt date |
| amount | numeric | Dollar amount |
| status | text | Pending/Approved/Rejected/Reimbursed |
| category_id | uuid | FK → categories |
| description | text | User notes |
| image_url | text | Storage path |
| created_at | timestamp | Auto-generated |
| updated_at | timestamp | Auto-updated |

**RLS**: Enabled. Policies (`receipts_select`/`insert`/`update`/`delete`) allow a row when `user_id = auth.uid() OR public.is_admin()` — owners see/modify only their own rows; admins see/modify all. Defined in `dws-app/supabase/migrations/00000000000002_enable_rls_receipts_categories.sql`; `20260822130000_rls_scalar_subqueries.sql` rewrote the same predicates as `(select auth.uid())` / `(select public.is_admin())` so Postgres evaluates them once per statement instead of once per row.

### categories

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Category name (unique) |
| created_at | timestamp | Auto-generated |

**RLS**: Enabled — authenticated read, admin write. `categories_select` allows `SELECT` to any `authenticated` user; `categories_insert`/`update`/`delete` require `public.is_admin()`. See `dws-app/supabase/migrations/00000000000002_enable_rls_receipts_categories.sql`.

**Default Categories**: Parking, Gas, Meals & Entertainment, Office Supplies, Other

### user_profiles

| Column | Type | Description |
|--------|------|-------------|
| user_id | uuid | PK, FK → auth.users |
| role | text | 'employee' or 'admin' |
| full_name | text | Full name |
| preferred_name | text | Display name |
| employee_id_internal | text | Internal ID |
| created_at | timestamp | Auto-generated |
| updated_at | timestamp | Auto-updated |
| deleted_at | timestamp | Soft delete |

**RLS**: Enabled — a user may update only the row where `user_id = auth.uid()`.
Reads are broader than that: two permissive SELECT policies are live
(`"Users can view their own profile"`, `auth.uid() = user_id`, and
`user_profiles_select_policy`, `auth.uid() is not null`), and permissive
policies OR together, so any authenticated user can read every profile row.

**Column grants**: RLS says *which row*; grants say *which columns*. The
`authenticated` role holds `UPDATE` on `full_name` only
(`dws-app/supabase/migrations/20260823100000_review_fixes.sql`). With the
table-wide grant it used to have, any employee could `PATCH` their own row to
`{"role":"admin"}` through PostgREST and `is_admin()` would start returning
true. `role`, `employee_id_internal`, and `deleted_at` are writable only by the
admin API routes, which use the service-role key.

## TypeScript Types

```typescript
// lib/types.ts
interface Receipt {
  id: string;
  user_id?: string;
  employeeName: string;      // Derived from profile
  employeeId: string;        // Derived from profile
  phone?: string;            // From auth.users
  date: string;              // Frontend field
  receipt_date?: string;     // Database field
  amount: number;
  status: "Pending" | "Approved" | "Rejected" | "Reimbursed";
  category_id?: string;
  category?: string;         // Display name from join
  description?: string;
  notes?: string;            // Alias for description
  image_url?: string;
}

interface UserProfile {
  user_id: string;
  role: 'employee' | 'admin';
  full_name?: string;
  preferred_name?: string;
  employee_id_internal?: string;
}

interface Category {
  id: string;
  name: string;
}
```

## RLS Bypass

For admin operations needing phone numbers (in auth.users):

```sql
-- Postgres RPC function
CREATE FUNCTION get_admin_receipts_with_phone(...)
RETURNS TABLE(...)
SECURITY DEFINER  -- Runs with elevated privileges
AS $$
  SELECT r.*, au.phone
  FROM receipts r
  JOIN auth.users au ON r.user_id = au.id
  ...
$$;
```

Called via: `supabase.rpc('get_admin_receipts_with_phone', { ... })` — the
payroll CSV export (`GET /api/admin/receipts/export`), which needs the whole
result set.

### get_admin_receipts_page(status_filter, from_date, to_date, page_num, page_size)

The paginated sibling used by `GET /api/admin/receipts`. Same columns and
filters, plus one bounded page and `total_count` / `total_amount` over the whole
filtered set, so the dashboard needs no second counting query. `SECURITY
DEFINER` for the `auth.users` join, and it raises `not authorized` unless
`public.is_admin()` — the API route's admin gate does not protect the function
from a direct PostgREST call.

A page past the end of the result set returns a single row whose receipt columns
are all `NULL`, carrying the totals; callers skip rows with a null `id`.

### is_admin()

`SECURITY DEFINER` helper used by the `receipts` and `categories` RLS policies to
encode the same admin semantics as the inline `user_profiles.role = 'admin'`
check copy-pasted across the admin API routes. Defined in
`dws-app/supabase/migrations/00000000000002_enable_rls_receipts_categories.sql`.

```sql
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.user_id = auth.uid() AND up.role = 'admin'
  );
$$;
```

`SECURITY DEFINER` so the `user_profiles` lookup is not itself blocked by RLS on
that table; `search_path` is locked to `public` to prevent search-path hijacking.

## Storage

**Bucket**: `receipt-images`

**Path Structure**:
```
{user_id}/temp_{uuid}_{timestamp}.jpg   # Temporary
{user_id}/{receipt_id}.jpg              # Final
```

**Public URL Generation**:
```typescript
const { data } = supabase.storage
  .from('receipt-images')
  .getPublicUrl(image_url);
```

## Common Query Patterns

### Insert with Return

```typescript
const { data, error } = await supabase
  .from('receipts')
  .insert({ user_id, receipt_date, amount, ... })
  .select()
  .single();
```

### Select with Join

```typescript
const { data } = await supabase
  .from('receipts')
  .select(`
    *,
    categories!receipts_category_id_fkey (name)
  `)
  .eq('user_id', userId)
  .order('receipt_date', { ascending: false });
```

### Update with Condition

```typescript
const { data } = await supabase
  .from('receipts')
  .update({ status: 'Approved', updated_at: new Date().toISOString() })
  .eq('id', receiptId)
  .select();
```

## Related Pages

- [[Architecture]] - System overview
- [[API]] - Endpoint reference
- [[Configuration]] - Environment variables
