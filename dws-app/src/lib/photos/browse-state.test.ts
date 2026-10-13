import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  customRange,
  dateFilterLabel,
  groupFilters,
  localDayRange,
  NO_FILTERS,
  parseBrowseState,
  presetRange,
  toDayInput,
  withFilterParams,
  writeBrowseState,
  type BrowseFilters,
  type BrowseOptions,
} from "./browse-state";
import type { PhotoGroup } from "./group";
import type { PhotoRow } from "./types";

const photos: BrowseOptions = { groupModes: ["date", "tag", "uploader", "type"], projectFilter: true };
const project: BrowseOptions = { groupModes: ["date", "tag", "uploader", "type"], projectFilter: false };
const from = "2026-09-01T07:00:00.000Z", to = "2026-10-01T06:59:59.999Z";

describe("parseBrowseState / writeBrowseState", () => {
  it("round-trips every filter, the sort, and the group, and leaves other keys alone", () => {
    const state = {
      filters: { project: "p1", uploader: "u1", tags: ["shop drawing", "professional"], type: "RAW" as const, from, to, favorites: true },
      sort: "asc" as const,
      group: "tag" as const,
    };
    const search = writeBrowseState("?q=3962&photo=x", state, photos);
    const params = new URLSearchParams(search);
    expect(params.get("q")).toBe("3962");
    expect(params.get("photo")).toBe("x");
    expect(params.get("tags")).toBe("shop drawing,professional");
    expect(params.get("type")).toBe("raw");
    expect(params.get("from")).toBe(from);
    expect(params.get("favorites")).toBe("1");
    expect(parseBrowseState(search, photos)).toEqual(state);
  });

  it("writes nothing for the defaults, so Clear leaves a plain URL", () => {
    const search = writeBrowseState("?tags=a&sort=asc&group=tag", { filters: NO_FILTERS, sort: "desc", group: "date" }, photos);
    expect(search).toBe("");
    expect(writeBrowseState("?q=x&tags=a", { filters: NO_FILTERS, sort: "desc", group: "date" }, photos)).toBe("?q=x");
  });

  it("ignores project where the page has none, and bad values anywhere", () => {
    const state = parseBrowseState("project=p1&type=RAW&from=2026-09-01&to=nope&sort=up&group=job&tags=,a,,a", project);
    expect(state).toEqual({ filters: { ...NO_FILTERS, tags: ["a"] }, sort: "desc", group: "date" });
    expect(writeBrowseState("", { ...state, filters: { ...state.filters, project: "p1" } }, project)).toBe("?tags=a");
  });

  it("counts each tag as its own filter and a date range as one", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, project: "none", tags: ["a", "b"], from, favorites: true })).toBe(5);
  });
});

describe("an album's custom order", () => {
  const arranged: BrowseOptions = { ...project, defaultSort: "custom", customSort: true };
  const dated: BrowseOptions = { ...project, customSort: true };

  it("defaults to the album's own order and writes only a different choice", () => {
    expect(parseBrowseState("", arranged).sort).toBe("custom");
    expect(parseBrowseState("", dated).sort).toBe("desc");
    expect(parseBrowseState("sort=desc", arranged).sort).toBe("desc");
    expect(parseBrowseState("sort=custom", dated).sort).toBe("custom");
    const state = { filters: NO_FILTERS, sort: "custom" as const, group: "date" as const };
    expect(writeBrowseState("", state, arranged)).toBe("");
    expect(writeBrowseState("", state, dated)).toBe("?sort=custom");
    expect(writeBrowseState("", { ...state, sort: "desc" }, arranged)).toBe("?sort=desc");
  });

  it("is no choice on a page without an album", () => {
    expect(parseBrowseState("sort=custom", photos).sort).toBe("desc");
  });

  it("asks the server for sort=custom, and its one list's tick takes every match", () => {
    expect(withFilterParams(new URLSearchParams({ album: "a1" }), NO_FILTERS, "custom").get("sort")).toBe("custom");
    const filters = { ...NO_FILTERS, tags: ["a"] };
    expect(groupFilters({ key: "custom:all", label: "Custom order", photos: [] }, filters)).toBe(filters);
  });
});

