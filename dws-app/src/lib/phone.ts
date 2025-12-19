/**
 * Formats a US phone number to E.164 format (+1XXXXXXXXXX)
 * @param input - Phone number in various formats
 * @returns E.164 formatted number or null if invalid
 */
export function formatUSPhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Formats E.164 phone number for display: (555) 123-4567
 * @param e164 - Phone number in E.164 format (+1XXXXXXXXXX)
 * @returns Formatted display string
 */
export function formatPhoneForDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/**
 * Validates that the input can be parsed as a valid US phone number
 * @param input - Phone number in various formats
 * @returns true if valid, false otherwise
 */
export function isValidUSPhoneNumber(input: string): boolean {
  return formatUSPhoneNumber(input) !== null;
}
