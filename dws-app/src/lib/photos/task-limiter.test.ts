import { describe, expect, it } from "vitest";
import { createTaskLimiter } from "./task-limiter";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("task limiter", () => {
  it("runs at most the limit at once, in order, and keeps going after a failure", async () => {
    const limiter = createTaskLimiter(2);
    const tasks = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const results = tasks.map((task, index) => limiter.run(() => { started.push(index); return task.promise; }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(limiter.pending).toBe(4);
    tasks[0].reject(new Error("server busy"));
    await expect(results[0]).rejects.toThrow("server busy");
    expect(started).toEqual([0, 1, 2]);
    tasks[1].resolve(); tasks[2].resolve();
    await Promise.all([results[1], results[2]]);
    expect(started).toEqual([0, 1, 2, 3]);
    tasks[3].resolve();
    await results[3];
    expect(limiter.pending).toBe(0);
  });
});
