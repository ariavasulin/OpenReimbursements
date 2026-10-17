import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  albumHeaderFromSummary,
  fetchJob,
  fetchJson,
  invalidatePhotoCaches,
  NO_CONNECTION_MESSAGE,
  patchFavorites,
  patchPhotoRows,
  patchPhotoTags,
  photoKeys,
  photoListOptions,
  prefetchCollection,
  READ_TIMEOUT_MS,
  removePhotosFromLists,
} from "./api";
import { NO_FILTERS } from "./browse-state";
import type { CachedGrid } from "./cache-patch";
import type { PhotoAlbumSummary, PhotoRow } from "./types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("fetchJson", () => {
  it("gives up on a stalled read after READ_TIMEOUT_MS and says there is no connection", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      )
    );
    const pending = fetchJson("/api/x", "Failed");
    const settled = expect(pending).rejects.toThrow(NO_CONNECTION_MESSAGE);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await settled;
  });

  it("never puts a deadline on a write, which may still finish on the server", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      seen = init;
      return Response.json({ ok: true });
    });
    await fetchJson("/api/x", "Failed", { method: "POST", body: "{}" });
    expect(seen?.signal).toBeUndefined();
  });

  it("turns the browser's network TypeError into plain words", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchJson("/api/x", "Failed", { method: "POST" })).rejects.toThrow(NO_CONNECTION_MESSAGE);
  });

  it("passes a cancel by the caller on as it is", async () => {
    globalThis.fetch = vi.fn((_url, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      )
    );
    const controller = new AbortController();
    const pending = fetchJson("/api/x", "Failed", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the server's message and status", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: "Nope" }, { status: 409 }));
    await expect(fetchJson("/api/x", "Failed")).rejects.toMatchObject({ message: "Nope", status: 409 });
  });
});

describe("fetchJob", () => {
  const job = { id: "j1", job_number: "1", name: "One", location: null, photo_count: 2, thumb_paths: [], latest_activity: null };

  it("is null for a deleted or unknown project", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: "not found" }, { status: 404 }));
    expect(await fetchJob("j1")).toBeNull();
  });

  it("reads the one project by itself, never the full list", async () => {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      requested.push(String(input));
      return Response.json({ success: true, job });
    });
    expect(await fetchJob("j1")).toEqual(job);
    expect(requested).toEqual(["/api/photo-jobs/j1"]);
  });

  it("passes any other failure on, so the header shows an error rather than 'not here'", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: "Down" }, { status: 500 }));
    await expect(fetchJob("j1")).rejects.toMatchObject({ status: 500 });
  });
});

const photo = (id: string, extra: Partial<PhotoRow> = {}) => ({ id, tags: [], ...extra }) as unknown as PhotoRow;
const gridOf = (...photos: PhotoRow[]): CachedGrid => ({ pages: [{ photos, nextCursor: null }], pageParams: [null] });
const idsOf = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<CachedGrid>(key)!.pages.flatMap((page) => page.photos.map((row) => row.id));

describe("query keys", () => {
  it("name a grid exactly as the grid always has: prefix, scope, list parameters", () => {
    expect(photoListOptions({ kind: "job", jobId: "j1" }, NO_FILTERS, "desc").queryKey).toEqual(["photos", "job:j1", "job=j1"]);
    expect(photoListOptions({ kind: "search", q: "deck" }, { ...NO_FILTERS, tags: ["Shop"] }, "asc").queryKey).toEqual([
      "photo-search", "search:deck", "q=deck&tags=Shop&sort=asc",
    ]);
  });
});

