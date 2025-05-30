"use client"

import type React from "react"
import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Upload, Camera } from "lucide-react"
import { toast as sonnerToast } from "sonner" // Renamed to avoid conflict if 'toast' is used elsewhere
import { useMobile } from "@/hooks/use-mobile"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog" // DialogHeader removed, DialogTitle kept
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
import { v4 as uuidv4 } from "uuid"
import type { Receipt } from "@/lib/types"

interface ReceiptUploaderProps {
  onReceiptAdded?: (receipt: Receipt) => void
}

export default function ReceiptUploader({ onReceiptAdded }: ReceiptUploaderProps) {
  const [isProcessingFile, setIsProcessingFile] = useState(false) // Renamed from isUploading for clarity
  const [isSubmitting, setIsSubmitting] = useState(false); // For the final submission step
  const [showDetailsCard, setShowDetailsCard] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [extractedData, setExtractedData] = useState<Partial<Receipt>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useMobile();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessingFile(true)
    setUploadedFile(file)

    // Simulate OCR processing (as per original logic, since OCR is out of scope for now)
    console.log("Simulating OCR for file:", file.name);
    setTimeout(() => {
      setIsProcessingFile(false)
      // initialData for ReceiptDetailsCard. Date, Amount, Category will be handled by the card.
      const mockExtractedData: Partial<Receipt> = {
        notes: "", // Can keep notes if we want to pre-fill from OCR in future, or leave empty
      }
      setExtractedData(mockExtractedData) // Pass minimal or empty initial data for details
      setShowDetailsCard(true)
    }, 1500)
  }

  const handleDetailsSubmit = async (receiptData: Partial<Receipt>) => {
    if (!uploadedFile) {
      sonnerToast.error("No file selected", { description: "Please select a receipt image to upload." });
      return;
    }
    // Use receipt_date for validation
    if (!receiptData.receipt_date || receiptData.amount === undefined || !receiptData.category_id) {
        sonnerToast.error("Missing details", { description: "Please fill in Date, Amount, and Category." });
        return;
    }


    setIsSubmitting(true);
    sonnerToast.info("Uploading receipt...", { id: "upload-toast" });

    try {
      // Step 1: Upload the file to get a temporary path
      const formData = new FormData();
      formData.append("file", uploadedFile);

      const uploadResponse = await fetch("/api/receipts/upload", {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json();
        throw new Error(errorData.error || "Failed to upload image.");
      }

      const uploadResult = await uploadResponse.json();
      if (!uploadResult.success || !uploadResult.tempFilePath) {
        throw new Error(uploadResult.error || "Image upload did not return a valid path.");
      }

      // Step 2: Create the receipt record with the temporary file path
      const createReceiptPayload = {
        ...receiptData, // date, amount, category_id, notes
        tempFilePath: uploadResult.tempFilePath,
      };

      const createReceiptResponse = await fetch("/api/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createReceiptPayload),
      });

      if (!createReceiptResponse.ok) {
        const errorData = await createReceiptResponse.json();
        throw new Error(errorData.error || "Failed to create receipt record.");
      }

      const createReceiptResult = await createReceiptResponse.json();
      if (!createReceiptResult.success || !createReceiptResult.receipt) {
        throw new Error(createReceiptResult.error || "Receipt creation did not return a valid receipt.");
      }

      if (onReceiptAdded) {
        onReceiptAdded(createReceiptResult.receipt);
      }

      sonnerToast.success("Receipt uploaded successfully!", { id: "upload-toast" });
      setShowDetailsCard(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadedFile(null);

    } catch (error) {
      console.error("Error submitting receipt:", error);
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
      sonnerToast.error("Submission failed", { id: "upload-toast", description: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setShowDetailsCard(false)
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
          accept="image/*,application/pdf" // Added PDF as per PRD
          capture={isMobile ? "environment" : undefined}
          onChange={handleFileSelect} // Changed to handleFileSelect
          className="sr-only"
        />
        <label htmlFor="receipt-upload" className="w-full">
          <Button asChild className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white" size="lg" disabled={isProcessingFile || isSubmitting}>
            <span>
              {isProcessingFile ? "Processing File..." : isSubmitting ? "Submitting..." : (
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
        <DialogContent className="sm:max-w-md bg-[#2e2e2e] p-0 border-none"> {/* Dialog content is now dark and has no padding/border */}
          {/* The DialogHeader has been removed. */}
          {/* The wrapping div has been removed, ReceiptDetailsCard is now a direct child. */}
          <ReceiptDetailsCard
            onSubmit={handleDetailsSubmit}
            onCancel={handleCancel}
            initialData={extractedData}
          />
          <DialogTitle className="sr-only">Confirm Receipt Details</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
}