import { describe, expect, it } from "vitest";
import { filterJobs } from "./job-filter";
import type { PhotoJobSummary } from "./types";

function makeJob(job_number: string, name: string): PhotoJobSummary {
  return {
    id: `job-${job_number}`,
    job_number,
    name,
    location: null,
    photo_count: 0,
    thumb_paths: [],
  };
}

// API order: most recent activity first.
const jobs = [
  makeJob("4100", "Harbor View Lobby"),
  makeJob("3962", "Westbridge Residence"),
  makeJob("3901", "Museum Tower 39th Floor"),
  makeJob("2210", "West End Cafe"),
  makeJob("3950", "Key West Bungalow"),
];

describe("filterJobs", () => {
  it("returns the first N in API order for an empty query", () => {
    expect(filterJobs(jobs, "", 3).map((j) => j.job_number)).toEqual([
      "4100",
      "3962",
      "3901",
    ]);
    expect(filterJobs(jobs, "   ")).toHaveLength(jobs.length);
  });

  it("ranks a job-number prefix above a name match", () => {
    // "39" is a prefix of 3962/3901/3950 and also appears in "39th Floor".
    const numbers = filterJobs(jobs, "39").map((j) => j.job_number);
    expect(numbers).toEqual(["3962", "3901", "3950"]);
  });

  it("puts an exact job number first", () => {
    expect(filterJobs(jobs, "3901")[0].job_number).toBe("3901");
  });

  it("matches word prefixes in the name, case-insensitive", () => {
    const numbers = filterJobs(jobs, "WEST").map((j) => j.job_number);
    expect(numbers).toEqual(["3962", "2210", "3950"]);
  });

  it("requires every word of a multi-word query to prefix some name word", () => {
    expect(filterJobs(jobs, "west end").map((j) => j.job_number)).toEqual([
      "2210",
    ]);
    expect(filterJobs(jobs, "key bung").map((j) => j.job_number)).toEqual([
      "3950",
    ]);
  });

  it("falls back to a substring match on the name", () => {
    expect(filterJobs(jobs, "bridge").map((j) => j.job_number)).toEqual([
      "3962",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterJobs(jobs, "zzz")).toEqual([]);
  });

  it("caps the result at limit", () => {
    expect(filterJobs(jobs, "", 2)).toHaveLength(2);
    expect(filterJobs(jobs, "west", 1)).toHaveLength(1);
  });
});
