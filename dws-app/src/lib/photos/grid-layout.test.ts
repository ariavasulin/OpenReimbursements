import { describe, expect, it } from "vitest";
import { DESKTOP_TILES, PHONE_TILES, sectionHeightGuess } from "./grid-layout";

describe("sectionHeightGuess", () => {
  it("is the header alone for an empty section", () => {
    expect(sectionHeightGuess(0, PHONE_TILES)).toBe(48);
  });

  it("counts a partly filled row as a whole row", () => {
    expect(sectionHeightGuess(1, PHONE_TILES)).toBe(48 + 122);
    expect(sectionHeightGuess(3, PHONE_TILES)).toBe(48 + 122);
    expect(sectionHeightGuess(4, PHONE_TILES)).toBe(48 + 2 * 122);
  });

  it("uses the desktop row shape when given it", () => {
    expect(sectionHeightGuess(15, DESKTOP_TILES)).toBe(48 + 3 * 158);
  });
});