describe("withFilterParams", () => {
  it("adds the filters to the scope; the URL's project is the API's job", () => {
    const params = withFilterParams(new URLSearchParams({ q: "yana" }), { ...NO_FILTERS, project: "none", tags: ["a", "b"], type: "Video", to }, "asc");
    expect(Object.fromEntries(params)).toEqual({ q: "yana", job: "none", tags: "a,b", type: "video", to, sort: "asc" });
  });
});

describe("dates", () => {
  // A Wednesday in local time, whatever zone the tests run in.
  const now = new Date(2026, 9, 14, 15, 30);

  it("turns presets into local-time instants ending one millisecond before the next period", () => {
    expect(presetRange("week", now)).toEqual({ from: new Date(2026, 9, 11).toISOString(), to: new Date(new Date(2026, 9, 18).getTime() - 1).toISOString() });
    expect(presetRange("month", now)).toEqual({ from: new Date(2026, 9, 1).toISOString(), to: new Date(new Date(2026, 10, 1).getTime() - 1).toISOString() });
    expect(presetRange("year", now).from).toBe(new Date(2026, 0, 1).toISOString());
    expect(dateFilterLabel(presetRange("month", now), now)).toBe("This month");
  });

  it("reads a custom range as whole local days, in order, either end optional", () => {
    expect(customRange("2032-03-03", "2032-03-01")).toEqual({ from: localDayRange(new Date(2032, 2, 1)).from, to: localDayRange(new Date(2032, 2, 3)).to });
    expect(customRange("", "2032-03-03")).toEqual({ from: null, to: localDayRange(new Date(2032, 2, 3)).to });
    expect(customRange("", "")).toBeNull();
    expect(toDayInput(localDayRange(new Date(2032, 2, 3)).to)).toBe("2032-03-03");
  });

  it("labels a range by its days", () => {
    expect(dateFilterLabel(customRange("2032-03-01", "2032-03-03")!, now)).toBe("Mar 1 – Mar 3, 2032");
    expect(dateFilterLabel(customRange("2031-12-30", "2032-01-02")!, now)).toBe("Dec 30, 2031 – Jan 2, 2032");
    expect(dateFilterLabel(customRange("2032-03-01", "2032-03-01")!, now)).toBe("Mar 1, 2032");
    expect(dateFilterLabel(customRange("2032-03-01", "")!, now)).toBe("From Mar 1, 2032");
    expect(dateFilterLabel(customRange("", "2032-03-01")!, now)).toBe("Until Mar 1, 2032");
  });
});

describe("groupFilters", () => {
  const photo = (captured: Date) => ({ captured_at: captured.toISOString() }) as PhotoRow;
  const group = (key: string, rows: PhotoRow[] = []): PhotoGroup => ({ key, label: key, photos: rows });
  const base: BrowseFilters = { ...NO_FILTERS, tags: ["a"] };

  it("names a date group's local day, kept inside the grid's own range", () => {
    const day = new Date(2032, 2, 2, 11);
    expect(groupFilters(group(`date:${day.toDateString()}`, [photo(day)]), base)).toEqual({ ...base, ...localDayRange(day) });
    const noon = new Date(2032, 2, 2, 12).toISOString();
    expect(groupFilters(group(`date:${day.toDateString()}`, [photo(day)]), { ...base, from: noon })!.from).toBe(noon);
    expect(groupFilters(group("date:unknown", [photo(day)]), base)).toBeNull();
  });

  it("names a tag, uploader, type, or project group by its key", () => {
    expect(groupFilters(group("tag:shop: drawing"), base)!.tags).toEqual(["a", "shop: drawing"]);
    expect(groupFilters(group("tag:a"), base)!.tags).toEqual(["a"]);
    expect(groupFilters(group("uploader:u9"), base)!.uploader).toBe("u9");
    expect(groupFilters(group("type:RAW"), base)!.type).toBe("RAW");
    expect(groupFilters(group("job:none"), base)!.project).toBe("none");
  });

  it("has no filter for the groups that collect what is missing", () => {
    expect(groupFilters(group("tag:none"), base)).toBeNull();
    expect(groupFilters(group("uploader:unknown"), base)).toBeNull();
  });
});
