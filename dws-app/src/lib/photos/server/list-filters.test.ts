import { describe, expect, it } from "vitest";
import {
  afterBound,
  afterFilter,
  decodePhotoCursor,
  encodePhotoCursor,
  fileTypeFilter,
  listColumns,
  MAX_SEARCH_WORDS,
  parsePhotoFilters,
  pastPosition,
  photoSource,
  searchWords,
  type PhotoFilters,
} from "./list-filters";
import { fileTypeSignals } from "../file-type";

const parse = (query: string) => parsePhotoFilters(new URLSearchParams(query));
const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("parsePhotoFilters", () => {
  it("reads every filter, with no filter meaning everything newest first", () => {
    expect(parse("")).toEqual({ job: null, noProject: false, album: null, uploader: null, tags: [], type: null,
      from: null, to: null, words: null, direction: "desc", custom: false, favorites: false });
    expect(parse(`job=none&album=${id}&uploader=${id}&tags=a, b,,&type=raw&from=2026-09-01T07:00:00.000Z&to=2026-09-08T06:59:59.999Z&q=3962 professional&sort=asc`))
      .toEqual({ job: null, noProject: true, album: id, uploader: id, tags: ["a", "b"], type: "RAW",
        from: "2026-09-01T07:00:00.000Z", to: "2026-09-08T06:59:59.999Z", words: ["3962", "professional"], direction: "asc", custom: false, favorites: false });
    expect(parse("type=video")).toMatchObject({ type: "Video" });
    expect(parse("from=2026-09-01T00:00:00-07:00".replace("+", "%2B"))).toMatchObject({ from: "2026-09-01T00:00:00-07:00" });
  });

  it("refuses malformed values with a message", () => {
    for (const bad of ["job=x", "album=x", "uploader=x", "sort=ASC", "sort=custom", "sort=custom&job=none", "type=RAW", "type=gif", "from=2026-09-01",
      "to=yesterday", "from=2026-09-01T00:00:00", `q=${Array.from({ length: MAX_SEARCH_WORDS + 1 }, (_, i) => `w${i}`).join("+")}`]) {
      expect(typeof parse(bad), bad).toBe("string");
    }
  });
});

describe("custom order (sort=custom)", () => {
  const custom = parse(`album=${id}&sort=custom`) as PhotoFilters;
  const dated = parse(`album=${id}`) as PhotoFilters;
  const capturedAt = "2026-09-01T07:00:00+00:00";

  it("needs an album and always walks ascending", () => {
    expect(custom).toMatchObject({ album: id, custom: true, direction: "asc" });
    expect(parse("sort=custom")).toBe("sort=custom needs an album");
  });

  it("marks a cursor with its order, so neither order reads the other's", () => {
    for (const position of [3, 1.5, "Infinity"]) {
      const cursor = encodePhotoCursor(custom, { id, album_position: position });
      expect(decodePhotoCursor(custom, cursor)).toEqual({ key: String(position), id });
      expect(decodePhotoCursor(dated, cursor)).toBeNull();
    }
    const dateCursor = encodePhotoCursor(dated, { id, captured_at: capturedAt });
    expect(decodePhotoCursor(dated, dateCursor)).toEqual({ key: capturedAt, id });
    expect(decodePhotoCursor(custom, dateCursor)).toBeNull();
    // Only a number (or Infinity) after the mark can reach a filter string.
    for (const key of ["position:", "position:1,id.gt.x", "position:-Infinity", "position:NaN", "3"]) {
      expect(decodePhotoCursor(custom, Buffer.from(JSON.stringify([key, id])).toString("base64url")), key).toBeNull();
    }
  });

  it("continues past (album_position, id) ascending", () => {
    expect(afterFilter(custom, { key: "2", id })).toBe(`album_position.gt.2,and(album_position.eq.2,id.gt.${id})`);
    expect(afterFilter(dated, { key: capturedAt, id })).toBe(`captured_at.lt.${capturedAt},and(captured_at.eq.${capturedAt},id.lt.${id})`);
  });

  it("bounds the sort column too, so the index has a place to start", () => {
    expect(afterBound(dated, { key: capturedAt, id })).toEqual({ column: "captured_at", operator: "lte", value: capturedAt });
    expect(afterBound(parse("sort=asc") as PhotoFilters, { key: capturedAt, id }))
      .toEqual({ column: "captured_at", operator: "gte", value: capturedAt });
    expect(afterBound(custom, { key: "Infinity", id })).toEqual({ column: "album_position", operator: "gte", value: "Infinity" });
  });

  it("continues a query with both the or() and the bound", () => {
    const calls: unknown[][] = [];
    const query = {
      or(filter: string) { calls.push(["or", filter]); return query; },
      filter(column: string, operator: string, value: unknown) { calls.push(["filter", column, operator, value]); return query; },
    };
    expect(pastPosition(query, dated, { key: capturedAt, id })).toBe(query);
    expect(calls).toEqual([
      ["or", afterFilter(dated, { key: capturedAt, id })],
      ["filter", "captured_at", "lte", capturedAt],
    ]);
  });
});

