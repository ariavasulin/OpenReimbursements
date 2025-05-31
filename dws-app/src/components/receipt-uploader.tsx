"use client"

import type React from "react"
import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Upload, Camera } from "lucide-react"
import { toast as sonnerToast } from "sonner" // Renamed to avoid conflict if 'toast' is used elsewhere
import { useMobile } from "@/hooks/use-mobile"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog" // DialogHeader removed, DialogTitle kept, DialogDescription removed
import { ReceiptDetailsCard } from "@/components/receipt-details-card"
// import { v4 as uuidv4 } from "uuid" // Unused import
import type { Receipt } from "@/lib/types"

interface ReceiptUploaderProps {
  onReceiptAdded?: (receipt: Receipt) => void
}

export default function ReceiptUploader({ onReceiptAdded }: ReceiptUploaderProps) {
  const [isProcessingFile, setIsProcessingFile] = useState(false) // Renamed from isUploading for clarity
  const [isSubmitting, setIsSubmitting] = useState(false); // For the final submission step
  const [showDetailsCard, setShowDetailsCard] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [tempFilePathState, setTempFilePathState] = useState<string | null>(null); // Store tempFilePath
  const [extractedData, setExtractedData] = useState<Partial<Receipt>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobile = useMobile();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessingFile(true)
    setUploadedFile(file)
    // Reset previously extracted data
    setExtractedData({});

    try {
      // Step 1: Upload the file to get a temporary path (for OCR)
      const formData = new FormData();
      formData.append("file", file);

      const uploadResponse = await fetch("/api/receipts/upload", {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json();
        throw new Error(errorData.error || "Failed to pre-upload image for OCR.");
      }

      const uploadResult = await uploadResponse.json();
      if (!uploadResult.success || !uploadResult.tempFilePath) {
        throw new Error(uploadResult.error || "Image pre-upload did not return a valid path.");
      }

      const tempFilePath = uploadResult.tempFilePath;
      setTempFilePathState(tempFilePath); // Store it in state

      // Step 2: Call OCR API with the temporary file path
      sonnerToast.info("Extracting receipt details...", { id: "ocr-toast" });
      const ocrResponse = await fetch("/api/receipts/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tempFilePath }),
      });

      if (!ocrResponse.ok) {
        const errorData = await ocrResponse.json();
        sonnerToast.error("OCR Failed", { id: "ocr-toast", description: errorData.error || "Could not extract details." });
        // Proceed without OCR data
        setExtractedData({});
      } else {
        const ocrResult = await ocrResponse.json();
        if (ocrResult.success && ocrResult.data) {
          sonnerToast.success("Details extracted!", { id: "ocr-toast", duration: 2000 });
          setExtractedData({
            receipt_date: ocrResult.data.date || undefined, // Ensure undefined if null
            amount: ocrResult.data.amount !== null ? ocrResult.data.amount : undefined, // Ensure undefined if null
            // notes will remain manual or can be set if vendor was extracted
          });
        } else {
          sonnerToast.warning("OCR: No details found", { id: "ocr-toast", description: ocrResult.error || "Could not find date or amount." });
          setExtractedData({});
        }
      }
    } catch (error) {
      console.error("Error during file processing or OCR:", error);
      const errorMessage = error instanceof Error ? error.message : "File processing error.";
      sonnerToast.error("Processing Error", { id: "ocr-toast", description: errorMessage });
      setExtractedData({}); // Ensure form is blank on error
    } finally {
      setIsProcessingFile(false)
        setShowDetailsCard(true) // Show card regardless of OCR success for manual input/correction
      }
    }
  
    const handleDetailsSubmit = async (receiptData: Partial<Receipt>) => {
      if (!uploadedFile || !tempFilePathState) { // Check for tempFilePathState as well
        sonnerToast.error("No file processed", { description: "Please select and process a receipt image first." });
        return;
      }
      // Use receipt_date for validation
      if (!receiptData.receipt_date || receiptData.amount === undefined || !receiptData.category_id) {
          sonnerToast.error("Missing details", { description: "Please fill in Date, Amount, and Category." });
          return;
      }
  
      setIsSubmitting(true);
      sonnerToast.info("Submitting receipt...", { id: "upload-toast" });
  
      try {
        // Step 1: tempFilePath is already available from tempFilePathState
        // The file was uploaded in handleFileSelect
  
        // Step 2: Create the receipt record with the stored temporary file path
        const createReceiptPayload = {
          ...receiptData, // date, amount, category_id, notes
          tempFilePath: tempFilePathState, // Use the stored tempFilePath
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
      setTempFilePathState(null); // Clear tempFilePath from state
      setExtractedData({}); // Clear extracted data

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
    setTempFilePathState(null); // Clear tempFilePath from state on cancel
    setExtractedData({}); // Clear extracted data on cancel
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