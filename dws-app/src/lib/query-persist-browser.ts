import { createStore, del, get, set, type UseStore } from "idb-keyval";
import { supabase } from "@/lib/supabaseClient";
import { createUserPersister, type OwnedBlob } from "@/lib/query-persist";

// The one saved-cache persister for the browser: IndexedDB (no size cap worth
// worrying about, unlike localStorage's ~5 MB, and it does not block the main
// thread), owned by whoever the auth listener says is signed in.

const KEY = "photos-query-cache";

let store: UseStore | undefined;
// Opened on first use, never at import: the server renders this module's
// importers too, and has no IndexedDB.
const idb = () => (store ??= createStore("dws-query-cache", "cache"));

let currentOwner: string | null | undefined;

/** Called by QueryProvider with every auth event's user id (null when signed out). */
export function setPersistOwner(userId: string | null): void {
  currentOwner = userId;
}

export const queryPersister = createUserPersister({
  // async, so a browser without IndexedDB (it throws on open) rejects
  // instead of throwing, and the persister's catch-alls apply.
  storage: {
    get: async () => get<OwnedBlob>(KEY, idb()),
    set: async (blob) => set(KEY, blob, idb()),
    del: async () => del(KEY, idb()),
  },
  currentUserId: () => currentOwner,
  sessionUserId: async () => {
    const { data, error } = await supabase.auth.getSession();
    // An expired token whose refresh failed (a weak signal) answers no session
    // AND an error, though the person is still signed in: that is "could not
    // check", not "signed out", and must not delete their saved cache.
    if (error) throw error;
    return data.session?.user?.id ?? null;
  },
});

// iOS often closes the home-screen app while it is in the background; write a
// pending save as soon as the page is hidden rather than after the throttle.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") queryPersister.flush();
  });
}

/** Deletes the saved cache (sign-out, or a different person signed in). */
export function clearPersistedQueries(): Promise<void> {
  return Promise.resolve(queryPersister.removeClient());
}
