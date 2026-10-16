/**
 * Runs at most `limit` tasks at once, in the order they were given; the rest
 * wait their turn. Used for work a batch hands off to run in the background
 * (server-made previews), so a batch of 50 HEIC files asks the server for two
 * at a time rather than fifty.
 */
export function createTaskLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const pump = () => {
    while (active < limit && waiting.length) waiting.shift()!();
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          active++;
          // Free the slot before settling, so the caller sees the next task already started.
          Promise.resolve().then(task).finally(() => {
            active--;
            pump();
          }).then(resolve, reject);
        });
        pump();
      });
    },
    /** Tasks running or waiting. */
    get pending() {
      return active + waiting.length;
    },
  };
}
