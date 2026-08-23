import { describe, expect, it } from "vitest";
import { nextPreviewIndex, readInputFiles } from "./batch";

describe("nextPreviewIndex", () => {
  it("stays put when a later file is removed", () => {
    expect(nextPreviewIndex(0, 2, 2)).toBe(0);
  });
  it("shifts back when an earlier file is removed", () => {
    expect(nextPreviewIndex(2, 0, 2)).toBe(1);
  });
  it("clamps when the viewed (last) file is removed", () => {
    expect(nextPreviewIndex(2, 2, 2)).toBe(1);
  });
  it("is null when nothing remains", () => {
    expect(nextPreviewIndex(0, 0, 0)).toBeNull();
  });
});

describe("readInputFiles", () => {
  const a = new File(["a"], "a.jpg", { type: "image/jpeg" });
  const b = new File(["b"], "b.jpg", { type: "image/jpeg" });

  const input = (files: FileList | null) =>
    ({ files, value: "C:\\fakepath\\a.jpg" }) as unknown as HTMLInputElement;

  const fileList = (...items: File[]) =>
    Object.assign({ length: items.length }, items) as unknown as FileList;

  it("reads a picker's FileList as a plain array", () => {
    expect(readInputFiles(input(fileList(a, b)))).toEqual([a, b]);
  });

  it("clears the input so re-picking the same file still fires change", () => {
    const element = input(fileList(a));
    readInputFiles(element);
    expect(element.value).toBe("");
  });

  it("clears the input even when nothing was picked", () => {
    const element = input(null);
    expect(readInputFiles(element)).toEqual([]);
    expect(element.value).toBe("");
  });
});
