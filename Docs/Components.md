# Components

[[README|← Back to Index]]

## Overview

UI built with shadcn/ui (52 components) plus 12 custom app components.

## shadcn/ui Components

All in `components/ui/`

### Inputs

| Component | Purpose |
|-----------|---------|
| `button.tsx` | Buttons with variants |
| `input.tsx` | Text input |
| `textarea.tsx` | Multi-line input |
| `checkbox.tsx` | Checkbox |
| `switch.tsx` | Toggle switch |
| `select.tsx` | Dropdown select |
| `calendar.tsx` | Date picker |
| `input-otp.tsx` | OTP code input |

### Layout

| Component | Purpose |
|-----------|---------|
| `card.tsx` | Card container |
| `table.tsx` | Data table |
| `tabs.tsx` | Tab navigation |
| `separator.tsx` | Divider |
| `scroll-area.tsx` | Scrollable area |
| `aspect-ratio.tsx` | Aspect ratio container |

### Overlays

| Component | Purpose |
|-----------|---------|
| `dialog.tsx` | Modal dialog (desktop) |
| `drawer.tsx` | Bottom sheet (mobile) |
| `alert-dialog.tsx` | Confirmation dialog |
| `popover.tsx` | Popover overlay |
| `tooltip.tsx` | Tooltip |
| `sheet.tsx` | Side panel |

### Navigation

| Component | Purpose |
|-----------|---------|
| `dropdown-menu.tsx` | Dropdown menu |
| `pagination.tsx` | Pagination controls |
| `breadcrumb.tsx` | Breadcrumb nav |

### Feedback

| Component | Purpose |
|-----------|---------|
| `badge.tsx` | Status badge |
| `alert.tsx` | Alert message |
| `sonner.tsx` | Toast notifications |
| `skeleton.tsx` | Loading skeleton |
| `progress.tsx` | Progress bar |

### Hooks

| Hook | Purpose |
|------|---------|
| `use-toast.ts` | Toast state |
| `use-mobile.tsx` | Mobile detection |

## Custom App Components

### Receipt Components

| Component | Purpose |
|-----------|---------|
| `receipt-dashboard.tsx` | Admin dashboard view |
| `receipt-table.tsx` | Admin receipt table |
| `employee-receipt-table.tsx` | Employee receipt table |
| `receipt-uploader.tsx` | Upload + OCR flow |
| `receipt-details-card.tsx` | Edit/confirm form |

### Batch Review

| Component | Purpose |
|-----------|---------|
| `batch-review-dashboard.tsx` | Batch approval UI |

### User Management

| Component | Purpose |
|-----------|---------|
| `user-management-dashboard.tsx` | User admin view |
| `user-table.tsx` | User list table |
| `user-form-modal.tsx` | Create/edit user |
| `ban-user-dialog.tsx` | Ban confirmation |

### Utilities

| Component | Purpose |
|-----------|---------|
| `date-range-picker.tsx` | Date range selection |
| `providers/query-provider.tsx` | React Query provider |

## Responsive Patterns

### Drawer vs Dialog

Mobile uses `Drawer` (bottom sheet), desktop uses `Dialog` (centered modal).

```tsx
{isMobile ? (
  <Drawer open={open} onOpenChange={setOpen}>
    <DrawerContent>
      <ReceiptDetailsCard ... />
    </DrawerContent>
  </Drawer>
) : (
  <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent>
      <ReceiptDetailsCard ... />
    </DialogContent>
  </Dialog>
)}
```

Used in: `receipt-uploader.tsx`, `employee-receipt-table.tsx`

### Responsive Sizing

```tsx
// Font size
className="text-xs sm:text-sm"

// Padding
className="px-1.5 sm:px-2"

// Icon size
<Icon size={isMobile ? 14 : 16} />
```

### Native Date Picker

Mobile uses native `<input type="date">` for better UX:

```tsx
{isMobile ? (
  <input type="date" value={format(date, 'yyyy-MM-dd')} ... />
) : (
  <Popover>
    <Calendar ... />
  </Popover>
)}
```

## Dark Theme

App uses dark theme throughout.

Background: `bg-[#222222]`
Cards: `bg-[#2e2e2e]`
Borders: `border-[#444444]`

Status badge colors use dark variants:
- Pending: `bg-yellow-900/30 text-yellow-300`
- Approved: `bg-green-900/30 text-green-300`
- Rejected: `bg-red-900/30 text-red-300`
- Reimbursed: `bg-blue-900/30 text-blue-300`

## Related Pages

- [[Configuration]] - Tailwind and shadcn setup
- [[Employee-Features]] - Employee UI
- [[Admin-Features]] - Admin UI
