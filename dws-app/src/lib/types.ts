export interface Receipt {
  id: string;
  user_id?: string;
  employeeName: string;
  employeeId: string;
  phone?: string | null;
  date: string;
  receipt_date?: string;
  amount: number;
  status: "Pending" | "Approved" | "Rejected" | "Reimbursed" | "pending" | "approved" | "rejected" | "reimbursed";
  category_id?: string;
  category?: string;
  description?: string;
  notes?: string;
  image_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Category {
  id: string;
  name: string;
  created_at?: string;
}

export interface UserProfile {
  user_id: string;
  role: 'employee' | 'admin';
  full_name?: string;
  preferred_name?: string;
  employee_id_internal?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface AdminUser {
  id: string;
  phone: string;
  created_at: string;
  last_sign_in_at?: string;
  banned_until?: string;
  role: 'employee' | 'admin';
  full_name?: string;
  preferred_name?: string;
  employee_id_internal?: string;
  deleted_at?: string | null;
}

export interface BulkUpdateResponse {
  success: boolean;
  message: string;
  updatedCount: number;
  error?: string;
}

export const RECEIPT_STATUS_VALUES = ["Pending", "Approved", "Rejected", "Reimbursed"] as const;

export type ReceiptStatusValue = (typeof RECEIPT_STATUS_VALUES)[number];

/** Status values a list filter can send; 'all' means no filter. */
export type ReceiptStatusFilter = 'all' | Lowercase<ReceiptStatusValue>;

const RECEIPT_STATUS_BY_LOWERCASE = new Map<string, ReceiptStatusValue>(
  RECEIPT_STATUS_VALUES.map((status) => [status.toLowerCase(), status])
);

/** The receipts.status value named by a case-insensitive input, if any. */
export function parseReceiptStatus(input: string): ReceiptStatusValue | undefined {
  return RECEIPT_STATUS_BY_LOWERCASE.get(input.toLowerCase());
}

/** The UI carries statuses lowercased; receipts.status stores them capitalized. */
export function toDbReceiptStatus(status: Lowercase<ReceiptStatusValue>): ReceiptStatusValue {
  return RECEIPT_STATUS_BY_LOWERCASE.get(status)!;
}

/** Columns the admin table can sort by — the get_admin_receipts_page whitelist. */
export const RECEIPT_SORT_FIELDS = ["date", "employee", "phone", "amount", "category", "description"] as const;
export type ReceiptSortField = (typeof RECEIPT_SORT_FIELDS)[number];

export interface ReceiptSort {
  field: ReceiptSortField;
  direction: "asc" | "desc";
}

/**
 * Employee display fields derived from an admin receipts RPC row. The dashboard
 * and the payroll export must agree on these, or an exported CSV names people
 * differently than the table the admin was looking at.
 */
export function employeeIdentity(row: {
  preferred_name?: string | null;
  full_name?: string | null;
  employee_id_internal?: string | null;
}): { employeeName: string; employeeId: string } {
  return {
    employeeName: row.preferred_name || row.full_name || 'Unknown',
    employeeId: row.employee_id_internal || '',
  };
}

export interface BatchStatusDecision {
  id: string;
  status: ReceiptStatusValue;
}

export interface BatchStatusRequest {
  decisions: BatchStatusDecision[];
}

export interface BatchStatusResponse {
  success: boolean;
  updatedCount?: number;
  error?: string;
}