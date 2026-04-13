export function formatUSPhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}

export function formatPhoneForDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

export function isValidUSPhoneNumber(input: string): boolean {
  return formatUSPhoneNumber(input) !== null;
}
