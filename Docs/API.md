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

Fetches user's receipts with category names.

**Auth**: Required

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
  ]
}
```

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
- Employees: Own pending receipts only
- Admins: Any receipt

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

Fetches all receipts with user info and phone numbers.

**Auth**: Admin required

**Query Params**:
- `status`: Filter by status
- `fromDate`: Start date (YYYY-MM-DD)
- `toDate`: End date (YYYY-MM-DD)

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
      ...
    }
  ]
}
```

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
