"use client"

import type React from "react"
import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Upload, FileImage } from "lucide-react"
import { toast as sonnerToast } from "sonner"
import { useMobile } from "@/hooks/use-mobile"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
import type { Receipt } from "@/lib/types"

interface ReceiptUploaderProps {
  onReceiptAdded?: (receipt: Receipt) => void
}

interface OcrResponse {
  success: boolean
  data: {
    date: string | null
    amount: number | null
    category: string | null
    category_id: string | null
  }
  duplicate: {
    isDuplicate: boolean
    existingReceipts: { id: string; description: string }[]
  }
  canAutoSubmit: boolean
  error?: string
}

export default function ReceiptUploader({ onReceiptAdded }: ReceiptUploaderProps) {
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showDetailsCard, setShowDetailsCard] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [tempFilePathState, setTempFilePathState] = useState<string | null>(null)
  const [extractedData, setExtractedData] = useState<Partial<Receipt>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useMobile()

  const getUserAgent = () => {
    const ua = navigator.userAgent
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
    if (/Android/.test(ua)) return 'android'
    return 'other'
  }

  const getAcceptAttribute = () => {
    if (!isMobile) return "image/*,application/pdf"
    
    const platform = getUserAgent()
    switch (platform) {
      case 'ios':
        // iOS supports HEIC and optimized for Photos app integration
        return "image/heic,image/jpeg,image/png,image/webp,application/pdf"
      case 'android':
        return "image/*,application/pdf"
      default:
        return "image/*,application/pdf"
    }
  }

  const getButtonText = () => {
    return isMobile ? "Take Photo" : "Upload Receipt"
  }

  const getButtonIcon = () => {
    if (!isMobile) return <Upload className="mr-2 h-4 w-4" />
    return <FileImage className="mr-2 h-4 w-4" />
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessingFile(true)
    setUploadedFile(file)
    setExtractedData({})

    try {
      const formData = new FormData()
      formData.append("file", file)

      const uploadResponse = await fetch("/api/receipts/upload", {
        method: "POST",
        body: formData,
      })

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json()
        throw new Error(errorData.error || "Failed to pre-upload image for OCR.")
      }

      const uploadResult = await uploadResponse.json()
      if (!uploadResult.success || !uploadResult.tempFilePath) {
        throw new Error(uploadResult.error || "Image pre-upload did not return a valid path.")
      }

      const tempFilePath = uploadResult.tempFilePath
      setTempFilePathState(tempFilePath)

      sonnerToast.info("Extracting receipt details...", { id: "ocr-toast" })
      const ocrResponse = await fetch("/api/receipts/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tempFilePath }),
      })

      if (!ocrResponse.ok) {
        const errorData = await ocrResponse.json()
        sonnerToast.error("OCR Failed", { id: "ocr-toast", description: errorData.error || "Could not extract details." })
        setExtractedData({})
        setIsProcessingFile(false)
        setShowDetailsCard(true)
        return
      }

      const ocrResult: OcrResponse = await ocrResponse.json()

      const extractedReceiptData: Partial<Receipt> = {
        receipt_date: ocrResult.data.date || undefined,
        amount: ocrResult.data.amount !== null ? ocrResult.data.amount : undefined,
        category_id: ocrResult.data.category_id || undefined,
      }
      setExtractedData(extractedReceiptData)

      if (ocrResult.canAutoSubmit && extractedReceiptData.receipt_date &&
          extractedReceiptData.amount !== undefined && extractedReceiptData.category_id) {

        sonnerToast.dismiss("ocr-toast")
        await handleAutoSubmit(extractedReceiptData, tempFilePath)

      } else {
        setIsProcessingFile(false)

        if (ocrResult.duplicate?.isDuplicate) {
          sonnerToast.warning("Potential duplicate detected", {
            id: "ocr-toast",
            description: "A receipt with the same date and amount exists. Please add a description to differentiate.",
            duration: 5000
          })
        } else if (!ocrResult.data.date || ocrResult.data.amount === null || !ocrResult.data.category_id) {
          sonnerToast.info("Please confirm details", {
            id: "ocr-toast",
            description: "Some fields couldn't be extracted automatically.",
            duration: 3000
          })
        } else {
          sonnerToast.success("Details extracted!", { id: "ocr-toast", duration: 2000 })
        }

        setShowDetailsCard(true)
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "File processing error."
      sonnerToast.error("Processing Error", { id: "ocr-toast", description: errorMessage })
      setExtractedData({})
      setIsProcessingFile(false)
      setShowDetailsCard(true)
    }
  }

  const handleAutoSubmit = async (receiptData: Partial<Receipt>, tempFilePath: string) => {
    setIsSubmitting(true)

    try {
      const createReceiptPayload = {
        receipt_date: receiptData.receipt_date,
        amount: receiptData.amount,
        category_id: receiptData.category_id,
        notes: '', // Empty for auto-submit
        tempFilePath,
      }

      const createReceiptResponse = await fetch("/api/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createReceiptPayload),
      })

      if (!createReceiptResponse.ok) {
        const errorData = await createReceiptResponse.json()
        throw new Error(errorData.error || "Failed to create receipt record.")
      }

      const createReceiptResult = await createReceiptResponse.json()
      if (!createReceiptResult.success || !createReceiptResult.receipt) {
        throw new Error(createReceiptResult.error || "Receipt creation did not return a valid receipt.")
      }

      const createdReceipt = createReceiptResult.receipt

      if (onReceiptAdded) {
        onReceiptAdded(createdReceipt)
      }

      const formatToastDate = (dateStr: string | undefined) => {
        if (!dateStr) return "N/A"
        try {
          const date = new Date(dateStr)
          const month = date.getMonth() + 1
          const day = date.getDate()
          const year = date.getFullYear().toString().slice(-2)
          return `${month}/${day}/${year}`
        } catch {
          return dateStr
        }
      }

      sonnerToast.custom(
        (t) => (
          <div
            className="flex items-center justify-between w-full bg-[#2e2e2e] border border-[#4e4e4e] rounded-lg p-4 shadow-lg cursor-pointer"
            onClick={() => {
              sonnerToast.dismiss(t)
              setExtractedData({
                ...receiptData,
                id: createdReceipt.id,
              })
              setShowDetailsCard(true)
            }}
          >
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-white font-medium text-sm">Receipt submitted!</p>
                <p className="text-gray-400 text-xs">${receiptData.amount?.toFixed(2)} on {formatToastDate(receiptData.receipt_date)}</p>
              </div>
            </div>
            <span className="text-blue-400 text-sm font-medium">Tap to edit</span>
          </div>
        ),
        {
          id: "auto-submit-toast",
          duration: 5000,
        }
      )

      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
      setUploadedFile(null)
      setTempFilePathState(null)
      setExtractedData({})

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Auto-submit failed."

      // Fall back to showing dialog with extracted data
      sonnerToast.error("Auto-submit failed", {
        id: "auto-submit-toast",
        description: `${errorMessage}. Please review and submit manually.`,
        duration: 5000
      })
      setShowDetailsCard(true)

    } finally {
      setIsSubmitting(false)
      setIsProcessingFile(false)
    }
  }
  
  const handleDetailsSubmit = async (receiptData: Partial<Receipt>) => {
    if (!uploadedFile || !tempFilePathState) {
      sonnerToast.error("No file processed", { description: "Please select and process a receipt image first." })
      return
    }
    
         if (!receiptData.receipt_date || receiptData.amount === undefined || !receiptData.category_id) {
       sonnerToast.error("Missing details", { description: "Please fill in Date, Amount, and Category." })
       return
     }

    setIsSubmitting(true)
    sonnerToast.info("Submitting receipt...", { id: "upload-toast" })

    try {
      const createReceiptPayload = {
        ...receiptData,
        tempFilePath: tempFilePathState,
      }

      const createReceiptResponse = await fetch("/api/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createReceiptPayload),
      })

      if (!createReceiptResponse.ok) {
        const errorData = await createReceiptResponse.json()
        throw new Error(errorData.error || "Failed to create receipt record.")
      }

      const createReceiptResult = await createReceiptResponse.json()
      if (!createReceiptResult.success || !createReceiptResult.receipt) {
        throw new Error(createReceiptResult.error || "Receipt creation did not return a valid receipt.")
      }

      if (onReceiptAdded) {
        onReceiptAdded(createReceiptResult.receipt)
      }

      sonnerToast.success("Receipt uploaded successfully!", { id: "upload-toast" })
      setShowDetailsCard(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
      setUploadedFile(null)
      setTempFilePathState(null)
      setExtractedData({})

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred."
      sonnerToast.error("Submission failed", { id: "upload-toast", description: errorMessage })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    setShowDetailsCard(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
    setUploadedFile(null)
    setTempFilePathState(null)
    setExtractedData({})
  }

  return (
    <>
      <div className="w-full">
        <input
          type="file"
          id="receipt-upload"
          ref={fileInputRef}
          accept={getAcceptAttribute()}
          onChange={handleFileSelect}
          className="sr-only"
        />
        <label htmlFor="receipt-upload" className="w-full">
          <Button asChild className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white" size="lg" disabled={isProcessingFile || isSubmitting}>
            <span>
              {isProcessingFile ? "Processing File..." : isSubmitting ? "Submitting..." : (
                <>
                  {getButtonIcon()}
                  {getButtonText()}
                </>
              )}
            </span>
          </Button>
        </label>
      </div>

      {isMobile ? (
        <Drawer open={showDetailsCard} onOpenChange={setShowDetailsCard}>
          <DrawerContent className="bg-[#2e2e2e] border-[#4e4e4e]">
            <DrawerTitle className="sr-only">
              {extractedData?.id ? 'Edit Receipt Details' : 'Confirm Receipt Details'}
            </DrawerTitle>
            <div className="pb-4">
              <ReceiptDetailsCard
                onSubmit={handleDetailsSubmit}
                onCancel={handleCancel}
                initialData={extractedData}
                mode={extractedData?.id ? 'edit' : 'create'}
                receiptId={extractedData?.id as string | undefined}
                onEditSuccess={(updatedReceipt) => {
                  if (onReceiptAdded) {
                    onReceiptAdded(updatedReceipt)
                  }
                  setShowDetailsCard(false)
                  setExtractedData({})
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={showDetailsCard} onOpenChange={setShowDetailsCard}>
          <DialogContent className="sm:max-w-md bg-[#2e2e2e] p-0 border-none">
            <ReceiptDetailsCard
              onSubmit={handleDetailsSubmit}
              onCancel={handleCancel}
              initialData={extractedData}
              mode={extractedData?.id ? 'edit' : 'create'}
              receiptId={extractedData?.id as string | undefined}
              onEditSuccess={(updatedReceipt) => {
                if (onReceiptAdded) {
                  onReceiptAdded(updatedReceipt)
                }
                setShowDetailsCard(false)
                setExtractedData({})
              }}
            />
            <DialogTitle className="sr-only">
              {extractedData?.id ? 'Edit Receipt Details' : 'Confirm Receipt Details'}
            </DialogTitle>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}