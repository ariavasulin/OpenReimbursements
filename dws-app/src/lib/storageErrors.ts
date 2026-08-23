// Supabase storage errors surface "not found" inconsistently depending on
// client version and transport: the pinned @supabase/storage-js puts the HTTP
// status on `status` (with `message: "Object not found"`); older shapes used
// `statusCode`, as a number or a string; some carry only the message.
// Normalize it once. When a status is present it decides: a 500 whose message
// happens to mention "not found" is an outage, not a missing file.
export function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    statusCode?: number | string;
    status?: number | string;
    message?: string;
    error?: string;
  };

  const code = candidate.statusCode ?? candidate.status;
  if (code !== undefined) return Number(code) === 404;

  const haystack = `${candidate.error ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  return haystack.includes("not found");
}
