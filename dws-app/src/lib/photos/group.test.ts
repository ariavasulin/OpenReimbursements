import { describe, expect, it } from "vitest";
import { groupPhotos } from "./group";
import type { PhotoRow } from "./types";

let counter = 0;

function makePhoto(overrides: Partial<PhotoRow> = {}): PhotoRow {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    job_id: "job-1",
    uploader_id: "user-1",
    kind: "image",
    tags: [],
    captured_at: "2026-08-14T14:41:00.000Z",
    captured_at_source: "exif",
    original_path: "originals/user-1/x/file.jpg",
    original_bytes: 1000,
    mime_type: "image/jpeg",
    original_name: "file.jpg",
    thumb_path: "derived/user-1/x_thumb.webp",
    preview_path: "derived/user-1/x_preview.webp",
    duration_secs: null,
    sidecar_path: null,
    sidecar_name: null,
    created_at: "2026-08-14T15:00:00.000Z",
    uploader: { full_name: "Marco Reyes" },
    job: { id: "job-1", job_number: "3612", name: "Museum Tower Penthouse" },
    ...overrides,
  };
}

describe("groupPhotos by date", () => {
  it("groups same-day photos together, newest day first", () => {
    const photos = [
      makePhoto({ captured_at: "2026-08-14T18:00:00.000Z" }),
      makePhoto({ captured_at: "2026-08-14T09:00:00.000Z" }),
      makePhoto({ captured_at: "2026-08-01T12:00:00.000Z" }),
    ];
    const groups = groupPhotos(photos, "date");
    expect(groups).toHaveLength(2);
    expect(groups[0].photos).toHaveLength(2);
    expect(groups[1].photos).toHaveLength(1);
  });

  it("merges non-contiguous same-day photos into one group", () => {
    const photos = [
      makePhoto({ captured_at: "2026-08-14T18:00:00.000Z" }),
      makePhoto({ captured_at: "2026-08-01T12:00:00.000Z" }),
      makePhoto({ captured_at: "2026-08-14T09:00:00.000Z" }),
    ];
    const groups = groupPhotos(photos, "date");
    expect(groups).toHaveLength(2);
    expect(groups[0].photos).toHaveLength(2);
  });

  it("labels unparseable dates as Unknown date", () => {
    const groups = groupPhotos([makePhoto({ captured_at: "garbage" })], "date");
    expect(groups[0].label).toBe("Unknown date");
  });
});

describe("groupPhotos by job", () => {
  it("groups by job in encounter order with #number · name labels", () => {
    const jobA = { id: "job-a", job_number: "3612", name: "Museum Tower" };
    const jobB = { id: "job-b", job_number: "3648", name: "St Regis Lobby" };
    const photos = [
      makePhoto({ job_id: "job-a", job: jobA }),
      makePhoto({ job_id: "job-b", job: jobB }),
      makePhoto({ job_id: "job-a", job: jobA }),
    ];
    const groups = groupPhotos(photos, "job");
    expect(groups.map((group) => group.label)).toEqual([
      "#3612 · Museum Tower",
      "#3648 · St Regis Lobby",
    ]);
    expect(groups[0].photos).toHaveLength(2);
  });

  it("labels photos with no embedded job as Unknown job", () => {
    const groups = groupPhotos([makePhoto({ job: null })], "job");
    expect(groups[0].label).toBe("Unknown job");
  });
});
