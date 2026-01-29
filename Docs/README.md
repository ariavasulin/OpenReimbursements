# DWS Receipts

> Receipt management app for Design Workshops employees and accounting staff.

## Quick Navigation

| Area | Description |
|------|-------------|
| [[Architecture]] | System overview, tech stack, project structure |
| [[Authentication]] | SMS OTP login, role-based routing, session management |
| [[Receipts]] | Upload flow, OCR processing, status lifecycle |
| [[Database]] | Supabase setup, tables, RLS policies |
| [[API]] | REST endpoints reference |
| [[Admin-Features]] | Dashboard, batch review, user management |
| [[Employee-Features]] | Mobile receipt submission, OCR auto-fill |
| [[Components]] | UI component library |
| [[Configuration]] | Environment setup, deployment |

## What This App Does

1. **Employees** submit expense receipts via mobile with camera integration
2. **OCR** auto-extracts date, amount, and category from receipt images
3. **Admins** review, approve/reject, and mark as reimbursed
4. **Export** payroll-ready CSV for accounting

## Tech Stack

- **Framework**: Next.js 15 + React 19 + TypeScript
- **Database/Auth/Storage**: Supabase (Postgres, SMS OTP via Twilio)
- **OCR**: BAML + GPT-4.1-nano via OpenRouter
- **UI**: shadcn/ui + Tailwind CSS 4

## Key Flows

```
Employee submits receipt:
  Camera/Upload → Temp Storage → OCR → Auto/Manual Submit → Database

Admin reviews:
  Dashboard → Filter by Status → Approve/Reject → Bulk Reimburse → Export CSV
```

## Changelog

### December 2025
- **OCR Upgrade**: Switched from Google Vision to BAML + GPT-4.1-nano for faster, more accurate extraction
- **Auto-Submit**: Receipts now auto-submit when OCR extracts all required fields
- **Admin User Management**: Full-page UI for managing employees (ARI-15)
- **Performance**: TanStack Query caching for instant tab switching
- **Mobile UX**: Drawer modals and improved layout
- **Receipt Editing**: Edit pending submissions before approval
- **Security**: Next.js 15.3.6 upgrade (CVE-2025-66478)
- **Documentation**: Comprehensive project docs

### November 2025
- Phone number display in admin dashboard

### August 2025
- Feedback form for employee submissions
- Preferred name support in user profiles
- Payroll-formatted CSV export

### July 2025
- Mobile file upload improvements
- Server-side image preprocessing for OCR

### June 2025
- Bulk reimbursement workflow
- Security hardening

### May 2025
- Initial release
- Receipt dashboard and batch review
- OCR integration
- SMS OTP authentication

---

*Last updated: 2025-12-19*
