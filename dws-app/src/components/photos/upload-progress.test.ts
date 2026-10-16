import { describe, expect, it } from "vitest";
import { uploadingLabel } from "./upload-progress";

describe("an uploading row says which step it is on", () => {
  it.each([
    [{ stage: "preparing", sentBytes: 0, size: 10 }, "Preparing..."],
    [{ stage: "sending", sentBytes: 0, size: 10 }, "Sending..."],
    [{ stage: "sending", sentBytes: 2 * 1024 * 1024, size: 9 * 1024 * 1024 }, "2.0 MB / 9.0 MB"],
    [{ stage: "sending", sentBytes: 10, size: 10 }, "Sending..."],
    [{ stage: "finishing", sentBytes: 10, size: 10 }, "Finishing..."],
    [{ stage: "reconnecting", sentBytes: 4, size: 10 }, "Waiting for connection..."],
    [{ sentBytes: 0, size: 10 }, "Uploading..."],
  ] as const)("%j reads %s", (item, label) => {
    expect(uploadingLabel(item)).toBe(label);
  });
});
