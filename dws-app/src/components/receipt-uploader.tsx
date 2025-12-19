"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Upload, FileImage } from "lucide-react"
import { toast as sonnerToast } from "sonner"
import { useMobile } from "@/hooks/use-mobile"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
import type { Receipt } from "@/lib/types"

interface ReceiptUploaderProps {
  onReceiptAdded?: (receipt: Receipt) => void
}

// OCR API response type
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

  // Development helper to test platform detection
  const testPlatformDetection = () => {
    const platform = getUserAgent()
    const acceptAttr = getAcceptAttribute()
    const buttonText = getButtonText()
    
    console.log('Platform Detection Test:', {
      isMobile,
      platform,
      userAgent: navigator.userAgent,
      acceptAttribute: acceptAttr,
      buttonText,
      timestamp: new Date().toISOString()
    })
  }

     // Run platform detection test in development
   if (process.env.NODE_ENV === 'development') {
     // Test on component mount
     useEffect(() => {
       testPlatformDetection()
     }, [])
   }

  // Helper function to detect user's platform
  const getUserAgent = () => {
    const ua = navigator.userAgent
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
    if (/Android/.test(ua)) return 'android'
    return 'other'
  }

  // Helper function to get platform-specific accept attribute
  const getAcceptAttribute = () => {
    if (!isMobile) return "image/*,application/pdf"
    
    const platform = getUserAgent()
    switch (platform) {
      case 'ios':
        // iOS supports HEIC and optimized for Photos app integration
        return "image/heic,image/jpeg,image/png,image/webp,application/pdf"
      case 'android':
        // Android optimized for Gallery and Camera apps
        return "image/*,application/pdf"
      default:
        return "image/*,application/pdf"
    }
  }

  // Helper function to get button text (consistent across platforms)
  const getButtonText = () => {
    return isMobile ? "Take Photo" : "Upload Receipt"
  }

  // Helper function to get appropriate icon
  const getButtonIcon = () => {
    if (!isMobile) return <Upload className="mr-2 h-4 w-4" />
    return <FileImage className="mr-2 h-4 w-4" />
  }

  // Helper function to detect if user took a photo vs selected existing file
  const detectUserBehavior = (file: File) => {
    const fileAge = Date.now() - file.lastModified
    const isRecentFile = fileAge < 30000 // Within last 30 seconds
    const hasPhotoName = /^IMG_|^PHOTO_|^image_|^Camera/i.test(file.name)
    const isLikelyPhoto = isRecentFile || hasPhotoName
    
    // Enhanced feedback based on user behavior
    const platform = getUserAgent()
    const behaviorContext = {
      platform,
      isLikelyPhoto,
      fileName: file.name,
      fileAge: fileAge / 1000,
      fileSize: file.size,
      fileType: file.type,
      lastModified: new Date(file.lastModified).toISOString()
    }
    
    // Log for analytics (could be sent to analytics service)
    console.log(`User selected: ${isLikelyPhoto ? 'camera' : 'existing file'}`, behaviorContext)
    
    // Provide contextual toast feedback
    if (isLikelyPhoto) {
      sonnerToast.info("Photo captured", { 
        description: "Processing your photo...",
        id: "capture-feedback" 
      })
    } else {
      sonnerToast.info("File selected", { 
        description: "Processing your file...",
        id: "capture-feedback" 
      })
    }
    
    return behaviorContext
  }

  // Enhanced file validation with platform-specific feedback
  const validateFile = (file: File) => {
    const platform = getUserAgent()
    
    // Check file size with platform-specific limits
    const maxSize = isMobile ? 50 * 1024 * 1024 : 10 * 1024 * 1024 // 50MB mobile, 10MB desktop
    if (file.size > maxSize) {
      const sizeLimit = isMobile ? '50MB' : '10MB'
      sonnerToast.error("File too large", { 
        description: `Please select a file smaller than ${sizeLimit}` 
      })
      return false
    }
    
    // Check file type with helpful feedback
    const allowedTypes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'application/pdf'
    ]
    
    if (!allowedTypes.includes(file.type)) {
      const suggestion = platform === 'ios' 
        ? "Please use your camera or select a photo from your library"
        : "Please use your camera or select an image from your gallery"
      
      sonnerToast.error("Unsupported file type", { 
        description: suggestion 
      })
      return false
    }
    
    return true
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessingFile(true)
    setUploadedFile(file)
    setExtractedData({})

    // Detect and log user behavior
    if (isMobile) {
      detectUserBehavior(file)
    }

    try {
      // Step 1: Upload the file to get a temporary path (for OCR)
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

      // Step 2: Call OCR API with the temporary file path
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

      // Store extracted data for potential dialog use
      const extractedReceiptData: Partial<Receipt> = {
        receipt_date: ocrResult.data.date || undefined,
        amount: ocrResult.data.amount !== null ? ocrResult.data.amount : undefined,
        category_id: ocrResult.data.category_id || undefined,
      }
      setExtractedData(extractedReceiptData)

      // Step 3: Decide whether to auto-submit or show dialog
      if (ocrResult.canAutoSubmit && extractedReceiptData.receipt_date &&
          extractedReceiptData.amount !== undefined && extractedReceiptData.category_id) {

        // Auto-submit the receipt
        sonnerToast.dismiss("ocr-toast")
        await handleAutoSubmit(extractedReceiptData, tempFilePath)

      } else {
        // Show confirmation dialog - either fields missing or duplicate detected
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
      console.error("Error during file processing or OCR:", error)
      const errorMessage = error instanceof Error ? error.message : "File processing error."
      sonnerToast.error("Processing Error", { id: "ocr-toast", description: errorMessage })
      setExtractedData({})
      setIsProcessingFile(false)
      setShowDetailsCard(true)
    }
  }

  // New function for auto-submit with undo toast
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

      // Notify parent of new receipt
      if (onReceiptAdded) {
        onReceiptAdded(createdReceipt)
      }

      // Show success toast with Edit action
      sonnerToast.success("Receipt submitted!", {
        id: "auto-submit-toast",
        description: `$${receiptData.amount?.toFixed(2)} on ${receiptData.receipt_date}`,
        duration: 5000,
        action: {
          label: "Edit",
          onClick: () => {
            // Open the details card in edit mode with the created receipt
            setExtractedData({
              ...receiptData,
              id: createdReceipt.id,
            })
            setShowDetailsCard(true)
          }
        }
      })

      // Reset uploader state
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
      setUploadedFile(null)
      setTempFilePathState(null)
      setExtractedData({})

    } catch (error) {
      console.error("Error during auto-submit:", error)
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
      console.error("Error submitting receipt:", error)
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

      <Dialog open={showDetailsCard} onOpenChange={setShowDetailsCard}>
        <DialogContent className="sm:max-w-md bg-[#2e2e2e] p-0 border-none">
          <ReceiptDetailsCard
            onSubmit={handleDetailsSubmit}
            onCancel={handleCancel}
            initialData={extractedData}
            // If extractedData has an id, we're editing an auto-submitted receipt
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
    </>
  )
}