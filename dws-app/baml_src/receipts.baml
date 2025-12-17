// Receipt data extracted from image
class ExtractedReceipt {
  date string? @description("Receipt date in YYYY-MM-DD format. Extract the purchase/transaction date, not print date or expiry dates.")
  amount float? @description("Total amount paid after tax and tip. Look for TOTAL, GRAND TOTAL, AMOUNT DUE, or the final/largest amount.")
}

// Main extraction function
function ExtractReceiptFromImage(img: image) -> ExtractedReceipt {
  client GPT4oMini
  prompt #"
    {{_.role("user")}}

    Extract the date and total amount from this receipt image:
    {{ img }}

    Instructions:
    - date: Format as YYYY-MM-DD. Use the purchase/transaction date, not promotional or expiry dates. If year is unclear, assume current year.
    - amount: The final total amount paid (after tax, tip, discounts). Look for "TOTAL", "GRAND TOTAL", "AMOUNT DUE", "BALANCE DUE". If multiple totals exist, use the largest/final one.

    If a field cannot be determined, return null for that field.

    {{ ctx.output_format }}
  "#
}
