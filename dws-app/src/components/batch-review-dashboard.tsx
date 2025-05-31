"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowLeft, Check, X, ChevronLeft, ChevronRight } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { Receipt } from "@/lib/types"
import { supabase } from "@/lib/supabaseClient"
import { useEffect } from "react" // Ensure useEffect is imported

export default function BatchReviewDashboard() {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [reviewedCount, setReviewedCount] = useState(0)
  const [decisions, setDecisions] = useState<Record<string, "approved" | "rejected">>({})
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)

  useEffect(() => {
    const fetchPendingReceipts = async () => {
      setLoading(true)
      setError(null)
      try {
        const { data, error: supabaseError } = await supabase
          .from("receipts")
          .select(
            `
            id,
            receipt_date,
            amount,
            status,
            category,
            notes,
            image_url,
            job_code,
            user_profiles (
              full_name,
              employee_id_internal
            )
          `
          )
          .eq("status", "Pending") // Assuming DB stores status as "Pending"
          .order("created_at", { ascending: true }) // Process oldest first

        if (supabaseError) throw supabaseError

        const mappedReceipts: Receipt[] = data.map((item: any) => ({
          id: item.id,
          employeeName: item.user_profiles?.full_name || "N/A",
          employeeId: item.user_profiles?.employee_id_internal || "N/A",
          date: item.receipt_date,
          amount: item.amount,
          category: item.category || "Uncategorized",
          description: item.notes || "",
          status: item.status.toLowerCase() as Receipt['status'], // Keep frontend status lowercase
          imageUrl: item.image_url || "",
          jobCode: item.job_code || item.jobCode || "",
        }))
        setReceipts(mappedReceipts)
      } catch (err: any) {
        setError(err.message)
        console.error("Error fetching pending receipts:", err)
      } finally {
        setLoading(false)
      }
    }
    fetchPendingReceipts()
  }, [])

  const currentReceipt = receipts[currentIndex]
  const progress = receipts.length > 0 ? (reviewedCount / receipts.length) * 100 : 0


  const handleApprove = () => {
    if (!currentReceipt) return;
    const newDecisions = { ...decisions, [currentReceipt.id]: "approved" }
    setDecisions(newDecisions)
    if (!Object.keys(decisions).includes(currentReceipt.id)) { // only advance reviewedCount if it's a new decision
        setReviewedCount(prev => prev + 1);
    }
    moveNext()
  }

  const handleReject = () => {
    if (!currentReceipt) return;
    const newDecisions = { ...decisions, [currentReceipt.id]: "rejected" }
    setDecisions(newDecisions)
    if (!Object.keys(decisions).includes(currentReceipt.id)) { // only advance reviewedCount if it's a new decision
        setReviewedCount(prev => prev + 1);
    }
    moveNext()
  }

  const moveNext = () => {
    if (currentIndex < receipts.length - 1) {
      setCurrentIndex(currentIndex + 1)
    }
    // reviewedCount is now updated in handleApprove/Reject
    // to correctly reflect items actually decided upon, not just skipped
  }

  const movePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }

  const handleSubmitAll = async () => {
    if (Object.keys(decisions).length === 0) {
      alert("No decisions have been made to submit.")
      return
    }
    setIsSubmitting(true)
    setError(null)

    const updatePromises = Object.entries(decisions).map(([id, status]) => {
      const dbStatus = status.charAt(0).toUpperCase() + status.slice(1) // e.g. "Approved"
      return supabase.from("receipts").update({ status: dbStatus }).eq("id", id)
    })

    try {
      const results = await Promise.all(updatePromises)
      const anyError = results.some(result => result.error)
      if (anyError) {
        // Attempt to find the first error message
        const firstError = results.find(result => result.error)?.error?.message || "An unknown error occurred during batch update."
        throw new Error(`Some updates failed. First error: ${firstError}`)
      }

      alert("All decisions submitted successfully!")
      // Reset state and refetch or filter out processed ones
      setDecisions({})
      setReviewedCount(0)
      setCurrentIndex(0)
      // Refetch pending receipts
      const fetchPendingReceipts = async () => {
        setLoading(true)
        const { data, error: supabaseError } = await supabase
          .from("receipts")
          .select(
            `id, receipt_date, amount, status, category, notes, image_url, job_code, user_profiles (full_name, employee_id_internal)`
          )
          .eq("status", "Pending")
          .order("created_at", { ascending: true })
        if (supabaseError) throw supabaseError
        setReceipts(data.map((item: any) => ({
            id: item.id, employeeName: item.user_profiles?.full_name || "N/A", employeeId: item.user_profiles?.employee_id_internal || "N/A",
            date: item.receipt_date, amount: item.amount, category: item.category || "Uncategorized", description: item.notes || "",
            status: item.status.toLowerCase() as Receipt['status'], imageUrl: item.image_url || "", jobCode: item.job_code || item.jobCode || "",
        })))
        setLoading(false)
      }
      fetchPendingReceipts()
    } catch (err: any) {
      setError(err.message)
      alert(`Error submitting decisions: ${err.message}`)
      console.error("Error submitting decisions:", err)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-background text-foreground items-center justify-center">
        <p>Loading pending receipts...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col min-h-screen bg-background text-foreground items-center justify-center">
        <p className="text-red-500">Error: {error}</p> {/* Consider using text-destructive */}
        <Button onClick={() => window.location.reload()} className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90">Try Again</Button>
      </div>
    )
  }

  if (receipts.length === 0) {
    return (
      <div className="flex flex-col min-h-screen bg-background text-foreground">
         {/* Header */}
        <div className="border-b border-border">
          <div className="flex h-16 items-center px-4 md:px-8">
            <div className="flex items-center">
              <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" />
            </div>
            <div className="ml-auto flex items-center space-x-4">
              <Link href="/dashboard"> {/* Corrected Link to /dashboard */}
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-secondary text-secondary-foreground hover:bg-muted"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xl">No pending receipts to review.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b border-border">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center">
            <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" />
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/dashboard"> {/* Corrected Link to /dashboard */}
              <Button
                variant="outline"
                size="sm"
                className="bg-secondary text-secondary-foreground hover:bg-muted"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-4 md:p-8 pt-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Batch Receipt Review</h1>
          <p className="text-muted-foreground">
            Quickly review and approve/reject pending receipts. Progress: {reviewedCount} of {receipts.length} decided. ({currentIndex + 1} / {receipts.length} viewed)
          </p>
          <Progress value={progress} className="h-2 mt-2 bg-secondary" indicatorClassName="bg-green-500" /> {/* Green indicator for progress seems fine */}
        </div>

        {/* Show review UI if there are receipts and not all have had decisions made, or if all decided but user is still navigating them */}
        {receipts.length > 0 && reviewedCount < receipts.length && currentReceipt ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Receipt Details */}
            <Card className="bg-card text-card-foreground border-border">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>Receipt {currentReceipt.id}</CardTitle>
                  <Badge variant="outline" className={`capitalize ${
                    decisions[currentReceipt.id] === 'approved' ? 'bg-green-500/30 text-green-300 border-green-500/30' :
                    decisions[currentReceipt.id] === 'rejected' ? 'bg-red-500/30 text-red-300 border-red-500/30' :
                    'bg-yellow-500/30 text-yellow-300 border-yellow-500/30' // Assuming 'pending' maps to yellow
                  }`}>
                    {decisions[currentReceipt.id] || currentReceipt.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-muted-foreground text-sm">Employee</p>
                    <p className="font-medium">{currentReceipt.employeeName}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-sm">Employee ID</p>
                    <p className="font-medium">{currentReceipt.employeeId}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-sm">Date</p>
                    <p className="font-medium">{new Date(currentReceipt.date).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-sm">Amount</p>
                    <p className="font-medium">${currentReceipt.amount.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-sm">Category</p>
                    <p className="font-medium">{currentReceipt.category}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-sm">Description</p>
                    <p className="font-medium">{currentReceipt.description}</p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex justify-between border-t border-border pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={movePrevious}
                  disabled={currentIndex === 0 || isSubmitting} // Added isSubmitting here
                  className="bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <div className="flex space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReject}
                    disabled={isSubmitting}
                    className="border-red-500/30 bg-red-500/30 text-red-300 hover:bg-red-500/50 hover:text-red-200 disabled:opacity-50"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleApprove}
                    disabled={isSubmitting}
                    className="border-green-500/30 bg-green-500/30 text-green-300 hover:bg-green-500/50 hover:text-green-200 disabled:opacity-50"
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={moveNext}
                  disabled={currentIndex === receipts.length - 1 || isSubmitting}
                  className="bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-50"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </CardFooter>
            </Card>

            {/* Receipt Image */}
            <Card className="bg-card text-card-foreground border-border flex flex-col">
              <CardHeader>
                <CardTitle>Receipt Image</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex items-center justify-center p-4">
                {currentReceipt.imageUrl ? (
                  <Image
                    src={currentReceipt.imageUrl}
                    alt={`Receipt ${currentReceipt.id}`}
                    width={400}
                    height={400}
                    className="object-contain max-w-full max-h-[400px] rounded-md"
                  />
                ) : (
                  <div className="text-center bg-muted rounded-lg p-4 w-full h-[400px] flex items-center justify-center">
                    <p className="text-muted-foreground">No image available</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : receipts.length > 0 && Object.keys(decisions).length >= receipts.length ? (
           // This card shows when decisions have been made for all initially fetched receipts
           <Card className="bg-card text-card-foreground border-border mt-6">
            <CardHeader>
              <CardTitle>All Pending Receipts Processed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">You have processed all available pending receipts. Submit your decisions or review them again.</p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-green-500 mr-2"></div>
                  <p>To be Approved: {Object.values(decisions).filter((d) => d === "approved").length}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-red-500 mr-2"></div>
                  <p>To be Rejected: {Object.values(decisions).filter((d) => d === "rejected").length}</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setCurrentIndex(0)} // Allow user to go back and review decisions
                disabled={isSubmitting}
                className="bg-secondary text-secondary-foreground hover:bg-muted disabled:opacity-50"
              >
                Review My Decisions
              </Button>
              <Button
                onClick={handleSubmitAll}
                disabled={isSubmitting || Object.keys(decisions).length === 0}
                className="bg-green-600 text-white hover:bg-green-700 disabled:opacity-50" // Explicit green for submit
              >
                {isSubmitting ? "Submitting..." : `Submit ${Object.keys(decisions).length} Decisions`}
              </Button>
            </CardFooter>
          </Card>
        )}


        {/* Navigation between receipts */}
        {currentReceipt && receipts.length > 0 && (
          <div className="mt-6 flex justify-center">
            <div className="flex items-center space-x-2 bg-muted rounded-lg p-2 overflow-x-auto max-w-full">
              {receipts.length > 10 ? (
                // Show pagination style navigation for many receipts (simplified for now)
                <>
                  {/* Always show first few */}
                  {[0, 1, 2].map((index) => (
                    <button
                      key={index}
                      onClick={() => setCurrentIndex(index)}
                      disabled={isSubmitting} // Added disabled state
                      className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        index === currentIndex
                          ? "bg-primary text-primary-foreground"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-500/30 text-green-300" // Keep decision indication
                            : "bg-secondary text-secondary-foreground hover:bg-accent"
                      } disabled:opacity-50`}
                    >
                      {index + 1}
                    </button>
                  ))}

                  {/* Show ellipsis if not at the beginning */}
                  {currentIndex > 3 && receipts.length > 5 && <span className="text-foreground px-1">...</span>}

                  {/* Show current and surrounding */}
                  {currentIndex >= 3 && currentIndex < receipts.length - 3 && (
                    <>
                      {[currentIndex - 1, currentIndex, currentIndex + 1]
                        .filter((idx) => idx >= 3 && idx < receipts.length - 3)
                        .map((index) => (
                          <button
                            key={index}
                            onClick={() => setCurrentIndex(index)}
                            disabled={isSubmitting} // Added disabled state
                            className={`w-8 h-8 rounded-full flex items-center justify-center ${
                              index === currentIndex
                                ? "bg-primary text-primary-foreground"
                                : index < currentIndex || decisions[receipts[index].id]
                                  ? "bg-green-500/30 text-green-300"
                                  : "bg-secondary text-secondary-foreground hover:bg-accent"
                            } disabled:opacity-50`}
                          >
                            {index + 1}
                          </button>
                        ))}
                    </>
                  )}

                  {/* Show ellipsis if not at the end */}
                  {currentIndex < receipts.length - 4 && receipts.length > 5 && <span className="text-foreground px-1">...</span>}

                  {/* Always show last few */}
                  {[receipts.length - 3, receipts.length - 2, receipts.length - 1].map((index) => (
                    <button
                      key={index}
                      onClick={() => setCurrentIndex(index)}
                      disabled={isSubmitting} // Added disabled state
                      className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        index === currentIndex
                          ? "bg-primary text-primary-foreground"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-500/30 text-green-300"
                            : "bg-secondary text-secondary-foreground hover:bg-accent"
                      } disabled:opacity-50`}
                    >
                      {index + 1}
                    </button>
                  ))}
                </>
              ) : (
                // Show all buttons if 10 or fewer receipts
                receipts.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentIndex(index)}
                    disabled={isSubmitting} // Added disabled state
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      index === currentIndex
                        ? "bg-primary text-primary-foreground"
                        : index < currentIndex || decisions[receipts[index].id]
                          ? "bg-green-500/30 text-green-300"
                          : "bg-secondary text-secondary-foreground hover:bg-accent"
                    } disabled:opacity-50`}
                  >
                    {index + 1}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
