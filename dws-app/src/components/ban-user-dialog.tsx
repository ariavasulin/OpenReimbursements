"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Loader2, AlertTriangle } from "lucide-react"
import type { AdminUser } from "@/lib/types"

interface BanUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: AdminUser | null
  onSuccess: () => void
}

export function BanUserDialog({
  open,
  onOpenChange,
  user,
  onSuccess,
}: BanUserDialogProps) {
  const [isBanning, setIsBanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleBan = async () => {
    if (!user) return

    setError(null)
    setIsBanning(true)

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to ban user")
      }

      onSuccess()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setIsBanning(false)
    }
  }

  const displayName = user?.preferred_name || user?.full_name || "this user"

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="bg-[#333333] border-[#444444]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-white flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            Ban User?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-gray-300 space-y-3">
            <p>
              Are you sure you want to ban <span className="font-semibold text-white">{displayName}</span>?
            </p>
            <div className="bg-[#444444] p-3 rounded-md text-sm">
              <p className="font-medium text-gray-200 mb-2">This will:</p>
              <ul className="list-disc list-inside space-y-1 text-gray-400">
                <li>Prevent the user from logging in</li>
                <li>Sign out all active sessions</li>
                <li>Preserve their receipt history</li>
              </ul>
            </div>
            {error && (
              <div className="text-red-400 bg-red-900/30 p-3 rounded-md">
                {error}
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isBanning}
            className="bg-transparent border-[#555555] text-white hover:bg-[#555555]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleBan}
            disabled={isBanning}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {isBanning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Banning...
              </>
            ) : (
              "Ban User"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
