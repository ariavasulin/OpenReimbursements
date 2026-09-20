import { extensionOf } from "./classify";

export const METADATA_MAX_BYTES = 16 * 1024 * 1024;
export const DERIVATIVES_MAX_BYTES = 24 * 1024 * 1024;

export function isRawImage(file: Pick<File, "name">): boolean {
  return ["tif", "tiff", "dng", "cr2", "nef", "arw"].includes(extensionOf(file.name));
}

/** The selection UI must obey the same decoding budget as ingestion. */
export function canDecodePreview(file: Pick<File, "name" | "size">): boolean {
  return file.size <= DERIVATIVES_MAX_BYTES && !isRawImage(file);
}
