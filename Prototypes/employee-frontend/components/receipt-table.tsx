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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Your Receipts</h2>
        <Select
          value={filter}
          onValueChange={(value) => {
            setFilter(value)
            setCurrentPage(1) // Reset to first page when filter changes
          }}
        >
          <SelectTrigger className="w-[130px] bg-[#3e3e3e] border-[#4e4e4e]">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="reimbursed">Reimbursed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border border-[#4e4e4e] rounded-lg overflow-hidden bg-[#3e3e3e]">
        <Table>
          <TableHeader className="bg-[#3e3e3e]">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Photo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentReceipts.length > 0 ? (
              currentReceipts.map((receipt) => (
                <TableRow key={receipt.id} className="border-[#4e4e4e]">
                  <TableCell>{formatDate(receipt.date)}</TableCell>
                  <TableCell>{formatCurrency(receipt.amount)}</TableCell>
                  <TableCell>
                    <StatusBadge status={receipt.status} />
                  </TableCell>
                  <TableCell>
                    {receipt.driveLink ? (
                      <a
                        href={receipt.driveLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center text-blue-400 hover:text-blue-300 transition-colors"
                        aria-label={`View receipt photo for ${formatDate(receipt.date)}`}
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
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-4 text-muted-foreground">
                  No receipts found
                </TableCell>
              </TableRow>
            )}
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
                  disabled={currentPage === 1}
                  className={currentPage === 1 ? "opacity-50 cursor-not-allowed" : ""}
                />
              </PaginationItem>

              {/* Generate page links */}
              {Array.from({ length: totalPages }).map((_, index) => {
                const pageNumber = index + 1
                // Show first page, last page, and pages around current page
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
                      >
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  )
                }
                // Show ellipsis for gaps
                if (
                  (pageNumber === 2 && currentPage > 3) ||
                  (pageNumber === totalPages - 1 && currentPage < totalPages - 2)
                ) {
                  return <PaginationItem key={pageNumber}>...</PaginationItem>
                }
                return null
              })}

              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className={currentPage === totalPages ? "opacity-50 cursor-not-allowed" : ""}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}

      <div className="text-sm text-center text-gray-400">
        Showing {Math.min(filteredReceipts.length, 1 + (currentPage - 1) * ITEMS_PER_PAGE)}-
        {Math.min(filteredReceipts.length, currentPage * ITEMS_PER_PAGE)} of {filteredReceipts.length} receipts
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Receipt["status"] }) {
  const variants = {
    pending: "bg-yellow-900/30 text-yellow-300 hover:bg-yellow-900/30 border-yellow-800",
    approved: "bg-green-900/30 text-green-300 hover:bg-green-900/30 border-green-800",
    reimbursed: "bg-blue-900/30 text-blue-300 hover:bg-blue-900/30 border-blue-800",
    rejected: "bg-red-900/30 text-red-300 hover:bg-red-900/30 border-red-800",
  }

  return (
    <Badge variant="outline" className={variants[status]}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}
