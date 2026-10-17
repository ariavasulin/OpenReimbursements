// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_CONNECTION_MESSAGE,
  photoKeys,
  setCachedPhotoSettings,
  usePhotoActor,
  usePhotoAlbum,
  usePhotoJob,
  usePhotoSettings,
} from "./api";
import type { PhotoAlbumSummary, PhotoJobSummary } from "./types";

// The hooks behind every header and permission check, rendered for real: what
// they ask the server for, and what they show while and after it answers.

let root: Root;
let client: QueryClient;
const fetchMock = vi.fn();
const requested = () => fetchMock.mock.calls.map((call) => String(call[0]));
let latest: unknown;

function Probe({ useValue }: { useValue: () => unknown }) {
  latest = useValue();
  return null;
}

async function render(useValue: () => unknown) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe useValue={useValue} />
      </QueryClientProvider>
    );
  });
}

const useActorAndSettings = () => ({ actor: usePhotoActor(), settings: usePhotoSettings() });
const useJob = () => usePhotoJob("j1");
const useAlbum = () => usePhotoAlbum("al");

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // As the app's provider has it: answers stay fresh for 5 minutes, one retry.
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000, retry: false } } });
  root = createRoot(document.createElement("div"));
  latest = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("permissions and settings", () => {
  const me = {
    actor: { user_id: "u1", photo_admin: true },
    settings: { starter_tags: ["Deck"], slideshow: { shuffle: true, delay_seconds: 5 } },
  };

  it("come from one request to /api/photos/me", async () => {
    fetchMock.mockImplementation(async () => Response.json(me));
    await render(useActorAndSettings);
    await settle();
    expect(requested()).toEqual(["/api/photos/me"]);
    expect(latest).toEqual(me);
  });

  it("a saved setting shows at once and keeps the permissions", async () => {
    client.setQueryData(photoKeys.me, me);
    const saved = { ...me.settings, starter_tags: ["Roof"] };
    setCachedPhotoSettings(client, saved);
    expect(client.getQueryData(photoKeys.me)).toEqual({ actor: me.actor, settings: saved });
  });
});

describe("a project header seeded from a cached list", () => {
  const job: PhotoJobSummary = {
    id: "j1", job_number: "3612", name: "Museum Tower", location: null, photo_count: 2, thumb_paths: [], latest_activity: null,
  } as PhotoJobSummary;

  it("needs no request when the list is fresh", async () => {
    client.setQueryData(photoKeys.jobs(""), [job]);
    await render(useJob);
    await settle();
    expect((latest as ReturnType<typeof useJob>).data).toEqual(job);
    expect(requested()).toEqual([]);
  });

  it("asks again when the list is old, and keeps the card when that read fails", async () => {
    client.setQueryData(photoKeys.jobs(""), [job], { updatedAt: Date.now() - 10 * 60_000 });
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await render(useJob);
    await settle();
    expect(requested()).toEqual(["/api/photo-jobs/j1"]);
    const result = latest as ReturnType<typeof useJob>;
    expect(result.error?.message).toBe(NO_CONNECTION_MESSAGE);
    expect(result.data).toEqual(job);
  });

  it("asks again when an edit marked the list stale", async () => {
    client.setQueryData(photoKeys.jobs(""), [job]);
    await client.invalidateQueries({ queryKey: photoKeys.allJobs, refetchType: "none" });
    fetchMock.mockImplementation(async () => Response.json({ job: { ...job, photo_count: 3 } }));
    await render(useJob);
    await settle();
    expect(requested()).toEqual(["/api/photo-jobs/j1"]);
    expect((latest as ReturnType<typeof useJob>).data?.photo_count).toBe(3);
  });
});

describe("an album header seeded from a cached list", () => {
  const card: PhotoAlbumSummary = {
    id: "al", name: "Kitchen", photo_count: 3, thumb_paths: [], created_at: "2026-10-01T00:00:00Z",
    created_by: "u1", latest_activity: null, sort_mode: "custom", has_custom_order: true,
  };

  it("needs no request when the list is fresh", async () => {
    client.setQueryData(photoKeys.albums(""), [card]);
    await render(useAlbum);
    await settle();
    expect((latest as ReturnType<typeof useAlbum>).data).toMatchObject({ id: "al", sort_mode: "custom", has_custom_order: true });
    expect(requested()).toEqual([]);
  });

  it("waits for the album's own read when the card does not say its order", async () => {
    const older: PhotoAlbumSummary = { ...card };
    delete older.sort_mode;
    delete older.has_custom_order;
    client.setQueryData(photoKeys.albums(""), [older]);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await render(useAlbum);
    await settle();
    expect((latest as ReturnType<typeof useAlbum>).data).toBeUndefined();
    expect(requested()).toEqual(["/api/photo-albums/al"]);
  });
});
