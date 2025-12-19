# Authentication

[[README|← Back to Index]]

## Overview

DWS Receipts uses Supabase SMS OTP authentication. Users log in with their phone number, receive a 4-digit code via Twilio, and are routed based on their role.

## Login Flow

```
1. User enters phone number
2. POST /api/auth/send-otp → Supabase sends SMS
3. User enters 4-digit code
4. POST /api/auth/verify-otp → Session created
5. Client calls supabase.auth.setSession()
6. Redirect based on role:
   - employee → /employee
   - admin → /dashboard
```

## Key Files

| File | Purpose |
|------|---------|
| `app/login/page.tsx` | Login UI with phone/OTP forms |
| `app/api/auth/send-otp/route.ts` | Sends OTP via Supabase |
| `app/api/auth/verify-otp/route.ts` | Verifies OTP, creates session |
| `app/page.tsx` | Root redirect based on role |
| `lib/phone.ts` | Phone number formatting |

## Phone Number Format

All phones stored in E.164 format: `+12223334444`

```typescript
// lib/phone.ts
formatUSPhoneNumber("5551234567")  // → "+15551234567"
formatPhoneForDisplay("+15551234567")  // → "(555) 123-4567"
```

## Session Management

- **Duration**: 6 months (configured in `supabaseServerClient.ts`)
- **Storage**: HTTP-only cookies (server) + localStorage (browser)
- **Refresh**: Automatic via `@supabase/ssr`

### Cookie Configuration

```typescript
// lib/supabaseServerClient.ts
const SIX_MONTHS_SECONDS = 60 * 60 * 24 * 180;

cookies: {
  maxAge: SIX_MONTHS_SECONDS,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}
```

## Role-Based Routing

Roles stored in `user_profiles.role`: `'employee'` or `'admin'`

### Page Protection Pattern

Each protected page checks auth in `useEffect`:

```typescript
// Simplified pattern used in all protected pages
const { data: { session } } = await supabase.auth.getSession();
if (!session) redirect('/login');

const { data: profile } = await supabase
  .from('user_profiles')
  .select('role')
  .eq('user_id', session.user.id)
  .single();

if (profile.role !== 'admin') redirect('/employee');
```

### Route Access

| Route | Required Role |
|-------|---------------|
| `/login` | None (public) |
| `/employee` | `employee` |
| `/dashboard` | `admin` |
| `/batch-review` | `admin` |
| `/users` | `admin` |

## API Authentication

All API routes verify session:

```typescript
const supabase = await createSupabaseServerClient();
const { data: { session } } = await supabase.auth.getSession();

if (!session) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

Admin endpoints add role check:

```typescript
const { data: profile } = await supabase
  .from('user_profiles')
  .select('role')
  .eq('user_id', session.user.id)
  .single();

if (profile.role !== 'admin') {
  return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
}
```

## Auto-Created Profiles

If a user logs in without a profile, the employee page creates one:

```typescript
// app/employee/page.tsx:158-168
await supabase.from('user_profiles').insert({
  user_id: session.user.id,
  role: 'employee',  // Default role
  full_name: session.user.phone
});
```

## Auth State Listener

Pages subscribe to auth changes to handle logout:

```typescript
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    router.push('/login');
  }
});
```

## Related Pages

- [[Database]] - User profiles table
- [[API]] - Auth endpoints
- [[Admin-Features]] - User management
