"use client"
import { CalendarIcon } from "lucide-react"
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface DateRangePickerProps {
  date: DateRange | undefined
  onDateChange: (date: DateRange) => void
  className?: string
}

export function DateRangePicker({ date, onDateChange, className }: DateRangePickerProps) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "w-[250px] justify-start text-left font-normal border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white",
              !date && "text-[#999999]",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "LLL dd, y")} - {format(date.to, "LLL dd, y")}
                </>
              ) : (
                format(date.from, "LLL dd, y")
              )
            ) : (
              <span>Pick a date range</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 bg-[#2e2e2e] text-white border-[#3e3e3e]" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={onDateChange}
            numberOfMonths={2}
            className="bg-[#2e2e2e]"
            styles={{
              day: {
                color: "white",
              },
              caption: {
                color: "white",
              },
              nav_button: {
                color: "white",
                background: "#3e3e3e",
              },
              day_selected: {
                backgroundColor: "#3e3e3e",
              },
              day_today: {
                color: "white",
                fontWeight: "bold",
              },
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
