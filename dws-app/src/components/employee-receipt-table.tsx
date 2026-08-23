"use client"

import { useState } from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { Receipt, ReceiptStatusFilter } from "@/lib/types"
import { formatCurrency, formatDate, formatDateShort } from "@/lib/utils"
import { useMobile } from "@/hooks/use-mobile"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ExternalLink, Pencil } from "lucide-react"
import { ReceiptDetailsCard } from "@/components/receipt-details-card"

interface EmployeeReceiptTableProps {
  receipts: Receipt[]
  /** Owned by the page: it is a query parameter of the receipts request. */
  statusFilter: ReceiptStatusFilter
  onStatusFilterChange: (status: ReceiptStatusFilter) => void
  onReceiptUpdated?: (updatedReceipt: Receipt) => void
  /** The rows belong to the previous filter while the new one is in flight. */
  isStale: boolean
}

export default function EmployeeReceiptTable({
  receipts,
  statusFilter,
  onStatusFilterChange,
  onReceiptUpdated,
  isStale,
}: EmployeeReceiptTableProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null)
  const [contactAdminReceipt, setContactAdminReceipt] = useState<Receipt | null>(null)
  const isMobile = useMobile()

  const handleEditClick = (receipt: Receipt) => {
    if (receipt.status.toLowerCase() === 'pending') {
      setSelectedReceipt(receipt)
      setEditDialogOpen(true)
    } else {
      setContactAdminReceipt(receipt)
    }
  }

  const handleEditSuccess = (updatedReceipt: Receipt) => {
    setEditDialogOpen(false)
    setSelectedReceipt(null)
    if (onReceiptUpdated) {
      onReceiptUpdated(updatedReceipt)
    }
  }

  return (
    <div className="space-y-4 text-white">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Your Receipts</h2>
        <Select
          value={statusFilter}
          onValueChange={(value) => onStatusFilterChange(value as ReceiptStatusFilter)}
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

      <div
        className={`border border-[#4e4e4e] rounded-lg overflow-hidden bg-[#2e2e2e] transition-opacity ${isStale ? "opacity-50" : ""}`}
        aria-busy={isStale}
      >
        <Table>
          <TableHeader className="bg-[#3e3e3e] hover:bg-[#3e3e3e]">
            <TableRow className="border-[#4e4e4e]">
              <TableHead className="text-white text-xs sm:text-sm px-1.5 sm:px-2">Date</TableHead>
              <TableHead className="text-white text-xs sm:text-sm px-1.5 sm:px-2">Amount</TableHead>
              <TableHead className="text-white text-xs sm:text-sm px-1.5 sm:px-2">Status</TableHead>
              <TableHead className="text-white text-xs sm:text-sm px-1.5 sm:px-2 w-[1%] whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipts.length > 0
              ? receipts.map((receipt) => (
                  <TableRow key={receipt.id} className="border-[#4e4e4e] hover:bg-[#383838]">
                    <TableCell className="text-xs sm:text-sm px-1.5 sm:px-2">
                      {receipt.date ? (isMobile ? formatDateShort(receipt.date) : formatDate(receipt.date)) : 'N/A'}
                    </TableCell>
                    <TableCell className="text-xs sm:text-sm px-1.5 sm:px-2">{formatCurrency(receipt.amount)}</TableCell>
                    <TableCell className="px-1.5 sm:px-2"><StatusBadge status={receipt.status} /></TableCell>
                    <TableCell className="px-1.5 sm:px-2">
                      <div className="flex items-center">
                        {receipt.image_url && (
                          <a
                            href={receipt.image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 transition-colors p-1 sm:p-1.5"
                            aria-label={`View receipt photo for ${receipt.date ? formatDate(receipt.date) : 'this receipt'}`}
                          >
                            <ExternalLink size={isMobile ? 14 : 16} />
                          </a>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditClick(receipt)}
                          className="text-blue-400 hover:text-blue-300 hover:bg-[#4e4e4e] p-1 sm:p-1.5 h-auto min-w-0"
                          aria-label={`Edit receipt from ${receipt.date ? formatDate(receipt.date) : 'this date'}`}
                        >
                          <Pencil size={isMobile ? 14 : 16} />
                        </Button>
                      </div>
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

      <div className="text-sm text-center text-gray-400">
        {isStale
          ? "Loading…"
          : `${receipts.length} loaded`}
      </div>

      {/* Edit Receipt - Drawer on mobile, Dialog on desktop */}
      {isMobile ? (
        <Drawer open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DrawerContent className="bg-[#2e2e2e] border-[#4e4e4e]">
            <DrawerTitle className="sr-only">Edit Receipt</DrawerTitle>
            <div className="pb-4">
              {selectedReceipt && (
                <ReceiptDetailsCard
                  mode="edit"
                  receiptId={selectedReceipt.id}
                  initialData={{
                    receipt_date: selectedReceipt.date,
                    amount: selectedReceipt.amount,
                    category_id: selectedReceipt.category_id,
                    notes: selectedReceipt.notes || selectedReceipt.description,
                  }}
                  onSubmit={() => {}}
                  onCancel={() => setEditDialogOpen(false)}
                  onEditSuccess={handleEditSuccess}
                  onDelete={() => {
                    setEditDialogOpen(false)
                    setSelectedReceipt(null)
                    onReceiptUpdated?.({} as Receipt)
                  }}
                />
              )}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="bg-transparent border-none p-0 max-w-md">
            <DialogTitle className="sr-only">Edit Receipt</DialogTitle>
            {selectedReceipt && (
              <ReceiptDetailsCard
                mode="edit"
                receiptId={selectedReceipt.id}
                initialData={{
                  receipt_date: selectedReceipt.date,
                  amount: selectedReceipt.amount,
                  category_id: selectedReceipt.category_id,
                  notes: selectedReceipt.notes || selectedReceipt.description,
                }}
                onSubmit={() => {}}
                onCancel={() => setEditDialogOpen(false)}
                onEditSuccess={handleEditSuccess}
                onDelete={() => {
                  setEditDialogOpen(false)
                  setSelectedReceipt(null)
                  onReceiptUpdated?.({} as Receipt)
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Contact Admin Dialog */}
      <AlertDialog open={!!contactAdminReceipt} onOpenChange={(open) => !open && setContactAdminReceipt(null)}>
        <AlertDialogContent className="bg-[#333333] border-[#444444]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Cannot Edit Receipt</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-300">
              This receipt has been <span className="font-semibold capitalize">{contactAdminReceipt?.status}</span> and cannot be modified.
              <br /><br />
              Please contact your system administrator if you need to make changes to this receipt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="bg-[#2680FC] hover:bg-[#1a6cd9]">
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

  const displayStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()

  return (
    <Badge variant="outline" className={`${variants[normalizedStatus] || variants.pending} text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5`}>
      {displayStatus}
    </Badge>
  )
} 