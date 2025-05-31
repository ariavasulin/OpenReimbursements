"use client"

import { useState } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import type { Receipt } from "@/lib/types"
import { formatCurrency, formatDate } from "@/lib/utils"
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

interface EmployeeReceiptTableProps {
  receipts: Receipt[]
}

const ITEMS_PER_PAGE = 10

export default function EmployeeReceiptTable({ receipts }: EmployeeReceiptTableProps) {
  const [filter, setFilter] = useState<string>("all")
  const [currentPage, setCurrentPage] = useState(1)

  // Filter receipts based on status
  const filteredReceipts = filter === "all" ? receipts : receipts.filter((receipt) => {
    // Handle both capitalized and lowercase statuses
    return receipt.status.toLowerCase() === filter.toLowerCase()
  })

  // Calculate total pages
  const totalPages = Math.max(1, Math.ceil(filteredReceipts.length / ITEMS_PER_PAGE))

  // Ensure current page is valid after filtering
  if (currentPage > totalPages && totalPages > 0) {
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

  return (
    <div className="space-y-4 text-white">
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
            <SelectItem value="rejected" className="hover:bg-[#4e4e4e]">Rejected</SelectItem>
            <SelectItem value="reimbursed" className="hover:bg-[#4e4e4e]">Reimbursed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border border-[#4e4e4e] rounded-lg overflow-hidden bg-[#2e2e2e]">
        <Table>
          <TableHeader className="bg-[#3e3e3e] hover:bg-[#3e3e3e]">
            <TableRow className="border-[#4e4e4e]">
              <TableHead className="text-white">Date</TableHead>
              <TableHead className="text-white">Amount</TableHead>
              <TableHead className="text-white">Status</TableHead>
              <TableHead className="text-white">Photo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentReceipts.length > 0
              ? currentReceipts.map((receipt) => (
                  <TableRow key={receipt.id} className="border-[#4e4e4e] hover:bg-[#383838]">
                    <TableCell>{receipt.date ? formatDate(receipt.date) : 'N/A'}</TableCell>
                    <TableCell>{formatCurrency(receipt.amount)}</TableCell>
                    <TableCell><StatusBadge status={receipt.status} /></TableCell>
                    <TableCell>
                      {receipt.image_url ? (
                        <a
                          href={receipt.image_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center text-blue-400 hover:text-blue-300 transition-colors"
                          aria-label={`View receipt photo for ${receipt.date ? formatDate(receipt.date) : 'this receipt'}`}
                        >
                          <span className="mr-1">View</span>
                          <ExternalLink size={14} />
                        </a>
                      ) : (
                        <span className="text-gray-500">No photo</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              : (
                  <TableRow className="border-[#4e4e4e] hover:bg-[#383838]">
                    <TableCell colSpan={4} className="text-center py-4 text-gray-400">
                      No receipts found
                    </TableCell>
                  </TableRow>
                )
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
  const normalizedStatus = status.toLowerCase()
  
  const variants: Record<string, string> = {
    pending: "bg-yellow-900/30 text-yellow-300 hover:bg-yellow-900/30 border-yellow-700",
    approved: "bg-green-900/30 text-green-300 hover:bg-green-900/30 border-green-700",
    rejected: "bg-red-900/30 text-red-300 hover:bg-red-900/30 border-red-700",
    reimbursed: "bg-blue-900/30 text-blue-300 hover:bg-blue-900/30 border-blue-700",
  }

  // Capitalize the first letter for display
  const displayStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()

  return (
    <Badge variant="outline" className={`${variants[normalizedStatus] || variants.pending} text-xs px-2 py-0.5`}>
      {displayStatus}
    </Badge>
  )
} 