# DWS Receipts

Receipt management app for Design Workshops employees and accounting staff. Employees submit receipts via mobile with OCR auto-fill. Admins review, approve, and export for reimbursement.

## Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript
- **Database/Auth/Storage**: Supabase (Postgres, SMS OTP auth via Twilio, file storage)
- **UI**: shadcn/ui + Tailwind CSS 4 + Lucide icons
- **OCR**: Google Cloud Vision API

## Project Structure

All application code is in `dws-app/`:

```
dws-app/src/
├── app/           # Pages and API routes
│   ├── api/       # Backend endpoints (auth, receipts, categories, admin)
│   ├── login/     # Phone OTP login
│   ├── employee/  # Employee receipt submission
│   ├── dashboard/ # Admin receipt management
│   └── batch-review/  # Admin batch approval UI
├── components/    # React components (ui/ has shadcn components)
└── lib/           # Supabase clients, types, utils
```

## Development

```bash
cd dws-app
npm run dev      # Start dev server (Turbopack)
npm run build    # Production build
npm run lint     # ESLint
```

## Key Patterns

- **Auth**: SMS OTP login. Role-based routing: employees → `/employee`, admins → `/dashboard`
- **Receipts**: Two-phase upload (temp storage → OCR → final storage with receipt record)
- **Database**: `receipts`, `categories`, `user_profiles` tables with RLS policies
- **Status values**: Capitalized in DB ("Pending", "Approved", "Rejected", "Reimbursed")

## Linear Integration

- **Workspace**: ariav
- **Team ID**: ARI (ticket prefix: ARI-XXX)
- **Project**: DWS (DWS Receipts)
- **Config**: See `.linear.toml` for CLI settings

## Detailed Documentation

For comprehensive implementation details, see:
- `.cursorrules` - Full architecture, schema, API patterns, security
- `Docs/PRD.md` - Product requirements
- `dws-app/src/lib/types.ts` - TypeScript interfaces