describe("cache patches", () => {
  const scope = { kind: "all" } as const;
  const allKey = photoKeys.list(scope, "");
  const idsKey = photoKeys.ids(scope, "");

  it("favorites skip the Select all answers kept beside the grid", () => {
    const client = new QueryClient();
    client.setQueryData(allKey, gridOf(photo("a")));
    client.setQueryData(idsKey, { ids: ["a"], total: 1, truncated: false });
    expect(() => patchFavorites(client, ["a"], "me", true)).not.toThrow();
    expect(client.getQueryData<CachedGrid>(allKey)!.pages[0].photos[0].favorites).toEqual([{ user_id: "me" }]);
  });

  it("a renamed row replaces the cached one and keeps what the server row lacks", () => {
    const client = new QueryClient();
    client.setQueryData(allKey, gridOf(photo("a", { display_name: "old", favorites: [{ user_id: "me" }] })));
    client.setQueryData(photoKeys.detail("a"), { ...photo("a"), albums: [{ id: "al", name: "Al" }] });
    patchPhotoRows(client, [{ id: "a", display_name: "new" }]);
    const row = client.getQueryData<CachedGrid>(allKey)!.pages[0].photos[0];
    expect(row.display_name).toBe("new");
    expect(row.favorites).toEqual([{ user_id: "me" }]);
    expect(client.getQueryData<{ albums: unknown[] }>(photoKeys.detail("a"))!.albums).toHaveLength(1);
    expect(client.getQueryState(allKey)?.isInvalidated).toBe(true);
  });

  it("an edited row with new tags also refreshes the tag menus, a renamed one does not", () => {
    const client = new QueryClient();
    client.setQueryData(photoKeys.tags(), ["Shop"]);
    patchPhotoRows(client, [{ id: "a", display_name: "new" }]);
    expect(client.getQueryState(photoKeys.tags())?.isInvalidated).toBe(false);
    patchPhotoRows(client, [{ id: "a", tags: ["Deck"] }]);
    expect(client.getQueryState(photoKeys.tags())?.isInvalidated).toBe(true);
  });

  it("tags show at once, in the library's spelling", () => {
    const client = new QueryClient();
    client.setQueryData(allKey, gridOf(photo("a", { tags: ["Shop"] }), photo("b")));
    client.setQueryData(photoKeys.tags(), ["kitchen"]);
    patchPhotoTags(client, ["a"], { add: ["Kitchen"] });
    const rows = client.getQueryData<CachedGrid>(allKey)!.pages[0].photos;
    expect(rows.map((row) => row.tags)).toEqual([["Shop", "kitchen"], []]);
  });

  it("trashed photos leave every grid; removed-from-album ones only that album's", () => {
    const client = new QueryClient();
    const album = { kind: "album", album: { id: "al", name: "Al" } } as const;
    const albumKey = photoKeys.list(album, "album=al");
    client.setQueryData(allKey, gridOf(photo("a"), photo("b")));
    client.setQueryData(albumKey, gridOf(photo("a"), photo("b")));
    client.setQueryData(idsKey, { ids: ["a", "b"], total: 2, truncated: false });

    removePhotosFromLists(client, ["a"], { fromAlbumId: "al" });
    expect(idsOf(client, allKey)).toEqual(["a", "b"]);
    expect(idsOf(client, albumKey)).toEqual(["b"]);

    removePhotosFromLists(client, ["b"]);
    expect(idsOf(client, allKey)).toEqual(["a"]);
    expect(client.getQueryData(idsKey)).toEqual({ ids: ["a", "b"], total: 2, truncated: false });
    expect(client.getQueryState(idsKey)?.isInvalidated).toBe(true);
  });

  it("the broad refresh never refetches a Select all walk, only marks it stale", async () => {
    const client = new QueryClient();
    const walk = vi.fn(async () => ({ ids: [], total: 0, truncated: false }));
    const tags = vi.fn(async () => ["Shop"]);
    // Both "on screen", so a default invalidation would refetch them.
    const watchers = [
      new QueryObserver(client, { queryKey: idsKey, queryFn: walk }),
      new QueryObserver(client, { queryKey: photoKeys.tags(), queryFn: tags }),
    ];
    const stops = watchers.map((watcher) => watcher.subscribe(() => undefined));
    await vi.waitFor(() => expect(client.getQueryState(photoKeys.tags())?.status).toBe("success"));
    await vi.waitFor(() => expect(client.getQueryState(idsKey)?.status).toBe("success"));
    walk.mockClear();
    invalidatePhotoCaches(client);
    await vi.waitFor(() => expect(tags).toHaveBeenCalledTimes(2));
    expect(walk).not.toHaveBeenCalled();
    expect(client.getQueryState(idsKey)?.isInvalidated).toBe(true);
    stops.forEach((stop) => stop());
  });
});

