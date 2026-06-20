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