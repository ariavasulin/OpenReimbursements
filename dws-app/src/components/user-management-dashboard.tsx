"use client"

import { useState, useEffect } from "react"
import Image from "next/image"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ArrowLeft, Search, UserPlus, RefreshCw, Loader2, LogOut } from "lucide-react"
import { toast } from "sonner"
import UserTable from "@/components/user-table"
import { UserFormModal } from "@/components/user-form-modal"
import { BanUserDialog } from "@/components/ban-user-dialog"
import type { AdminUser } from "@/lib/types"
import { useAdminUsers, useInvalidateAdminUsers } from "@/hooks/use-admin-users"

interface UserManagementDashboardProps {
  currentUserId?: string
  onLogout?: () => Promise<void>
}

export default function UserManagementDashboard({
  currentUserId,
  onLogout,
}: UserManagementDashboardProps) {
  // Use React Query for cached data fetching
  const { data: users = [], isLoading, error: queryError, refetch } = useAdminUsers()
  const invalidateUsers = useInvalidateAdminUsers()
  const error = queryError?.message || null

  const [filteredUsers, setFilteredUsers] = useState<AdminUser[]>([])
  const [searchQuery, setSearchQuery] = useState("")

  // Modal states
  const [showUserForm, setShowUserForm] = useState(false)
  const [formMode, setFormMode] = useState<"create" | "edit">("create")
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [showBanDialog, setShowBanDialog] = useState(false)
  const [userToBan, setUserToBan] = useState<AdminUser | null>(null)

  // Filter users based on search query
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredUsers(users)
      return
    }

    const query = searchQuery.toLowerCase()
    const filtered = users.filter(user => {
      const fullName = (user.full_name || "").toLowerCase()
      const preferredName = (user.preferred_name || "").toLowerCase()
      const phone = (user.phone || "").toLowerCase()
      const employeeId = (user.employee_id_internal || "").toLowerCase()

      return fullName.includes(query) ||
             preferredName.includes(query) ||
             phone.includes(query) ||
             employeeId.includes(query)
    })

    setFilteredUsers(filtered)
  }, [users, searchQuery])

  const handleAddUser = () => {
    setFormMode("create")
    setSelectedUser(null)
    setShowUserForm(true)
  }

  const handleEditUser = (user: AdminUser) => {
    setFormMode("edit")
    setSelectedUser(user)
    setShowUserForm(true)
  }

  const handleBanUser = (user: AdminUser) => {
    setUserToBan(user)
    setShowBanDialog(true)
  }

  const handleFormSuccess = () => {
    if (formMode === "create") {
      toast.success("User created successfully")
    } else {
      toast.success("User updated successfully")
    }
    // Invalidate cache to refetch users
    invalidateUsers()
  }

  const handleBanSuccess = () => {
    toast.success("User has been banned")
    // Invalidate cache to refetch users
    invalidateUsers()
  }

  return (
    <div className="flex flex-col h-screen bg-[#222222] text-white">
      {/* Header */}
      <div className="border-b border-[#444444]">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center">
            <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" priority style={{ width: 'auto', height: 'auto' }} />
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/dashboard">
              <Button
                variant="ghost"
                size="sm"
                className="bg-[#333333] text-white hover:bg-[#444444]"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Button>
            </Link>
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

      {/* Main Content */}
      <div className="flex-1 p-4 md:p-8 pt-6 overflow-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Manage Users</h1>
          <p className="text-gray-400">
            Create, edit, and manage user accounts and permissions.
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-6">
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search by name, phone, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-[#333333] text-white border-[#444444] placeholder:text-gray-500"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refetch()}
              disabled={isLoading}
              className="bg-[#333333] border-[#444444] text-white hover:bg-[#444444]"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
            <Button
              onClick={handleAddUser}
              className="bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Add User
            </Button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="text-red-400 bg-red-900/30 p-3 rounded-md mb-4">
            {error}
          </div>
        )}

        {/* User count */}
        <div className="text-sm text-gray-400 mb-4">
          {filteredUsers.length} user{filteredUsers.length !== 1 ? "s" : ""}
          {searchQuery && ` matching "${searchQuery}"`}
        </div>

        {/* Table */}
        {isLoading && users.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : (
          <UserTable
            users={filteredUsers}
            onEdit={handleEditUser}
            onBan={handleBanUser}
            currentUserId={currentUserId}
          />
        )}
      </div>

      {/* User form modal */}
      <UserFormModal
        open={showUserForm}
        onOpenChange={setShowUserForm}
        mode={formMode}
        user={selectedUser}
        onSuccess={handleFormSuccess}
      />

      {/* Ban confirmation dialog */}
      <BanUserDialog
        open={showBanDialog}
        onOpenChange={setShowBanDialog}
        user={userToBan}
        onSuccess={handleBanSuccess}
      />
    </div>
  )
}
