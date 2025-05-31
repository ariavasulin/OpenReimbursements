"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { Download, RefreshCw, ListChecks } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DateRangePicker } from "@/components/date-range-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import ReceiptTable from "@/components/receipt-table"
import type { ColDef } from "ag-grid-community"
import type { IReceipt } from "@/types/receipt"

export default function ReceiptDashboard() {
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined,
  })

  // Mock data for receipts
  const receiptData: IReceipt[] = [
    {
      id: "REC-001",
      employeeName: "John Doe",
      employeeId: "EMP-001",
      date: new Date("2023-05-01"),
      amount: 125.5,
      category: "Travel",
      description: "Uber to client meeting",
      status: "approved",
      imageUrl: "/receipts/receipt-1.jpg",
      jobCode: "PROJ-123",
    },
    {
      id: "REC-002",
      employeeName: "Jane Smith",
      employeeId: "EMP-002",
      date: new Date("2023-05-03"),
      amount: 45.75,
      category: "Meals",
      description: "Lunch with client",
      status: "pending",
      imageUrl: "/receipts/receipt-2.jpg",
      jobCode: "PROJ-456",
    },
    {
      id: "REC-003",
      employeeName: "Michael Johnson",
      employeeId: "EMP-003",
      date: new Date("2023-05-05"),
      amount: 350.0,
      category: "Equipment",
      description: "External monitor",
      status: "reimbursed",
      imageUrl: "/receipts/receipt-3.jpg",
      jobCode: "PROJ-789",
    },
    {
      id: "REC-004",
      employeeName: "Sarah Williams",
      employeeId: "EMP-004",
      date: new Date("2023-05-10"),
      amount: 75.25,
      category: "Office Supplies",
      description: "Printer paper and ink",
      status: "rejected",
      imageUrl: "/receipts/receipt-4.jpg",
      jobCode: "PROJ-123",
    },
    {
      id: "REC-005",
      employeeName: "John Doe",
      employeeId: "EMP-001",
      date: new Date("2023-05-15"),
      amount: 200.0,
      category: "Travel",
      description: "Train tickets",
      status: "pending",
      imageUrl: "/receipts/receipt-5.jpg",
      jobCode: "PROJ-456",
    },
    {
      id: "REC-006",
      employeeName: "Jane Smith",
      employeeId: "EMP-002",
      date: new Date("2023-05-18"),
      amount: 89.99,
      category: "Software",
      description: "Adobe subscription",
      status: "approved",
      imageUrl: "/receipts/receipt-6.jpg",
      jobCode: "PROJ-789",
    },
    {
      id: "REC-007",
      employeeName: "Michael Johnson",
      employeeId: "EMP-003",
      date: new Date("2023-05-20"),
      amount: 150.75,
      category: "Travel",
      description: "Hotel stay",
      status: "reimbursed",
      imageUrl: "/receipts/receipt-7.jpg",
      jobCode: "PROJ-123",
    },
    {
      id: "REC-008",
      employeeName: "Sarah Williams",
      employeeId: "EMP-004",
      date: new Date("2023-05-22"),
      amount: 35.5,
      category: "Meals",
      description: "Team lunch",
      status: "approved",
      imageUrl: "/receipts/receipt-8.jpg",
      jobCode: "PROJ-456",
    },
  ]

  // Filter receipts based on current filters
  const filteredReceipts = receiptData.filter((receipt) => {
    // Filter by status
    if (filterStatus !== "all" && receipt.status !== filterStatus) {
      return false
    }

    // Filter by search query (employee name or description)
    if (
      searchQuery &&
      !receipt.employeeName.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !receipt.description.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false
    }

    // Filter by date range
    if (dateRange.from && receipt.date < dateRange.from) {
      return false
    }
    if (dateRange.to && receipt.date > dateRange.to) {
      return false
    }

    return true
  })

  // Column definitions for AG Grid - updated order and renamed "Receipt Image" to "Image"
  const columnDefs: ColDef[] = [
    {
      field: "jobCode",
      headerName: "Job Code",
      sortable: true,
      filter: true,
    },
    {
      field: "date",
      headerName: "Date",
      sortable: true,
      filter: true,
      valueFormatter: (params) => {
        return params.value ? new Date(params.value).toLocaleDateString() : ""
      },
    },
    {
      field: "employeeName",
      headerName: "Employee",
      sortable: true,
      filter: true,
    },
    {
      field: "amount",
      headerName: "Amount",
      sortable: true,
      filter: true,
      valueFormatter: (params) => {
        return params.value ? `$${params.value.toFixed(2)}` : ""
      },
    },
    {
      field: "category",
      headerName: "Category",
      sortable: true,
      filter: true,
    },
    {
      field: "description",
      headerName: "Description",
      sortable: true,
      filter: true,
      flex: 1.5,
    },
    {
      field: "status",
      headerName: "Status",
      sortable: true,
      filter: true,
      width: 120,
    },
    {
      field: "imageUrl",
      headerName: "Image",
      width: 120,
    },
  ]

  // Default column definition
  const defaultColDef = {
    flex: 1,
    minWidth: 100,
    resizable: true,
  }

  // Function to download CSV
  const downloadCSV = () => {
    // Convert filtered receipts to CSV - only include the displayed columns
    const headers = ["Job Code", "Date", "Employee", "Amount", "Category", "Description", "Status"]
    const csvData = filteredReceipts.map((receipt) => [
      receipt.jobCode,
      receipt.date.toLocaleDateString(),
      receipt.employeeName,
      `$${receipt.amount.toFixed(2)}`,
      receipt.category,
      receipt.description,
      receipt.status,
    ])

    // Create CSV content
    const csvContent = [headers.join(","), ...csvData.map((row) => row.join(","))].join("\n")

    // Create download link
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.setAttribute("href", url)
    link.setAttribute("download", `receipts_export_${new Date().toISOString().split("T")[0]}.csv`)
    link.style.visibility = "hidden"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Calculate summary statistics
  const totalReceipts = filteredReceipts.length
  const totalAmount = filteredReceipts.reduce((sum, receipt) => sum + receipt.amount, 0)
  const pendingCount = filteredReceipts.filter((r) => r.status === "pending").length
  const approvedCount = filteredReceipts.filter((r) => r.status === "approved").length
  const reimbursedCount = filteredReceipts.filter((r) => r.status === "reimbursed").length

  return (
    <div className="flex flex-col h-screen bg-[#2e2e2e] text-white">
      <div>
        <div className="flex h-16 items-center px-8">
          <div className="flex items-center">
            <Image src="/images/logo.png" alt="Company Logo" width={200} height={200} className="mr-3 mt-6" />
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/batch-review">
              <Button
                variant="outline"
                size="sm"
                className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white mr-2"
              >
                <ListChecks className="mr-2 h-4 w-4" />
                Review Receipts
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
              className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 p-8 pt-3">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Receipts</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-[#999999]"
              >
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalReceipts}</div>
              <p className="text-xs text-[#999999]">Total amount: ${totalAmount.toFixed(2)}</p>
            </CardContent>
          </Card>

          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-[#999999]"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pendingCount}</div>
              <p className="text-xs text-[#999999]">
                {Math.round((pendingCount / totalReceipts) * 100)}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Approved</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-[#999999]"
              >
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <path d="M2 10h20" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{approvedCount}</div>
              <p className="text-xs text-[#999999]">
                {Math.round((approvedCount / totalReceipts) * 100)}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Reimbursed</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-[#999999]"
              >
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{reimbursedCount}</div>
              <p className="text-xs text-[#999999]">
                {Math.round((reimbursedCount / totalReceipts) * 100)}% of total receipts
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader>
              <CardTitle>Receipt Management</CardTitle>
              <CardDescription className="text-[#999999]">
                Review and manage employee receipts for reimbursement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all" className="space-y-4">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                  <TabsList className="bg-[#3e3e3e] text-white">
                    <TabsTrigger
                      value="all"
                      onClick={() => setFilterStatus("all")}
                      className="data-[state=active]:bg-[#4a4a4a] data-[state=active]:text-white"
                    >
                      All Receipts
                    </TabsTrigger>
                    <TabsTrigger
                      value="pending"
                      onClick={() => setFilterStatus("pending")}
                      className="data-[state=active]:bg-[#4a4a4a] data-[state=active]:text-white"
                    >
                      Pending
                    </TabsTrigger>
                    <TabsTrigger
                      value="approved"
                      onClick={() => setFilterStatus("approved")}
                      className="data-[state=active]:bg-[#4a4a4a] data-[state=active]:text-white"
                    >
                      Approved
                    </TabsTrigger>
                    <TabsTrigger
                      value="reimbursed"
                      onClick={() => setFilterStatus("reimbursed")}
                      className="data-[state=active]:bg-[#4a4a4a] data-[state=active]:text-white"
                    >
                      Reimbursed
                    </TabsTrigger>
                  </TabsList>

                  <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="search" className="sr-only">
                        Search
                      </Label>
                      <Input
                        id="search"
                        placeholder="Search employee or description..."
                        className="w-full md:w-[250px] bg-[#3e3e3e] text-white border-[#3e3e3e] focus:border-[#555] focus:ring-[#555]"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>

                    <DateRangePicker date={dateRange} onDateChange={setDateRange} />

                    <Button
                      variant="outline"
                      onClick={downloadCSV}
                      className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                </div>

                <TabsContent value="all" className="space-y-4">
                  <div className="h-[600px] w-full">
                    <ReceiptTable
                      rowData={filteredReceipts}
                      colDefs={columnDefs}
                      defaultColDef={defaultColDef}
                      rowSelection="multiRow"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="pending" className="space-y-4">
                  <div className="h-[600px] w-full">
                    <ReceiptTable
                      rowData={filteredReceipts}
                      colDefs={columnDefs}
                      defaultColDef={defaultColDef}
                      rowSelection="multiRow"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="approved" className="space-y-4">
                  <div className="h-[600px] w-full">
                    <ReceiptTable
                      rowData={filteredReceipts}
                      colDefs={columnDefs}
                      defaultColDef={defaultColDef}
                      rowSelection="multiRow"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="reimbursed" className="space-y-4">
                  <div className="h-[600px] w-full">
                    <ReceiptTable
                      rowData={filteredReceipts}
                      colDefs={columnDefs}
                      defaultColDef={defaultColDef}
                      rowSelection="multiRow"
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
