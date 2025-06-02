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
              "w-[170px] justify-start text-left font-normal border-[#3e3e3e] bg-[#3e3e3e] text-white hover:bg-[#4a4a4a] hover:text-white",
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
      {/* PopoverContent should use card variables. Calendar uses its own theming based on CSS vars. */}
      <PopoverContent className="w-auto p-0 bg-card text-card-foreground border-border" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={onDateChange}
            numberOfMonths={2}
          // className="bg-card" // Calendar itself might not need bg-card if PopoverContent has it.
          // ShadCN Calendar is typically styled via global CSS variables like:
          // --cal-bg, --cal-border, --cal-text, --cal-selected-bg, --cal-selected-text, etc.
          // Or it picks up from --primary, --secondary, --muted, --accent, --popover-foreground etc.
          // The `styles` prop here is overriding. We should remove these overrides if possible
          // and let it inherit from globals.css or default ShadCN theming.
          // For now, let's make them use the theme variables explicitly if ShadCN doesn't pick them up automatically.
          // However, ShadCN Calendar is usually themed via CSS variables set in globals.css or via tailwind config.
          // The default ShadCN calendar should already be themed by the variables in globals.css.
          // Removing the explicit `styles` prop to test default theme application.
          // If it doesn't work, specific CSS variables for calendar might be missing or need to be mapped.
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
