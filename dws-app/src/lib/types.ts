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

/**
 * The UI carries statuses lowercased; receipts.status stores them capitalized.
 * One transform so the API query string and the export query string agree.
 */
export function toDbReceiptStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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