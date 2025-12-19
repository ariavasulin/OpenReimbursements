# Admin Features

[[README|← Back to Index]]

## Overview

Admins access three main areas:
- **Dashboard** (`/dashboard`) - Receipt management
- **Batch Review** (`/batch-review`) - Rapid approval workflow
- **Users** (`/users`) - User management

## Dashboard

### Access

Route: `/dashboard`

Auth: Admin role required (redirects employees to `/employee`)

### Features

| Feature | Description |
|---------|-------------|
| View All Receipts | See receipts from all employees |
| Filter by Status | Tabs: All, Pending, Approved, Reimbursed, Rejected |
| Date Range Filter | Filter by receipt date |
| Search | Search employee name or description |
| Edit Any Receipt | Change date, amount, category, notes, status |
| Delete Any Receipt | Remove receipt and image |
| Bulk Reimburse | Mark all approved as reimbursed |
| Export CSV | Download payroll totals |

### Summary Cards

Dashboard shows 4 stat cards:
- **Total Receipts**: Count and total amount
- **Pending Review**: Count and percentage
- **Approved**: Count and percentage
- **Reimbursed**: Count and percentage

### Bulk Reimburse Flow

```
1. Click "Reimburse" button
2. System counts all approved receipts
3. Confirmation dialog shows count
4. Confirm → PUT /api/receipts/bulk-update
5. All approved → reimbursed
```

**Important**: Affects ALL approved receipts globally, not just filtered ones.

### CSV Export

Exports payroll-ready totals grouped by employee:

```csv
LastName,FirstName,EmployeeNumber,TotalAmount
Doe,John,EMP123,150.00
Smith,Jane,EMP456,275.50
```

- Uses `filteredReceipts` (respects current filters)
- Groups by `employee_id_internal`
- Sums amounts per employee

### Key Files

| File | Purpose |
|------|---------|
| `app/dashboard/page.tsx` | Auth protection |
| `components/receipt-dashboard.tsx` | Dashboard UI |
| `components/receipt-table.tsx` | Receipt table |
| `hooks/use-admin-receipts.ts` | Data fetching |

---

## Batch Review

### Access

Route: `/batch-review`

Auth: Admin role required

### Purpose

Rapid approval workflow for reviewing pending receipts one at a time.

### Flow

```
1. Load all pending receipts
2. Display one receipt at a time
3. Admin clicks Approve or Reject
4. Navigate to next receipt
5. After all reviewed, submit decisions
```

### UI Layout

| Panel | Content |
|-------|---------|
| Left | Receipt details (date, amount, category, employee) |
| Right | Receipt image |
| Bottom | Navigation dots showing progress |

### Navigation

- **Previous/Next**: Move between receipts
- **Dots**: Click to jump to any receipt
- **Color coding**: Blue (current), Green (decided), Gray (undecided)

### Decision States

Decisions stored locally until submission:

```typescript
{
  "receipt-id-1": "approved",
  "receipt-id-2": "rejected",
  // ...
}
```

### Completion Screen

After reviewing all receipts:
- Shows summary (X approved, Y rejected)
- "Review My Decisions" - go back and change
- "Submit X Decisions" - finalize

### Submission

Submits all decisions in parallel:

```typescript
await Promise.all(
  Object.entries(decisions).map(([id, status]) =>
    supabase.from('receipts').update({ status }).eq('id', id)
  )
);
```

### Key Files

| File | Purpose |
|------|---------|
| `app/batch-review/page.tsx` | Auth protection |
| `components/batch-review-dashboard.tsx` | Batch review UI |

---

## User Management

### Access

Route: `/users`

Auth: Admin role required

### Features

| Feature | Description |
|---------|-------------|
| List Users | Paginated user list with search |
| Create User | Add new employee or admin |
| Edit User | Update name, phone, role |
| Ban User | Soft delete (100-year ban) |

### Create User

Required fields:
- Phone number (10-digit US)
- Full name

Optional fields:
- Preferred name
- Employee ID
- Role (defaults to employee)

### Edit User

Can change:
- Phone number (triggers global sign out)
- Full name / Preferred name
- Employee ID
- Role (employee ↔ admin)

### Ban User

- Sets `banned_until` to ~100 years
- Sets `deleted_at` in user_profiles
- Signs out user globally
- Cannot ban yourself

### Key Files

| File | Purpose |
|------|---------|
| `app/users/page.tsx` | Auth protection |
| `components/user-management-dashboard.tsx` | User management UI |
| `components/user-table.tsx` | User list |
| `components/user-form-modal.tsx` | Create/edit form |
| `components/ban-user-dialog.tsx` | Ban confirmation |

---

## Admin API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/receipts` | GET | All receipts with phone |
| `/api/admin/users` | GET | User list |
| `/api/admin/users` | POST | Create user |
| `/api/admin/users/[id]` | GET | Single user |
| `/api/admin/users/[id]` | PATCH | Update user |
| `/api/admin/users/[id]` | DELETE | Ban user |
| `/api/receipts/bulk-update` | PUT | Bulk reimburse |

All admin endpoints verify:
1. Valid session exists
2. User role is `admin`

## Related Pages

- [[API]] - Endpoint details
- [[Authentication]] - Access control
- [[Receipts]] - Receipt status lifecycle
