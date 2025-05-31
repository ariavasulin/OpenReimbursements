"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowLeft, Check, X, ChevronLeft, ChevronRight } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { IReceipt } from "@/types/receipt"

export default function BatchReviewDashboard() {
  // Mock data for receipts - only pending ones for review
  const [receipts, setReceipts] = useState<IReceipt[]>([
    {
      id: "REC-002",
      employeeName: "Jane Smith",
      employeeId: "EMP-002",
      date: new Date("2023-05-03"),
      amount: 45.75,
      category: "Meals",
      description: "Lunch with client",
      status: "pending",
      imageUrl: "/receipts/receipt-2.jpg",
    },
    {
      id: "REC-005",
      employeeName: "John Doe",
      employeeId: "EMP-001",
      date: new Date("2023-05-15"),
      amount: 200.0,
      category: "Travel",
      description: "Train tickets",
      status: "pending",
      imageUrl: "/receipts/receipt-5.jpg",
    },
    {
      id: "REC-009",
      employeeName: "Emily Johnson",
      employeeId: "EMP-005",
      date: new Date("2023-05-25"),
      amount: 89.99,
      category: "Office Supplies",
      description: "Printer cartridges",
      status: "pending",
      imageUrl: "/receipts/receipt-9.jpg",
    },
    {
      id: "REC-012",
      employeeName: "Michael Brown",
      employeeId: "EMP-008",
      date: new Date("2023-05-28"),
      amount: 120.5,
      category: "Travel",
      description: "Taxi fares",
      status: "pending",
      imageUrl: "/receipts/receipt-12.jpg",
    },
    {
      id: "REC-015",
      employeeName: "Sarah Wilson",
      employeeId: "EMP-010",
      date: new Date("2023-06-01"),
      amount: 35.25,
      category: "Meals",
      description: "Team coffee meeting",
      status: "pending",
      imageUrl: "/receipts/receipt-15.jpg",
    },
    {
      id: "REC-018",
      employeeName: "David Lee",
      employeeId: "EMP-012",
      date: new Date("2023-06-03"),
      amount: 149.99,
      category: "Software",
      description: "Project management tool subscription",
      status: "pending",
      imageUrl: "/receipts/receipt-18.jpg",
    },
    {
      id: "REC-021",
      employeeName: "Jennifer Garcia",
      employeeId: "EMP-015",
      date: new Date("2023-06-05"),
      amount: 78.5,
      category: "Travel",
      description: "Parking fees",
      status: "pending",
      imageUrl: "/receipts/receipt-21.jpg",
    },
    {
      id: "REC-023",
      employeeName: "Robert Martinez",
      employeeId: "EMP-018",
      date: new Date("2023-06-07"),
      amount: 320.75,
      category: "Equipment",
      description: "Wireless headphones",
      status: "pending",
      imageUrl: "/receipts/receipt-23.jpg",
    },
    {
      id: "REC-027",
      employeeName: "Lisa Thompson",
      employeeId: "EMP-020",
      date: new Date("2023-06-10"),
      amount: 55.25,
      category: "Meals",
      description: "Client dinner",
      status: "pending",
      imageUrl: "/receipts/receipt-27.jpg",
    },
    {
      id: "REC-030",
      employeeName: "James Wilson",
      employeeId: "EMP-022",
      date: new Date("2023-06-12"),
      amount: 189.99,
      category: "Office Supplies",
      description: "Ergonomic keyboard",
      status: "pending",
      imageUrl: "/receipts/receipt-30.jpg",
    },
    {
      id: "REC-032",
      employeeName: "Patricia Davis",
      employeeId: "EMP-025",
      date: new Date("2023-06-15"),
      amount: 42.3,
      category: "Travel",
      description: "Fuel reimbursement",
      status: "pending",
      imageUrl: "/receipts/receipt-32.jpg",
    },
    {
      id: "REC-035",
      employeeName: "Thomas Anderson",
      employeeId: "EMP-027",
      date: new Date("2023-06-18"),
      amount: 275.0,
      category: "Training",
      description: "Online course subscription",
      status: "pending",
      imageUrl: "/receipts/receipt-35.jpg",
    },
    {
      id: "REC-038",
      employeeName: "Jessica Robinson",
      employeeId: "EMP-030",
      date: new Date("2023-06-20"),
      amount: 68.75,
      category: "Meals",
      description: "Team lunch",
      status: "pending",
      imageUrl: "/receipts/receipt-38.jpg",
    },
    {
      id: "REC-041",
      employeeName: "Daniel White",
      employeeId: "EMP-032",
      date: new Date("2023-06-22"),
      amount: 129.99,
      category: "Software",
      description: "Design software license",
      status: "pending",
      imageUrl: "/receipts/receipt-41.jpg",
    },
    {
      id: "REC-044",
      employeeName: "Nancy Clark",
      employeeId: "EMP-035",
      date: new Date("2023-06-25"),
      amount: 95.5,
      category: "Office Supplies",
      description: "Desk organizer set",
      status: "pending",
      imageUrl: "/receipts/receipt-44.jpg",
    },
    {
      id: "REC-047",
      employeeName: "Christopher Lewis",
      employeeId: "EMP-038",
      date: new Date("2023-06-27"),
      amount: 350.25,
      category: "Equipment",
      description: "Portable monitor",
      status: "pending",
      imageUrl: "/receipts/receipt-47.jpg",
    },
    {
      id: "REC-050",
      employeeName: "Elizabeth Walker",
      employeeId: "EMP-040",
      date: new Date("2023-06-29"),
      amount: 22.99,
      category: "Books",
      description: "Professional development book",
      status: "pending",
      imageUrl: "/receipts/receipt-50.jpg",
    },
    {
      id: "REC-053",
      employeeName: "Kevin Hall",
      employeeId: "EMP-042",
      date: new Date("2023-07-01"),
      amount: 175.0,
      category: "Travel",
      description: "Hotel accommodation",
      status: "pending",
      imageUrl: "/receipts/receipt-53.jpg",
    },
    {
      id: "REC-056",
      employeeName: "Margaret Young",
      employeeId: "EMP-045",
      date: new Date("2023-07-03"),
      amount: 49.99,
      category: "Subscriptions",
      description: "Industry newsletter annual fee",
      status: "pending",
      imageUrl: "/receipts/receipt-56.jpg",
    },
    {
      id: "REC-059",
      employeeName: "Richard Allen",
      employeeId: "EMP-048",
      date: new Date("2023-07-05"),
      amount: 85.75,
      category: "Meals",
      description: "Business meeting refreshments",
      status: "pending",
      imageUrl: "/receipts/receipt-59.jpg",
    },
  ])

  const [currentIndex, setCurrentIndex] = useState(0)
  const [reviewedCount, setReviewedCount] = useState(0)
  const [decisions, setDecisions] = useState<Record<string, "approved" | "rejected">>({})

  const currentReceipt = receipts[currentIndex]
  const progress = (reviewedCount / receipts.length) * 100

  const handleApprove = () => {
    const newDecisions = { ...decisions, [currentReceipt.id]: "approved" }
    setDecisions(newDecisions)
    moveNext()
  }

  const handleReject = () => {
    const newDecisions = { ...decisions, [currentReceipt.id]: "rejected" }
    setDecisions(newDecisions)
    moveNext()
  }

  const moveNext = () => {
    if (currentIndex < receipts.length - 1) {
      setCurrentIndex(currentIndex + 1)
      setReviewedCount(reviewedCount + 1)
    } else {
      // All receipts reviewed
      setReviewedCount(receipts.length)
    }
  }

  const movePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }

  const handleSubmitAll = () => {
    // Here you would typically send the decisions to your backend
    console.log("Submitting decisions:", decisions)

    // Update the receipts with the decisions
    const updatedReceipts = receipts.map((receipt) => {
      if (decisions[receipt.id]) {
        return { ...receipt, status: decisions[receipt.id] }
      }
      return receipt
    })

    setReceipts(updatedReceipts)

    // Reset the review state
    setCurrentIndex(0)
    setReviewedCount(0)
    setDecisions({})

    // In a real app, you might redirect to the dashboard or show a success message
    alert("All receipts have been processed!")
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#2e2e2e] text-white">
      {/* Header */}
      <div>
        <div className="flex h-16 items-center px-8">
          <div className="flex items-center">
            <Image src="/images/logo.png" alt="Company Logo" width={200} height={200} className="mr-3 mt-4" />
          </div>
          <div className="ml-auto flex items-center space-x-4">
            <Link href="/">
              <Button
                variant="outline"
                size="sm"
                className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-8 pt-3">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Batch Receipt Review</h1>
          <p className="text-[#999999]">
            Quickly review and approve/reject pending receipts. Progress: {reviewedCount} of {receipts.length} reviewed.
          </p>
          <Progress value={progress} className="h-2 mt-2 bg-[#3e3e3e]" indicatorColor="bg-green-500" />
        </div>

        {reviewedCount < receipts.length ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Receipt Details */}
            <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>Receipt {currentReceipt.id}</CardTitle>
                  <Badge variant="outline" className="bg-yellow-500/30 text-yellow-300 border-yellow-500/30">
                    Pending
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[#999999] text-sm">Employee</p>
                    <p className="font-medium">{currentReceipt.employeeName}</p>
                  </div>
                  <div>
                    <p className="text-[#999999] text-sm">Employee ID</p>
                    <p className="font-medium">{currentReceipt.employeeId}</p>
                  </div>
                  <div>
                    <p className="text-[#999999] text-sm">Date</p>
                    <p className="font-medium">{currentReceipt.date.toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-[#999999] text-sm">Amount</p>
                    <p className="font-medium">${currentReceipt.amount.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-[#999999] text-sm">Category</p>
                    <p className="font-medium">{currentReceipt.category}</p>
                  </div>
                  <div>
                    <p className="text-[#999999] text-sm">Description</p>
                    <p className="font-medium">{currentReceipt.description}</p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex justify-between border-t border-[#3e3e3e] pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={movePrevious}
                  disabled={currentIndex === 0}
                  className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <div className="flex space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReject}
                    className="border-red-500/30 bg-red-500/30 text-red-300 hover:bg-red-500/50 hover:text-white"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleApprove}
                    className="border-green-500/30 bg-green-500/30 text-green-300 hover:bg-green-500/50 hover:text-white"
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={moveNext}
                  disabled={currentIndex === receipts.length - 1}
                  className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white disabled:opacity-50"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </CardFooter>
            </Card>

            {/* Receipt Image */}
            <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e] flex flex-col">
              <CardHeader>
                <CardTitle>Receipt Image</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex items-center justify-center p-4">
                <div className="bg-[#3e3e3e] rounded-lg p-2 w-full h-[400px] flex items-center justify-center">
                  {/* In a real app, this would be the actual receipt image */}
                  <div className="text-center">
                    <p className="text-[#999999] mb-2">Receipt Image Placeholder</p>
                    <p className="text-sm text-[#999999]">{currentReceipt.imageUrl}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="bg-[#2e2e2e] text-white border-[#3e3e3e]">
            <CardHeader>
              <CardTitle>Review Complete</CardTitle>
            </CardHeader>
            <CardContent>
              <p>You have reviewed all pending receipts. Here's a summary:</p>
              <div className="mt-4 space-y-2">
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-green-500 mr-2"></div>
                  <p>Approved: {Object.values(decisions).filter((d) => d === "approved").length}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-4 h-4 rounded-full bg-red-500 mr-2"></div>
                  <p>Rejected: {Object.values(decisions).filter((d) => d === "rejected").length}</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => {
                  setCurrentIndex(0)
                  setReviewedCount(0)
                  setDecisions({})
                }}
                className="border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white"
              >
                Review Again
              </Button>
              <Button
                onClick={handleSubmitAll}
                className="bg-green-500/30 text-green-300 hover:bg-green-500/50 hover:text-white"
              >
                Submit All Decisions
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Navigation between receipts */}
        {reviewedCount < receipts.length && (
          <div className="mt-6 flex justify-center">
            <div className="flex items-center space-x-2 bg-[#3e3e3e] rounded-lg p-2 overflow-x-auto max-w-full">
              {receipts.length > 10 ? (
                // Show pagination style navigation for many receipts
                <>
                  {/* Always show first few */}
                  {[0, 1, 2].map((index) => (
                    <button
                      key={index}
                      onClick={() => setCurrentIndex(index)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        index === currentIndex
                          ? "bg-white text-[#2e2e2e]"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-500/30 text-green-300"
                            : "bg-[#4a4a4a] text-white"
                      }`}
                    >
                      {index + 1}
                    </button>
                  ))}

                  {/* Show ellipsis if not at the beginning */}
                  {currentIndex > 3 && <span className="text-white px-1">...</span>}

                  {/* Show current and surrounding */}
                  {currentIndex >= 3 && currentIndex < receipts.length - 3 && (
                    <>
                      {[currentIndex - 1, currentIndex, currentIndex + 1]
                        .filter((idx) => idx >= 3 && idx < receipts.length - 3)
                        .map((index) => (
                          <button
                            key={index}
                            onClick={() => setCurrentIndex(index)}
                            className={`w-8 h-8 rounded-full flex items-center justify-center ${
                              index === currentIndex
                                ? "bg-white text-[#2e2e2e]"
                                : index < currentIndex || decisions[receipts[index].id]
                                  ? "bg-green-500/30 text-green-300"
                                  : "bg-[#4a4a4a] text-white"
                            }`}
                          >
                            {index + 1}
                          </button>
                        ))}
                    </>
                  )}

                  {/* Show ellipsis if not at the end */}
                  {currentIndex < receipts.length - 4 && <span className="text-white px-1">...</span>}

                  {/* Always show last few */}
                  {[receipts.length - 3, receipts.length - 2, receipts.length - 1].map((index) => (
                    <button
                      key={index}
                      onClick={() => setCurrentIndex(index)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center ${
                        index === currentIndex
                          ? "bg-white text-[#2e2e2e]"
                          : index < currentIndex || decisions[receipts[index].id]
                            ? "bg-green-500/30 text-green-300"
                            : "bg-[#4a4a4a] text-white"
                      }`}
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
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      index === currentIndex
                        ? "bg-white text-[#2e2e2e]"
                        : index < currentIndex || decisions[receipts[index].id]
                          ? "bg-green-500/30 text-green-300"
                          : "bg-[#4a4a4a] text-white"
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
