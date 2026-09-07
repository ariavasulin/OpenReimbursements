import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineExceeded, WorkBudget } from "./deadline";

afterEach(() => vi.useRealTimers());

describe("shared repair deadline", () => {
  it("purge and inventory leave only the remainder for media, then stop new work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new WorkBudget();
    await budget.run(async () => { vi.setSystemTime(180_000); }); // Purge.
    await budget.run(async () => { vi.setSystemTime(239_950); }); // Inventory.
    expect(budget.remaining()).toBe(50);
    let mediaSignal!: AbortSignal;
    const media = budget.run((signal) => {
      mediaSignal = signal;
      return new Promise(() => {});
    });
    const assertion = expect(media).rejects.toBeInstanceOf(DeadlineExceeded);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(mediaSignal.aborted).toBe(true);
    const later = vi.fn();
    await expect(budget.run(later)).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(later).not.toHaveBeenCalled();
  });

  it("lease loss aborts every current operation and prevents later work", async () => {
    const budget = new WorkBudget();
    const signals: AbortSignal[] = [];
    const operation = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    const first = budget.run(operation);
    const second = budget.run(operation);
    const lostLease = new Error("repair lease lost");
    budget.cancel(lostLease);
    await expect(first).rejects.toBe(lostLease);
    await expect(second).rejects.toBe(lostLease);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(() => budget.check()).toThrow(lostLease);
  });

  it("propagates caller cancellation without cancelling unrelated work", async () => {
    const budget = new WorkBudget();
    const caller = new AbortController();
    const pending = budget.run(() => new Promise(() => {}), caller.signal);
    caller.abort(new Error("request closed"));
    await expect(pending).rejects.toThrow("request closed");
    await expect(budget.run(async () => 1)).resolves.toBe(1);
  });
});
