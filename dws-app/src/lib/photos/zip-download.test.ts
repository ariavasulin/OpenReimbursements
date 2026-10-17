import { describe, expect, it, vi } from "vitest";
import {
  findRows,
  formatDownloadSize,
  inOrderPool,
  isLargeDownload,
  ROW_LOOKUP_SIZE,
  selectionBytes,
  ZIP_WARN_BYTES,
  ZIP_WARN_BYTES_IN_MEMORY,
  zipEntryNames,
  zipFileName,
  type ZipRow,
} from "./zip-download";

const row = (id: string, fields: Partial<ZipRow> = {}): ZipRow => ({
  id,
  original_path: `originals/${id}.jpg`,
  original_bytes: 1000,
  original_name: "IMG_0001.JPG",
  display_name: null,
  captured_at: "2026-09-23T23:04:32Z",
  ...fields,
});

describe("zipEntryNames", () => {
  it("names each entry like a single download, numbering repeats before the extension", () => {
    const names = zipEntryNames([
      row("a", { display_name: "3962 – 260923 160432" }),
      row("b", { display_name: "3962 – 260923 160432" }),
      row("c", { display_name: "3962 – 260923 160432" }),
      row("d", { display_name: "Kitchen", original_name: "k.heic" }),
    ]);
    expect(names).toEqual([
      "3962 – 260923 160432.JPG",
      "3962 – 260923 160432 (2).JPG",
      "3962 – 260923 160432 (3).JPG",
      "Kitchen.heic",
    ]);
  });

  it("treats names that differ only in case as the same, and skips a number already used", () => {
    const names = zipEntryNames([
      row("a", { original_name: "IMG.jpg" }),
      row("b", { original_name: "img (2).JPG" }),
      row("c", { original_name: "img.JPG" }),
    ]);
    expect(names).toEqual(["IMG.jpg", "img (2).JPG", "img (3).JPG"]);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
  });

  it("keeps 40 photos with one automatic name unique", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`p${i}`, { display_name: "260923 160432" }));
    const names = zipEntryNames(rows);
    expect(new Set(names).size).toBe(40);
    expect(names[39]).toBe("260923 160432 (40).JPG");
  });

  it("replaces characters a zip or Windows cannot hold, and names a nameless photo", () => {
    expect(zipEntryNames([row("a", { display_name: 'Shop/Field: "A" | B?' })])).toEqual([
      "Shop-Field- -A- - B-.JPG",
    ]);
    expect(zipEntryNames([row("a", { original_name: null }), row("b", { original_name: null })])).toEqual([
      "photo.jpg",
      "photo (2).jpg",
    ]);
  });
});

describe("selectionBytes and the size warnings", () => {
  it("adds the recorded sizes and counts the unknown ones", () => {
    expect(
      selectionBytes([{ original_bytes: 1500 }, { original_bytes: null }, { original_bytes: 2500 }])
    ).toEqual({ bytes: 4000, unknown: 1 });
    expect(selectionBytes([])).toEqual({ bytes: 0, unknown: 0 });
  });

  it("warns above 2 GB when the zip streams to a file", () => {
    expect(ZIP_WARN_BYTES).toBe(2 * 1024 ** 3);
    expect(isLargeDownload(ZIP_WARN_BYTES)).toBe(false);
    expect(isLargeDownload(ZIP_WARN_BYTES + 1)).toBe(true);
    expect(isLargeDownload(40 * 3_000_000)).toBe(false);
  });

  it("warns above 400 MB when the zip is built in memory (phones, Safari, Firefox)", () => {
    expect(ZIP_WARN_BYTES_IN_MEMORY).toBe(400 * 1024 ** 2);
    expect(isLargeDownload(ZIP_WARN_BYTES_IN_MEMORY, true)).toBe(false);
    expect(isLargeDownload(ZIP_WARN_BYTES_IN_MEMORY + 1, true)).toBe(true);
    // 120 phone photos of about 3 MB fit; 200 do not.
    expect(isLargeDownload(120 * 3_000_000, true)).toBe(false);
    expect(isLargeDownload(200 * 3_000_000, true)).toBe(true);
  });

  it("writes sizes in GB past a gigabyte", () => {
    expect(formatDownloadSize(ZIP_WARN_BYTES + 0.4 * 1024 ** 3)).toBe("2.4 GB");
    expect(formatDownloadSize(120 * 1024 * 1024)).toBe("120.0 MB");
    expect(formatDownloadSize(0)).toBe("0 B");
  });
});

describe("zipFileName", () => {
  it("uses the album's name, else Photos and the date", () => {
    expect(zipFileName(new Date(2026, 9, 2), "Lobby / before")).toBe("Lobby - before.zip");
    expect(zipFileName(new Date(2026, 9, 2))).toBe("Photos 2026-10-02.zip");
  });
});

describe("inOrderPool", () => {
  it("runs at most `size` at once and yields in item order", async () => {
    let running = 0;
    let peak = 0;
    const out: number[] = [];
    const work = async (n: number) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 2));
      running -= 1;
      return n * 10;
    };
    for await (const value of inOrderPool([0, 1, 2, 3, 4], 2, work)) out.push(value);
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });
});

describe("findRows", () => {
  /** A rows lookup that knows p0…p1199, recording each request's ids. */
  const library = new Map(Array.from({ length: 1200 }, (_, i) => [`p${i}`, row(`p${i}`)]));
  const lookup = vi.fn(async (ids: string[]) => ids.flatMap((id) => library.get(id) ?? []));

  it("uses loaded rows, looks the rest up by id, and names the ones no longer available", async () => {
    lookup.mockClear();
    const ids = ["p0", "p250", "gone", "p5"];
    const { rows, missing } = await findRows(ids, [row("p0"), row("p5")], lookup);
    expect(rows.map((r) => r.id)).toEqual(["p0", "p250", "p5"]);
    expect(missing).toEqual(["gone"]);
    expect(lookup.mock.calls.map(([sent]) => sent)).toEqual([["p250", "gone"]]);
  });

  it("asks ROW_LOOKUP_SIZE ids a request, keeps the selection's order, and asks nothing when all are loaded", async () => {
    lookup.mockClear();
    const ids = Array.from({ length: 1200 }, (_, i) => `p${1199 - i}`);
    const { rows, missing } = await findRows(ids, [], lookup);
    expect(lookup.mock.calls.map(([sent]) => sent.length)).toEqual([ROW_LOOKUP_SIZE, ROW_LOOKUP_SIZE, 1200 - 2 * ROW_LOOKUP_SIZE]);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(missing).toEqual([]);
    lookup.mockClear();
    await findRows(["p3"], [row("p3")], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("passes the signal on, and fails when a lookup fails", async () => {
    const controller = new AbortController();
    const seen = vi.fn(async (_ids: string[], signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return [];
    });
    await findRows(["x"], [], seen, controller.signal);
    expect(seen).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => {
      throw new Error("Could not look up the photos (500)");
    });
    await expect(findRows(["x"], [], failing)).rejects.toThrow("(500)");
  });
});
