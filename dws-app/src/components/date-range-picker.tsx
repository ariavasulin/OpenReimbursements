"use client"
import { useRef } from "react"
import { CalendarIcon } from "lucide-react"
import { format, parseISO } from "date-fns"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface DateRangePickerProps {
  date: { from: Date | undefined; to: Date | undefined } | undefined
  onDateChange: (date: { from: Date | undefined; to: Date | undefined }) => void
  className?: string
}

export function DateRangePicker({ date, onDateChange, className }: DateRangePickerProps) {
  const fromInputRef = useRef<HTMLInputElement>(null)
  const toInputRef = useRef<HTMLInputElement>(null)

  const handleFromChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    const newFrom = value ? parseISO(value + "T00:00:00") : undefined
    onDateChange({
      from: newFrom,
      to: date?.to,
    })
    // Auto-open "to" picker after selecting "from"
    if (newFrom) {
      setTimeout(() => toInputRef.current?.showPicker(), 100)
    }
  }

  const handleToChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    const newTo = value ? parseISO(value + "T00:00:00") : undefined
    onDateChange({
      from: date?.from,
      to: newTo,
    })
  }

  const displayText = date?.from
    ? date.to
      ? `${format(date.from, "LLL dd")} - ${format(date.to, "LLL dd")}`
      : format(date.from, "LLL dd, y")
    : "Pick a date range"

  return (
    <div className={cn("relative", className)}>
      <Button
        variant="outline"
        className={cn(
          "w-[170px] justify-start text-left font-normal border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white",
          !date?.from && "text-[#999999]"
        )}
        onClick={() => fromInputRef.current?.showPicker()}
      >
        <CalendarIcon className="mr-2 h-4 w-4" />
        {displayText}
      </Button>
      {/* Hidden native date inputs */}
      <input
        ref={fromInputRef}
        type="date"
        value={date?.from ? format(date.from, "yyyy-MM-dd") : ""}
        onChange={handleFromChange}
        className="sr-only"
        aria-label="From date"
      />
      <input
        ref={toInputRef}
        type="date"
        value={date?.to ? format(date.to, "yyyy-MM-dd") : ""}
        onChange={handleToChange}
        className="sr-only"
        aria-label="To date"
      />
    </div>
  )
}