describe("where a list reads from", () => {
  const filters = (query: string) => parse(query) as PhotoFilters;

  it("starts from the album or the favorites, not the whole library", () => {
    expect(photoSource(filters(""))).toBe("photos");
    expect(photoSource(filters(`job=${id}&tags=a`))).toBe("photos");
    expect(photoSource(filters(`album=${id}`))).toBe("album_photo_order");
    expect(photoSource(filters(`album=${id}&sort=custom`))).toBe("album_photo_order");
    expect(photoSource(filters("favorites=1"))).toBe("photo_favorite_photos");
    // Album plus favorites: the album bounds the read; the favorites embed filters it.
    expect(photoSource(filters(`album=${id}&favorites=1`))).toBe("album_photo_order");
  });

  it("selects the position only for custom order, and the favorites embed once", () => {
    const embed = "favorites:photo_favorites(user_id)";
    expect(listColumns(filters(""), "id", embed)).toBe(`id, ${embed}`);
    expect(listColumns(filters("favorites=1"), "id", embed)).toBe(`id, ${embed}`);
    expect(listColumns(filters(`album=${id}&sort=custom`), "id", embed)).toBe(`id, album_position, ${embed}`);
    expect(listColumns(filters(`album=${id}&favorites=1`), "id", embed)).toBe("id");
  });
});

describe("searchWords", () => {
  it("splits on whitespace and filter grammar, once per word whatever its case", () => {
    expect(searchWords("  yana   Sept ")).toEqual(["yana", "Sept"]);
    expect(searchWords("punch (list),Punch*x \"quoted\"")).toEqual(["punch", "list", "x", "quoted"]);
    expect(parse("q=() ,")).toMatchObject({ words: null });
  });
});

describe("fileTypeFilter", () => {
  it("draws its lists from the labels' own tables", () => {
    const signals = fileTypeSignals();
    expect(signals.RAW.extensions.sort()).toEqual(["arw", "cr2", "cr3", "dng", "nef", "tif", "tiff"]);
    expect(signals.JPEG).toEqual({ extensions: ["jpg", "jpeg"], mimes: ["image/jpeg"] });
    expect(signals.HEIC.mimes).toEqual(["image/heic", "image/heif"]);
    const png = fileTypeFilter("PNG");
    expect(png.startsWith("and(kind.neq.video,or(original_name.ilike._%.png,")).toBe(true);
    expect(png).toContain("or(mime_type.ilike.image/png)");
    expect(fileTypeFilter("Video").startsWith("kind.eq.video,")).toBe(true);
    // The route's integration test checks each filter against fileTypeLabel row by row.
  });
});

describe("favorites", () => {
  it("reads favorites=1 and refuses any other value", () => {
    const on = parsePhotoFilters(new URLSearchParams("favorites=1"));
    expect(on).toMatchObject({ favorites: true });
    expect(parsePhotoFilters(new URLSearchParams(""))).toMatchObject({ favorites: false });
    expect(parsePhotoFilters(new URLSearchParams("favorites=yes"))).toBe("Invalid favorites");
  });
});
