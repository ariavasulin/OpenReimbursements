export const REPAIR_WORK_MS = 240_000;

export class DeadlineExceeded extends Error {
  constructor() {
    super("repair work deadline reached");
    this.name = "DeadlineExceeded";
  }
}

/** Construct once at invocation entry, before purge, and share across all work. */
export class WorkBudget {
  readonly deadlineAt: number;
  private readonly controller = new AbortController();

  constructor(
    startedAt = Date.now(),
    workMs = REPAIR_WORK_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.deadlineAt = startedAt + workMs;
  }

  remaining(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  cancel(reason: unknown = new Error("repair work cancelled")): void {
    this.controller.abort(reason);
  }

  check(): void {
    this.controller.signal.throwIfAborted();
    if (this.remaining() === 0) {
      this.cancel(new DeadlineExceeded());
      this.controller.signal.throwIfAborted();
    }
  }

  /** The callback must pass signal into cancellable I/O and include body reads.
   * The race also bounds callers whose underlying API ignores cancellation. */
  async run<T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
    callerSignal?: AbortSignal | null,
  ): Promise<T> {
    this.check();
    callerSignal?.throwIfAborted();
    const scoped = new AbortController();
    const onBudgetAbort = () => scoped.abort(this.controller.signal.reason);
    const onCallerAbort = () => scoped.abort(callerSignal?.reason);
    this.controller.signal.addEventListener("abort", onBudgetAbort, { once: true });
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => this.cancel(new DeadlineExceeded()), this.remaining());
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(scoped.signal.reason);
      scoped.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([operation(scoped.signal), aborted]);
      this.check();
      scoped.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      scoped.signal.removeEventListener("abort", onAbort);
      this.controller.signal.removeEventListener("abort", onBudgetAbort);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
