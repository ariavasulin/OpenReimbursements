import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DehydratedState } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { PHOTO_ACTOR_KEY, PHOTO_SETTINGS_KEY, photoKeys } from "@/lib/photos/api";
import {
  MAX_PERSISTED_GRIDS,
  createUserPersister,
  markRestoredStale,
  shouldPersistQuery,
  trimForPersist,
  type BlobStorage,
  type OwnedBlob,
} from "./query-persist";

type DehydratedQuery = DehydratedState["queries"][number];

const query = (queryKey: unknown[], data: unknown, dataUpdatedAt = 1): DehydratedQuery =>
  ({
    queryKey,
    queryHash: JSON.stringify(queryKey),
    state: {
      data,
      dataUpdateCount: 1,
      dataUpdatedAt,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: "success",
      fetchStatus: "idle",
    },
  }) as DehydratedQuery;

const grid = (scope: string, pages: number, dataUpdatedAt = 1) =>
  query(
    ["photos", scope, `scope=${scope}`],
    {
      pages: Array.from({ length: pages }, (_, i) => ({ photos: [`${scope}-${i}`], nextCursor: `c${i + 1}` })),
      pageParams: Array.from({ length: pages }, (_, i) => (i === 0 ? null : `c${i}`)),
    },
    dataUpdatedAt
  );

const client = (queries: DehydratedQuery[]): PersistedClient => ({
  timestamp: 1,
  buster: "b",
  clientState: { mutations: [], queries },
});

describe("which queries are saved on the device", () => {
  it("saves the full project and album lists, settings, album headers and grids", () => {
    expect(shouldPersistQuery(["photo-jobs", ""])).toBe(true);
    expect(shouldPersistQuery(["photo-albums", ""])).toBe(true);
    expect(shouldPersistQuery(PHOTO_SETTINGS_KEY)).toBe(true);
    expect(shouldPersistQuery(["photo-album", "a1"])).toBe(true);
    expect(shouldPersistQuery(["photos", "all", "sort=newest"])).toBe(true);
  });

  it("leaves out typed prefixes, the actor, searches, trash and receipts", () => {
    expect(shouldPersistQuery(["photo-jobs", "36"])).toBe(false);
    expect(shouldPersistQuery(["photo-albums", "kit"])).toBe(false);
    expect(shouldPersistQuery(PHOTO_ACTOR_KEY)).toBe(false);
    expect(shouldPersistQuery(["photo-search", "q", "q=kitchen"])).toBe(false);
    expect(shouldPersistQuery(["photo-trash"])).toBe(false);
    expect(shouldPersistQuery(["photo-detail", "p1"])).toBe(false);
    expect(shouldPersistQuery(["photo-album", ""])).toBe(false);
    expect(shouldPersistQuery(["receipts"])).toBe(false);
    expect(shouldPersistQuery(["photos", "all", "sort=newest", "ids"])).toBe(false);
  });

  it("agrees with the keys api.ts builds, so a change to the key factory shows up here", () => {
    const all = { kind: "all" } as const;
    const album = { kind: "album", album: { id: "a1", name: "Kitchen" } } as const;
    expect(shouldPersistQuery(photoKeys.jobs())).toBe(true);
    expect(shouldPersistQuery(photoKeys.albums())).toBe(true);
    expect(shouldPersistQuery(photoKeys.album("a1"))).toBe(true);
    expect(shouldPersistQuery(photoKeys.list(all, "sort=asc"))).toBe(true);
    expect(shouldPersistQuery(photoKeys.list(album, "album=a1"))).toBe(true);

    expect(shouldPersistQuery(photoKeys.jobs("36"))).toBe(false);
    expect(shouldPersistQuery(photoKeys.jobSuggestions("", 5))).toBe(false);
    expect(shouldPersistQuery(photoKeys.albumSuggestions("", 25))).toBe(false);
    expect(shouldPersistQuery(photoKeys.ids(all, ""))).toBe(false);
    expect(shouldPersistQuery(photoKeys.count(all, ""))).toBe(false);
    expect(shouldPersistQuery(photoKeys.list({ kind: "search", q: "deck" }, "q=deck"))).toBe(false);
    expect(shouldPersistQuery(photoKeys.detail("p1"))).toBe(false);
    expect(shouldPersistQuery(photoKeys.tags())).toBe(false);
    expect(shouldPersistQuery(photoKeys.trash)).toBe(false);
  });
});