describe("album header from its card", () => {
  // An older server's card, before the list carried the album's order.
  const card = {
    id: "al", name: "Al", photo_count: 3, thumb_paths: [], created_at: "2026-10-01T00:00:00Z",
    created_by: "u1", latest_activity: null,
  } as unknown as PhotoAlbumSummary;

  it("needs the album's order, or the grid would start in the wrong one", () => {
    expect(albumHeaderFromSummary(card)).toBeUndefined();
    expect(albumHeaderFromSummary({ ...card, sort_mode: "custom", has_custom_order: true })).toEqual({
      id: "al", name: "Al", photo_count: 3, created_at: "2026-10-01T00:00:00Z", created_by: "u1",
      sort_mode: "custom", has_custom_order: true,
    });
  });

  it("prefetches an arranged album's grid in its own order", async () => {
    const client = new QueryClient();
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      requested.push(String(input));
      return String(input).startsWith("/api/photos?")
        ? Response.json({ photos: [], nextCursor: null })
        : Response.json({ album: { ...card, sort_mode: "custom", has_custom_order: true } });
    });
    client.setQueryData(photoKeys.albums(""), [{ ...card, sort_mode: "custom", has_custom_order: true }]);
    prefetchCollection(client, { kind: "album", id: "al" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toContain("/api/photos?album=al&sort=custom");
    expect(client.getQueryData(["photos", "album:al", "album=al&sort=custom"])).toBeDefined();
  });
});

