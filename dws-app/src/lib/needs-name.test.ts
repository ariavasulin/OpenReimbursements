import { describe, expect, it } from "vitest";
import { needsNameFor } from "./needs-name";

describe("asking for a name after sign-in", () => {
  it("asks when there is no name or only a placeholder", () => {
    expect(needsNameFor(null, "15555550199")).toBe(true);
    expect(needsNameFor("   ", "15555550199")).toBe(true);
    expect(needsNameFor("Employee", "15555550199")).toBe(true);
    expect(needsNameFor("15555550199", "15555550199")).toBe(true);
    expect(needsNameFor("+15555550199", "15555550199")).toBe(true);
  });

  it("does not ask when a real name is saved", () => {
    expect(needsNameFor("Marco Reyes", "15555550199")).toBe(false);
    expect(needsNameFor(" Marco ", null)).toBe(false);
  });
});
