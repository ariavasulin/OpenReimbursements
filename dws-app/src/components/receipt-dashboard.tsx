"use client"

import { useState, useEffect } from "react"
import Image from "next/image"
import Link from "next/link"
import { supabase } from "@/lib/supabaseClient"
import { Download, RefreshCw, ListChecks, LogOut, Search, CheckCircle, AlertCircle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DateRangePicker } from "@/components/date-range-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import ReceiptTable from "@/components/receipt-table"
// import type { ColDef } from "ag-grid-community" // Removed as ag-grid is not used
import type { Receipt, BulkUpdateResponse } from "@/lib/types"

export default function ReceiptDashboard({ onLogout }: { onLogout?: () => Promise<void> }) {
  const [activeTab, setActiveTab] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined,
  })

  // Bulk update states
  const [isBulkUpdateLoading, setIsBulkUpdateLoading] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [pendingBulkUpdateCount, setPendingBulkUpdateCount] = useState(0)

  const handleDateChange = (selectedDateRange: import("react-day-picker").DateRange | undefined) => {
    setDateRange({
      from: selectedDateRange?.from,
      to: selectedDateRange?.to,
    });
  };

  const handleSelectedRowsChange = (newSelectedRows: Set<string>) => {
    setSelectedRows(newSelectedRows)
  }

  const handleClearSelection = () => {
    setSelectedRows(new Set())
  }

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }

  const handlePageSizeChange = (newPageSize: number) => {
    setPageSize(newPageSize)
    setCurrentPage(1) // Reset to first page when changing page size
  }

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
            category_id,
            user_id,
            categories!receipts_category_id_fkey (name),
            description,
            image_url
          `
          )

        if (filterStatus !== "all") {
          // The 'status' in the DB might be capitalized as per types.ts for dws-app
          // The prototype used lowercase. For now, assuming DB uses capitalized.
          const dbStatus = filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1)
          query = query.eq("status", dbStatus)
        }

        // Search filtering is handled client-side to avoid PostgREST parsing issues

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

        // Fetch user profiles separately
        const userIds = [...new Set(data.map(item => item.user_id).filter(Boolean))]
        
        const { data: userProfiles, error: profilesError } = await supabase
          .from("user_profiles")
          .select("user_id, full_name, preferred_name, employee_id_internal")
          .in("user_id", userIds)

        if (profilesError) {
          console.warn("Error fetching user profiles:", profilesError)
        }

        // Create a map of user profiles by user_id
        const profilesMap = new Map()
        if (userProfiles) {
          userProfiles.forEach(profile => {
            profilesMap.set(profile.user_id, profile)
          })
        }

        const mappedReceipts: Receipt[] = data.map((item: any) => {
          const userProfile = profilesMap.get(item.user_id)
          return {
            id: item.id,
            employeeName: userProfile?.preferred_name || userProfile?.full_name || "N/A",
            employeeId: userProfile?.employee_id_internal || "N/A",
            date: item.receipt_date, // This is a string (ISO date)
            amount: item.amount,
            category: item.categories?.name || "Uncategorized",
            description: item.description || "",
            status: item.status.toLowerCase() as Receipt['status'],
            image_url: item.image_url ? supabase.storage.from('receipt-images').getPublicUrl(item.image_url).data.publicUrl : "",
            // jobCode: item.job_code || item.jobCode || "", // Removed
          }
        })
        setReceipts(mappedReceipts)
      } catch (err: any) {
        console.error("Full error object fetching receipts:", JSON.stringify(err, null, 2));
        let errorMessage = "An unknown error occurred";
        if (err && typeof err === 'object') {
          if ('message' in err && typeof err.message === 'string') {
            errorMessage = err.message;
          } else if (Object.keys(err).length > 0) {
            errorMessage = `Supabase error: ${JSON.stringify(err)}`;
          }
        } else if (typeof err === 'string') {
          errorMessage = err;
        }
        setError(errorMessage);
        console.error("Error fetching receipts (processed):", errorMessage);
      } finally {
        setLoading(false)
      }
    }

    // Only fetch when both dates are selected, or when no dates are selected, or when only filterStatus/searchQuery changes
    const shouldFetch = !dateRange.from || (dateRange.from && dateRange.to)
    
    if (shouldFetch) {
      fetchReceipts()
    }
  }, [filterStatus, dateRange])

  // Apply client-side search filtering since server-side search has PostgREST issues
  const filteredReceipts = receipts.filter(receipt => {
    if (!searchQuery) return true
    
    const searchLower = searchQuery.toLowerCase()
    const employeeName = receipt.employeeName?.toLowerCase() || ''
    const description = receipt.description?.toLowerCase() || ''
    
    return employeeName.includes(searchLower) || description.includes(searchLower)
  })

  // Calculate pagination info
  const totalPages = Math.ceil(filteredReceipts.length / pageSize)

  // const columnDefs: ColDef<Receipt>[] = [ ... ] // Removed as ReceiptTable handles its own columns
  // const defaultColDef = { ... } // Removed

  // (Removed) Legacy CSV export function in favor of payroll-formatted CSV

  // Helper to format Saturday of the current week as MM/DD/YYYY (zero-padded)
  const getCurrentWeekEndingSaturday = (): string => {
    const today = new Date()
    // JavaScript: 0=Sun, 6=Sat. We want the Saturday of the current week.
    const day = today.getDay()
    const diffToSaturday = 6 - day
    const saturday = new Date(today)
    saturday.setHours(0, 0, 0, 0)
    saturday.setDate(saturday.getDate() + diffToSaturday)
    const mm = String(saturday.getMonth() + 1).padStart(2, '0')
    const dd = String(saturday.getDate()).padStart(2, '0')
    const yyyy = String(saturday.getFullYear())
    return `${mm}/${dd}/${yyyy}`
  }

  // Helper to CSV-quote a value (wrap in double quotes and escape internal quotes)
  const quoteCsv = (value: string): string => {
    const escaped = value.replace(/"/g, '""')
    return `"${escaped}"`
  }

  // Function to download Payroll-formatted CSV matching Time_5_20.csv
  const downloadPayrollCSV = () => {
    // Exact header order and quoting to match sample
    const headers = [
      '"WeekEnded"',
      '"DeptCd"',
      '"EmplCode"',
      '"EarnDeduct"',
      '"EarningCd"',
      '"Dept"',
      '"Project"',
      '"Sheet"',
      '"CostCode"',
      '"Hours"',
      '"CheckNo"',
      '"SpecialRate"',
    ]

    const weekEnded = getCurrentWeekEndingSaturday() // e.g., 05/17/2025

    const csvRows = filteredReceipts.map((receipt) => {
      const emplCode = receipt.employeeId ?? ''
      const hours = Number.isFinite(receipt.amount) ? receipt.amount.toFixed(2) : '0.00'

      // Columns with required quoting per sample: WeekEnded, EmplCode, EarnDeduct, EarningCd, Dept, Project
      const row = [
        quoteCsv(weekEnded),      // WeekEnded
        '30',                     // DeptCd (unquoted)
        quoteCsv(emplCode),       // EmplCode
        '"E"',                  // EarnDeduct
        '"01"',                 // EarningCd
        '"30"',                 // Dept
        '"4053"',               // Project
        '',                       // Sheet (empty)
        '30',                     // CostCode (unquoted)
        hours,                    // Hours (unquoted two-decimal)
        '1',                      // CheckNo (unquoted)
        '',                       // SpecialRate (empty)
      ]

      return row.join(',')
    })

    const csvContent = [headers.join(','), ...csvRows].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute('download', `payroll_export_${getCurrentWeekEndingSaturday().replaceAll('/', '-')}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Function to get total approved receipts count (ignoring filters)
  const getTotalApprovedCount = async () => {
    try {
      const { count, error } = await supabase
        .from('receipts')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Approved');
      
      if (error) {
        console.error('Error counting approved receipts:', error);
        return 0;
      }
      
      return count || 0;
    } catch (error) {
      console.error('Error in getTotalApprovedCount:', error);
      return 0;
    }
  }

  // Function to handle bulk update confirmation
  const handleBulkUpdateClick = async () => {
    console.log('Reimburse button clicked!'); // Debug log
    const count = await getTotalApprovedCount();
    console.log('Approved count:', count); // Debug log
    setPendingBulkUpdateCount(count);
    
    if (count === 0) {
      toast.info("No approved receipts found to reimburse");
      return;
    }
    
    setShowConfirmDialog(true);
  }

  // Function to perform bulk update
  const performBulkUpdate = async () => {
    setIsBulkUpdateLoading(true);
    setShowConfirmDialog(false);
    
    try {
      const response = await fetch('/api/receipts/bulk-update', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fromStatus: 'Approved',
          toStatus: 'Reimbursed'
        }),
      });

      const result: BulkUpdateResponse = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to update receipts');
      }

      if (result.success) {
        toast.success(result.message);
        // Refresh the receipts data
        window.location.reload();
      } else {
        throw new Error(result.error || 'Update failed');
      }

    } catch (error) {
      console.error('Bulk update error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An error occurred during bulk update';
      toast.error(`Failed to update receipts: ${errorMessage}`);
    } finally {
      setIsBulkUpdateLoading(false);
    }
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


  // Render immediately; do not gate the page behind a loading screen

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
    <div className="flex flex-col h-screen bg-[#222222] text-white">
      {/* Header - Assuming this might be part of a larger app layout eventually */}
      <div className="border-b border-[#444444]">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center"> {/* Assuming logo might come from a shared component or be static here */}
            <Image 
              src="/images/logo.png" 
              alt="Company Logo" 
              width={150} 
              height={30} 
              className="mr-3"
              priority
              style={{ width: 'auto', height: 'auto' }}
            /> {/* Adjusted size for typical header */}
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/batch-review">
              <Button
                variant="ghost"
                size="sm"
                // Using theme variables for secondary button like elements
                className="bg-[#333333] text-white hover:bg-[#444444]"
              >
                <ListChecks className="mr-2 h-4 w-4" />
                Review Receipts
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.location.reload()}
               // Using theme variables
              className="bg-[#333333] text-white hover:bg-[#444444]"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onLogout}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 overflow-y-auto">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Card with theme variables */}
          <Card className="bg-[#333333] text-white border-[#444444]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">Total Receipts</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-gray-400"
              >
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white">{totalReceipts}</div>
              <p className="text-xs text-gray-400">Total amount: ${totalAmount.toFixed(2)}</p>
            </CardContent>
          </Card>

          <Card className="bg-[#333333] text-white border-[#444444]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">Pending Review</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-gray-400"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white">{pendingCount}</div>
              <p className="text-xs text-gray-400">
                {totalReceipts > 0 ? Math.round((pendingCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#333333] text-white border-[#444444]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">Approved</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-gray-400"
              >
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <path d="M2 10h20" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white">{approvedCount}</div>
              <p className="text-xs text-gray-400">
                {totalReceipts > 0 ? Math.round((approvedCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#333333] text-white border-[#444444]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-300">Reimbursed</CardTitle>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="h-4 w-4 text-gray-400"
              >
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white">{reimbursedCount}</div>
              <p className="text-xs text-gray-400">
                {totalReceipts > 0 ? Math.round((reimbursedCount / totalReceipts) * 100) : 0}% of total receipts
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card className="bg-[#333333] text-white border-[#444444]">
            <CardHeader>
              <CardTitle>Receipt Management</CardTitle>
              <CardDescription className="text-gray-400">
                Review and manage employee receipts for reimbursement.
              </CardDescription>
            </CardHeader>
            {/* </CardHeader>  // Removed duplicate closing tag */}
            <CardContent>
              <Tabs
                value={activeTab}
                onValueChange={(value) => {
                  setActiveTab(value);
                  setFilterStatus(value);
                }}
                className="space-y-4"
              >
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
                  {/* TabsList using theme variables for secondary/muted background and foreground, active state uses primary or accent */}
                  <TabsList className="bg-[#444444] text-gray-300">
                    <TabsTrigger
                      value="all"
                      className="data-[state=active]:bg-[#2680FC] data-[state=active]:text-white"
                    >
                      All Receipts
                    </TabsTrigger>
                    <TabsTrigger
                      value="pending"
                      className="data-[state=active]:bg-[#2680FC] data-[state=active]:text-white"
                    >
                      Pending
                    </TabsTrigger>
                    <TabsTrigger
                      value="approved"
                      className="data-[state=active]:bg-[#2680FC] data-[state=active]:text-white"
                    >
                      Approved
                    </TabsTrigger>
                    <TabsTrigger
                      value="reimbursed"
                      className="data-[state=active]:bg-[#2680FC] data-[state=active]:text-white"
                    >
                      Reimbursed
                    </TabsTrigger>
                     <TabsTrigger
                      value="rejected"
                      className="data-[state=active]:bg-[#2680FC] data-[state=active]:text-white"
                    >
                      Rejected
                    </TabsTrigger>
                  </TabsList>
                  <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="search" className="sr-only">
                        Search
                      </Label>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-white" />
                        <Input
                          id="search"
                          placeholder="Search employee or description..."
                          className="w-full md:w-[270px] bg-[#444444] text-white border-[#555555] placeholder:text-white focus:border-[#2680FC] focus:ring-[#2680FC] pl-10"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                      </div>
                    </div>

                    {/* DateRangePicker needs internal styling review too, but its trigger button style is handled here */}
                    <DateRangePicker date={dateRange} onDateChange={handleDateChange} />

                    <Button
                      variant="ghost"
                      onClick={handleBulkUpdateClick}
                      disabled={isBulkUpdateLoading}
                      className="bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {isBulkUpdateLoading ? (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      ) : (
                        <CheckCircle className="mr-2 h-4 w-4" />
                      )}
                      {isBulkUpdateLoading ? "Processing..." : "Reimburse"}
                    </Button>

                    <Button
                      variant="ghost"
                      onClick={downloadPayrollCSV}
                      className="bg-[#444444] text-white hover:bg-[#555555]"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                </div>

                <TabsContent value="all" className="space-y-4">
                  <div className="w-full">
                    {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-64">
                         <p className="text-[#999999]">No receipts found for the current filters.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        currentPage={currentPage}
                        pageSize={pageSize}
                        onPageChange={handlePageChange}
                        onPageSizeChange={handlePageSizeChange}
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="pending" className="space-y-4">
                  <div className="w-full">
                     {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-64">
                         <p className="text-[#999999]">No pending receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        currentPage={currentPage}
                        pageSize={pageSize}
                        onPageChange={handlePageChange}
                        onPageSizeChange={handlePageSizeChange}
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="approved" className="space-y-4">
                  <div className="w-full">
                    {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-64">
                         <p className="text-[#999999]">No approved receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        currentPage={currentPage}
                        pageSize={pageSize}
                        onPageChange={handlePageChange}
                        onPageSizeChange={handlePageSizeChange}
                      />
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="reimbursed" className="space-y-4">
                  <div className="w-full">
                     {filteredReceipts.length === 0 && !loading && (
                       <div className="flex items-center justify-center h-64">
                         <p className="text-[#999999]">No reimbursed receipts found.</p>
                       </div>
                    )}
                    {filteredReceipts.length > 0 && (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        currentPage={currentPage}
                        pageSize={pageSize}
                        onPageChange={handlePageChange}
                        onPageSizeChange={handlePageSizeChange}
                      />
                    )}
                  </div>
                </TabsContent>
                 <TabsContent value="rejected" className="space-y-4">
                  <div className="w-full">
                    {loading ? null : filteredReceipts.length === 0 ? (
                       <div className="flex items-center justify-center h-64">
                         <p className="text-[#999999]">No rejected receipts found.</p>
                       </div>
                    ) : (
                       <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        currentPage={currentPage}
                        pageSize={pageSize}
                        onPageChange={handlePageChange}
                        onPageSizeChange={handlePageSizeChange}
                      />
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Selected rows info - positioned outside the Card component */}
        {selectedRows.size > 0 && (
          <div className="flex items-center justify-between p-3 bg-[#444444] text-gray-300 rounded-md border border-[#555555]">
            <p className="text-sm">{selectedRows.size} row(s) selected</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearSelection}
              className="bg-[#555555] text-white hover:bg-[#666666]"
            >
              Clear selection
            </Button>
          </div>
        )}

        {/* Pagination controls - positioned below selected rows info */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
          <div className="flex items-center space-x-2">
            <p className="text-sm text-gray-400">
              Showing {Math.min((currentPage - 1) * pageSize + 1, filteredReceipts.length)} to{" "}
              {Math.min(currentPage * pageSize, filteredReceipts.length)} of {filteredReceipts.length} entries
            </p>
          </div>
          
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
            <div className="flex items-center space-x-2">
              <p className="text-sm text-gray-400">Rows per page</p>
              <Select
                value={pageSize.toString()}
                onValueChange={(value) => handlePageSizeChange(Number(value))}
              >
                <SelectTrigger className="h-8 w-[70px] bg-[#444444] text-white border-[#555555]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#333333] text-white border-[#444444]">
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="flex items-center space-x-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="bg-[#444444] text-white hover:bg-[#555555] disabled:opacity-50"
              >
                Previous
              </Button>
              <div className="flex items-center space-x-1 px-3">
                <p className="text-sm text-gray-400">
                  Page {currentPage} of {totalPages}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="bg-[#444444] text-white hover:bg-[#555555] disabled:opacity-50"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="bg-[#333333] text-white border-[#444444]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-500" />
              Confirm Bulk Update
            </DialogTitle>
            <DialogDescription className="text-gray-300">
              Are you sure you want to mark {pendingBulkUpdateCount} approved receipt{pendingBulkUpdateCount !== 1 ? 's' : ''} as reimbursed?
              <br />
              <span className="text-yellow-300 font-medium">This action cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
              className="bg-transparent border-[#555555] text-white hover:bg-[#555555]"
            >
              Cancel
            </Button>
            <Button
              onClick={performBulkUpdate}
              disabled={isBulkUpdateLoading}
              className="bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {isBulkUpdateLoading ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Processing...
                </>
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Confirm Update
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