describe("a patch made while a grid is loading", () => {
  const scope = { kind: "all" } as const;
  const key = photoKeys.list(scope, "");
  const page = (...ids: string[]) => ({ photos: ids.map((id) => photo(id)), nextCursor: null });

  /** A grid fetch that waits until `land` is called, counting its requests. */
  function slowGrid() {
    const calls: unknown[] = [];
    let land: (value: ReturnType<typeof page>) => void = () => undefined;
    const queryFn = vi.fn(({ pageParam }: { pageParam: unknown }) => {
      calls.push(pageParam);
      return new Promise<ReturnType<typeof page>>((resolve) => (land = resolve));
    });
    return { calls, queryFn, land: (value: ReturnType<typeof page>) => land(value) };
  }

  it("keeps a trash made during a refetch that started before it, without asking again", async () => {
    const client = new QueryClient();
    client.setQueryData(key, gridOf(photo("a"), photo("b")));
    const slow = slowGrid();
    const refetch = client.fetchInfiniteQuery({
      queryKey: key, queryFn: slow.queryFn, initialPageParam: null as string | null,
      getNextPageParam: () => null, staleTime: 0,
    });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));

    removePhotosFromLists(client, ["a"]);
    expect(idsOf(client, key)).toEqual(["b"]);
    // The server answers as it was before the trash.
    slow.land(page("a", "b"));
    await refetch;

    expect(idsOf(client, key)).toEqual(["b"]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(slow.calls).toHaveLength(1);
  });

  it("keeps both of two trashes made during one refetch when the answer already has the first", async () => {
    const client = new QueryClient();
    client.setQueryData(key, gridOf(photo("a"), photo("b")));
    const slow = slowGrid();
    const refetch = client.fetchInfiniteQuery({
      queryKey: key, queryFn: slow.queryFn, initialPageParam: null as string | null,
      getNextPageParam: () => null, staleTime: 0,
    });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    removePhotosFromLists(client, ["a"]);
    removePhotosFromLists(client, ["b"]);
    // Read after the first trash, before the second.
    slow.land(page("b"));
    await refetch;
    expect(idsOf(client, key)).toEqual([]);
  });

  it("keeps a rename made after a tag the answer already carries", async () => {
    const client = new QueryClient();
    client.setQueryData(key, gridOf({ ...photo("b"), display_name: "old" }));
    const slow = slowGrid();
    const refetch = client.fetchInfiniteQuery({
      queryKey: key, queryFn: slow.queryFn, initialPageParam: null as string | null,
      getNextPageParam: () => null, staleTime: 0,
    });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    patchPhotoTags(client, ["b"], { add: ["Deck"] });
    patchPhotoRows(client, [{ id: "b", display_name: "new" }]);
    slow.land({ photos: [{ ...photo("b"), tags: ["Deck"], display_name: "old" }], nextCursor: null });
    await refetch;
    const [row] = client.getQueryData<CachedGrid>(key)!.pages[0].photos;
    expect([row.display_name, row.tags]).toEqual(["new", ["Deck"]]);
  });

  it("keeps a rename made while an open photo's read is on its way", async () => {
    const client = new QueryClient();
    const detailKey = photoKeys.detail("a");
    client.setQueryData(detailKey, { ...photo("a"), display_name: "old", albums: [] });
    let land: (value: unknown) => void = () => undefined;
    const read = client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise((resolve) => (land = resolve)), staleTime: 0 });
    await vi.waitFor(() => expect(client.getQueryState(detailKey)?.fetchStatus).toBe("fetching"));
    patchPhotoRows(client, [{ id: "a", display_name: "new" }]);
    patchPhotoTags(client, ["a"], { add: ["Deck"] });
    // The server answers as it was before the rename and the tag.
    land({ ...photo("a"), display_name: "old", tags: [], albums: [] });
    await read;
    expect(client.getQueryData<PhotoRow>(detailKey)).toMatchObject({ display_name: "new", tags: ["Deck"] });
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it("keeps a new tag when the next page lands after it", async () => {
    const client = new QueryClient();
    client.setQueryData(key, { pages: [{ photos: [photo("a")], nextCursor: "c1" }], pageParams: [null] });
    const slow = slowGrid();
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key, queryFn: slow.queryFn, initialPageParam: null as string | null,
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor, staleTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);
    const more = observer.fetchNextPage();
    await vi.waitFor(() => expect(slow.calls).toEqual(["c1"]));

    patchPhotoTags(client, ["a", "b"], { add: ["Deck"] });
    slow.land(page("b"));
    await more;

    const rows = client.getQueryData<CachedGrid>(key)!.pages.flatMap((p) => p.photos);
    expect(rows.map((row) => [row.id, row.tags])).toEqual([["a", ["Deck"]], ["b", ["Deck"]]]);
    expect(slow.calls).toEqual(["c1"]);
    stop();
  });

  it("applies the patch to a grid's first load that was already on its way", async () => {
    const client = new QueryClient();
    const slow = slowGrid();
    const first = client.fetchInfiniteQuery({
      queryKey: key, queryFn: slow.queryFn, initialPageParam: null as string | null, getNextPageParam: () => null,
    });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    removePhotosFromLists(client, ["a"]);
    slow.land(page("a", "b"));
    await first;
    expect(idsOf(client, key)).toEqual(["b"]);
  });
});

describe("prefetching a card's grid", () => {
  it("leaves a cached grid alone even when an edit marked it stale", async () => {
    const client = new QueryClient();
    const jobGrid = photoListOptions({ kind: "job", jobId: "j1" }, NO_FILTERS, "desc");
    client.setQueryData(jobGrid.queryKey, {
      pages: [{ photos: [photo("a")], nextCursor: "c1" }, { photos: [photo("b")], nextCursor: null }],
      pageParams: [null, "c1"],
    });
    patchPhotoTags(client, ["a"], { add: ["Deck"] });
    expect(client.getQueryState(jobGrid.queryKey)?.isInvalidated).toBe(true);
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      requested.push(String(input));
      return Response.json({ photos: [], nextCursor: null });
    });

    prefetchCollection(client, { kind: "job", id: "j1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toEqual([]);

    prefetchCollection(client, { kind: "job", id: "j2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toEqual(["/api/photos?job=j2"]);
  });
});
