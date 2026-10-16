import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  convert, DERIVED_CACHE_SECONDS, parseArgs, reasonFor, run, sniff,
} from "../../../scripts/backfill-png-derivatives.mjs";
import { DERIVED_CACHE_SECONDS as APP_DERIVED_CACHE_SECONDS } from "./storage-cache";

const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#4080c0" } }).png().toBuffer();
const webp = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#4080c0" } }).webp().toBuffer();
const jpeg = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#4080c0" } }).jpeg().toBuffer();

interface Stored { bytes: Buffer; mimetype: string | null; cacheControl: string }

/** An in-memory photos bucket with the four storage calls the script uses. */
function fakeStorage(files: Record<string, Stored>) {
  const writes: string[] = [];
  const storage = {
    async list(prefix: string, { limit, offset }: { limit: number; offset: number }) {
      const depth = prefix.split("/").length;
      const names = [...new Set(Object.keys(files)
        .filter((name) => name.startsWith(`${prefix}/`))
        .map((name) => name.split("/").slice(0, depth + 1).join("/")))].sort();
      const data = names.slice(offset, offset + limit).map((full) => {
        const file = files[full];
        const name = full.slice(prefix.length + 1);
        return file
          ? { id: full, name, metadata: { mimetype: file.mimetype, cacheControl: file.cacheControl, size: file.bytes.length } }
          : { id: null, name, metadata: null };
      });
      return { data, error: null };
    },
    async download(name: string) {
      const file = files[name];
      return file ? { data: new Blob([new Uint8Array(file.bytes)]), error: null } : { data: null, error: { message: "not found" } };
    },
    async update(name: string, body: Buffer, options: { contentType: string; cacheControl: string }) {
      if (!files[name]) return { error: { message: "not found" } };
      writes.push(name);
      files[name] = { bytes: Buffer.from(body), mimetype: options.contentType, cacheControl: `max-age=${options.cacheControl}` };
      return { error: null };
    },
  };
  return { storage, files, writes };
}

const quiet = () => {};
const opts = (extra: Partial<ReturnType<typeof parseArgs>> = {}) => ({ ...parseArgs([]), ...extra });

