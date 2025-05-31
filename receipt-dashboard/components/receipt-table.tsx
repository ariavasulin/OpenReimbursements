"use client"

import type React from "react"
import { useState, useMemo } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// Define the interface directly in this file
interface IReceipt {
  id: string
  employeeName: string
  employeeId: string
  date: Date
  amount: number
  category: string
  description: string
  status: "pending" | "approved" | "rejected" | "reimbursed"
  imageUrl: string
  jobCode: string
}

interface ReceiptTableProps {
  rowData?: IReceipt[]
  height?: number | string
}

type SortField = keyof IReceipt
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
      <div className="rounded-md border border-[#3e3e3e] bg-[#2e2e2e]" style={{ height }}>
        <div className="overflow-auto h-full">
          <Table>
            <TableHeader className="sticky top-0 bg-[#3a3a3a] z-10">
              <TableRow className="border-[#555] hover:bg-[#3a3a3a]">
                <TableHead className="w-12 text-center">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={handleSelectAll}
                    ref={(el) => {
                      if (el) el.indeterminate = isIndeterminate
                    }}
                    className="border-white data-[state=checked]:bg-white data-[state=checked]:text-[#2e2e2e]"
                  />
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("jobCode")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Job Code
                    {getSortIcon("jobCode")}
                  </Button>
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("date")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Date
                    {getSortIcon("date")}
                  </Button>
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("employeeName")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Employee
                    {getSortIcon("employeeName")}
                  </Button>
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("amount")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Amount
                    {getSortIcon("amount")}
                  </Button>
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("category")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Category
                    {getSortIcon("category")}
                  </Button>
                </TableHead>
                <TableHead className="text-white">
                  <Button
                    variant="ghost"
                    onClick={() => handleSort("description")}
                    className="h-auto p-0 font-medium text-white hover:bg-transparent hover:text-white"
                  >
                    Description
                    {getSortIcon("description")}
                  </Button>
                </TableHead>
                <TableHead className="text-white text-center">Status</TableHead>
                <TableHead className="text-white text-center">Image</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.map((receipt) => (
                <TableRow key={receipt.id} className="border-[#555] hover:bg-[#333333] text-white">
                  <TableCell className="text-center">
                    <Checkbox
                      checked={selectedRows.has(receipt.id)}
                      onCheckedChange={(checked) => handleSelectRow(receipt.id, checked as boolean)}
                      className="border-white data-[state=checked]:bg-white data-[state=checked]:text-[#2e2e2e]"
                    />
                  </TableCell>
                  <TableCell className="text-white">{receipt.jobCode}</TableCell>
                  <TableCell className="text-white">{receipt.date.toLocaleDateString()}</TableCell>
                  <TableCell className="text-white">{receipt.employeeName}</TableCell>
                  <TableCell className="text-white">${receipt.amount.toFixed(2)}</TableCell>
                  <TableCell className="text-white">{receipt.category}</TableCell>
                  <TableCell className="text-white">{receipt.description}</TableCell>
                  <TableCell className="text-center">{getStatusBadge(receipt.status)}</TableCell>
                  <TableCell className="text-center">
                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-[#3e3e3e] hover:bg-[#4a4a4a] text-white border-[#3e3e3e] hover:border-[#4a4a4a]"
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
          <p className="text-sm text-[#999999]">
            Showing {Math.min((currentPage - 1) * pageSize + 1, sortedData.length)} to{" "}
            {Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length} entries
          </p>
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <p className="text-sm text-[#999999]">Rows per page</p>
            <Select
              value={pageSize.toString()}
              onValueChange={(value) => {
                setPageSize(Number(value))
                setCurrentPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-[70px] bg-[#3e3e3e] text-white border-[#3e3e3e]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#3e3e3e] text-white border-[#3e3e3e]">
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
              className="bg-[#3e3e3e] hover:bg-[#4a4a4a] text-white border-[#3e3e3e] hover:border-[#4a4a4a] disabled:opacity-50"
            >
              Previous
            </Button>
            <div className="flex items-center space-x-1">
              <p className="text-sm text-[#999999]">
                Page {currentPage} of {totalPages}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="bg-[#3e3e3e] hover:bg-[#4a4a4a] text-white border-[#3e3e3e] hover:border-[#4a4a4a] disabled:opacity-50"
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      {/* Selected rows info */}
      {selectedRows.size > 0 && (
        <div className="flex items-center justify-between p-2 bg-[#3e3e3e] rounded-md">
          <p className="text-sm text-white">{selectedRows.size} row(s) selected</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedRows(new Set())}
            className="bg-[#2e2e2e] hover:bg-[#4a4a4a] text-white border-[#555] hover:border-[#666]"
          >
            Clear selection
          </Button>
        </div>
      )}
    </div>
  )
}

export default ReceiptTable
