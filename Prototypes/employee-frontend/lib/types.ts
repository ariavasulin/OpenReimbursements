export interface Receipt {
  id: string
  date: string
  amount: number
  status: "pending" | "approved" | "reimbursed" | "rejected"
  imageUrl?: string
  driveLink?: string
  category?: string
  notes?: string
}
