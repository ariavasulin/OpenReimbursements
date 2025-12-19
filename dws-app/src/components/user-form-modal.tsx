"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2 } from "lucide-react"
import { isValidUSPhoneNumber } from "@/lib/phone"
import type { AdminUser } from "@/lib/types"

interface UserFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  user?: AdminUser | null
  onSuccess: (user: AdminUser) => void
}

interface FormData {
  phone: string
  full_name: string
  preferred_name: string
  employee_id_internal: string
  role: "employee" | "admin"
}

export function UserFormModal({
  open,
  onOpenChange,
  mode,
  user,
  onSuccess,
}: UserFormModalProps) {
  const [formData, setFormData] = useState<FormData>({
    phone: "",
    full_name: "",
    preferred_name: "",
    employee_id_internal: "",
    role: "employee",
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when modal opens/closes or mode changes
  useEffect(() => {
    if (open) {
      if (mode === "edit" && user) {
        // Strip +1 from phone for display
        const phoneDisplay = user.phone?.replace(/^\+1/, "") || ""
        setFormData({
          phone: phoneDisplay,
          full_name: user.full_name || "",
          preferred_name: user.preferred_name || "",
          employee_id_internal: user.employee_id_internal || "",
          role: user.role || "employee",
        })
      } else {
        setFormData({
          phone: "",
          full_name: "",
          preferred_name: "",
          employee_id_internal: "",
          role: "employee",
        })
      }
      setError(null)
    }
  }, [open, mode, user])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validate required fields
    if (!formData.phone.trim() || !formData.full_name.trim()) {
      setError("Phone and full name are required")
      return
    }

    // Validate phone format
    if (!isValidUSPhoneNumber(formData.phone)) {
      setError("Please enter a valid 10-digit US phone number")
      return
    }

    setIsSubmitting(true)

    try {
      const url = mode === "create"
        ? "/api/admin/users"
        : `/api/admin/users/${user?.id}`

      const method = mode === "create" ? "POST" : "PATCH"

      const body: Record<string, string | undefined> = {
        phone: formData.phone,
        full_name: formData.full_name,
        role: formData.role,
      }

      // Only include optional fields if they have values
      if (formData.preferred_name.trim()) {
        body.preferred_name = formData.preferred_name.trim()
      }
      if (formData.employee_id_internal.trim()) {
        body.employee_id_internal = formData.employee_id_internal.trim()
      }

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || `Failed to ${mode} user`)
      }

      onSuccess(data.user)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleChange = (field: keyof FormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#333333] text-white border-[#444444] sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "Add New User" : "Edit User"}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {mode === "create"
                ? "Create a new user account with phone number authentication."
                : "Update user details. Changing the phone number will sign out the user."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <div className="text-sm text-red-400 bg-red-900/30 p-3 rounded-md">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="phone" className="text-white">
                Phone Number <span className="text-red-400">*</span>
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={formData.phone}
                onChange={(e) => handleChange("phone", e.target.value)}
                className="bg-[#444444] text-white border-[#555555] placeholder:text-gray-500"
                disabled={isSubmitting}
                autoComplete="tel"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="full_name" className="text-white">
                Full Name <span className="text-red-400">*</span>
              </Label>
              <Input
                id="full_name"
                type="text"
                placeholder="Last, First"
                value={formData.full_name}
                onChange={(e) => handleChange("full_name", e.target.value)}
                className="bg-[#444444] text-white border-[#555555] placeholder:text-gray-500"
                disabled={isSubmitting}
              />
              <p className="text-xs text-gray-400">Format: Last, First (e.g., Smith, John)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="preferred_name" className="text-white">
                Preferred Name
              </Label>
              <Input
                id="preferred_name"
                type="text"
                placeholder="Johnny"
                value={formData.preferred_name}
                onChange={(e) => handleChange("preferred_name", e.target.value)}
                className="bg-[#444444] text-white border-[#555555] placeholder:text-gray-500"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="employee_id_internal" className="text-white">
                Employee ID
              </Label>
              <Input
                id="employee_id_internal"
                type="text"
                placeholder="EMP001"
                value={formData.employee_id_internal}
                onChange={(e) => handleChange("employee_id_internal", e.target.value)}
                className="bg-[#444444] text-white border-[#555555] placeholder:text-gray-500"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role" className="text-white">
                Role <span className="text-red-400">*</span>
              </Label>
              <Select
                value={formData.role}
                onValueChange={(value) => handleChange("role", value)}
                disabled={isSubmitting}
              >
                <SelectTrigger className="bg-[#444444] text-white border-[#555555]">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent className="bg-[#333333] text-white border-[#444444]">
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="bg-transparent border-[#555555] text-white hover:bg-[#555555]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {mode === "create" ? "Creating..." : "Saving..."}
                </>
              ) : (
                mode === "create" ? "Create User" : "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
