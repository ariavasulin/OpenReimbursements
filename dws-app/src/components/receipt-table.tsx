"use client"

import type React from "react"
import { useState, useMemo, useEffect } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatDate } from "@/lib/utils"
import type { Receipt } from "@/lib/types"

interface ReceiptTableProps {
  rowData?: Receipt[]
  height?: number | string | "auto"
  selectedRows?: Set<string>
  onSelectedRowsChange?: (selectedRows: Set<string>) => void
  currentPage?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
}

type SortField = keyof Receipt
type SortDirection = "asc" | "desc" | null

const ReceiptTable: React.FC<ReceiptTableProps> = ({ 
  rowData = [], 
  height = "auto", 
  selectedRows: controlledSelectedRows,
  onSelectedRowsChange,
  currentPage = 1,
  pageSize = 10,
  onPageChange,
  onPageSizeChange
}) => {
  const [internalSelectedRows, setInternalSelectedRows] = useState<Set<string>>(new Set())
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)

  // Use controlled or internal state
  const selectedRows = controlledSelectedRows !== undefined ? controlledSelectedRows : internalSelectedRows

  // Notify parent when selected rows change (only for uncontrolled mode)
  useEffect(() => {
    if (controlledSelectedRows === undefined && onSelectedRowsChange) {
      onSelectedRowsChange(internalSelectedRows)
    }
  }, [internalSelectedRows, onSelectedRowsChange, controlledSelectedRows])

  // Handle selection changes
  const handleSelectedRowsChange = (newSelectedRows: Set<string>) => {
    if (controlledSelectedRows !== undefined) {
      // Controlled mode - notify parent
      onSelectedRowsChange?.(newSelectedRows)
    } else {
      // Uncontrolled mode - update internal state
      setInternalSelectedRows(newSelectedRows)
    }
  }

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortField || !sortDirection) return rowData

    return [...rowData].sort((a, b) => {
      const aValue = a[sortField];
      const bValue = b[sortField];

      // Handle undefined values by treating them as "lesser" or provide specific logic
      if (aValue === undefined && bValue === undefined) return 0;
      if (aValue === undefined) return sortDirection === "asc" ? -1 : 1;
      if (bValue === undefined) return sortDirection === "asc" ? 1 : -1;

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      }

      if (aValue < bValue) return sortDirection === "asc" ? -1 : 1;
      if (aValue > bValue) return sortDirection === "asc" ? 1 : -1;
      return 0;
    })
  }, [rowData, sortField, sortDirection])

  // Paginate data
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return sortedData.slice(startIndex, startIndex + pageSize)
  }, [sortedData, currentPage, pageSize])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDirection === "asc") {
        setSortDirection("desc")
      } else if (sortDirection === "desc") {
        setSortField(null)
        setSortDirection(null)
      } else {
        setSortDirection("asc")
      }
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
  }

  const getSortIcon = (field: SortField) => {
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
      handleSelectedRowsChange(new Set(paginatedData.map((row) => row.id)))
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

  const isAllSelected = paginatedData.length > 0 && paginatedData.every((row) => selectedRows.has(row.id))
  const isIndeterminate = paginatedData.some((row) => selectedRows.has(row.id)) && !isAllSelected

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
                    onClick={() => handleSort("employeeName")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                  >
                    Employee
                    {getSortIcon("employeeName")}
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.map((receipt) => (
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
    </div>
  )
}

export default ReceiptTable
