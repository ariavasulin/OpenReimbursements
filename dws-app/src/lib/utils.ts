import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount)
}

export function formatDateShort(dateString: string | null | undefined): string {
  if (!dateString) return "N/A"
  try {
    // Check if it's in YYYY-MM-DD format
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/)

    if (dateMatch) {
      const year = dateMatch[1].slice(-2)
      const month = parseInt(dateMatch[2], 10)
      const day = parseInt(dateMatch[3], 10)
      // Format as M/D/YY (e.g., "12/18/24")
      return `${month}/${day}/${year}`
    } else {
      // Fallback for other date formats
      const date = new Date(dateString)
      if (isNaN(date.getTime())) {
        return "N/A"
      }
      const year = date.getFullYear().toString().slice(-2)
      return `${date.getMonth() + 1}/${date.getDate()}/${year}`
    }
  } catch {
    return "N/A"
  }
}

export function formatDate(dateString: string): string {
  // Handle timezone issues by parsing date components manually
  // This prevents '2024-03-18' from being interpreted as midnight UTC
  
  // Check if it's in YYYY-MM-DD format
  const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  
  if (dateMatch) {
    // Parse components manually to avoid timezone issues
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1; // Month is 0-indexed
    const day = parseInt(dateMatch[3], 10);
    
    // Create date in local timezone
    const date = new Date(year, month, day);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return "Invalid Date";
    }
    
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short", 
      day: "numeric",
    }).format(date);
  } else {
    // Fallback for other date formats
    const date = new Date(dateString);
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return "Invalid Date";
    }
    
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  }
}
