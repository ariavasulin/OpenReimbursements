import { describe, expect, it } from "vitest";
import { groupPhotos, openableInDisplayOrder } from "./group";
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

  // photo-albums Decision 1: a project is optional.
  it("puts photos with no project in one 'No project' group with a stable key", () => {
    const groups = groupPhotos(
      [
        makePhoto({ job_id: null, job: null }),
        makePhoto(),
        makePhoto({ job_id: null, job: null }),
      ],
      "job"
    );
    expect(groups.map((group) => [group.key, group.label, group.photos.length])).toEqual([
      ["job:none", "No project", 2],
      ["job:job-1", "#3612 · Museum Tower Penthouse", 1],
    ]);
  });
});

describe("groupPhotos by tag", () => {
  it("shows a photo under each of its tags, tags A to Z ignoring case, and No tags last", () => {
    const both = makePhoto({ tags: ["shop drawing", "Kitchen"] });
    const bare = makePhoto({ tags: [] });
    const one = makePhoto({ tags: ["kitchen tile"] });
    const groups = groupPhotos([bare, both, one], "tag");
    expect(groups.map((group) => [group.key, group.label, group.photos.map((photo) => photo.id)])).toEqual([
      ["tag:Kitchen", "Kitchen", [both.id]],
      ["tag:kitchen tile", "kitchen tile", [one.id]],
      ["tag:shop drawing", "shop drawing", [both.id]],
      ["tag:none", "No tags", [bare.id]],
    ]);
  });

  it("leaves out the No tags group when every photo has a tag, and keeps newest first inside a group", () => {
    const newer = makePhoto({ tags: ["roof"], captured_at: "2026-08-14T18:00:00.000Z" });
    const older = makePhoto({ tags: ["roof"], captured_at: "2026-08-01T18:00:00.000Z" });
    const groups = groupPhotos([newer, older], "tag");
    expect(groups.map((group) => group.label)).toEqual(["roof"]);
    expect(groups[0].photos.map((photo) => photo.id)).toEqual([newer.id, older.id]);
  });

  it("hands the viewer each photo once even when it sits in two tag groups", () => {
    const both = makePhoto({ tags: ["a", "b"] });
    const other = makePhoto({ tags: ["b"] });
    const openable = openableInDisplayOrder(groupPhotos([both, other], "tag"));
    expect(openable.map((photo) => photo.id)).toEqual([both.id, other.id]);
  });
});
