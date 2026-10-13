import { describe, expect, it, vi } from "vitest";
import {
  findRows,
  formatDownloadSize,
  inOrderPool,
  isLargeDownload,
  selectionBytes,
  ZIP_WARN_BYTES,
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

describe("selectionBytes and the 2 GB rule", () => {
  it("adds the recorded sizes and counts the unknown ones", () => {
    expect(
      selectionBytes([{ original_bytes: 1500 }, { original_bytes: null }, { original_bytes: 2500 }])
    ).toEqual({ bytes: 4000, unknown: 1 });
    expect(selectionBytes([])).toEqual({ bytes: 0, unknown: 0 });
  });

  it("warns only above 2 GB", () => {
    expect(ZIP_WARN_BYTES).toBe(2 * 1024 ** 3);
    expect(isLargeDownload(ZIP_WARN_BYTES)).toBe(false);
    expect(isLargeDownload(ZIP_WARN_BYTES + 1)).toBe(true);
    expect(isLargeDownload(40 * 3_000_000)).toBe(false);
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
  const listed = Array.from({ length: 450 }, (_, i) => row(`p${i}`));
  const page = vi.fn(async (params: URLSearchParams) => {
    const start = Number(params.get("cursor") ?? 0);
    const limit = Number(params.get("limit"));
    const end = start + limit;
    return { photos: listed.slice(start, end), nextCursor: end < listed.length ? String(end) : null };
  });

  it("uses loaded rows, walks the grid's list until every id is found, then asks for leftovers", async () => {
    page.mockClear();
    const one = vi.fn(async (id: string) => (id === "gone" ? null : row(id)));
    const ids = ["p0", "p250", "elsewhere", "gone", "p5"];
    const { rows, missing } = await findRows(ids, [row("p0"), row("p5")], "job=j1&sort=asc", { page, one });
    expect(rows.map((r) => r.id)).toEqual(["p0", "p250", "elsewhere", "p5"]);
    expect(missing).toEqual(["gone"]);
    // Three pages of 200 hold 450 rows; "elsewhere" and "gone" are not in them.
    expect(page).toHaveBeenCalledTimes(3);
    expect(page.mock.calls[0][0].toString()).toBe("job=j1&sort=asc&limit=200");
    expect(one.mock.calls.map(([id]) => id)).toEqual(["elsewhere", "gone"]);
  });

  it("stops walking once every id is found, and asks nothing when all are loaded", async () => {
    page.mockClear();
    const one = vi.fn(async () => null);
    await findRows(["p3", "p150"], [], "", { page, one });
    expect(page).toHaveBeenCalledTimes(1);
    page.mockClear();
    await findRows(["p3"], [row("p3")], "", { page, one });
    expect(page).not.toHaveBeenCalled();
    expect(one).not.toHaveBeenCalled();
  });

  it("fails when a lookup fails", async () => {
    const one = vi.fn(async () => {
      throw new Error("Could not look up a photo (500)");
    });
    await expect(findRows(["x"], [], null, { page, one })).rejects.toThrow("(500)");
  });
});
