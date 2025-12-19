# Receipts

[[README|← Back to Index]]

## Overview

Receipt management is the core feature. Employees upload receipt images, OCR extracts data, and admins review for reimbursement.

## Upload Flow

```
1. User selects/captures image
2. POST /api/receipts/upload → Temp storage
3. POST /api/receipts/ocr → Extract date, amount, category
4. Auto-submit OR manual confirmation
5. POST /api/receipts → Create record, move image to final path
```

## Two-Phase Storage

### Phase 1: Temporary Upload

```typescript
// Temp path format
{userId}/temp_{uuid8}_{timestamp}.jpg

// POST /api/receipts/upload
const formData = new FormData();
formData.append('file', file);
const { tempFilePath } = await fetch('/api/receipts/upload', {
  method: 'POST',
  body: formData
});
```

### Phase 2: Finalization

When receipt is created, file moves to permanent path:

```typescript
// Final path format
{userId}/{receiptId}.jpg

// Inside POST /api/receipts
await supabase.storage.from('receipt-images').move(tempFilePath, finalPath);
```

## Image Processing

Images are optimized on upload using Sharp:

```typescript
// api/receipts/upload/route.ts
sharp(buffer)
  .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 80, progressive: true })
```

| Setting | Value |
|---------|-------|
| Max dimensions | 1200x1200 |
| Format | JPEG |
| Quality | 80% |
| PDFs | Uploaded as-is |

## OCR with BAML

OCR uses BAML to call GPT-4.1-nano via OpenRouter.

### BAML Definition

```baml
// baml_src/receipts.baml
class ExtractedReceipt {
  date string? @description("YYYY-MM-DD format")
  amount float? @description("Total amount paid")
  category string? @description("Parking, Gas, Meals & Entertainment, Office Supplies, Other")
}

function ExtractReceiptFromImage(img: image) -> ExtractedReceipt {
  client GPT4oMini
  prompt #"Extract receipt data..."#
}
```

### OCR Response

```typescript
// POST /api/receipts/ocr response
{
  success: true,
  data: {
    date: "2025-01-15",
    amount: 42.99,
    category: "Office Supplies",
    category_id: "uuid-or-null"
  },
  duplicate: {
    isDuplicate: false,
    existingReceipts: []
  },
  canAutoSubmit: true  // All fields extracted + no duplicates
}
```

## Auto-Submit Logic

Receipts auto-submit when ALL conditions are met:

1. Date was extracted
2. Amount was extracted
3. Category was mapped to ID
4. No duplicate receipts found

Otherwise, user sees confirmation form.

## Duplicate Detection

Before creating a receipt, the system checks for existing receipts with same:
- `user_id`
- `receipt_date`
- `amount`

User is warned and must add a unique description.

## Status Lifecycle

```
New Receipt → Pending
                ↓
           (Admin Review)
           ↙         ↘
      Approved    Rejected
         ↓
    Reimbursed
```

### Status Values

Database stores capitalized: `"Pending"`, `"Approved"`, `"Rejected"`, `"Reimbursed"`

Frontend normalizes to lowercase for display.

### Status Permissions

| Action | Employee | Admin |
|--------|----------|-------|
| Edit Pending | ✅ Own only | ✅ Any |
| Edit Other Status | ❌ | ✅ |
| Delete Pending | ✅ Own only | ✅ Any |
| Delete Other Status | ❌ | ✅ |

## Key Files

| File | Purpose |
|------|---------|
| `components/receipt-uploader.tsx` | Upload UI + OCR flow |
| `components/receipt-details-card.tsx` | Edit/confirmation form |
| `api/receipts/upload/route.ts` | Image upload + processing |
| `api/receipts/ocr/route.ts` | OCR extraction |
| `api/receipts/route.ts` | CRUD operations |

## File Types Supported

| Type | Extension | Notes |
|------|-----------|-------|
| JPEG | .jpg, .jpeg | Converted to optimized JPEG |
| PNG | .png | Converted to JPEG |
| WebP | .webp | Converted to JPEG |
| HEIC | .heic, .heif | iOS photos, converted |
| PDF | .pdf | Uploaded as-is |

## Size Limits

| Platform | Limit |
|----------|-------|
| Mobile | 50 MB |
| Desktop | 10 MB |

## Related Pages

- [[Employee-Features]] - Mobile submission experience
- [[Admin-Features]] - Review and approval
- [[API]] - Endpoint details
- [[Database]] - Receipts table schema
