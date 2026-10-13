import { supabase } from "@/lib/supabaseClient";
import type { UploadDeps } from "./upload";
import { createResumableUpload } from "./upload-tus";
import type { UploadAttempt, AcquireUploadOutcome, ClaimUploadOutcome, CanonicalUploadOutcome, OriginalUploadState, CancelUploadInput, CancelUploadOutcome, FormatTwin } from "./upload-contract";
import { extractCapturedAt } from "./exif";
import { sha256 } from "./hash";
import { createUploadRequest } from "./upload-http";
import { createAbortablePhotoStorage, createRetryingPhotoStorage } from "./upload-storage";

export function buildBrowserUploadDeps(): UploadDeps {
  return {
    hash: sha256,
    extractCapturedAt,
    storage: createRetryingPhotoStorage({
      storage: createAbortablePhotoStorage({
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        getAccessToken: getUploadAccessToken,
      }),
      refreshAuth: refreshUploadAuth,
    }),
    resumableUpload: createResumableUpload({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      getAccessToken: getUploadAccessToken,
      refreshAuth: refreshUploadAuth,
    }),
    createAttempt: (input, options) => uploadRequest<UploadAttempt>("attempt", input, options),
    acquireLease: (input, options) => uploadRequest<AcquireUploadOutcome>("acquire", input, options),
    claimContent: (input, options) => uploadRequest<ClaimUploadOutcome>("claim", input, options),
    probeOriginal: (input, options) => uploadRequest<OriginalUploadState>("original", input, options),
    renewLease: (input, options) => uploadRequest("renew", input, options),
    releaseLease: (input) => uploadRequest("release", input),
    finalize: (input, options) => uploadRequest<CanonicalUploadOutcome>("finalize", input, options),
    attachSidecar: (input, options) => uploadRequest<CanonicalUploadOutcome>("sidecar", input, options),
    findFormatTwin: async ({ job_id, base, captured_at, content_sha256 }, options) =>
      (await uploadRequest<{ photo: FormatTwin | null }>("twin",
        { job: job_id, base, captured_at, sha: content_sha256 }, options)).photo,
    deriveOnServer: async (photoId, options) => {
      const response = await fetch(`/api/photos/${encodeURIComponent(photoId)}/derive`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: options?.signal,
      });
      if (!response.ok) throw new Error(`derive failed (HTTP ${response.status})`);
      return (await response.json()) as { thumb_path: string | null };
    },
  };
}

async function refreshUploadAuth() {
  const { data, error } = await supabase.auth.refreshSession();
  return !error && !!data.session;
}
async function getUploadAccessToken() {
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
const uploadRequest = createUploadRequest({ refreshAuth: refreshUploadAuth });

/** Deliberate removal has its own request, independent of the transfer signal. */
export const cancelBrowserUpload = (input: CancelUploadInput) =>
  uploadRequest<CancelUploadOutcome>("cancel", input);
