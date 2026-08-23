# API Reference

[[README|← Back to Index]]

## Overview

All endpoints are Next.js API routes in `app/api/`. Authentication uses Supabase session cookies.

## Authentication Endpoints

### POST /api/auth/send-otp

Sends SMS OTP to phone number.

**Auth**: None (public)

**Request**:
```json
{ "phone": "+12223334444" }
```

**Response**:
```json
{ "success": true, "message": "OTP sent successfully" }
```

**Errors**: 400 (invalid format), 500 (send failed)

---

### POST /api/auth/verify-otp

Verifies OTP and creates session.

**Auth**: None (public)

**Request**:
```json
{ "phone": "+12223334444", "token": "1234" }
```

**Response**:
```json
{
  "success": true,
  "user": { ... },
  "session": { "access_token": "...", "refresh_token": "..." }
}
```

**Errors**: 400 (invalid), 401 (wrong code)

---

## Receipt Endpoints

### POST /api/receipts/upload

Uploads image to temporary storage.

**Auth**: Required

**Request**: `multipart/form-data` with `file` field

**Response**:
```json
{ "success": true, "tempFilePath": "user-id/temp_abc123_1234567890.jpg" }
```

**Errors**: 400 (invalid file), 401 (unauthorized)

---

### POST /api/receipts/ocr

Extracts data from receipt image using AI.

**Auth**: Required

**Request**:
```json
{ "tempFilePath": "user-id/temp_abc123_1234567890.jpg" }
```

**Response**:
```json
{
  "success": true,
  "data": {
    "date": "2025-01-15",
    "amount": 42.99,
    "category": "Office Supplies",
    "category_id": "uuid"
  },
  "duplicate": { "isDuplicate": false, "existingReceipts": [] },
  "canAutoSubmit": true
}
```

---

### POST /api/receipts

Creates receipt record and finalizes image storage.

**Auth**: Required

**Request**:
```json
{
  "receipt_date": "2025-01-15",
  "amount": 42.99,
  "category_id": "uuid",
  "notes": "Office supplies",
  "tempFilePath": "user-id/temp_abc123.jpg"
}
```

**Response**:
```json
{
  "success": true,
  "receipt": { "id": "...", "status": "Pending", ... }
}
```

---

### GET /api/receipts

Fetches the signed-in user's own receipts with category names, newest first.
Keyset-paginated: one page per request, `nextCursor` fetches the next.

**Auth**: Required

**Query Params** (an invalid value for any of them is a 400):
- `status`: `pending` | `approved` | `rejected` | `reimbursed` (case-insensitive;
  `all` or omitted means every status)
- `limit`: page size, 1–200 (default 50)
- `cursor`: opaque `nextCursor` from the previous response; omit for page 1

**Response**:
```json
{
  "success": true,
  "receipts": [
    {
      "id": "uuid",
      "date": "2025-01-15",
      "amount": 42.99,
      "status": "pending",
      "category": "Office Supplies",
      "image_url": "https://..."
    }
  ],
  "nextCursor": "eyJ..."
}
```

`nextCursor` is `null` on the last page. Ordering is
`receipt_date DESC, created_at DESC`, and the cursor encodes that pair, so pages
must be requested in order.

---

### PATCH /api/receipts

Updates receipt fields.

**Auth**: Required (owner or admin)

**Request**:
```json
{
  "id": "receipt-uuid",
  "receipt_date": "2025-01-16",
  "amount": 50.00,
  "category_id": "uuid",
  "notes": "Updated notes"
}
```

**Permissions**:
- Employees: Own pending receipts only, and never `status` — a body carrying
  `status` from a non-admin is a 403.
- Admins: Any receipt, any field

---

### DELETE /api/receipts?id={receiptId}

Deletes receipt and associated image.

**Auth**: Required (owner or admin)

**Permissions**:
- Employees: Own pending receipts only
- Admins: Any receipt

---

### PUT /api/receipts/bulk-update

Bulk status update (admin only).

**Auth**: Admin required

