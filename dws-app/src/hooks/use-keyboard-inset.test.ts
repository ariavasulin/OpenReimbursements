import { describe, expect, it } from "vitest";
import { keyboardInsetFrom } from "./use-keyboard-inset";

describe("keyboardInsetFrom", () => {
  it("reports the keyboard height when the visual viewport shrinks by a lot", () => {
    // iPhone: 844px layout viewport, keyboard eats 336px.
    expect(keyboardInsetFrom(844, 508, 0)).toBe(336);
  });

  it("accounts for the visual viewport scrolling down while the keyboard is up", () => {
    // Safari scrolls the visual viewport to keep the focused field on screen.
    expect(keyboardInsetFrom(844, 508, 40)).toBe(296);
  });

  it("ignores a URL-bar collapse (below the keyboard threshold)", () => {
    expect(keyboardInsetFrom(844, 760, 0)).toBe(0);
  });

  it("is 0 when the keyboard is closed", () => {
    expect(keyboardInsetFrom(844, 844, 0)).toBe(0);
  });

  it("never goes negative", () => {
    expect(keyboardInsetFrom(844, 900, 0)).toBe(0);
  });
});
