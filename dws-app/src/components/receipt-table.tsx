"use client"

import { useState } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import type { Receipt } from "@/lib/types"
import { formatCurrency, formatDate } from "@/lib/utils" // Ensure these exist in dws-app/src/lib/utils.ts
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ExternalLink } from "lucide-react"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

interface ReceiptTableProps {
  receipts: Receipt[]
}

const ITEMS_PER_PAGE = 10

export default function ReceiptTable({ receipts }: ReceiptTableProps) {
  const [filter, setFilter] = useState<string>("all")
  const [currentPage, setCurrentPage] = useState(1)

  // Filter receipts based on status
  const filteredReceipts = filter === "all" ? receipts : receipts.filter((receipt) => receipt.status === filter)

  // Calculate total pages
  const totalPages = Math.max(1, Math.ceil(filteredReceipts.length / ITEMS_PER_PAGE))

  // Ensure current page is valid after filtering
  if (currentPage > totalPages) {
    // This state update should be wrapped in useEffect or handled differently to avoid potential issues
    // For now, keeping prototype logic. Consider:
    // useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages); }, [currentPage, totalPages]);
    setCurrentPage(totalPages) 
  }

  // Get current page receipts
  const currentReceipts = filteredReceipts.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE)

  // Handle page change
  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
    }
  }

  console.log("ReceiptTable: Received receipts prop:", JSON.stringify(receipts, null, 2)); // Log received props

  return (
    <div className="space-y-4 text-white"> {/* Added text-white for base text color in dark theme */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Your Receipts</h2>
        <Select
          value={filter}
          onValueChange={(value) => {
            setFilter(value)
            setCurrentPage(1) // Reset to first page when filter changes
          }}
        >
          <SelectTrigger className="w-[130px] bg-[#3e3e3e] border-[#4e4e4e] text-white">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent position="popper" className="bg-[#2e2e2e] text-white border-[#4e4e4e]">
            <SelectItem value="all" className="hover:bg-[#4e4e4e]">All</SelectItem>
            <SelectItem value="pending" className="hover:bg-[#4e4e4e]">Pending</SelectItem>
            <SelectItem value="approved" className="hover:bg-[#4e4e4e]">Approved</SelectItem>
            {/* <SelectItem value="reimbursed">Reimbursed</SelectItem> // Removed as per type alignment */}
            <SelectItem value="rejected" className="hover:bg-[#4e4e4e]">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border border-[#4e4e4e] rounded-lg overflow-hidden bg-[#2e2e2e]"> {/* Changed bg to #2e2e2e from prototype's #3e3e3e for table area */}
        <Table>
          <TableHeader className="bg-[#3e3e3e] hover:bg-[#3e3e3e]">{/* Ensure header bg doesn't change on hover if not desired */}
            <TableRow className="border-[#4e4e4e]">
              <TableHead className="text-white">Date</TableHead>
              <TableHead className="text-white">Amount</TableHead>
              <TableHead className="text-white">Status</TableHead>
              <TableHead className="text-white">Photo</TableHead>
            </TableRow></TableHeader>
          <TableBody>
            {currentReceipts.length > 0
              ? currentReceipts.map((receipt) => {
                  console.log("ReceiptTable: Rendering receipt in map:", JSON.stringify(receipt, null, 2)); // Log each receipt being mapped
                  return (<TableRow key={receipt.id} className="border-[#4e4e4e] hover:bg-[#383838]">
                    <TableCell>{receipt.receipt_date ? formatDate(receipt.receipt_date) : 'N/A'}</TableCell>
                    <TableCell>{formatCurrency(receipt.amount)}</TableCell>
                    <TableCell><StatusBadge status={receipt.status} /></TableCell>
                    <TableCell>
                      {receipt.image_url ? (
                        <a
                          href={receipt.image_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center text-blue-400 hover:text-blue-300 transition-colors"
                          aria-label={`View receipt photo for ${receipt.receipt_date ? formatDate(receipt.receipt_date) : 'this receipt'}`}
                        >
                          <span className="mr-1">View</span>
                          <ExternalLink size={14} />
                        </a>
                      ) : (
                        <span className="text-gray-500">No photo</span>
                      )}
                    </TableCell>
                  </TableRow>);
                })
              : (<TableRow className="border-[#4e4e4e] hover:bg-[#383838]">
                  <TableCell colSpan={4} className="text-center py-4 text-gray-400">
                    No receipts found
                  </TableCell>
                </TableRow>)
            }
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handlePageChange(currentPage - 1)}
                  // disabled={currentPage === 1} // className handles visual disabling
                  className={currentPage === 1 ? "opacity-50 cursor-not-allowed text-gray-600 hover:bg-transparent hover:text-gray-600" : "text-white hover:bg-[#4e4e4e]"}
                />
              </PaginationItem>

              {Array.from({ length: totalPages }).map((_, index) => {
                const pageNumber = index + 1
                if (
                  pageNumber === 1 ||
                  pageNumber === totalPages ||
                  (pageNumber >= currentPage - 1 && pageNumber <= currentPage + 1)
                ) {
                  return (
                    <PaginationItem key={pageNumber}>
                      <PaginationLink
                        isActive={pageNumber === currentPage}
                        onClick={() => handlePageChange(pageNumber)}
                        className={pageNumber === currentPage ? "bg-[#2680FC] text-white border-[#2680FC] hover:bg-[#2680FC]" : "text-white hover:bg-[#4e4e4e]"}
                      >
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  )
                }
                if (
                  (pageNumber === 2 && currentPage > 3) ||
                  (pageNumber === totalPages - 1 && currentPage < totalPages - 2)
                ) {
                  return <PaginationItem key={`ellipsis-${pageNumber}`} className="text-white">...</PaginationItem>
                }
                return null
              })}

              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(currentPage + 1)}
                  // disabled={currentPage === totalPages}
                  className={currentPage === totalPages ? "opacity-50 cursor-not-allowed text-gray-600 hover:bg-transparent hover:text-gray-600" : "text-white hover:bg-[#4e4e4e]"}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}

      <div className="text-sm text-center text-gray-400">
        Showing {currentReceipts.length > 0 ? Math.min(filteredReceipts.length, 1 + (currentPage - 1) * ITEMS_PER_PAGE) : 0}-
        {Math.min(filteredReceipts.length, currentPage * ITEMS_PER_PAGE)} of {filteredReceipts.length} receipts
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Receipt["status"] }) {
  const variants: Record<Receipt["status"], string> = { // Added type annotation for variants
    Pending: "bg-yellow-900/30 text-yellow-300 hover:bg-yellow-900/30 border-yellow-700",
    Approved: "bg-green-900/30 text-green-300 hover:bg-green-900/30 border-green-700",
    Rejected: "bg-red-900/30 text-red-300 hover:bg-red-900/30 border-red-700",
  };

  // The status prop itself will be capitalized (e.g., "Pending") due to the Receipt type.
  // The text display `status.charAt(0).toUpperCase() + status.slice(1)` will still work fine.
  return (
    <Badge variant="outline" className={`${variants[status]} text-xs px-2 py-0.5`}>
      {status}
    </Badge>
  )
}