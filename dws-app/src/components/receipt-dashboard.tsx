"use client"

import { useState, useEffect } from "react"
import Image from "next/image"
import Link from "next/link"
import { supabase } from "@/lib/supabaseClient"
import { Download, RefreshCw, ListChecks } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DateRangePicker } from "@/components/date-range-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import ReceiptTable from "@/components/receipt-table"
import type { ColDef } from "ag-grid-community"
import type { Receipt } from "@/lib/types"

export default function ReceiptDashboard() {
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined,
  })
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchReceipts = async () => {
      setLoading(true)
      setError(null)

      try {
        let query = supabase
          .from("receipts")
          .select(
            `
            id,
            receipt_date,
            amount,
            status,
            category,
            notes,
            image_url,
            job_code,
            user_profiles (
              full_name,
              employee_id_internal
            )
          `
          )
          // Ensure user_profiles is not null, if it can be
          // .not("user_profiles", "is", null)

        if (filterStatus !== "all") {
          // The 'status' in the DB might be capitalized as per types.ts for dws-app
          // The prototype used lowercase. For now, assuming DB uses capitalized.
          const dbStatus = filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1)
          query = query.eq("status", dbStatus)
        }

        if (searchQuery) {
          query = query.or(
            `user_profiles.full_name.ilike.%${searchQuery}%,notes.ilike.%${searchQuery}%`
          )
        }

        if (dateRange.from) {
          query = query.gte("receipt_date", dateRange.from.toISOString())
        }
        if (dateRange.to) {
          // Add 1 day to 'to' date to make it inclusive for the whole day
          const toDate = new Date(dateRange.to)
          toDate.setDate(toDate.getDate() + 1)
          query = query.lt("receipt_date", toDate.toISOString())
        }

        query = query.order('receipt_date', { ascending: false });


        const { data, error: supabaseError } = await query

        if (supabaseError) {
          throw supabaseError
        }

        const mappedReceipts: Receipt[] = data.map((item: any) => ({
          id: item.id,
          employeeName: item.user_profiles?.full_name || "N/A",
          employeeId: item.user_profiles?.employee_id_internal || "N/A",
          date: item.receipt_date, // This is a string (ISO date)
          amount: item.amount,
          category: item.category || "Uncategorized",
          description: item.notes || "", // Map notes to description
          status: item.status.toLowerCase() as Receipt['status'], // Assuming status from DB needs to be lowercased for prototype compatibility
          imageUrl: item.image_url || "",
          jobCode: item.job_code || item.jobCode || "", // job_code from DB, jobCode as fallback
        }))
        setReceipts(mappedReceipts)
      } catch (err: any) {
        setError(err.message)
        console.error("Error fetching receipts:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchReceipts()
  }, [filterStatus, searchQuery, dateRange])

  // filteredReceipts are now just the receipts state, as filtering is server-side
  const filteredReceipts = receipts;

  const columnDefs: ColDef<Receipt>[] = [
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
        // params.value is expected to be a string (ISO date) from Supabase
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
    const headers = ["Job Code", "Date", "Employee", "Amount", "Category", "Description", "Status", "Image URL"]
    const csvData = filteredReceipts.map((receipt) => [
      receipt.jobCode || "",
      receipt.date ? new Date(receipt.date).toLocaleDateString() : "", // Corrected: was receipt.date.toLocaleDateString()
      receipt.employeeName,
      `$${receipt.amount.toFixed(2)}`,
      receipt.category || "",
      receipt.description || "",
      receipt.status,
      receipt.imageUrl || "",
    ])

    const csvContent = [headers.join(","), ...csvData.map((row) => row.join(","))].join("\n")
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
  const totalReceipts = receipts.length // Use 'receipts' as filtering is server-side for the main list
  const totalAmount = receipts.reduce((sum, receipt) => sum + receipt.amount, 0)
  // For counts, we can filter the already fetched 'receipts' or make separate aggregate queries if performance is an issue
  const pendingCount = receipts.filter((r) => r.status === "pending").length
  const approvedCount = receipts.filter((r) => r.status === "approved").length
  const reimbursedCount = receipts.filter((r) => r.status === "reimbursed").length
  // Add other statuses if necessary, e.g., rejected
  // const rejectedCount = receipts.filter((r) => r.status === "rejected").length;


  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-[#2e2e2e] text-white items-center justify-center">
        <RefreshCw className="animate-spin h-12 w-12 text-white" />
        <p className="mt-4">Loading receipts...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col h-screen bg-[#2e2e2e] text-white items-center justify-center">
        <p className="text-red-500">Error loading receipts: {error}</p>
        <Button
          onClick={() => { /* Consider a refetch function or just reload for simplicity */
            window.location.reload();
          }}
          className="mt-4"
        >
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* Header - Assuming this might be part of a larger app layout eventually */}
      <div className="border-b border-border">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center"> {/* Assuming logo might come from a shared component or be static here */}
            <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" /> {/* Adjusted size for typical header */}
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/batch-review">
              <Button
                variant="outline"
                size="sm"
                // Using theme variables for secondary button like elements
                className="bg-secondary text-secondary-foreground hover:bg-muted"
              >
                <ListChecks className="mr-2 h-4 w-4" />
                Review Receipts
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
               // Using theme variables
              className="bg-secondary text-secondary-foreground hover:bg-muted"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Card with theme variables */}
          <Card className="bg-card text-card-foreground border-border">
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
                className="h-4 w-4 text-muted-foreground" // Theme variable for muted text
              >
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalReceipts}</div>
              <p className="text-xs text-muted-foreground">Total amount: ${totalAmount.toFixed(2)}</p>
            </CardContent>
          </Card>

          <Card className="bg-card text-card-foreground border-border">
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
                className="h-4 w-4 text-muted-foreground"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pendingCount}</div>
              <p className="text-xs text-muted-foreground">
                {totalReceipts > 0 ? Math.round((pendingCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card text-card-foreground border-border">
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
                className="h-4 w-4 text-muted-foreground"
              >
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <path d="M2 10h20" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{approvedCount}</div>
              <p className="text-xs text-muted-foreground">
                {totalReceipts > 0 ? Math.round((approvedCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card text-card-foreground border-border">
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
                className="h-4 w-4 text-muted-foreground"
              >
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{reimbursedCount}</div>
              <p className="text-xs text-muted-foreground">
                {totalReceipts > 0 ? Math.round((reimbursedCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle>Receipt Management</CardTitle>
              <CardDescription className="text-muted-foreground">
                Review and manage employee receipts for reimbursement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all" className="space-y-4">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                  {/* TabsList using theme variables for secondary/muted background and foreground, active state uses primary or accent */}
                  <TabsList className="bg-muted text-muted-foreground">
                    <TabsTrigger
                      value="all"
                      onClick={() => setFilterStatus("all")}
                      className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      All Receipts
                    </TabsTrigger>
                    <TabsTrigger
                      value="pending"
                      onClick={() => setFilterStatus("pending")}
                      className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      Pending
                    </TabsTrigger>
                    <TabsTrigger
                      value="approved"
                      onClick={() => setFilterStatus("approved")}
                      className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      Approved
                    </TabsTrigger>
                    <TabsTrigger
                      value="reimbursed"
                      onClick={() => setFilterStatus("reimbursed")}
                      className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      Reimbursed
                    </TabsTrigger>
                     <TabsTrigger
                      value="rejected"
                      onClick={() => setFilterStatus("rejected")}
                      className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                    >
                      Rejected
                    </TabsTrigger>
                  </TabsList>

                  <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="search" className="sr-only">
                        Search
                      </Label>
                      {/* Input using theme variables */}
                      <Input
                        id="search"
                        placeholder="Search employee or description..."
                        className="w-full md:w-[250px] bg-input text-foreground border-border focus:ring-ring focus:ring-offset-background"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>

                    {/* DateRangePicker needs internal styling review too, but its trigger button style is handled here */}
                    <DateRangePicker date={dateRange} onDateChange={setDateRange} />

                    <Button
                      variant="outline"
                      onClick={downloadCSV}
                      className="bg-secondary text-secondary-foreground hover:bg-muted"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                </div>

                <TabsContent value="all" className="space-y-4">
                  <div className="h-[600px] w-full">
                    {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-full">
                         <p className="text-[#999999]">No receipts found for the current filters.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        colDefs={columnDefs}
                        defaultColDef={defaultColDef}
                        rowSelection="multiRow"
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="pending" className="space-y-4">
                  <div className="h-[600px] w-full">
                     {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-full">
                         <p className="text-[#999999]">No pending receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        colDefs={columnDefs}
                        defaultColDef={defaultColDef}
                        rowSelection="multiRow"
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="approved" className="space-y-4">
                  <div className="h-[600px] w-full">
                    {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-full">
                         <p className="text-[#999999]">No approved receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        colDefs={columnDefs}
                        defaultColDef={defaultColDef}
                        rowSelection="multiRow"
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="reimbursed" className="space-y-4">
                  <div className="h-[600px] w-full">
                     {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-full">
                         <p className="text-[#999999]">No reimbursed receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        colDefs={columnDefs}
                        defaultColDef={defaultColDef}
                        rowSelection="multiRow"
                      />
                    )}
                  </div>
                </TabsContent>
                 <TabsContent value="rejected" className="space-y-4">
                  <div className="h-[600px] w-full">
                    {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-full">
                         <p className="text-[#999999]">No rejected receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
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
