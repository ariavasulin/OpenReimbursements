import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESKTOP_MQ } from "./use-desktop";

const strip = (value: string) => value.replace(/\s+/g, "");

describe("DESKTOP_MQ", () => {
  it("matches the desktop: Tailwind variant in globals.css exactly", () => {
    const css = readFileSync(
      new URL("../app/globals.css", import.meta.url),
      "utf8"
    );
    expect(strip(css)).toContain(
      `@custom-variantdesktop(@media${strip(DESKTOP_MQ)})`
    );
  });
});
