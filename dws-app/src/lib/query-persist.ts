import type { DehydratedState, QueryKey } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";

// The query cache saved on the device between visits (audit HOST-3), so a cold
// launch paints Projects, Albums and the last grids at once and then refreshes
// them quietly. Only photo lists are saved, only for the person who saved
// them, and never past sign-out.

/** How long a saved cache may be used. Older than this, it is thrown away. */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Changes with every deploy, so a new build never reads a cache shaped by the
 * old one (a list field the new code expects could be missing). Vercel exposes
 * the commit to the browser build; locally it is "local". Bump the "v1" if the
 * saved shape itself changes.
 */
export const PERSIST_BUSTER = `v1:${process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "local"}`;

/** At most this many photo grids are saved, the most recently loaded first. */
export const MAX_PERSISTED_GRIDS = 6;

/**
 * Which queries are saved. These mirror photoKeys in lib/photos/api.ts
 * (query-persist.test.ts checks them against it):
 * - the full project and album lists (the "" search prefix only; typed
 *   prefixes are throwaway),
 * - photo settings,
 * - one album's header,
 * - photo grids (["photos", scope, list params]), trimmed to their first
 *   page below.
 * Not saved: who the person is and what they may do ("photo-actor" — a stale
 * admin flag would draw the wrong buttons), searches, trash, details, and
 * every receipts query.
 */
export function shouldPersistQuery(queryKey: QueryKey): boolean {
  const [kind, arg] = queryKey;
  switch (kind) {
    case "photo-jobs":
    case "photo-albums":
      return queryKey.length === 2 && arg === "";
    case "photo-settings":
      return queryKey.length === 1;
    case "photo-album":
      return typeof arg === "string" && arg.length > 0;
    case "photos":
      // [prefix, scope, list params]; a fourth "ids" entry is a selection's
      // id list, not a grid.
      return queryKey.length === 3;
    default:
      return false;
  }
}

function isGrid(query: DehydratedState["queries"][number]): boolean {
  return query.queryKey[0] === "photos";
}

/** An infinite query's data cut to its first page, so a restored grid refetches one page, not all of them. */
function firstPageOnly(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const { pages, pageParams } = data as { pages?: unknown; pageParams?: unknown };
  if (!Array.isArray(pages) || !Array.isArray(pageParams)) return data;
  return { pages: pages.slice(0, 1), pageParams: pageParams.slice(0, 1) };
}

/**
 * What is written to the device: every saved list as is, and the
 * MAX_PERSISTED_GRIDS most recently loaded grids with their first page only.
 * No mutations: a write is never replayed from the device.
 */
export function trimForPersist(state: DehydratedState): DehydratedState {
  const keptGrids = new Set(
    state.queries
      .filter(isGrid)
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
      .slice(0, MAX_PERSISTED_GRIDS)
  );
  return {
    mutations: [],
    queries: state.queries
      .filter((query) => !isGrid(query) || keptGrids.has(query))
      .map((query) =>
        isGrid(query)
          ? { ...query, state: { ...query.state, data: firstPageOnly(query.state.data) } }
          : query
      ),
  };
}

/**
 * A restored cache is shown at once but always refetched when it is next
 * shown, however recent it is: a reload has always meant "get me the latest",
 * and someone else may have uploaded since.
 */
export function markRestoredStale(client: PersistedClient): PersistedClient {
  return {
    ...client,
    clientState: {
      ...client.clientState,
      queries: client.clientState.queries.map((query) => ({
        ...query,
        state: { ...query.state, isInvalidated: true },
      })),
    },
  };
}

/** The saved record: the cache plus whose it is. */
export interface OwnedBlob {
  owner: string;
  client: PersistedClient;
}

export interface BlobStorage {
  get(): Promise<OwnedBlob | undefined>;
  set(blob: OwnedBlob): Promise<void>;
  del(): Promise<void>;
}

export interface UserPersister extends Persister {
  /** Writes a pending save now (the page is being hidden or closed). */
  flush(): void;
}

/**
 * A Persister that ties the saved cache to one person. The photo query keys
 * carry no user id, and the provider treats the first sign-in it sees as a
 * baseline rather than a change, so without this a second person on the same
 * device could be shown the first one's lists:
 * - every save records `currentUserId()` as the owner (no one signed in: no save),
 * - a restore hands back the cache only when `sessionUserId()` is that owner,
 *   and deletes it when it names someone else or no one; when it throws (the
 *   sign-in could not be checked) the cache is skipped this time but kept;
 *   what it hands back is marked stale,
 * - saves are batched: at most one write per `throttleMs`.
 */
export function createUserPersister({
  storage,
  currentUserId,
  sessionUserId,
  throttleMs = 1000,
  restoreTimeoutMs = 2000,
}: {
  storage: BlobStorage;
  /** Who is signed in now, as the auth listener last saw it. */
  currentUserId(): string | null | undefined;
  /**
   * Who is signed in, asked of the auth client (may refresh the token). Null
   * only for a sure "no one"; throws when it could not tell.
   */
  sessionUserId(): Promise<string | null>;
  throttleMs?: number;
  /** A device whose storage never answers must not hold up every query. */
  restoreTimeoutMs?: number;
}): UserPersister {
  let pending: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let restored = false;

  const write = () => {
    timer = null;
    const client = pending;
    pending = null;
    const owner = currentUserId();
    if (!client || !owner) return;
    storage
      .set({ owner, client: { ...client, clientState: trimForPersist(client.clientState) } })
      // Full or unavailable storage: the app simply starts cold next time.
      .catch(() => undefined);
  };

  return {
    persistClient(client) {
      pending = client;
      if (timer === null) timer = setTimeout(write, throttleMs);
    },

    async restoreClient() {
      // Once per page load: the provider remounts when moving between areas
      // of the site, and the live cache is newer than the saved one by then.
      if (restored) return undefined;
      restored = true;
      const blob = await Promise.race([
        storage.get().catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, restoreTimeoutMs)),
      ]);
      if (!blob) return undefined;
      let userId: string | null;
      try {
        userId = await sessionUserId();
      } catch {
        // Could not tell who is signed in: start cold, but keep the cache for next time.
        return undefined;
      }
      if (!userId || blob.owner !== userId) {
        await storage.del().catch(() => undefined);
        return undefined;
      }
      return markRestoredStale(blob.client);
    },

    async removeClient() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      await storage.del().catch(() => undefined);
    },

    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      write();
    },
  };
}
