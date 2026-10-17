// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reloadIfRedeployed } from "./redeploy";

const CHUNK = "https://photos.example/_next/static/chunks/123.abc.js";
/** What webpack rejects a failed code download with. */
const chunkError = () => Object.assign(new Error(`Loading chunk 123 failed.\n(error: ${CHUNK})`), { name: "ChunkLoadError", request: CHUNK });

let reload: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  reload = vi.fn<() => void>();
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it("reloads when the file the tab asked for is gone from the server (a deploy removed it)", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  await reloadIfRedeployed(chunkError(), reload);
  expect(fetch.mock.calls[0][0]).toBe(CHUNK);
  expect(reload).toHaveBeenCalledOnce();
  // Not again within the minute, so a deploy missing its own files cannot loop.
  await reloadIfRedeployed(chunkError(), reload);
  expect(reload).toHaveBeenCalledOnce();
});

it("leaves the page alone on a weak signal or when the file is there", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await reloadIfRedeployed(chunkError(), reload);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  await reloadIfRedeployed(chunkError(), reload);
  expect(reload).not.toHaveBeenCalled();
});

it("ignores a failure that names no file", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await reloadIfRedeployed(new Error("offline"), reload);
  expect(fetch).not.toHaveBeenCalled();
});
