"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDate } from "@/lib/utils"
import type { Receipt, ReceiptSortField } from "@/lib/types"

export type ReceiptSortDirection = "asc" | "desc"
export interface ReceiptSort {
  field: ReceiptSortField
  direction: ReceiptSortDirection
}

// Renders exactly the rows it is handed, in the order it is handed them.
// Sorting and paging happen server-side: the header controls only report the
// requested sort to the caller, which sends it with the page request.
interface ReceiptTableProps {
  rowData?: Receipt[]
  height?: number | string | "auto"
  selectedRows?: Set<string>
  onSelectedRowsChange?: (selectedRows: Set<string>) => void
  onEdit?: (receipt: Receipt) => void
  onDelete?: (receipt: Receipt) => void
  showActions?: boolean
  sort: ReceiptSort | null
  onSortChange: (sort: ReceiptSort | null) => void
}

const ReceiptTable: React.FC<ReceiptTableProps> = ({
  rowData = [],
  height = "auto",
  selectedRows: controlledSelectedRows,
  onSelectedRowsChange,
  onEdit,
  onDelete,
  showActions = true,
  sort,
  onSortChange,
}) => {
  const [internalSelectedRows, setInternalSelectedRows] = useState<Set<string>>(new Set())
  const sortField = sort?.field ?? null
  const sortDirection = sort?.direction ?? null

  const selectedRows = controlledSelectedRows !== undefined ? controlledSelectedRows : internalSelectedRows

  useEffect(() => {
    if (controlledSelectedRows === undefined && onSelectedRowsChange) {
      onSelectedRowsChange(internalSelectedRows)
    }
  }, [internalSelectedRows, onSelectedRowsChange, controlledSelectedRows])

  const handleSelectedRowsChange = (newSelectedRows: Set<string>) => {
    if (controlledSelectedRows !== undefined) {
      onSelectedRowsChange?.(newSelectedRows)
    } else {
      setInternalSelectedRows(newSelectedRows)
    }
  }

  // asc -> desc -> default order, per column.
  const handleSort = (field: ReceiptSortField) => {
    if (sortField !== field) {
      onSortChange({ field, direction: "asc" })
    } else if (sortDirection === "asc") {
      onSortChange({ field, direction: "desc" })
    } else {
      onSortChange(null)
    }
  }

  const getSortIcon = (field: ReceiptSortField) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="ml-2 h-4 w-4" />
    }
    if (sortDirection === "asc") {
      return <ChevronUp className="ml-2 h-4 w-4" />
    }
    if (sortDirection === "desc") {
      return <ChevronDown className="ml-2 h-4 w-4" />
    }
    return <ChevronsUpDown className="ml-2 h-4 w-4" />
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      handleSelectedRowsChange(new Set(rowData.map((row) => row.id)))
    } else {
      handleSelectedRowsChange(new Set())
    }
  }

  const handleSelectRow = (id: string, checked: boolean) => {
    const newSelected = new Set(selectedRows)
    if (checked) {
      newSelected.add(id)
    } else {
      newSelected.delete(id)
    }
    handleSelectedRowsChange(newSelected)
  }

  const isAllSelected = rowData.length > 0 && rowData.every((row) => selectedRows.has(row.id))
  const isIndeterminate = rowData.some((row) => selectedRows.has(row.id)) && !isAllSelected

  const formatPhoneNumber = (phone: string | null | undefined) => {
    if (!phone) return "N/A"

    const cleaned = phone.replace(/\D/g, '')

    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`
    } else if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`
    }

    return phone
  }

  const getStatusBadge = (status: string) => {
    const variants = {
      pending: "bg-yellow-500/30 text-yellow-300 border-yellow-500/30",
      approved: "bg-green-500/30 text-green-300 border-green-500/30",
      reimbursed: "bg-blue-500/30 text-blue-300 border-blue-500/30",
      rejected: "bg-red-500/30 text-red-300 border-red-500/30",
    }

    return (
      <Badge
        variant="outline"
        className={`capitalize ${variants[status as keyof typeof variants] || "bg-gray-500/30 text-gray-300 border-gray-500/30"}`}
      >
        {status}
      </Badge>
    )
  }

  return (
      <div className="rounded-md border border-[#444444] bg-[#333333]" style={{ height: height === "auto" ? "fit-content" : height }}>
        <div className="overflow-visible">
          <Table>
            <TableHeader className="bg-[#444444]">
            <TableRow className="border-[#444444] hover:bg-[#555555]">
              <TableHead className="w-12 text-center p-3">
                  <Checkbox
                    checked={isIndeterminate ? 'indeterminate' : isAllSelected}
                    onCheckedChange={handleSelectAll}
                  className="border-white data-[state=checked]:border-white data-[state=checked]:bg-[#444444] data-[state=checked]:text-white data-[state=indeterminate]:text-white data-[state=indeterminate]:bg-[#444444]"
                  />
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("date")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Date
                    {getSortIcon("date")}
                </div>
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("employee")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Employee
                    {getSortIcon("employee")}
                </div>
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("phone")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Phone
                    {getSortIcon("phone")}
                </div>
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("amount")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Amount
                    {getSortIcon("amount")}
                </div>
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("category")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Category
                    {getSortIcon("category")}
                </div>
                </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                    onClick={() => handleSort("description")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Description
                    {getSortIcon("description")}
                </div>
                </TableHead>
              <TableHead className="text-white text-center p-3">Status</TableHead>
              <TableHead className="text-white text-center p-3">Image</TableHead>
              {showActions && (
                <TableHead className="text-white text-center p-3 w-20">Actions</TableHead>
              )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowData.map((receipt) => (
                <TableRow key={receipt.id} className="border-[#444444] hover:bg-[#555555] text-white">
                <TableCell className="text-center p-3">
                    <Checkbox
                      checked={selectedRows.has(receipt.id)}
                      onCheckedChange={(checked) => handleSelectRow(receipt.id, checked as boolean)}
                    className="border-white data-[state=checked]:border-white data-[state=checked]:bg-[#444444] data-[state=checked]:text-white"
                    />
                  </TableCell>
                <TableCell className="text-left p-3">{formatDate(receipt.date)}</TableCell>
                <TableCell className="text-left p-3">{receipt.employeeName}</TableCell>
                <TableCell className="text-left p-3">{formatPhoneNumber(receipt.phone)}</TableCell>
                <TableCell className="text-left p-3">${receipt.amount.toFixed(2)}</TableCell>
                <TableCell className="text-left p-3">{receipt.category}</TableCell>
                <TableCell className="text-left p-3">{receipt.description}</TableCell>
                <TableCell className="text-center p-3">{getStatusBadge(receipt.status)}</TableCell>
                <TableCell className="text-center p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-[#444444] text-white hover:bg-[#555555] border-[#555555]"
                      onClick={() => {
                        if (receipt.image_url) {
                          window.open(receipt.image_url, "_blank", "noopener,noreferrer");
                        } else {
                          alert("No image URL available for this receipt.");
                        }
                      }}
                    >
                      View
                    </Button>
                  </TableCell>
                  {showActions && (
                    <TableCell className="text-center p-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 hover:bg-[#555555]">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-[#333333] border-[#444444]">
                          <DropdownMenuItem
                            onClick={() => onEdit?.(receipt)}
                            className="text-white hover:bg-[#444444] cursor-pointer"
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onDelete?.(receipt)}
                            className="text-red-400 hover:bg-[#444444] hover:text-red-300 cursor-pointer"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
    </div>
  )
}

export default ReceiptTable
