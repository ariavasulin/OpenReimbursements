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
    expect(keyboardInsetFrom(844, 508, 200)).toBe(136);
  });

  it("detects the keyboard from the raw height, not the scroll-adjusted one", () => {
    // Scrolled far enough that the leftover overlap is under the threshold,
    // but the keyboard is still up, so the overlap is still reported.
    expect(keyboardInsetFrom(844, 508, 300)).toBe(36);
  });

  it("applies the threshold at exactly 150px", () => {
    expect(keyboardInsetFrom(844, 844 - 149, 0)).toBe(0);
    expect(keyboardInsetFrom(844, 844 - 150, 0)).toBe(150);
  });

  it("ignores a URL-bar collapse (below the keyboard threshold)", () => {
    expect(keyboardInsetFrom(844, 760, 0)).toBe(0);
  });

  it("is 0 when the keyboard is closed", () => {
    expect(keyboardInsetFrom(844, 844, 0)).toBe(0);
  });

  it("never goes negative", () => {
    expect(keyboardInsetFrom(844, 900, 0)).toBe(0);
    expect(keyboardInsetFrom(844, 508, 400)).toBe(0);
  });
});
