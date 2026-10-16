import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedBlob } from "./query-persist";

// The browser persister's own check of who is signed in, against the auth
// client's two "no session" answers: signed out, or could not refresh.

const getSession = vi.fn();
vi.mock("@/lib/supabaseClient", () => ({ supabase: { auth: { getSession } } }));

const saved = new Map<string, unknown>();
const del = vi.fn(async (key: string) => void saved.delete(key));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => saved.get(key),
  set: async (key: string, value: unknown) => void saved.set(key, value),
  del: (key: string) => del(key),
}));

const blob: OwnedBlob = {
  owner: "alice",
  client: { timestamp: 1, buster: "b", clientState: { mutations: [], queries: [] } },
};

/** A fresh module per test: the persister restores once per page load. */
async function freshPersister() {
  vi.resetModules();
  return (await import("./query-persist-browser")).queryPersister;
}

beforeEach(() => {
  saved.clear();
  saved.set("photos-query-cache", blob);
  del.mockClear();
  getSession.mockReset();
});

describe("restoring the saved cache in the browser", () => {
  it("keeps it when the token refresh failed on a weak signal", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: new Error("Failed to fetch") });
    expect(await (await freshPersister()).restoreClient()).toBeUndefined();
    expect(del).not.toHaveBeenCalled();
    expect(saved.has("photos-query-cache")).toBe(true);
  });

  it("deletes it when no one is signed in", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await (await freshPersister()).restoreClient()).toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("hands it back to its owner", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "alice" } } }, error: null });
    expect(await (await freshPersister()).restoreClient()).toBeDefined();
  });
});
