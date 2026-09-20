import { describe, expect, it } from "vitest";
import { classifyMediaFailure } from "./media-retry";

describe("shared media failure policy", () => {
  it.each([
    { status: 507 },
    { status: 500, code: "quota_exceeded" },
    { status: 503, message: "Insufficient storage" },
  ])("requires a capacity remedy for %j", (failure) => {
    expect(classifyMediaFailure(failure)).toEqual({ retryable: false, remedy: expect.stringContaining("administrator") });
  });

  it.each([403, 413, 415])("does not automatically retry HTTP%s", (status) => {
    expect(classifyMediaFailure({ status }).retryable).toBe(false);
  });

  it("keeps recoverable network/server/rate limits and transport-specific locks distinct", () => {
    for (const failure of [{ networkFailure: true }, { status: 500 }, { status: 503 }, { status: 429 }]) {
      expect(classifyMediaFailure(failure).retryable).toBe(true);
    }
    for (const status of [409, 423]) {
      expect(classifyMediaFailure({ status }).retryable).toBe(false);
      expect(classifyMediaFailure({ status, allowStorageLockRetry: true }).retryable).toBe(true);
    }
  });
});