**Request**:
```json
{ "fromStatus": "Approved", "toStatus": "Reimbursed" }
```

**Response**:
```json
{
  "success": true,
  "message": "Successfully updated 15 receipts",
  "updatedCount": 15
}
```

**Note**: Only supports Approved → Reimbursed transition.

---

## Admin Endpoints

### GET /api/admin/receipts

Fetches one page of receipts with user info and phone numbers, plus the totals
over the whole filtered set.

**Auth**: Admin required

**Query Params** (an invalid `sort` or `dir` is a 400):
- `status`: Filter by status (capitalized, e.g. `Approved`; `all` or omitted for every status)
- `fromDate`: Start date (YYYY-MM-DD), inclusive
- `toDate`: End date (YYYY-MM-DD), **exclusive**
- `q`: free-text search — case-insensitive substring over the employee's
  display name and the receipt description
- `sort`: `date` | `employee` | `phone` | `amount` | `category` | `description`;
  omitted means `receipt_date DESC, created_at DESC`, which is also every
  sort's tiebreak.
- `dir`: `asc` | `desc` (default `asc`)
- `page`: 1-based page number (default 1)
- `pageSize`: rows per page, 1–200 (default 25)

**Response**:
```json
{
  "success": true,
  "receipts": [
    {
      "id": "uuid",
      "employeeName": "John Doe",
      "employeeId": "EMP123",
      "phone": "+12223334444",
      "...": "..."
    }
  ],
  "totalCount": 3158,
  "totalAmount": 81176.24
}
```

`totalCount` / `totalAmount` describe every receipt matching the status, date
and search filters, not just the returned page, and stay correct on a page past
the end of the result set (which returns an empty `receipts` array).

---

### GET /api/admin/receipts/export

Payroll CSV: one row per employee with their total for the filtered set.

**Auth**: Admin required

**Query Params**:
- `status`, `fromDate`, `toDate`, `q`: as for `GET /api/admin/receipts`

**Response**: `text/csv` attachment
(`LastName,FirstName,EmployeeNumber,TotalAmount`), `Cache-Control: no-store`.
Text cells that begin with `=`, `+`, `-` or `@` are prefixed with `'` so a
spreadsheet does not evaluate them.

**Errors**: 413 when more than 100,000 receipts match — the export refuses
rather than returning a truncated file; narrow the filters.

---

### GET /api/admin/users

Lists all users with profiles.

**Auth**: Admin required

**Query Params**:
- `page`: Page number (default: 1)
- `perPage`: Results per page (default: 50)
- `search`: Search name/phone/ID
- `includeDeleted`: Include banned users

---

### POST /api/admin/users

Creates new user.

**Auth**: Admin required

**Request**:
```json
{
  "phone": "2223334444",
  "full_name": "John Doe",
  "role": "employee"
}
```

---

### GET /api/admin/users/[id]

Fetches single user details.

**Auth**: Admin required

---

### PATCH /api/admin/users/[id]

Updates user details.

**Auth**: Admin required

**Request**:
```json
{
  "phone": "3334445555",
  "full_name": "Jane Doe",
  "role": "admin"
}
```

---

### DELETE /api/admin/users/[id]

Bans user (soft delete).

**Auth**: Admin required

**Note**: Cannot ban yourself.

---

## Categories Endpoint

### GET /api/categories

Fetches all categories.

**Auth**: None required (public data)

**Response**:
```json
{
  "success": true,
  "categories": [
    { "id": "uuid", "name": "Parking" },
    { "id": "uuid", "name": "Gas" }
  ]
}
```

---

## Error Response Format

All errors follow this pattern:

```json
{ "error": "Error message here" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request / validation error |
| 401 | Not authenticated |
| 403 | Not authorized (wrong role) |
| 404 | Resource not found |
| 409 | Conflict (duplicate) |
| 500 | Server error |

## Related Pages

- [[Authentication]] - Auth flow details
- [[Receipts]] - Receipt processing
- [[Admin-Features]] - Admin operations
