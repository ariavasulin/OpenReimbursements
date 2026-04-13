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
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/)

    if (dateMatch) {
      const year = dateMatch[1].slice(-2)
      const month = parseInt(dateMatch[2], 10)
      const day = parseInt(dateMatch[3], 10)
      return `${month}/${day}/${year}`
    } else {
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
  const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateMatch) {
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1;
    const day = parseInt(dateMatch[3], 10);
    const date = new Date(year, month, day);

    if (isNaN(date.getTime())) {
      return "Invalid Date";
    }
    
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short", 
      day: "numeric",
    }).format(date);
  } else {
    const date = new Date(dateString);

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
