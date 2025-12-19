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

**RLS**: Enabled. Users can only access their own receipts (unless admin).

### categories

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Category name (unique) |
| created_at | timestamp | Auto-generated |

**RLS**: Disabled (public data).

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

**RLS**: Enabled.

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

Called via: `supabase.rpc('get_admin_receipts_with_phone', { ... })`

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
