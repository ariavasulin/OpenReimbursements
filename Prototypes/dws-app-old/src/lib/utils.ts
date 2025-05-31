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

export function formatDate(dateString: string): string {
  // Ensure the dateString is valid and correctly parsed.
  // The prototype's formatDate assumes dateString is directly usable by `new Date()`.
  // If dateString is already 'yyyy-MM-dd', `new Date(dateString)` might have timezone issues.
  // It's often safer to parse 'yyyy-MM-dd' by splitting or using a library like date-fns.
  // For now, keeping it simple as per prototype.
  // Consider adding UTC handling if dates are stored as such: new Date(dateString + 'T00:00:00Z')
  const date = new Date(dateString);
  // Check if date is valid
  if (isNaN(date.getTime())) {
    return "Invalid Date";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", // Added year for clarity
    month: "short",
    day: "numeric",
  }).format(date)
}
