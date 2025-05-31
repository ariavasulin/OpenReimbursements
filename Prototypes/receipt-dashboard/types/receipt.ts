export interface IReceipt {
  id: string
  employeeName: string
  employeeId: string
  date: Date
  amount: number
  category: string
  description: string
  status: "pending" | "approved" | "rejected" | "reimbursed"
  imageUrl: string
  jobCode: string
}
