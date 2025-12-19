# Architecture

[[README|← Back to Index]]

## System Overview

DWS Receipts is a Next.js 15 App Router application with Supabase backend. The app runs as a single deployment serving both employees and admins with role-based access control.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) + React 19 |
| Language | TypeScript (strict mode) |
| Database | Supabase Postgres |
| Auth | Supabase SMS OTP (Twilio) |
| Storage | Supabase Storage |
| OCR | BAML + GPT-4.1-nano (OpenRouter) |
| UI | shadcn/ui + Tailwind CSS 4 |
| Icons | Lucide React |
| State | TanStack React Query |

## Project Structure

```
dws-app/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/                # API routes
│   │   │   ├── auth/           # OTP endpoints
│   │   │   ├── receipts/       # Receipt CRUD + OCR
│   │   │   ├── admin/          # Admin-only endpoints
│   │   │   └── categories/     # Category lookup
│   │   ├── login/              # Login page
│   │   ├── employee/           # Employee portal
│   │   ├── dashboard/          # Admin dashboard
│   │   ├── batch-review/       # Batch approval UI
│   │   └── users/              # User management
│   ├── components/             # React components
│   │   ├── ui/                 # shadcn/ui primitives
│   │   └── providers/          # Context providers
│   ├── hooks/                  # Custom React hooks
│   └── lib/                    # Utilities & Supabase clients
├── baml_src/                   # BAML AI definitions
└── baml_client/                # Generated BAML client
```

## Request Flow

```
Browser → Next.js API Route → Supabase Client → Postgres
                ↓
         Supabase Storage (images)
                ↓
         BAML → OpenRouter → GPT-4.1-nano (OCR)
```

## Key Patterns

### Three Supabase Clients

| Client | File | Purpose |
|--------|------|---------|
| Browser | `lib/supabaseClient.ts` | Client-side operations |
| Server | `lib/supabaseServerClient.ts` | API routes with cookies |
| Admin | `lib/supabaseAdminClient.ts` | Bypasses RLS |

See [[Database]] for details.

### Two-Phase Upload

Receipt images use temporary storage during OCR, then move to permanent location. See [[Receipts]].

### Role-Based Access

Users have `role` in `user_profiles` table (`employee` or `admin`). See [[Authentication]].

## Related Pages

- [[Database]] - Supabase configuration
- [[API]] - Endpoint reference
- [[Configuration]] - Environment setup
