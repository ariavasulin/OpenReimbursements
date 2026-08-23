"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { Download, RefreshCw, ListChecks, LogOut, Search, CheckCircle, AlertCircle, Users } from "lucide-react"
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import ReceiptTable from "@/components/receipt-table"
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
import { formatCurrency } from "@/lib/utils"
import { normalizeReceiptSearch, receiptMatchesSearch } from "@/lib/receiptSearch"
import { toDbReceiptStatus, type Receipt, type BulkUpdateResponse } from "@/lib/types"
import { useAdminReceipts, useAdminReceiptCounts, useDeleteReceipt, useInvalidateAdminReceipts } from "@/hooks/use-admin-receipts"
import { useAdminPrefetch } from "@/hooks/use-admin-prefetch"
import type { ReceiptStatusFilter } from "@/hooks/use-receipts"

const TAB_EMPTY_MESSAGES = {
  all: "No receipts found for the current filters.",
  pending: "No pending receipts found.",
  approved: "No approved receipts found.",
  reimbursed: "No reimbursed receipts found.",
  rejected: "No rejected receipts found.",
}

export default function ReceiptDashboard({ onLogout }: { onLogout?: () => Promise<void> }) {
  useAdminPrefetch()

  const [activeTab, setActiveTab] = useState<ReceiptStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined,
  })

  const [isBulkUpdateLoading, setIsBulkUpdateLoading] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [pendingBulkUpdateCount, setPendingBulkUpdateCount] = useState(0)

  const [editingReceipt, setEditingReceipt] = useState<Receipt | null>(null)
  const [deletingReceipt, setDeletingReceipt] = useState<Receipt | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDateChange = (selectedDateRange: { from: Date | undefined; to: Date | undefined }) => {
    setDateRange({
      from: selectedDateRange?.from,
      to: selectedDateRange?.to,
    });
    setCurrentPage(1);
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
    setCurrentPage(1)
  }

  const fromDateParam = dateRange.from?.toISOString().split('T')[0]
  // toDate carries +1 day so the picked end date is included.
  const toDateParam = dateRange.to ? (() => {
    const toDate = new Date(dateRange.to)
    toDate.setDate(toDate.getDate() + 1)
    return toDate.toISOString().split('T')[0]
  })() : undefined

  // Only fetch when both dates are selected, or when no dates are selected
  const shouldFetch = !dateRange.from || Boolean(dateRange.from && dateRange.to)

  const {
    data: receiptsPage,
    isLoading: loading,
    error: queryError,
    refetch
  } = useAdminReceipts({
    status: activeTab,
    fromDate: fromDateParam,
    toDate: toDateParam,
    page: currentPage,
    pageSize,
    enabled: shouldFetch,
  })

  const rawReceipts = receiptsPage?.receipts ?? []
  const totalCount = receiptsPage?.totalCount ?? 0

  const { data: receiptCounts } = useAdminReceiptCounts({
    fromDate: fromDateParam,
    toDate: toDateParam,
    enabled: shouldFetch,
  })

  const error = queryError?.message || null
  const invalidateReceipts = useInvalidateAdminReceipts()
  const deleteReceiptMutation = useDeleteReceipt()

  const receipts: Receipt[] = rawReceipts.map((receipt: Receipt) => ({
    ...receipt,
    status: receipt.status.toLowerCase() as Receipt['status'],
  }))

  // Search filters the loaded page; the export sends the same term and applies
  // this matcher server-side.
  const normalizedSearch = normalizeReceiptSearch(searchQuery)
  const filteredReceipts = receipts.filter(receipt =>
    receiptMatchesSearch(receipt, normalizedSearch)
  )

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const downloadPayrollCSV = () => {
    const params = new URLSearchParams()
    if (activeTab !== 'all') {
      params.set('status', toDbReceiptStatus(activeTab))
    }
    if (fromDateParam) params.set('fromDate', fromDateParam)
    if (toDateParam) params.set('toDate', toDateParam)
    // Carry the search box through: the CSV must describe what the admin is
    // looking at, not everyone.
    if (normalizedSearch) params.set('q', normalizedSearch)
    window.location.href = `/api/admin/receipts/export?${params.toString()}`
  }

  const getTotalApprovedCount = async () => {
    try {
      const response = await fetch('/api/admin/receipts/status-counts');

      if (!response.ok) {
        return 0;
      }

      const result = await response.json();
      return result?.counts?.approved || 0;
    } catch (error) {
      return 0;
    }
  }

  const handleBulkUpdateClick = async () => {
    const count = await getTotalApprovedCount();
    setPendingBulkUpdateCount(count);
    
    if (count === 0) {
      toast.info("No approved receipts found to reimburse");
      return;
    }
    
    setShowConfirmDialog(true);
  }

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
        invalidateReceipts();
      } else {
        throw new Error(result.error || 'Update failed');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An error occurred during bulk update';
      toast.error(`Failed to update receipts: ${errorMessage}`);
    } finally {
      setIsBulkUpdateLoading(false);
    }
  }

  const handleDeleteReceipt = async () => {
    if (!deletingReceipt) return;
    setIsDeleting(true);
    try {
      await deleteReceiptMutation.mutateAsync(deletingReceipt.id);
      toast.success("Receipt deleted successfully");
      setDeletingReceipt(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete receipt");
    } finally {
      setIsDeleting(false);
    }
  }

  const handleEditSuccess = () => {
    setEditingReceipt(null);
    invalidateReceipts();
    toast.success("Receipt updated successfully");
  }

  // Counts come from a server-side aggregate so they're cap-proof and remain
  // correct regardless of how many receipts exist. Total amount is a window
  // aggregate over the full filtered set, computed by the paged RPC — the
  // client only ever receives one page of rows.
  const totalReceipts = receiptCounts?.total ?? 0
  const totalAmount = receiptsPage?.totalAmount ?? 0
  const pendingCount = receiptCounts?.pending ?? 0
  const approvedCount = receiptCounts?.approved ?? 0
  const reimbursedCount = receiptCounts?.reimbursed ?? 0

  if (error) {
    return (
      <div className="flex flex-col h-screen bg-[#2e2e2e] text-white items-center justify-center">
        <p className="text-red-500">Error loading receipts: {error}</p>
        <Button
          onClick={() => refetch()}
          className="mt-4"
        >
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#222222] text-white">
      <div className="border-b border-[#444444]">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center">
            <Image 
              src="/images/logo.png" 
              alt="Company Logo" 
              width={150} 
              height={30} 
              className="mr-3"
              priority
              style={{ width: 'auto', height: 'auto' }}
            />
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/users">
              <Button
                variant="ghost"
                size="sm"
                className="bg-[#333333] text-white hover:bg-[#444444]"
              >
                <Users className="mr-2 h-4 w-4" />
                Manage Users
              </Button>
            </Link>
            <Link href="/batch-review">
              <Button
                variant="ghost"
                size="sm"
                className="bg-[#333333] text-white hover:bg-[#444444]"
              >
                <ListChecks className="mr-2 h-4 w-4" />
                Review Receipts
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
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
            <CardContent>
              <Tabs
                value={activeTab}
                onValueChange={(value) => {
                  setActiveTab(value as ReceiptStatusFilter);
                  setCurrentPage(1); // pagination is server-driven; a new filter starts at page 1
                }}
                className="space-y-4"
              >
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
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

                {/* One body for every tab: the status filter is pushed to the
                    server, so all five tabs render the same fetched page and
                    differ only in what they say when it is empty. */}
                <TabsContent value={activeTab} className="space-y-4">
                  <div className="w-full">
                    {filteredReceipts.length === 0 && !loading && (
                      <div className="flex items-center justify-center h-64">
                        <p className="text-[#999999]">{TAB_EMPTY_MESSAGES[activeTab]}</p>
                      </div>
                    )}
                    {filteredReceipts.length > 0 && (
                      <ReceiptTable
                        rowData={filteredReceipts}
                        selectedRows={selectedRows}
                        onSelectedRowsChange={handleSelectedRowsChange}
                        onEdit={setEditingReceipt}
                        onDelete={setDeletingReceipt}
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
              Showing {Math.min((currentPage - 1) * pageSize + 1, totalCount)} to{" "}
              {Math.min(currentPage * pageSize, totalCount)} of {totalCount} entries
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingReceipt} onOpenChange={(open) => !open && setDeletingReceipt(null)}>
        <AlertDialogContent className="bg-[#333333] border-[#444444]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete Receipt?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-300">
              Are you sure you want to delete this receipt from <span className="font-semibold">{deletingReceipt?.employeeName}</span> for {deletingReceipt?.amount ? formatCurrency(deletingReceipt.amount) : '$0.00'}?
              <br /><br />
              <span className="text-red-400 font-medium">This action cannot be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isDeleting}
              className="bg-transparent border-[#555555] text-white hover:bg-[#555555]"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteReceipt}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? "Deleting..." : "Delete Receipt"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Receipt Dialog */}
      <Dialog open={!!editingReceipt} onOpenChange={(open) => !open && setEditingReceipt(null)}>
        <DialogContent className="bg-transparent border-none p-0 max-w-md">
          <DialogTitle className="sr-only">Edit Receipt</DialogTitle>
          {editingReceipt && (
            <ReceiptDetailsCard
              mode="edit"
              receiptId={editingReceipt.id}
              initialData={{
                receipt_date: editingReceipt.date,
                amount: editingReceipt.amount,
                category_id: editingReceipt.category_id,
                notes: editingReceipt.notes || editingReceipt.description,
                status: editingReceipt.status,
              }}
              onSubmit={() => {}} // Not used in edit mode
              onCancel={() => setEditingReceipt(null)}
              onEditSuccess={handleEditSuccess}
              onDelete={() => {
                setEditingReceipt(null);
                invalidateReceipts();
              }}
              isAdmin={true}
            />
          )}
        </DialogContent>
      </Dialog>

    </div>
  )
}