describe("PNG derivative backfill", () => {
  it("is a dry run unless --execute is given, and refuses unknown options", () => {
    expect(parseArgs([])).toMatchObject({ execute: false, recache: false, limit: Infinity, concurrency: 4 });
    expect(parseArgs(["--execute", "--recache", "--limit", "10"])).toMatchObject({ execute: true, recache: true, limit: 10 });
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--force"])).toThrow();
  });

  it("uses the same one-year cache as the app's uploads", () => {
    expect(DERIVED_CACHE_SECONDS).toBe(APP_DERIVED_CACHE_SECONDS);
  });

  it("picks PNG and mislabelled thumbnails and previews, never other files", () => {
    const at = (name: string, mimetype: string | null, cacheControl = "max-age=3600") => ({ name, metadata: { mimetype, cacheControl } });
    expect(reasonFor(at("derived/u/p_thumb.webp", "image/png"), { recache: false })).toBe("png");
    expect(reasonFor(at("derived/u/p_preview.webp", "application/octet-stream"), { recache: false })).toBe("mislabelled");
    expect(reasonFor(at("derived/u/p_thumb.webp", "image/webp"), { recache: false })).toBeNull();
    expect(reasonFor(at("derived/u/p_thumb.webp", "image/jpeg"), { recache: false })).toBeNull();
    expect(reasonFor(at("derived/u/p_thumb.webp", "image/webp"), { recache: true })).toBe("short-cache");
    expect(reasonFor(at("derived/u/p_thumb.webp", "image/webp", "max-age=31536000"), { recache: true })).toBeNull();
    expect(reasonFor(at("derived/u/p_playback.mp4", "application/octet-stream"), { recache: true })).toBeNull();
  });

  it("re-encodes PNG to WebP and keeps WebP and JPEG bytes as they are", async () => {
    const fromPng = await convert(await png(), sharp);
    expect(fromPng?.contentType).toBe("image/webp");
    expect(sniff(fromPng!.body)).toBe("image/webp");
    const realWebp = await webp();
    expect(await convert(realWebp, sharp)).toEqual({ body: realWebp, contentType: "image/webp" });
    expect((await convert(await jpeg(), sharp))?.contentType).toBe("image/jpeg");
    expect(await convert(Buffer.from("not an image"), sharp)).toBeNull();
  });

  it("writes nothing on a dry run", async () => {
    const { storage, writes } = fakeStorage({
      "derived/u1/a_thumb.webp": { bytes: await png(), mimetype: "image/png", cacheControl: "max-age=3600" },
    });
    const counts = await run({ storage, sharp, opts: opts(), log: quiet });
    expect(counts).toMatchObject({ listed: 1, candidates: 1, png: 1 });
    expect(writes).toEqual([]);
  });

  it("fixes PNG and mislabelled files in place with the long cache, and a re-run finds nothing", async () => {
    const { storage, files, writes } = fakeStorage({
      "derived/u1/a_thumb.webp": { bytes: await png(), mimetype: "image/png", cacheControl: "max-age=3600" },
      "derived/u1/a_preview.webp": { bytes: await png(), mimetype: "image/png", cacheControl: "max-age=3600" },
      "derived/u1/b_thumb.webp": { bytes: await webp(), mimetype: "application/octet-stream", cacheControl: "max-age=3600" },
      "derived/u2/c_thumb.webp": { bytes: await webp(), mimetype: "image/webp", cacheControl: "max-age=3600" },
      "derived/u2/c_playback.mp4": { bytes: Buffer.from("mp4"), mimetype: "video/mp4", cacheControl: "max-age=3600" },
      "derived/u2/d_thumb.webp": { bytes: Buffer.from("garbage"), mimetype: "image/png", cacheControl: "max-age=3600" },
    });

    const counts = await run({ storage, sharp, opts: opts({ execute: true }), log: quiet });

    expect(counts).toMatchObject({ listed: 6, candidates: 4, reencoded: 2, relabelled: 1, unknownBytes: 1, errors: 0 });
    expect(files["derived/u1/a_thumb.webp"]).toMatchObject({ mimetype: "image/webp", cacheControl: "max-age=31536000" });
    expect(sniff(files["derived/u1/a_thumb.webp"].bytes)).toBe("image/webp");
    expect(files["derived/u1/b_thumb.webp"]).toMatchObject({ mimetype: "image/webp", cacheControl: "max-age=31536000" });
    // Correct files are left alone without --recache.
    expect(writes).not.toContain("derived/u2/c_thumb.webp");

    writes.length = 0;
    const again = await run({ storage, sharp, opts: opts({ execute: true }), log: quiet });
    // Only the unreadable file still matches, and it is still left alone.
    expect(again).toMatchObject({ candidates: 1, unknownBytes: 1 });
    expect(writes).toEqual([]);
  });

  it("with --recache gives correct one-hour files the long cache, keeping their bytes", async () => {
    const bytes = await webp();
    const { storage, files } = fakeStorage({
      "derived/u2/c_thumb.webp": { bytes, mimetype: "image/webp", cacheControl: "max-age=3600" },
    });
    const counts = await run({ storage, sharp, opts: opts({ execute: true, recache: true }), log: quiet });
    expect(counts).toMatchObject({ recached: 1 });
    expect(files["derived/u2/c_thumb.webp"]).toMatchObject({ mimetype: "image/webp", cacheControl: "max-age=31536000" });
    expect(files["derived/u2/c_thumb.webp"].bytes.equals(bytes)).toBe(true);
  });

  it("stops after --limit files and counts a vanished file as an error, not a recreation", async () => {
    const { storage, files, writes } = fakeStorage({
      "derived/u1/a_thumb.webp": { bytes: await png(), mimetype: "image/png", cacheControl: "max-age=3600" },
      "derived/u1/b_thumb.webp": { bytes: await png(), mimetype: "image/png", cacheControl: "max-age=3600" },
    });
    const update = storage.update;
    storage.update = async (name, body, options) => {
      if (name.includes("/a_")) delete files[name]; // purged mid-run
      return update(name, body, options);
    };
    const counts = await run({ storage, sharp, opts: opts({ execute: true, limit: 1 }), log: quiet });
    expect(counts).toMatchObject({ candidates: 2, errors: 1, reencoded: 0 });
    expect(files["derived/u1/a_thumb.webp"]).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
