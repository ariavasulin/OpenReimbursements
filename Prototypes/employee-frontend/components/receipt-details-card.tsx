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
import { format } from "date-fns"
import { useState } from "react"
import type { Receipt } from "@/lib/types"

interface ReceiptDetailsCardProps {
  onSubmit: (receiptData: Partial<Receipt>) => void
  onCancel: () => void
  initialData?: Partial<Receipt>
}

export function ReceiptDetailsCard({ onSubmit, onCancel, initialData }: ReceiptDetailsCardProps) {
  const [date, setDate] = useState<Date | undefined>(initialData?.date ? new Date(initialData.date) : undefined)
  const [amount, setAmount] = useState(initialData?.amount?.toString() || "")
  const [category, setCategory] = useState<string>(initialData?.category || "")
  const [notes, setNotes] = useState(initialData?.notes || "")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      date: date ? format(date, "yyyy-MM-dd") : undefined,
      amount: amount ? Number.parseFloat(amount) : undefined,
      category,
      notes,
    })
  }

  return (
    <Card className="w-full max-w-md bg-[#2e2e2e] text-white border-[#4e4e4e]">
      <CardHeader className="pb-0">
        <h3 className="text-lg font-medium">Confirm Receipt Details</h3>
        <h3 className="text-lg font-medium"></h3>
        <h3 className="text-lg font-medium"></h3>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} id="receipt-form">
          <div className="grid w-full items-center gap-4">
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="date" className="text-white">
                Date of Purchase
              </Label>
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
                  <Calendar mode="single" selected={date} onSelect={setDate} initialFocus />
                </PopoverContent>
              </Popover>
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
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="category" className="bg-[#3e3e3e] border-[#3e3e3e] text-white">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="travel">Travel</SelectItem>
                  <SelectItem value="meals">Meals & Entertainment</SelectItem>
                  <SelectItem value="supplies">Office Supplies</SelectItem>
                  <SelectItem value="software">Software/Subscriptions</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
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
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel} className="border-[#3e3e3e] text-white hover:bg-[#4e4e4e]">
          Cancel
        </Button>
        <Button type="submit" form="receipt-form" className="bg-blue-600 hover:bg-blue-700">
          Submit Receipt
        </Button>
      </CardFooter>
    </Card>
  )
}
