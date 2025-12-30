// Receipt data extracted from image
class ExtractedReceipt {
  date (string? @check(valid_year, {{ this|regex_match("^202[56]-") }})) @description("Receipt date in YYYY-MM-DD format. Extract the purchase/transaction date, not print date or expiry dates.")
  amount float? @description("Total amount paid after tax and tip. Look for TOTAL, GRAND TOTAL, AMOUNT DUE, or the final/largest amount.")
  category string? @description("The expense category. Must be exactly one of: Parking, Gas, Meals & Entertainment, Office Supplies, Other")
}

// Main extraction function
function ExtractReceiptFromImage(img: image) -> ExtractedReceipt {
  client GPT4oMini
  prompt #"
    {{_.role("user")}}

    Extract the date, total amount, and category from this receipt image:
    {{ img }}

    Instructions:
    - date: Format as YYYY-MM-DD. Use the purchase/transaction date, not promotional or expiry dates. If year is unclear, assume current year.
    - amount: The final total amount paid (after tax, tip, discounts). Look for "TOTAL", "GRAND TOTAL", "AMOUNT DUE", "BALANCE DUE". If multiple totals exist, use the largest/final one.
    - category: Choose exactly one from: Parking, Gas, Meals & Entertainment, Office Supplies, Other
      Common mappings:
      - Parking meters, garages, lots → "Parking"
      - Gas stations, fuel → "Gas"
      - Restaurants, fast food, cafes, groceries → "Meals & Entertainment"
      - Office supplies, printing, stationery → "Office Supplies"
      - If unclear or doesn't fit → "Other"

    If a field cannot be determined with reasonable confidence, return null for that field.

    {{ ctx.output_format }}
  "#
}
