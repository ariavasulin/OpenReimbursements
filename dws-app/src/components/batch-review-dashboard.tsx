"use client"

import { useState, useEffect, useMemo } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowLeft, Check, X, ChevronLeft, ChevronRight, LogOut } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { Receipt } from "@/lib/types"
import { supabase } from "@/lib/supabaseClient"

export default function BatchReviewDashboard({ onLogout }: { onLogout?: () => Promise<void> }) {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [reviewedCount, setReviewedCount] = useState(0)
  const [decisions, setDecisions] = useState<Record<string, "approved" | "rejected">>({})
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [showCompletionScreen, setShowCompletionScreen] = useState<boolean>(false)

  const decisionsCount = useMemo(() => Object.keys(decisions).length, [decisions])

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
            category_id,
            categories!receipts_category_id_fkey (name),
            description,
            image_url,
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
          category: item.categories?.name || "Uncategorized",
          description: item.description || "",
          status: item.status.toLowerCase() as Receipt['status'],
          image_url: item.image_url ? supabase.storage.from('receipt-images').getPublicUrl(item.image_url).data.publicUrl : "",
          // jobCode: item.job_code || item.jobCode || "", // Removed
        }))
        setReceipts(mappedReceipts)
      } catch (err: any) {
        const errorMessage = err?.message || (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
        setError(errorMessage);
        console.error("Error fetching pending receipts (processed):", errorMessage, "Original error:", err);
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
    const decision: "approved" = "approved";
    const newDecisions = { ...decisions, [currentReceipt.id]: decision }
    setDecisions(newDecisions)
    if (!Object.keys(decisions).includes(currentReceipt.id)) {
        setReviewedCount(prev => prev + 1);
    }
    moveNext()
  }

  const handleReject = () => {
    if (!currentReceipt) return;
    const decision: "rejected" = "rejected";
    const newDecisions = { ...decisions, [currentReceipt.id]: decision }
    setDecisions(newDecisions)
    if (!Object.keys(decisions).includes(currentReceipt.id)) {
        setReviewedCount(prev => prev + 1);
    }
    moveNext()
  }

  const moveNext = () => {
    if (currentIndex < receipts.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else if (decisionsCount === receipts.length) {
      // If at the end and all decisions made, show completion screen
      setShowCompletionScreen(true)
    }
  }

  const movePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
    // Always show review UI when navigating backwards
    setShowCompletionScreen(false)
  }

  const handleReviewDecisions = () => {
    setCurrentIndex(0)
    setShowCompletionScreen(false)
  }

  const handleSubmitAll = async () => {
    if (decisionsCount === 0) {
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
      setShowCompletionScreen(false)

      // Refetch pending receipts
      const fetchPendingReceipts = async () => {
        setLoading(true)
        const { data, error: supabaseError } = await supabase
          .from("receipts")
          .select(
            `id, receipt_date, amount, status, category_id, categories!receipts_category_id_fkey (name), description, image_url, user_profiles (full_name, employee_id_internal)`
          )
          .eq("status", "Pending")
          .order("created_at", { ascending: true })
        if (supabaseError) throw supabaseError
        setReceipts(data.map((item: any) => ({
            id: item.id, employeeName: item.user_profiles?.full_name || "N/A", employeeId: item.user_profiles?.employee_id_internal || "N/A",
            date: item.receipt_date, amount: item.amount, category: item.categories?.name || "Uncategorized", description: item.description || "",
            status: item.status.toLowerCase() as Receipt['status'], image_url: item.image_url ? supabase.storage.from('receipt-images').getPublicUrl(item.image_url).data.publicUrl : "",
            // jobCode: item.job_code || item.jobCode || "", // Removed
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

  // Check if all decisions are made and automatically show completion screen
  useEffect(() => {
    if (receipts.length > 0 && decisionsCount === receipts.length && !showCompletionScreen) {
      // Only auto-show completion screen if user is at the end or beyond
      if (currentIndex >= receipts.length - 1) {
        setShowCompletionScreen(true)
      }
    }
  }, [decisionsCount, receipts.length, currentIndex, showCompletionScreen])

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-[#222222] text-white items-center justify-center">
        <p className="text-lg">Loading pending receipts...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col min-h-screen bg-[#222222] text-white items-center justify-center">
        <p className="text-red-400">Error: {error}</p>
        <Button onClick={() => window.location.reload()} className="mt-4 bg-[#2680FC] text-white hover:bg-[#1a6fd8]">Try Again</Button>
      </div>
    )
  }

  if (receipts.length === 0) {
    return (
      <div className="flex flex-col min-h-screen bg-[#222222] text-white">
         {/* Header */}
        <div className="border-b border-[#444444]">
          <div className="flex h-16 items-center px-4 md:px-8">
            <div className="flex items-center">
              <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" />
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
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xl text-white">No pending receipts to review.</p>
        </div>
      </div>
    )
  }

  return ( // The error "Unexpected token div" was here. Ensuring proper return.
    <div className="flex flex-col min-h-screen bg-[#222222] text-white">
      {/* Header */}
      <div className="border-b border-[#444444]">
        <div className="flex h-16 items-center px-4 md:px-8">
          <div className="flex items-center">
            <Image src="/images/logo.png" alt="Company Logo" width={150} height={30} className="mr-3" />
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
      <div className="flex-1 p-4 md:p-8 pt-6 text-white">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2 text-white">Batch Receipt Review</h1>
          <p className="text-gray-400">
            Quickly review and approve/reject pending receipts. Progress: {reviewedCount} of {receipts.length} decided. ({currentIndex + 1} / {receipts.length} viewed)
          </p>
          <Progress value={progress} className="h-2 mt-2 bg-[#444444]" indicatorColor="bg-green-500" />
        </div>

        {/* Show review UI if there are receipts and user is actively reviewing (not on completion screen) */}
        {receipts.length > 0 && currentReceipt && !showCompletionScreen ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Receipt Details */}
            <Card className="bg-[#333333] text-white border-[#444444]">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle className="text-white">Receipt {currentReceipt.id}</CardTitle>
                  {/* Badge styling kept as is for now for status distinction */}
                  <Badge variant="outline" className={`capitalize ${
                    decisions[currentReceipt.id] === 'approved' ? 'bg-green-500/30 text-green-300 border-green-500/30' :
                    decisions[currentReceipt.id] === 'rejected' ? 'bg-red-500/30 text-red-300 border-red-500/30' :
                    'bg-yellow-500/30 text-yellow-300 border-yellow-500/30'
                  }`}>
                    {decisions[currentReceipt.id] || currentReceipt.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-gray-400 text-sm">Employee</p>
                    <p className="font-medium text-white">{currentReceipt.employeeName}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Employee ID</p>
                    <p className="font-medium text-white">{currentReceipt.employeeId}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Date</p>
                    <p className="font-medium text-white">{new Date(currentReceipt.date).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Amount</p>
                    <p className="font-medium text-white">${currentReceipt.amount.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Category</p>
                    <p className="font-medium text-white">{currentReceipt.category}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Description</p>
                    <p className="font-medium text-white">{currentReceipt.description}</p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex justify-between border-t border-[#444444] pt-4">
                <Button
                  size="sm"
                  onClick={movePrevious}
                  disabled={currentIndex === 0 || isSubmitting}
                  className="bg-[#444444] text-white hover:bg-[#555555] disabled:opacity-50 border-0"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <div className="flex space-x-2">
                  <Button
                    size="sm"
                    onClick={handleReject}
                    disabled={isSubmitting}
                    className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 border-0"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleApprove}
                    disabled={isSubmitting}
                    className="bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 border-0"
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                </div>
                <Button
                  size="sm"
                  onClick={moveNext}
                  disabled={currentIndex === receipts.length - 1 || isSubmitting}
                  className="bg-[#444444] text-white hover:bg-[#555555] disabled:opacity-50 border-0"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </CardFooter>
            </Card>

            {/* Receipt Image */}
            <Card className="bg-[#333333] text-white border-[#444444] flex flex-col">
              <CardHeader>
                <CardTitle className="text-white">Receipt Image</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex items-center justify-center p-4">
                {currentReceipt.image_url ? (
                  <Image
                    src={currentReceipt.image_url}
                    alt={`Receipt ${currentReceipt.id}`}
                    width={400}
                    height={400}
                    className="object-contain max-w-full max-h-[400px] rounded-md"
                  />
                ) : (
                  <div className="text-center bg-[#444444] rounded-lg p-4 w-full h-[400px] flex items-center justify-center">
                    <p className="text-gray-400">No image available</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : receipts.length > 0 && showCompletionScreen ? (
           <Card className="bg-[#333333] text-white border-[#444444] mt-6">
            <CardHeader>
              <CardTitle className="text-white">All Pending Receipts Processed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">You have processed all available pending receipts. Submit your decisions or review them again.</p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-green-500 mr-2"></div>
                  <p className="text-white">To be Approved: {Object.values(decisions).filter((d) => d === "approved").length}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-red-500 mr-2"></div>
                  <p className="text-white">To be Rejected: {Object.values(decisions).filter((d) => d === "rejected").length}</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex justify-between border-t border-[#444444] pt-4">
              <Button
                onClick={handleReviewDecisions}
                disabled={isSubmitting}
                className="bg-[#444444] text-white hover:bg-[#555555] disabled:opacity-50 border-0"
              >
                Review My Decisions
              </Button>
              <Button
                onClick={handleSubmitAll}
                disabled={isSubmitting || decisionsCount === 0}
                className="bg-[#2680FC] text-white hover:bg-[#1a6fd8] disabled:opacity-50 border-0"
              >
                {isSubmitting ? "Submitting..." : `Submit ${decisionsCount} Decisions`}
              </Button>
            </CardFooter>
          </Card>
        ) : null }

        {/* Navigation between receipts */}
        {currentReceipt && receipts.length > 0 && (
          <div className="mt-6 flex justify-center">
            <div className="flex items-center space-x-2 bg-[#444444] rounded-lg p-2 overflow-x-auto max-w-full">
              {receipts.length > 10 ? (
                <>
                  {[0, 1, 2].map((index) => (
                    <button
                      key={index}
                      onClick={() => {
                        setCurrentIndex(index)
                        setShowCompletionScreen(false)
                      }}
                      disabled={isSubmitting}
                      className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-50 ${
                        index === currentIndex
                          ? "bg-[#2680FC] text-white"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-700/50 text-green-300"
                            : "bg-[#555555] text-gray-300 hover:bg-[#666666]"
                      }`}
                    >
                      {index + 1}
                    </button>
                  ))}
                  {currentIndex > 3 && receipts.length > 5 && <span className="text-gray-300 px-1">...</span>}
                  {currentIndex >= 3 && currentIndex < receipts.length - 3 && (
                    <>
                      {[currentIndex - 1, currentIndex, currentIndex + 1]
                        .filter((idx) => idx >= 3 && idx < receipts.length - 3)
                        .map((index) => (
                          <button
                            key={index}
                            onClick={() => {
                              setCurrentIndex(index)
                              setShowCompletionScreen(false)
                            }}
                            disabled={isSubmitting}
                            className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-50 ${
                              index === currentIndex
                                ? "bg-[#2680FC] text-white"
                                : index < currentIndex || decisions[receipts[index].id]
                                  ? "bg-green-700/50 text-green-300"
                                  : "bg-[#555555] text-gray-300 hover:bg-[#666666]"
                            }`}
                          >
                            {index + 1}
                          </button>
                        ))}
                    </>
                  )}
                  {currentIndex < receipts.length - 4 && receipts.length > 5 && <span className="text-gray-300 px-1">...</span>}
                  {[receipts.length - 3, receipts.length - 2, receipts.length - 1].map((index) => (
                    <button
                      key={index}
                      onClick={() => {
                        setCurrentIndex(index)
                        setShowCompletionScreen(false)
                      }}
                      disabled={isSubmitting}
                      className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-50 ${
                        index === currentIndex
                          ? "bg-[#2680FC] text-white"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-700/50 text-green-300"
                            : "bg-[#555555] text-gray-300 hover:bg-[#666666]"
                      }`}
                    >
                      {index + 1}
                    </button>
                  ))}
                </>
              ) : (
                receipts.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      setCurrentIndex(index)
                      setShowCompletionScreen(false)
                    }}
                    disabled={isSubmitting}
                    className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-50 ${
                      index === currentIndex
                        ? "bg-[#2680FC] text-white"
                        : index < currentIndex || decisions[receipts[index].id]
                          ? "bg-green-700/50 text-green-300"
                          : "bg-[#555555] text-gray-300 hover:bg-[#666666]"
                    }`}
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
