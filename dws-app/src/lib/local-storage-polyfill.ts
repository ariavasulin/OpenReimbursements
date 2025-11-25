// In some dev environments Node is started with `--localstorage-file` but no valid
// path, leaving `globalThis.localStorage` defined but non-functional. That crashes
// libraries that expect the Storage API. This shim installs an in-memory fallback
// during SSR only.
const isServer = typeof window === "undefined"

if (isServer) {
  const existing = (globalThis as any).localStorage
  const needsShim =
    typeof existing === "undefined" ||
    typeof existing.getItem !== "function" ||
    typeof existing.setItem !== "function" ||
    typeof existing.removeItem !== "function"

  if (needsShim) {
    const store = new Map<string, string>()
    ;(globalThis as any).localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => {
        store.clear()
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size
      },
    } as Storage
  }
}
