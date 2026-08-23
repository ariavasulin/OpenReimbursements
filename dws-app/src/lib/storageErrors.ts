// Supabase storage errors surface "not found" inconsistently depending on
// client version and transport: sometimes as a numeric `statusCode`, sometimes
// as a string, sometimes only in the message. Normalize it once.
export function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    statusCode?: number | string;
    status?: number | string;
    message?: string;
    error?: string;
  };

  const code = candidate.statusCode ?? candidate.status;
  if (code !== undefined && Number(code) === 404) return true;

  const haystack = `${candidate.error ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  return haystack.includes("not found") || haystack.includes("object not found");
}
