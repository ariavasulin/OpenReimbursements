const RELOADED_AT_KEY = "photos.reloaded-for-deploy-at";
/** One reload per minute at most, so a deploy missing its own files cannot loop. */
const RELOAD_GAP_MS = 60_000;

/** The address of the file a failed code download asked for (webpack's ChunkLoadError carries it). */
function failedFileUrl(error: unknown): string | null {
  const request = (error as { request?: unknown } | null)?.request;
  if (typeof request === "string") return request;
  const match = error instanceof Error ? /https?:\/\/\S+?\.(?:js|css)\b/.exec(error.message) : null;
  return match ? match[0] : null;
}

/**
 * A tab opened before a deploy asks for its build's file names, which the
 * deploy removed: every try fails the same way, so the part would never open
 * again in that tab. When the server answers that the file is not there (404),
 * the page reloads onto the new build; the upload tray's leave-page warning
 * still guards a running upload. A file that cannot be reached at all is a weak signal, which
 * the next try may get past, so nothing reloads.
 */
export async function reloadIfRedeployed(
  error: unknown,
  reload: () => void = () => window.location.reload()
): Promise<void> {
  const url = failedFileUrl(error);
  if (url === null) return;
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (response.status !== 404) return;
    const last = Number(window.sessionStorage.getItem(RELOADED_AT_KEY));
    if (Date.now() - last < RELOAD_GAP_MS) return;
    window.sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  } catch {
    return;
  }
  reload();
}
