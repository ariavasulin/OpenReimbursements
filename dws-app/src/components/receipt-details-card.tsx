"use client"

import type React from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CalendarIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { format, parseISO } from "date-fns" // Added parseISO
import { toast as sonnerToast } from "sonner" // Import sonnerToast
import { useState, useEffect } from "react" // Added useEffect
import type { Receipt, Category as CategoryType } from "@/lib/types" // Added CategoryType
import { useMobile } from "@/hooks/use-mobile" // Added useMobile hook

interface ReceiptDetailsCardProps {
  onSubmit: (receiptData: Partial<Receipt>) => void
  onCancel: () => void
  initialData?: Partial<Receipt> // initialData might contain category (name) or category_id
  mode?: 'create' | 'edit' // 'create' for new receipts, 'edit' for existing
  receiptId?: string // Required when mode is 'edit'
  onEditSuccess?: (updatedReceipt: Receipt) => void // Callback after successful edit
  onDelete?: () => void // Callback when delete succeeds
  allowDelete?: boolean // Whether to show delete button (default: true in edit mode)
}

export function ReceiptDetailsCard({
  onSubmit,
  onCancel,
  initialData,
  mode = 'create',
  receiptId,
  onEditSuccess,
  onDelete,
  allowDelete = true,
}: ReceiptDetailsCardProps) {
  const isMobile = useMobile();
  const isEditMode = mode === 'edit';
  
  const parseDateString = (dateString: string | undefined | null): Date | undefined => {
    if (!dateString) return undefined;
    // dateString is expected to be "YYYY-MM-DD"
    const parts = dateString.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed for new Date()
      const day = parseInt(parts[2], 10);
      if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
        return new Date(year, month, day);
      }
    }
    // Fallback or warning if format is unexpected, though OCR API should provide YYYY-MM-DD
    console.warn("ReceiptDetailsCard: Could not parse initial date string:", dateString);
    return undefined;
  };

  // Initialize from canonical receipt_date; fallback to date (for robustness)
  const [date, setDate] = useState<Date | undefined>(
    parseDateString(initialData?.receipt_date ?? initialData?.date)
  );
  const [amount, setAmount] = useState(initialData?.amount?.toString() || "");
  const [categoryId, setCategoryId] = useState<string>(initialData?.category_id || '');
  const [notes, setNotes] = useState(initialData?.notes || "");
  const [categories, setCategories] = useState<CategoryType[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(true);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
 
  useEffect(() => {
    // Sync local state if parent provides new initialData (e.g., after OCR finishes)
    const parsed = parseDateString(initialData?.receipt_date ?? initialData?.date);
    setDate(parsed);
    const fetchCategories = async () => {
      setIsLoadingCategories(true);
      try {
        const response = await fetch('/api/categories');
        if (!response.ok) {
          throw new Error('Failed to fetch categories');
        }
        const data = await response.json();
        if (data.success && data.categories) {
          setCategories(data.categories);
          // If initialData had a category NAME, try to find its ID (less ideal)
          // Or, if initialData.category_id is provided, set it.
          // For now, if initialData.category_id is present, it's used by useState.
          // If not, and initialData.category (name) was provided, we could try to match it.
          // However, the `initialData.category` from ReceiptUploader was "other", which is a name.
          // It's better if ReceiptUploader doesn't send a default category name.
          if (initialData?.category_id) {
             setCategoryId(initialData.category_id);
          } else if (data.categories.length > 0 && !initialData?.category_id && categoryId === '') {
            // If no initial categoryId was provided and categoryId state is still empty,
            // try to set "Parking" as the default.
            const parkingCategory = data.categories.find((cat: CategoryType) => cat.name.toLowerCase() === 'parking');
            if (parkingCategory) {
              setCategoryId(parkingCategory.id);
            }
            // If "Parking" isn't found, it will remain '', and user must select.
          }
        }
      } catch (error) {
        console.error("Error fetching categories:", error);
        // Handle error (e.g., show a toast)
      } finally {
        setIsLoadingCategories(false);
      }
    };
    fetchCategories();
  }, [initialData?.category_id, initialData?.receipt_date, initialData?.date]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!date || !amount || !categoryId) {
        sonnerToast.error("Missing details", { description: "Please fill in Date, Amount, and Category." });
        return;
    }

    const currentReceiptData = {
      receipt_date: format(date, "yyyy-MM-dd"),
      amount: Number.parseFloat(amount),
      category_id: categoryId,
      notes: notes.trim(), // Use trimmed notes for checks and submission
    };

    setIsCheckingDuplicate(true);

    // Handle edit mode - call PATCH API directly
    if (isEditMode && receiptId) {
      try {
        const response = await fetch('/api/receipts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: receiptId,
            ...currentReceiptData,
          }),
        });

        const result = await response.json();

        if (!response.ok) {
          sonnerToast.error("Update Failed", { description: result.error || "Could not update receipt." });
          setIsCheckingDuplicate(false);
          return;
        }

        sonnerToast.success("Receipt Updated", { description: "Your receipt has been updated successfully." });
        if (onEditSuccess && result.receipt) {
          onEditSuccess(result.receipt);
        } else {
          // Fallback: close dialog if no onEditSuccess handler
          onCancel();
        }
      } catch (error) {
        console.error("Error updating receipt:", error);
        sonnerToast.error("Error", { description: "An error occurred while updating the receipt." });
      } finally {
        setIsCheckingDuplicate(false);
      }
      return;
    }

    // Handle create mode - existing duplicate check logic
    try {
      const duplicateCheckResponse = await fetch('/api/receipts/check-duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt_date: currentReceiptData.receipt_date,
          amount: currentReceiptData.amount,
        }),
      });

      if (!duplicateCheckResponse.ok) {
        const errorData = await duplicateCheckResponse.json();
        sonnerToast.error("Duplicate Check Failed", { description: errorData.error || "Could not verify receipt uniqueness." });
        setIsCheckingDuplicate(false);
        return;
      }

      const duplicateResult = await duplicateCheckResponse.json();

      if (duplicateResult.isDuplicate) {
        const currentTrimmedNotes = currentReceiptData.notes.toLowerCase();
        const existingDescriptions = duplicateResult.existingReceipts.map(
          (r: { description: string }) => (r.description || "").trim().toLowerCase()
        );

        if (existingDescriptions.includes(currentTrimmedNotes) || (currentTrimmedNotes === "" && existingDescriptions.some((desc: string) => desc === ""))) {
          sonnerToast.warning(
            "Potential Duplicate Found",
            {
              description: "A receipt with the same date and amount already exists with a similar or empty description. Please provide a unique description or cancel.",
              duration: 8000, // Keep toast longer
            }
          );
          setIsCheckingDuplicate(false);
          return; // Stop submission
        }
      }

      // If no duplicate concern or description is unique, proceed with actual submission
      onSubmit(currentReceiptData);

    } catch (error) {
      console.error("Error during duplicate check:", error);
      sonnerToast.error("Error", { description: "An error occurred while checking for duplicates." });
    } finally {
      setIsCheckingDuplicate(false);
    }
  };

  const handleDelete = async () => {
    if (!receiptId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/receipts?id=${receiptId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete receipt');
      }

      sonnerToast.success("Receipt Deleted", {
        description: "The receipt has been permanently deleted."
      });

      if (onDelete) {
        onDelete();
      } else {
        // Fallback: close dialog if no onDelete handler
        onCancel();
      }
    } catch (error) {
      sonnerToast.error("Delete Failed", {
        description: error instanceof Error ? error.message : "Failed to delete receipt"
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDateChange = (selectedDate: Date | undefined | string) => {
    if (typeof selectedDate === 'string') {
      // From native date input (yyyy-MM-dd)
      // Ensure time zone issues are handled if the string doesn't include time/offset
      // parseISO will parse it as local time if no timezone offset is present.
      // Adding 'T00:00:00' makes it explicit to avoid potential UTC interpretation by new Date() in some browsers.
      setDate(parseISO(selectedDate + "T00:00:00"));
    } else {
      // From Calendar component
      setDate(selectedDate);
    }
  };

  return (
    <Card className="w-full max-w-md bg-[#2e2e2e] text-white border-none">
      <CardHeader className="pb-0">
      <h3 className="text-lg font-medium">{isEditMode ? 'Edit Receipt Details' : 'Confirm Receipt Details'}</h3>
    </CardHeader>
    <CardContent>
      <form onSubmit={handleSubmit} id="receipt-form">
        <div className="grid w-full items-center gap-4">
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="date" className="text-white">
              Date of Purchase
            </Label>
            {isMobile ? (
              <Input
                type="date"
                id="date"
                value={date ? format(date, "yyyy-MM-dd") : ""}
                onChange={(e) => handleDateChange(e.target.value)}
                className="appearance-none block w-full bg-[#3e3e3e] border-[#3e3e3e] text-white placeholder:text-gray-400"
                // Mobile browsers usually show their own placeholder or "yyyy-mm-dd"
              />
            ) : (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal bg-[#3e3e3e] border-[#3e3e3e] text-white hover:bg-[#4e4e4e]"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {date ? format(date, "PPP") : <span>Select date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={date} onSelect={handleDateChange} initialFocus />
                </PopoverContent>
              </Popover>
            )}
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="amount" className="text-white">
                Amount
              </Label>
              <Input
                id="amount"
                placeholder="0.00"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="bg-[#3e3e3e] border-[#3e3e3e] text-white placeholder:text-gray-400"
              />
            </div>
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="category" className="text-white">
                Category
              </Label>
              <Select value={categoryId} onValueChange={setCategoryId} disabled={isLoadingCategories}>
                <SelectTrigger id="category" className="w-full bg-[#3e3e3e] border-[#3e3e3e] text-white">
                  <SelectValue placeholder={isLoadingCategories ? "Loading categories..." : "Select category"} />
                </SelectTrigger>
                <SelectContent position="popper" className="bg-[#2e2e2e] text-white border-[#4e4e4e]">
                  {!isLoadingCategories && categories.length === 0 && (
                    <SelectItem value="no-categories" disabled>No categories available</SelectItem>
                  )}
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id} className="hover:bg-[#4e4e4e]">
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="notes" className="text-white">
                Notes/Description
              </Label>
              <Input
                id="notes"
                placeholder="Brief description of expense"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="bg-[#3e3e3e] border-[#3e3e3e] text-white placeholder:text-gray-400"
              />
            </div>
          </div>
        </form>
      </CardContent>
      <CardFooter className={`flex ${isEditMode && allowDelete ? 'justify-between' : 'justify-end'} gap-3`}>
        {isEditMode && allowDelete && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isCheckingDuplicate || isDeleting}
            className="bg-red-600 hover:bg-red-700 flex-1"
          >
            Delete
          </Button>
        )}
        <Button
          variant="outline"
          onClick={onCancel}
          className={`border-[#3e3e3e] text-neutral-800 hover:bg-[#4e4e4e] hover:text-white ${isEditMode && allowDelete ? 'flex-1' : ''}`}
          disabled={isCheckingDuplicate || isDeleting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          form="receipt-form"
          className={`bg-blue-600 hover:bg-blue-700 text-white ${isEditMode && allowDelete ? 'flex-1' : ''}`}
          disabled={isCheckingDuplicate || isDeleting}
        >
          {isCheckingDuplicate ? (isEditMode ? "Saving..." : "Checking...") : (isEditMode ? "Save" : "Submit Receipt")}
        </Button>
      </CardFooter>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="bg-[#333333] border-[#444444]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete Receipt?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-300">
              Are you sure you want to delete this receipt? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} className="bg-transparent border-[#555555] text-white hover:bg-[#555555]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? "Deleting..." : "Delete Receipt"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}