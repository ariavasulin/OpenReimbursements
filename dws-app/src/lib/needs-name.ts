/**
 * Does this person still need to type their name after signing in? True when
 * there is no profile name yet, or it is one of the placeholders a new account
 * starts with ("Employee", or the phone number, which Supabase stores without
 * the "+"). The sign-in page uses it, and /api/auth/verify-otp can answer it
 * in the same response so the page skips its own profile query.
 */
export function needsNameFor(fullName: string | null | undefined, phone: string | null | undefined): boolean {
  const name = (fullName ?? "").trim();
  const digits = phone ?? "";
  return !name || name === "Employee" || name === digits || name === `+${digits}`;
}
