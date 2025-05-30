"use client"

import type React from "react"

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Upload, Camera } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useMobile } from "@/hooks/use-mobile"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
import { v4 as uuidv4 } from "uuid"
import type { Receipt } from "@/lib/types"

interface ReceiptUploaderProps {
  onReceiptAdded?: (receipt: Receipt) => void
}

export default function ReceiptUploader({ onReceiptAdded }: ReceiptUploaderProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [showDetailsCard, setShowDetailsCard] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [extractedData, setExtractedData] = useState<Partial<Receipt>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const isMobile = useMobile()

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    setUploadedFile(file)

    // Simulate OCR processing
    setTimeout(() => {
      setIsUploading(false)

      // Mock extracted data (in a real app, this would come from OCR)
      const mockExtractedData = {
        date: new Date().toISOString().split("T")[0],
        amount: Math.floor(Math.random() * 200) + 10 + Math.random().toFixed(2),
        category: "other",
        notes: "",
      }

      setExtractedData(mockExtractedData)
      setShowDetailsCard(true)
    }, 1500)
  }

  const handleDetailsSubmit = (receiptData: Partial<Receipt>) => {
    // Create a new receipt with the submitted data
    const newReceipt: Receipt = {
      id: `rec-${uuidv4().slice(0, 8)}`,
      date: receiptData.date || new Date().toISOString().split("T")[0],
      amount: receiptData.amount || 0,
      status: "pending",
      category: receiptData.category,
      notes: receiptData.notes,
      driveLink: `https://drive.google.com/file/d/${uuidv4()}/view`,
    }

    // Call the onReceiptAdded callback if provided
    if (onReceiptAdded) {
      onReceiptAdded(newReceipt)
    }

    // Close the dialog
    setShowDetailsCard(false)

    // Show success toast
    toast({
      title: "Receipt submitted",
      description: "Your receipt has been uploaded and added to your list.",
    })

    // Reset the file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
    setUploadedFile(null)
  }

  const handleCancel = () => {
    setShowDetailsCard(false)
    // Reset the file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
    setUploadedFile(null)
  }

  return (
    <>
      <div className="w-full">
        <input
          type="file"
          id="receipt-upload"
          ref={fileInputRef}
          accept="image/*"
          capture={isMobile ? "environment" : undefined}
          onChange={handleUpload}
          className="sr-only"
        />
        <label htmlFor="receipt-upload">
          <Button className="w-full" size="lg" disabled={isUploading} asChild>
            <span>
              {isUploading ? (
                "Processing..."
              ) : (
                <>
                  {isMobile ? <Camera className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
                  {isMobile ? "Take Photo" : "Upload Receipt"}
                </>
              )}
            </span>
          </Button>
        </label>
      </div>

      <Dialog open={showDetailsCard} onOpenChange={setShowDetailsCard}>
        <DialogContent className="sm:max-w-md p-0 bg-transparent border-none">
          <ReceiptDetailsCard onSubmit={handleDetailsSubmit} onCancel={handleCancel} initialData={extractedData} />
        </DialogContent>
      </Dialog>
    </>
  )
}
