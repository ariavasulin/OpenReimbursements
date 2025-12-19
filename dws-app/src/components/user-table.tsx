"use client"

import type React from "react"
import { useState, useMemo } from "react"
import { ChevronUp, ChevronDown, ChevronsUpDown, MoreHorizontal, Pencil, Ban } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatPhoneForDisplay } from "@/lib/phone"
import type { AdminUser } from "@/lib/types"

interface UserTableProps {
  users: AdminUser[]
  onEdit?: (user: AdminUser) => void
  onBan?: (user: AdminUser) => void
  currentUserId?: string // To disable ban for self
}

type SortField = keyof AdminUser
type SortDirection = "asc" | "desc" | null

// Test account phone numbers to hide
const HIDDEN_TEST_PHONES = ["1234567", "7654321"]

const UserTable: React.FC<UserTableProps> = ({
  users,
  onEdit,
  onBan,
  currentUserId,
}) => {
  const [sortField, setSortField] = useState<SortField | null>("full_name")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")

  // Filter and sort data
  const sortedData = useMemo(() => {
    const filtered = users.filter(u => !HIDDEN_TEST_PHONES.some(p => u.phone.endsWith(p)))

    if (!sortField || !sortDirection) return filtered

    return [...filtered].sort((a, b) => {
      const aValue = a[sortField]
      const bValue = b[sortField]

      if (aValue === undefined && bValue === undefined) return 0
      if (aValue === undefined) return sortDirection === "asc" ? -1 : 1
      if (bValue === undefined) return sortDirection === "asc" ? 1 : -1

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue)
      }

      if (aValue < bValue) return sortDirection === "asc" ? -1 : 1
      if (aValue > bValue) return sortDirection === "asc" ? 1 : -1
      return 0
    })
  }, [users, sortField, sortDirection])

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

  const getRoleBadge = (role: string) => {
    if (role === "admin") {
      return (
        <Badge
          variant="outline"
          className="bg-yellow-500/30 text-yellow-300 border-yellow-500/30"
        >
          Admin
        </Badge>
      )
    }
    return (
      <Badge
        variant="outline"
        className="bg-gray-500/30 text-gray-300 border-gray-500/30"
      >
        Employee
      </Badge>
    )
  }

  const getDisplayName = (user: AdminUser) => {
    if (!user.full_name) return "Unknown"
    // Convert "Lastname, Firstname" to "Firstname Lastname"
    const parts = user.full_name.split(", ")
    if (parts.length === 2) {
      return `${parts[1]} ${parts[0]}`
    }
    return user.full_name
  }

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return "N/A"
    return new Date(dateString).toLocaleDateString()
  }

  return (
    <div className="rounded-md border border-[#444444] bg-[#333333] overflow-auto">
        <Table>
          <TableHeader className="bg-[#444444]">
            <TableRow className="border-[#444444] hover:bg-[#555555]">
              <TableHead className="text-white text-left p-3">
                <div
                  onClick={() => handleSort("full_name")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                >
                  Name
                  {getSortIcon("full_name")}
                </div>
              </TableHead>
              <TableHead className="text-white text-left p-3">
                Nickname
              </TableHead>
              <TableHead className="text-white text-left p-3">
                Phone
              </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                  onClick={() => handleSort("role")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                >
                  Role
                  {getSortIcon("role")}
                </div>
              </TableHead>
              <TableHead className="text-white text-left p-3">
                Employee ID
              </TableHead>
              <TableHead className="text-white text-left p-3">
                <div
                  onClick={() => handleSort("created_at")}
                  className="cursor-pointer font-medium text-white hover:text-gray-300 flex items-center justify-start"
                >
                  Created
                  {getSortIcon("created_at")}
                </div>
              </TableHead>
              <TableHead className="text-white text-center p-3 w-20">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedData.length === 0 ? (
              <TableRow className="border-[#444444]">
                <TableCell colSpan={7} className="text-center p-8 text-gray-400">
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              sortedData.map((user) => (
                <TableRow key={user.id} className="border-[#444444] hover:bg-[#555555] text-white">
                  <TableCell className="text-left p-3">{getDisplayName(user)}</TableCell>
                  <TableCell className="text-left p-3">{user.preferred_name || "—"}</TableCell>
                  <TableCell className="text-left p-3">{formatPhoneForDisplay(user.phone)}</TableCell>
                  <TableCell className="text-left p-3">{getRoleBadge(user.role)}</TableCell>
                  <TableCell className="text-left p-3">{user.employee_id_internal || "N/A"}</TableCell>
                  <TableCell className="text-left p-3">{formatDate(user.created_at)}</TableCell>
                  <TableCell className="text-center p-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 hover:bg-[#555555]">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-[#333333] border-[#444444]">
                        <DropdownMenuItem
                          onClick={() => onEdit?.(user)}
                          className="text-white hover:bg-[#444444] cursor-pointer"
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onBan?.(user)}
                          disabled={user.id === currentUserId}
                          className="text-red-400 hover:bg-[#444444] hover:text-red-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Ban className="mr-2 h-4 w-4" />
                          Ban User
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
    </div>
  )
}

export default UserTable
