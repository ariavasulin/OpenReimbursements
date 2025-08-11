export interface Receipt {
  id: string; // Corresponds to Supabase 'id' (uuid)
  user_id?: string; // Foreign key to auth.users.id, will be added when saving
  employeeName: string; // From prototype
  employeeId: string; // From prototype
  date: string; // From prototype (was receipt_date)
  amount: number; // Corresponds to Supabase 'amount' (numeric)
  status: "Pending" | "Approved" | "Rejected" | "Reimbursed" | "pending" | "approved" | "rejected" | "reimbursed"; // Updated to include both cases
  category_id?: string; // Foreign key to categories.id
  category?: string; // For display or form input, maps to category_id. From prototype.
  description?: string; // From prototype
  notes?: string; // Corresponds to Supabase 'description' (text), kept for existing dws-app functionality
  image_url?: string; // Corresponds to Supabase 'image_url' (text) - stores path in Supabase Storage or a public URL. From prototype as imageUrl.
  // jobCode?: string; // Removed as per user request
  // driveLink?: string; // From prototype, redundant.
  created_at?: string; // Corresponds to Supabase 'created_at'
  updated_at?: string; // Corresponds to Supabase 'updated_at'
}

// You might want to define other types here as the app grows, e.g., for Category
export interface Category {
  id: string;
  name: string;
  created_at?: string;
}

// For user profiles, if you fetch them client-side
export interface UserProfile {
  user_id: string;
  role: 'employee' | 'admin';
  full_name?: string;
  preferred_name?: string;
  employee_id_internal?: string;
  created_at?: string;
  updated_at?: string;
}

// For bulk update API responses
export interface BulkUpdateResponse {
  success: boolean;
  message: string;
  updatedCount: number;
  error?: string;
}