describe("trimming what is saved", () => {
  it("keeps only a grid's first page and its page param", () => {
    const [saved] = trimForPersist({ mutations: [], queries: [grid("all", 3)] }).queries;
    expect(saved.state.data).toEqual({
      pages: [{ photos: ["all-0"], nextCursor: "c1" }],
      pageParams: [null],
    });
  });

  it("keeps the most recently loaded grids, up to the cap, and every list", () => {
    const grids = Array.from({ length: MAX_PERSISTED_GRIDS + 2 }, (_, i) => grid(`g${i}`, 1, i));
    const lists = [query(["photo-jobs", ""], []), query(["photo-albums", ""], [])];
    const saved = trimForPersist({ mutations: [], queries: [...grids, ...lists] }).queries;
    const scopes = saved.filter((q) => q.queryKey[0] === "photos").map((q) => q.queryKey[1]);
    expect(scopes).toHaveLength(MAX_PERSISTED_GRIDS);
    expect(scopes).not.toContain("g0");
    expect(scopes).not.toContain("g1");
    expect(saved.filter((q) => q.queryKey[0] !== "photos")).toHaveLength(2);
  });

  it("leaves non-grid data as it is", () => {
    const jobs = query(["photo-jobs", ""], [{ id: "j1" }]);
    expect(trimForPersist({ mutations: [], queries: [jobs] }).queries[0]).toBe(jobs);
  });

  it("marks everything restored as stale, so it refetches when shown", () => {
    const restored = markRestoredStale(client([grid("all", 1), query(["photo-jobs", ""], [])]));
    expect(restored.clientState.queries.every((q) => q.state.isInvalidated)).toBe(true);
  });
});

describe("the per-person persister", () => {
  let stored: OwnedBlob | undefined;
  let storage: BlobStorage;
  let owner: string | null | undefined;
  let session: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    stored = undefined;
    owner = "alice";
    session = "alice";
    storage = {
      get: vi.fn(async () => stored),
      set: vi.fn(async (blob: OwnedBlob) => {
        stored = blob;
      }),
      del: vi.fn(async () => {
        stored = undefined;
      }),
    };
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    createUserPersister({
      storage,
      currentUserId: () => owner,
      sessionUserId: async () => session,
      throttleMs: 1000,
    });

  it("batches saves and records who they belong to", async () => {
    const persister = make();
    persister.persistClient(client([grid("a", 2)]));
    persister.persistClient(client([grid("b", 2)]));
    expect(storage.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(stored?.owner).toBe("alice");
    expect(stored?.client.clientState.queries[0].queryKey[1]).toBe("b");
    expect((stored?.client.clientState.queries[0].state.data as { pages: unknown[] }).pages).toHaveLength(1);
  });

  it("saves nothing while no one is signed in", async () => {
    owner = null;
    const persister = make();
    persister.persistClient(client([grid("a", 1)]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("restores the owner's cache, marked stale", async () => {
    stored = { owner: "alice", client: client([grid("a", 1)]) };
    const restored = await make().restoreClient();
    expect(restored?.clientState.queries[0].state.isInvalidated).toBe(true);
  });

  it("refuses and deletes another person's cache", async () => {
    stored = { owner: "alice", client: client([grid("a", 1)]) };
    session = "bob";
    expect(await make().restoreClient()).toBeUndefined();
    expect(stored).toBeUndefined();
  });

  it("refuses and deletes the cache when no one is signed in", async () => {
    stored = { owner: "alice", client: client([grid("a", 1)]) };
    session = null;
    expect(await make().restoreClient()).toBeUndefined();
    expect(stored).toBeUndefined();
  });

  it("restores once per page load", async () => {
    stored = { owner: "alice", client: client([grid("a", 1)]) };
    const persister = make();
    expect(await persister.restoreClient()).toBeDefined();
    expect(await persister.restoreClient()).toBeUndefined();
  });

  it("gives up on storage that never answers", async () => {
    storage.get = () => new Promise(() => {});
    const restoring = make().restoreClient();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await restoring).toBeUndefined();
  });

  it("keeps going when storage fails", async () => {
    storage.get = async () => {
      throw new Error("no IndexedDB");
    };
    storage.set = async () => {
      throw new Error("quota");
    };
    const persister = make();
    expect(await persister.restoreClient()).toBeUndefined();
    persister.persistClient(client([grid("a", 1)]));
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("removing cancels a pending save and deletes what is stored", async () => {
    stored = { owner: "alice", client: client([]) };
    const persister = make();
    persister.persistClient(client([grid("a", 1)]));
    await persister.removeClient();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.set).not.toHaveBeenCalled();
    expect(stored).toBeUndefined();
  });

  it("flush writes a pending save at once", async () => {
    const persister = make();
    persister.persistClient(client([grid("a", 1)]));
    persister.flush();
    await Promise.resolve();
    expect(storage.set).toHaveBeenCalledTimes(1);
  });
});
