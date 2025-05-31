"use client"

import type React from "react"
import { useState, useMemo } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Receipt } from "@/lib/types"

interface ReceiptTableProps {
  rowData?: Receipt[]
  height?: number | string
}

type SortField = keyof Receipt
type SortDirection = "asc" | "desc" | null

const ReceiptTable: React.FC<ReceiptTableProps> = ({ rowData = [], height = 500 }) => {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortField || !sortDirection) return rowData

    return [...rowData].sort((a, b) => {
      const aValue = a[sortField]
      const bValue = b[sortField]

      if (aValue < bValue) return sortDirection === "asc" ? -1 : 1
      if (aValue > bValue) return sortDirection === "asc" ? 1 : -1
      return 0
    })
  }, [rowData, sortField, sortDirection])

  // Paginate data
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return sortedData.slice(startIndex, startIndex + pageSize)
  }, [sortedData, currentPage, pageSize])

  const totalPages = Math.ceil(sortedData.length / pageSize)

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
      setSelectedRows(new Set(paginatedData.map((row) => row.id)))
    } else {
      setSelectedRows(new Set())
    }
  }

  const handleSelectRow = (id: string, checked: boolean) => {
    const newSelected = new Set(selectedRows)
    if (checked) {
      newSelected.add(id)
    } else {
      newSelected.delete(id)
    }
    setSelectedRows(newSelected)
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
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card" style={{ height }}>
        <div className="overflow-auto h-full">
          <Table>
            <TableHeader className="sticky top-0 bg-muted z-10"> {/* Changed bg for header */}
              <TableRow className="border-border hover:bg-accent"> {/* hover:bg-accent or similar */}
                <TableHead className="w-12 text-center">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={handleSelectAll}
                    ref={(el) => {
                      if (el) el.indeterminate = isIndeterminate
                    }}
                    // Standard ShadCN checkbox should pick up theme from globals.css
                    // className="border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                  />
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("jobCode")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Job Code
                    {getSortIcon("jobCode")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("date")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Date
                    {getSortIcon("date")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("employeeName")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Employee
                    {getSortIcon("employeeName")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("amount")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Amount
                    {getSortIcon("amount")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("category")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Category
                    {getSortIcon("category")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("description")}
                    className="h-auto p-0 font-medium text-foreground hover:bg-transparent hover:text-accent-foreground"
                  >
                    Description
                    {getSortIcon("description")}
                  </Button>
                </TableHead>
                <TableHead className="text-foreground text-center">Status</TableHead>
                <TableHead className="text-foreground text-center">Image</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.map((receipt) => (
                <TableRow key={receipt.id} className="border-border hover:bg-accent text-foreground">
                  <TableCell className="text-center">
                    <Checkbox
                      checked={selectedRows.has(receipt.id)}
                      onCheckedChange={(checked) => handleSelectRow(receipt.id, checked as boolean)}
                      // Standard ShadCN checkbox
                    />
                  </TableCell>
                  <TableCell>{receipt.jobCode}</TableCell> {/* Removed explicit text-white */}
                  <TableCell>{new Date(receipt.date).toLocaleDateString()}</TableCell>
                  <TableCell>{receipt.employeeName}</TableCell>
                  <TableCell>${receipt.amount.toFixed(2)}</TableCell>
                  <TableCell>{receipt.category}</TableCell>
                  <TableCell>{receipt.description}</TableCell>
                  <TableCell className="text-center">{getStatusBadge(receipt.status)}</TableCell>
                  <TableCell className="text-center">
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-secondary text-secondary-foreground hover:bg-muted border-border"
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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <p className="text-sm text-muted-foreground">
            Showing {Math.min((currentPage - 1) * pageSize + 1, sortedData.length)} to{" "}
            {Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length} entries
          </p>
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <p className="text-sm text-muted-foreground">Rows per page</p>
            <Select
              value={pageSize.toString()}
              onValueChange={(value) => {
                setPageSize(Number(value))
                setCurrentPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-[70px] bg-input text-foreground border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover text-popover-foreground border-border">
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="bg-secondary text-secondary-foreground hover:bg-muted border-border disabled:opacity-50"
            >
              Previous
            </Button>
            <div className="flex items-center space-x-1">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="bg-secondary text-secondary-foreground hover:bg-muted border-border disabled:opacity-50"
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      {/* Selected rows info */}
      {selectedRows.size > 0 && (
        <div className="flex items-center justify-between p-2 bg-muted text-muted-foreground rounded-md">
          <p className="text-sm">{selectedRows.size} row(s) selected</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedRows(new Set())}
            className="bg-secondary text-secondary-foreground hover:bg-accent border-border"
          >
            Clear selection
          </Button>
        </div>
      )}
    </div>
  )
}

export default ReceiptTable
