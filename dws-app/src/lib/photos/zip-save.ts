// Fetch the originals and write them into one zip (client-zip: streaming,
// stored without compression, since photos and videos are compressed already).
// Where the browser offers a save dialog (showSaveFilePicker: desktop Chrome
// and Edge) the zip streams straight to disk; elsewhere it is assembled in
// memory and saved as a blob download, which is why the confirm warns above
// 2 GB. Each original is fully fetched before it goes into the zip, so one
// failed photo is left out and named rather than breaking the whole file.

import { makeZip } from "client-zip";
import { publicUrl } from "./urls";
import { inOrderPool, zipEntryNames, type ZipRow } from "./zip-download";

/** Originals fetched at once. */
const FETCH_POOL = 4;

/** Where the zip goes: a file the person picked, or a blob download. */
export type ZipTarget = { kind: "file"; writable: FileSystemWritableFileStream } | { kind: "blob"; fileName: string };

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/**
 * Ask where to save, when the browser can. Call it first thing in the click
 * handler: the dialog needs the click's user activation. Null when the person
 * cancels the dialog.
 */
export async function openZipTarget(fileName: string): Promise<ZipTarget | null> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  // The dialog is refused inside a cross-origin frame; a blob download is not.
  if (typeof picker !== "function" || window.self !== window.top) return { kind: "blob", fileName };
  try {
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: "Zip file", accept: { "application/zip": [".zip"] } }],
    });
    return { kind: "file", writable: await handle.createWritable() };
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") return null;
    return { kind: "blob", fileName };
  }
}

/** Every photo failed, so no zip was kept. */
export class ZipEmptyError extends Error {
  constructor(readonly failed: string[]) {
    super("None of the photos could be downloaded.");
    this.name = "ZipEmptyError";
  }
}

export interface ZipProgress {
  /** Photos finished (in the zip or failed). */
  done: number;
  total: number;
}

/** One original, read whole; null after a second failed try. */
async function fetchOriginal(row: ZipRow): Promise<Blob | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(publicUrl(row.original_path));
      if (response.ok) return await response.blob();
      if (response.status < 500) return null; // gone or refused: trying again will not help
    } catch {
      // Network trouble: one more try.
    }
  }
  return null;
}

/**
 * Write `rows` into one zip at `target`. Resolves with the names of photos that
 * could not be fetched (the zip holds the rest); rejects when writing failed,
 * or with ZipEmptyError when nothing could be fetched (nothing is kept then).
 */
export async function saveZip(
  rows: readonly ZipRow[],
  target: ZipTarget,
  onProgress: (progress: ZipProgress) => void
): Promise<{ failed: string[] }> {
  const names = zipEntryNames(rows);
  const failed: string[] = [];
  let done = 0;

  async function* entries() {
    const fetched = inOrderPool(rows, FETCH_POOL, async (row, index) => ({
      row,
      name: names[index],
      blob: await fetchOriginal(row),
    }));
    for await (const { row, name, blob } of fetched) {
      if (blob) yield { name, input: blob, lastModified: new Date(row.captured_at) };
      else failed.push(name);
      done += 1;
      onProgress({ done, total: rows.length });
    }
    // Erroring the stream discards the file instead of keeping an empty zip.
    if (rows.length > 0 && failed.length === rows.length) throw new ZipEmptyError(failed);
  }

  const zip = makeZip(entries());
  try {
    if (target.kind === "file") {
      // A failure aborts the file, so a broken zip is never left behind.
      await zip.pipeTo(target.writable);
    } else {
      const blob = await new Response(zip).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = target.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // The download has its own reference by now; free ours a little later.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (reason) {
    // A blob read reports the stream's error in its own words; say what it was.
    if (rows.length > 0 && failed.length === rows.length) throw new ZipEmptyError(failed);
    throw reason;
  }
  return { failed };
}
