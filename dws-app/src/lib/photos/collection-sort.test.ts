import { describe, expect, it } from "vitest";
import { jobNumberKey, nameKey, parseAlbumSort, parseJobSort, sortAlbums, sortJobs } from "./collection-sort";
import type { PhotoAlbumSummary, PhotoJobSummary } from "./types";

const job = (id: string, job_number: string, name: string, latest_activity: string | null = null, photo_count = 0): PhotoJobSummary =>
  ({ id, job_number, name, location: null, photo_count, thumb_paths: [], latest_activity });
const album = (id: string, name: string, extra: Partial<PhotoAlbumSummary> = {}): PhotoAlbumSummary =>
  ({ id, name, photo_count: 0, thumb_paths: [], created_at: "2026-01-01T00:00:00Z", created_by: null, latest_activity: null, sort_mode: "date", has_custom_order: false, ...extra });

describe("the Projects and Albums Sort chip", () => {
  it("reads the URL value and falls back to each page's default", () => {
    expect(parseJobSort("recent")).toBe("recent");
    expect(parseJobSort("desc")).toBe("number");
    expect(parseJobSort(null)).toBe("number");
    expect(parseAlbumSort("count")).toBe("count");
    expect(parseAlbumSort("number")).toBe("name");
  });

  it("builds the same keys as the SQL page functions", () => {
    expect(jobNumberKey("3612")).toBe(`1${"3612".padStart(20, "0")}`);
    expect(jobNumberKey("P-7")).toBe(`0${"7".padStart(20, "0")}`);
    expect(jobNumberKey("ABC")).toBe("0ABC");
    expect(nameKey("Kitchen 2")).toBe("kitchen 000000000002");
    expect(nameKey("Kitchen 10") > nameKey("Kitchen 2")).toBe(true);
  });

  it("orders projects by number (newest first, codes last), by name, or by latest upload", () => {
    const jobs = [job("a", "399", "Zed", "2026-10-01T00:00:00Z"), job("b", "P-2", "Alpha", null), job("c", "3612", "Mid", "2026-09-01T00:00:00Z"), job("d", "P-10", "Beta", "2026-11-01T00:00:00Z")];
    expect(sortJobs(jobs, "number").map((j) => j.job_number)).toEqual(["3612", "399", "P-10", "P-2"]);
    expect(sortJobs(jobs, "name").map((j) => j.name)).toEqual(["Alpha", "Beta", "Mid", "Zed"]);
    expect(sortJobs(jobs, "recent").map((j) => j.job_number)).toEqual(["P-10", "399", "3612", "P-2"]);
    expect(jobs.map((j) => j.id)).toEqual(["a", "b", "c", "d"]); // never sorted in place
  });

  it("orders albums by name (digits first, as numbers), by latest added, or by size", () => {
    const albums = [
      album("a", "Marketing", { latest_activity: "2026-09-01T00:00:00Z", photo_count: 3 }),
      album("b", "100 Stockton", { photo_count: 9 }),
      album("c", "50 California", { created_at: "2026-10-01T00:00:00Z" }),
      album("d", "adyen", { latest_activity: "2026-08-01T00:00:00Z", photo_count: 9 }),
    ];
    expect(sortAlbums(albums, "name").map((a) => a.name)).toEqual(["50 California", "100 Stockton", "adyen", "Marketing"]);
    expect(sortAlbums(albums, "recent").map((a) => a.name)).toEqual(["50 California", "Marketing", "adyen", "100 Stockton"]);
    expect(sortAlbums(albums, "count").map((a) => a.name)).toEqual(["100 Stockton", "adyen", "Marketing", "50 California"]);
  });
});
