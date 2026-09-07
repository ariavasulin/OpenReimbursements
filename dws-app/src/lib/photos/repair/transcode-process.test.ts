import { afterAll, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { DeadlineExceeded, WorkBudget } from "./deadline";
import { probe, transcode } from "./transcode";

// Substitute only the executable. Cancellation still goes through the real
// execFile, AbortSignal and OS child process, including an ignored SIGTERM.
vi.mock("ffmpeg-static", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "repair-child-")), "ffmpeg");
  writeFileSync(path, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(__filename + '.pid', String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  return { default: path };
});

afterAll(() => rmSync(dirname(ffmpegPath!), { recursive: true, force: true }));

it("probe cancellation propagates and hard-kills an actual child ignoring SIGTERM", async () => {
  const budget = new WorkBudget();
  const result = probe("input", budget).catch((error: unknown) => error);
  await vi.waitFor(() => expect(existsSync(`${ffmpegPath}.pid`)).toBe(true));
  const pid = Number(readFileSync(`${ffmpegPath}.pid`, "utf8"));
  process.kill(pid, 0);
  budget.cancel(new DeadlineExceeded());
  expect(await result).toBeInstanceOf(DeadlineExceeded);
  await vi.waitFor(() => {
    expect(() => process.kill(pid, 0)).toThrow();
  });
  rmSync(`${ffmpegPath}.pid`);
});

it("transcode receives only time left after earlier phases and cannot start after expiry", async () => {
  let now = 0;
  const budget = new WorkBudget(0, 240_000, () => now);
  await budget.run(async () => { now = 239_900; });
  expect(budget.remaining()).toBe(100);
  const started = Date.now();
  await expect(transcode("input", "output", budget)).rejects.toBeInstanceOf(DeadlineExceeded);
  expect(Date.now() - started).toBeLessThan(2_000);
  await expect(transcode("input", "output", budget)).rejects.toBeInstanceOf(DeadlineExceeded);
  if (existsSync(`${ffmpegPath}.pid`)) {
    const pid = Number(readFileSync(`${ffmpegPath}.pid`, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }
});
